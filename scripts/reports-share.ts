#!/usr/bin/env bun
/**
 * reports-share.ts — prepare the Allure and Playwright reports to be published BY HAND
 * on GitHub Pages. It publishes, pushes and uploads NOTHING, makes no network call and
 * reads no environment variable (run it as `bun --no-env-file`, see `reports:share`).
 *
 * Output (default `share-reports/`, gitignored):
 *   .reports-share-generated   marker: the generator only ever deletes a folder that holds it
 *   LEEME.md                   exact publish steps (Spanish)
 *   qa-reports/                the payload the owner copies to `docs/qa-reports/`
 *     allure/index.html        single-file Allure report
 *     playwright/              the redacted Playwright report
 *
 * Pipeline (strict order; nothing is written to `--out` until every scan has passed):
 *   1. arguments and `--out` guards
 *   2. stage a COPY of `allure-results/` (never in place), filtered by `--since` mtime
 *   3. scan the copy for secrets; any finding exits 1 and writes nothing
 *   4. redact e-mails and absolute user paths in the copy
 *   5. scan again (second pass): a finding or a leftover e-mail exits 1 and writes nothing
 *   6. Playwright report: copy, scan and redact (embedded base64 zip included), verify; fail closed
 *   7. Allure: single-file report generated from the redacted staging copy (injectable runner)
 *   8. build the output tree in a temp sibling, then swap it in
 *
 * Reports print counts, file names and value SHAPES only, never a value.
 *
 * Usage:
 *   bun --no-env-file scripts/reports-share.ts [--out <dir>] [--since <YYYY-MM-DD[THH:MM]>] [--results <dir>] [--playwright <dir>] [--help]
 *
 * Exit codes: 0 ok (or --help), 1 on any refusal.
 */

import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, parse, resolve, sep } from 'node:path';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { relativePosix, toPosix } from './lib/posix-path.ts';
import { FILE_LINE_PATTERN } from './lib/volatile-facts.ts';
import { SECRET_PATTERNS } from './qa-local.ts';

// ============================================
// Types and constants
// ============================================

export interface Options {
  out: string
  since: string | null
  results: string
  playwright: string
  help: boolean
}
export interface SecretHit { file: string, pattern: string, count: number, shapes?: string[] }
export interface StageStats { copied: number, excludedZips: number, skippedOld: number }
export interface Redaction { text: string, emails: number, paths: number }
export interface Deps {
  log: (line: string) => void
  now: () => Date
  /** True when git ignores the path. Only asked for an `--out` inside the repo. */
  checkIgnored: (path: string, repoRoot: string) => boolean
  /** Runs `allure <args>` from `cwd`; only the exit code matters. Injected by tests, never the real generator there. */
  runAllure: (args: string[], cwd: string) => { code: number }
  repoRoot: string
}
export interface ZipEntry { name: string, data: Buffer }
export interface PlaywrightStats { files: number, emails: number, paths: number }

const REPO_ROOT = join(import.meta.dir, '..');
const DEFAULT_OUT = 'share-reports';
const DEFAULT_RESULTS = 'allure-results';
const DEFAULT_PLAYWRIGHT = 'playwright-report';
const MARKER = '.reports-share-generated';
const PAYLOAD = 'qa-reports';
const OPTION_NAMES = new Set(['out', 'since', 'results', 'playwright']);
/** Repo folders `--out` may never be, or sit inside: sources, tests, tooling and the published `docs`. */
const PROTECTED_DIRS = ['.git', 'node_modules', 'tests', 'scripts', 'docs', '.context', '.agents', 'allure-results', 'playwright-report', 'allure-report'];
/** Allure metadata files kept whatever their date. */
const METADATA_FILES = new Set(['environment.properties', 'categories.json']);
const TEXT_FILE = /\.(?:json|txt|md|properties|csv|html|dat|js|xml)$/i;
/** `YYYY-MM-DD` or `YYYY-MM-DDTHH:MM`, local time: the time lets a cutoff fall right after a leak fix inside one day. */
const SINCE_FORMAT = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?$/;
const EMAIL = /[\w.%+-]+@([A-Z0-9-]+(?:\.[A-Z0-9-]+)+)/gi;
const USER_PATH = /[A-Z]:[\\/]+Users[\\/]+[^\\/"'\s]+/gi;
/** `fill` step titles with a quoted value of 8+ characters; the value is group 2. */
const FILL_VALUE = /fill\b[^"'`\n]{0,80}\\*(["'`])([^"'`\n\\]{8,})\\*\1/gi;
const AUTHORIZATION = /authorization\W{1,4}(?!bearer)\S{8,}/gi;
// Typed values that are generated test data, never credentials: the product's password rule needs upper + lower + digit, so a generated code (upper-case letters and digits only, or the lower-case form of an operator code), a `qa-sec.invalid` URL and a markup payload cannot be a password.
const ALLOWED_TYPED = /^(?:QAX|QA |\[correo\]@)|^[^\s@]+@[^\s@][^\s.@]*\.[^\s@]+$|^[A-Z0-9]{8,}$|^q[a-z0-9]{8}$|^https?:\/\/qa-sec\.invalid|^<(?:img|script|svg)\b/;
/** Value after a credential-like key (JSON-escaped quotes allowed); the value is group 1. Masked values (`***`, `[Function]`) and words are not secrets. */
const CREDENTIAL_VALUE = /(?:password|refresh_token|access_token|csrf)\w*(?:\\*["'])?\s*[=:]\s*(?:\\*["'])?([^\s"'\\,;}]+)/gi;
/** A real credential here has a letter AND a digit (the product requires upper + lower + digit): masks, prose, booleans and `name=value` attributes (`maxAge=900`, cookie flags) do not. */
const secretLike = (value: string): boolean => value.length >= 8 && /[A-Z]/i.test(value) && /\d/.test(value) && !/^[*[(]/.test(value) && !/^[A-Z-]+=/i.test(value);
/** The Playwright HTML reporter embeds its report as a base64 zip in a data URI; the base64 is group 2. */
const ZIP_PAYLOAD = /(data:application\/zip;base64,)([A-Za-z0-9+/=]+)/g;
/** GitHub's web upload caps a file at 25 MiB; warn a bit earlier. */
const ALLURE_WARN_BYTES = 24 * 1024 * 1024;
const SAFE_DOMAIN = /^example\.com$|\.(?:invalid|test|example|localhost)$/i;

class ShareError extends Error {}

const USAGE = `reports-share: prepare the Allure and Playwright reports to publish by hand (publishes nothing).

Usage:
  bun --no-env-file scripts/reports-share.ts [--out <dir>] [--since <YYYY-MM-DD[THH:MM]>] [--results <dir>] [--playwright <dir>]

  --out         output folder (default ${DEFAULT_OUT}); only an absent, empty or previously generated folder is replaced
  --since       keep only Allure results modified on or after this local date; without it the whole folder must scan clean
  --results     Allure results folder (default ${DEFAULT_RESULTS}), read-only
  --playwright  Playwright report folder (default ${DEFAULT_PLAYWRIGHT}), read-only
  --help        this text`;

// ============================================
// Arguments
// ============================================

/** Local time of a real `YYYY-MM-DD` (midnight) or `YYYY-MM-DDTHH:MM` value, or null when the text is not one. */
export function sinceDate(value: string): Date | null {
  const match = SINCE_FORMAT.exec(value);
  if (match === null) { return null; }
  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const [hour, minute] = match[4] === undefined ? [0, 0] : [Number(match[4]), Number(match[5])];
  const date = new Date(y, m - 1, d, hour, minute);
  return date.getFullYear() === y && date.getMonth() === m - 1 && date.getDate() === d && date.getHours() === hour && date.getMinutes() === minute ? date : null;
}

export function parseArgs(argv: string[]): Options {
  const opts: Options = { out: DEFAULT_OUT, since: null, results: DEFAULT_RESULTS, playwright: DEFAULT_PLAYWRIGHT, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') { opts.help = true; continue; }
    if (!arg.startsWith('--')) { throw new ShareError(`unexpected argument: ${arg}`); }
    const eq = arg.indexOf('=');
    const name = eq < 0 ? arg.slice(2) : arg.slice(2, eq);
    if (!OPTION_NAMES.has(name)) { throw new ShareError(`unknown option: --${name}`); }
    const value = eq < 0 ? argv[++i] : arg.slice(eq + 1);
    if (value === undefined || value === '' || value.startsWith('--')) { throw new ShareError(`--${name} needs a value`); }
    if (name === 'since' && sinceDate(value) === null) { throw new ShareError(`--since needs a real date as YYYY-MM-DD or YYYY-MM-DDTHH:MM, got ${value}`); }
    opts[name as 'out' | 'since' | 'results' | 'playwright'] = value;
  }
  return opts;
}

// ============================================
// --out guards
// ============================================

const inside = (child: string, parent: string): boolean => child === parent || child.startsWith(parent + sep);

/** Refuse any `out` that could clobber something that is not a previous reports-share build. */
export function checkOut(out: string, opts: Pick<Options, 'results' | 'playwright'>, deps: Pick<Deps, 'repoRoot' | 'checkIgnored'>): void {
  const repo = resolve(deps.repoRoot);
  const target = resolve(repo, out);
  if (out.trim() === '' || out.trim() === '.' || target === repo || inside(repo, target)) { throw new ShareError('--out may not be the repo root or one of its parents'); }
  if (parse(target).root === target) { throw new ShareError('--out may not be a filesystem root'); }
  if (inside(homedir(), target)) { throw new ShareError('--out may not be the user home folder or one of its parents'); }
  for (const name of PROTECTED_DIRS) {
    if (inside(target, join(repo, name))) { throw new ShareError(`--out may not be ${name} or a folder inside it`); }
  }
  for (const source of [opts.results, opts.playwright]) {
    const dir = resolve(repo, source);
    if (inside(target, dir) || inside(dir, target)) { throw new ShareError('--out may not contain a report source folder or sit inside one'); }
  }
  if (existsSync(target)) {
    if (!statSync(target).isDirectory()) { throw new ShareError('--out exists and is not a folder'); }
    if (readdirSync(target).length > 0 && !existsSync(join(target, MARKER))) { throw new ShareError(`--out is a non-empty folder without ${MARKER}: refusing to replace it`); }
  }
  // Ask about a file inside the folder: a directory-only rule such as "/share-reports/" never matches a folder that does not exist yet.
  if (inside(target, repo) && !deps.checkIgnored(join(target, MARKER), repo)) {
    throw new ShareError(`--out is inside the repo and git does not ignore it: add "/${relativePosix(repo, target)}/" to .gitignore`);
  }
}

/** Git's own answer for one path; any failure to ask counts as "not ignored" (fail closed). */
function gitIgnored(path: string, repoRoot: string): boolean {
  try { return Bun.spawnSync(['git', 'check-ignore', '-q', path], { cwd: repoRoot }).exitCode === 0; }
  catch { return false; }
}

// ============================================
// Staging
// ============================================

/** Copy the Allure result files into `dest` (flat or nested), filtered by `since`. The source is only read. */
export function stageResults(src: string, dest: string, since: Date | null): StageStats {
  const stats: StageStats = { copied: 0, excludedZips: 0, skippedOld: 0 };
  const walk = (dir: string, rel: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const from = join(dir, entry.name);
      const to = join(dest, rel, entry.name);
      if (entry.isDirectory()) { walk(from, join(rel, entry.name)); continue; }
      const info = lstatSync(from);
      if (!info.isFile()) { continue; }
      if (/\.zip$/i.test(entry.name)) { stats.excludedZips++; continue; }
      if (since !== null && !METADATA_FILES.has(entry.name) && info.mtime < since) { stats.skippedOld++; continue; }
      mkdirSync(dirname(to), { recursive: true });
      copyFileSync(from, to);
      stats.copied++;
    }
  };
  mkdirSync(dest, { recursive: true });
  walk(src, '');
  return stats;
}

// ============================================
// Scan and redaction
// ============================================

/** Length bucket and character classes of a value: enough to tune a detector, never the value. */
function shapeOf(value: string): string {
  const classes = [/[a-z]/.test(value) ? 'lower' : '', /[A-Z]/.test(value) ? 'upper' : '', /\d/.test(value) ? 'digit' : '', /[^A-Z0-9]/i.test(value) ? 'symbol' : ''].filter(Boolean);
  const len = value.length <= 12 ? '8-12' : value.length <= 20 ? '13-20' : '21+';
  return `len${len} ${classes.join('+')}`;
}

/**
 * Pattern name + count per detector; for typed values also the distinct shapes. Matches are never kept.
 * `bundle` is the static JS/CSS of the Playwright reporter shell (`index.html` around its embedded zip): its code is full of
 * `fill="..."` SVG attributes and `password` identifiers, so only the unambiguous detectors run on it; the report DATA (the zip) gets all of them.
 */
export function scanText(text: string, file = '', bundle = false): SecretHit[] {
  const hits: SecretHit[] = [];
  for (const { name, re } of SECRET_PATTERNS) {
    // The shared `credencial` pattern matches every key, including masked ones; it is replaced below by a value-aware check.
    if (name === 'credencial') { continue; }
    const count = text.match(re)?.length ?? 0;
    if (count > 0) { hits.push({ file, pattern: name, count }); }
  }
  const auth = text.match(AUTHORIZATION)?.length ?? 0;
  if (auth > 0) { hits.push({ file, pattern: 'authorization', count: auth }); }
  if (bundle) { return hits; }
  const credentials = [...text.matchAll(CREDENTIAL_VALUE)].filter(match => secretLike(match[1])).length;
  if (credentials > 0) { hits.push({ file, pattern: 'credencial', count: credentials }); }
  let typed = 0;
  const shapes = new Set<string>();
  for (const match of text.matchAll(FILL_VALUE)) {
    if (ALLOWED_TYPED.test(match[2])) { continue; }
    typed++;
    shapes.add(shapeOf(match[2]));
  }
  if (typed > 0) { hits.push({ file, pattern: 'typed-value', count: typed, shapes: [...shapes].sort() }); }
  return hits;
}

/** Text files under `dir`, as repo-stable relative paths. */
function textFiles(dir: string, rel = ''): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(join(dir, rel), { withFileTypes: true })) {
    const path = rel === '' ? entry.name : `${rel}/${entry.name}`;
    if (entry.isDirectory()) { files.push(...textFiles(dir, path)); }
    else if (TEXT_FILE.test(entry.name)) { files.push(path); }
  }
  return files.sort();
}

/** Scan every text file of a folder. latin1 keeps bytes intact; every detector is ASCII. */
export function scanDir(dir: string): SecretHit[] {
  return textFiles(dir).flatMap(file => scanText(readFileSync(join(dir, file), 'latin1'), file));
}

const safeDomain = (domain: string): boolean => SAFE_DOMAIN.test(domain);

const MARKDOWN_FILE = /\.md$/i;
const FILE_LINE_COLUMN = /(\.(?:ts|tsx|js|mjs|cjs|md|yaml|yml|json|jsonc|toml|html|sh|css)):(\d+)(?:-\d+)?(?::\d+)?\b/g;

/** `file.ts:13:3` to `file.ts (L13)` (ASCII on purpose: files are rewritten as latin1): the docs lint rejects the `path.ext:N` shape in a published .md. */
export function neutralizeFileLines(text: string): string {
  return text.replace(FILE_LINE_COLUMN, '$1 (L$2)');
}

/** `path.ext:N` citations left in a text; must be 0 for a published .md. */
export function leftoverFileLines(text: string): number {
  return text.match(FILE_LINE_PATTERN)?.length ?? 0;
}

/** Local part of an e-mail to `[correo]` (domain kept), then `C:\Users\<name>` to `<repo>`. Idempotent. */
export function redactText(text: string): Redaction {
  let emails = 0;
  let paths = 0;
  const withoutEmails = text.replace(EMAIL, (match, domain: string) => {
    if (safeDomain(domain)) { return match; }
    emails++;
    return `[correo]@${domain}`;
  });
  const redacted = withoutEmails.replace(USER_PATH, () => { paths++; return '<repo>'; });
  return { text: redacted, emails, paths };
}

/** E-mails whose domain is not a generated-test one: must be 0 after redaction. */
export function leftoverEmails(text: string): number {
  let count = 0;
  for (const match of text.matchAll(EMAIL)) { if (!safeDomain(match[1])) { count++; } }
  return count;
}

/** Redact every text file of a folder in place (the staging copy). */
export function redactDir(dir: string): { emails: number, paths: number } {
  const total = { emails: 0, paths: 0 };
  for (const file of textFiles(dir)) {
    const path = join(dir, file);
    const before = readFileSync(path, 'latin1');
    const { text, emails, paths } = redactText(before);
    total.emails += emails;
    total.paths += paths;
    if (text !== before) { writeFileSync(path, text, 'latin1'); }
  }
  return total;
}

// ============================================
// Minimal zip reader / writer (the Playwright report payload)
// ============================================

const CRC_TABLE = ((): Uint32Array => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) { c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; }
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(data: Uint8Array): number {
  let c = 0xFFFFFFFF;
  for (const byte of data) { c = CRC_TABLE[(c ^ byte) & 0xFF] ^ (c >>> 8); }
  return (c ^ 0xFFFFFFFF) >>> 0;
}

/** Read a zip (stored or deflated entries, no zip64). Any malformation throws: fail closed. */
export function readZip(buf: Buffer): ZipEntry[] {
  try {
    let eocd = -1;
    for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
      if (buf.readUInt32LE(i) === 0x06054B50) { eocd = i; break; }
    }
    if (eocd < 0) { throw new Error('no end of central directory'); }
    const count = buf.readUInt16LE(eocd + 10);
    const cdOffset = buf.readUInt32LE(eocd + 16);
    if (count === 0xFFFF || cdOffset === 0xFFFFFFFF) { throw new Error('zip64 is not supported'); }
    const entries: ZipEntry[] = [];
    let p = cdOffset;
    for (let i = 0; i < count; i++) {
      if (buf.readUInt32LE(p) !== 0x02014B50) { throw new Error('bad central directory entry'); }
      const method = buf.readUInt16LE(p + 10);
      const crc = buf.readUInt32LE(p + 16);
      const compressed = buf.readUInt32LE(p + 20);
      const size = buf.readUInt32LE(p + 24);
      const nameLen = buf.readUInt16LE(p + 28);
      const extraLen = buf.readUInt16LE(p + 30);
      const commentLen = buf.readUInt16LE(p + 32);
      const local = buf.readUInt32LE(p + 42);
      const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
      p += 46 + nameLen + extraLen + commentLen;
      if (buf.readUInt32LE(local) !== 0x04034B50) { throw new Error('bad local header'); }
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      if (start + compressed > buf.length) { throw new Error('entry runs past the end'); }
      const raw = buf.subarray(start, start + compressed);
      if (method !== 0 && method !== 8) { throw new Error(`unsupported method ${method}`); }
      const data = method === 0 ? Buffer.from(raw) : inflateRawSync(raw);
      if (data.length !== size || crc32(data) !== crc) { throw new Error('entry size or checksum mismatch'); }
      entries.push({ name, data });
    }
    return entries;
  }
  catch (e) { throw new ShareError(`Playwright report payload cannot be parsed (${(e as Error).message}); not publishing a report that cannot be inspected`); }
}

/** Write a deflated zip with fixed timestamps, so the same entries give the same bytes. */
export function writeZip(entries: ZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const body = deflateRawSync(data);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034B50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014B50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, body);
    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + body.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054B50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

const textEntry = (entry: ZipEntry): boolean => TEXT_FILE.test(entry.name);

/** Scan the text entries of a base64 zip payload: hits (shapes only) and surviving e-mails. */
export function inspectZipPayload(payload: string, file: string): { hits: SecretHit[], leftover: number } {
  const hits: SecretHit[] = [];
  let leftover = 0;
  for (const entry of readZip(Buffer.from(payload, 'base64')).filter(textEntry)) {
    const text = entry.data.toString('latin1');
    hits.push(...scanText(text, `${file}#${entry.name}`));
    leftover += leftoverEmails(text);
  }
  return { hits, leftover };
}

/** Redact the text entries of a base64 zip payload, re-pack, and verify by re-reading. Fails closed. */
export function redactZipPayload(payload: string): { payload: string, emails: number, paths: number } {
  let emails = 0;
  let paths = 0;
  const entries = readZip(Buffer.from(payload, 'base64')).map((entry) => {
    if (!textEntry(entry)) { return entry; }
    const result = redactText(entry.data.toString('latin1'));
    emails += result.emails;
    paths += result.paths;
    return { name: entry.name, data: Buffer.from(result.text, 'latin1') };
  });
  const rewritten = writeZip(entries).toString('base64');
  const check = inspectZipPayload(rewritten, 'payload');
  if (check.hits.length > 0 || check.leftover > 0) { throw new ShareError('the Playwright report payload still holds a finding after redaction; nothing written'); }
  return { payload: rewritten, emails, paths };
}

// ============================================
// Playwright report
// ============================================

/** Every file under `dir` as repo-stable relative paths. */
function allFiles(dir: string, rel = ''): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(join(dir, rel), { withFileTypes: true })) {
    const path = rel === '' ? entry.name : `${rel}/${entry.name}`;
    if (entry.isDirectory()) { files.push(...allFiles(dir, path)); }
    else if (entry.isFile()) { files.push(path); }
  }
  return files.sort();
}

/** Scan a copied Playwright report: plain text files plus the embedded zip of `index.html`. */
function scanPlaywright(dir: string): { hits: SecretHit[], leftover: number } {
  const hits: SecretHit[] = [];
  let leftover = 0;
  let payloads = 0;
  for (const file of textFiles(dir)) {
    const text = readFileSync(join(dir, file), 'latin1');
    let embedded = false;
    for (const match of text.matchAll(ZIP_PAYLOAD)) {
      embedded = true;
      if (file === 'index.html') { payloads++; }
      const inner = inspectZipPayload(match[2], file);
      hits.push(...inner.hits);
      leftover += inner.leftover;
    }
    const rest = text.replace(ZIP_PAYLOAD, '');
    hits.push(...scanText(rest, file, embedded));
    leftover += leftoverEmails(rest);
  }
  if (payloads === 0) { throw new ShareError('Playwright report index.html holds no embedded report payload; not publishing a report that cannot be inspected'); }
  return { hits, leftover };
}

/**
 * Copy the Playwright report into `dest`, scan it, redact it (embedded zip included) and verify.
 * `hits` non-empty means refuse: `dest` must then be discarded. The source is only read.
 */
export function preparePlaywright(src: string, dest: string): { hits: SecretHit[], stats: PlaywrightStats } {
  mkdirSync(dest, { recursive: true });
  const names = allFiles(src);
  for (const rel of names) {
    const to = join(dest, ...rel.split('/'));
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(join(src, ...rel.split('/')), to);
  }
  const first = scanPlaywright(dest);
  const stats: PlaywrightStats = { files: names.length, emails: 0, paths: 0 };
  if (first.hits.length > 0) { return { hits: first.hits, stats }; }
  for (const file of textFiles(dest)) {
    const path = join(dest, file);
    const before = readFileSync(path, 'latin1');
    const swapped = before.replace(ZIP_PAYLOAD, (_m, prefix: string, b64: string) => {
      const result = redactZipPayload(b64);
      stats.emails += result.emails;
      stats.paths += result.paths;
      return prefix + result.payload;
    });
    const redacted = redactText(swapped);
    stats.emails += redacted.emails;
    stats.paths += redacted.paths;
    const isMarkdown = MARKDOWN_FILE.test(file);
    const text = isMarkdown ? neutralizeFileLines(redacted.text) : redacted.text;
    if (isMarkdown && leftoverFileLines(text) > 0) { throw new ShareError(`the Playwright report file ${file} still holds a path:line citation; nothing written`); }
    if (text !== before) { writeFileSync(path, text, 'latin1'); }
  }
  const second = scanPlaywright(dest);
  if (second.hits.length > 0 || second.leftover > 0) { throw new ShareError('the Playwright report still holds a finding after redaction; nothing written'); }
  return { hits: [], stats };
}

// ============================================
// Allure single file
// ============================================

/** The real generator: `bunx allure`. Output is dropped so no report content reaches the log. */
function bunxAllure(args: string[], cwd: string): { code: number } {
  try { return { code: Bun.spawnSync(['bunx', 'allure', ...args], { cwd, stdout: 'ignore', stderr: 'ignore' }).exitCode ?? 1 }; }
  catch { return { code: 1 }; }
}

/** Report title: `<project_name> QA` from `.agents/project.yaml`, or plain `QA` when it is empty or unreadable. */
export function reportName(repoRoot: string): string {
  try {
    const yaml = readFileSync(join(repoRoot, '.agents', 'project.yaml'), 'utf8');
    const value = (/^\s*project_name:\s*([^#\r\n]+)/m.exec(yaml)?.[1] ?? '').trim().replace(/^["']|["']$/g, '');
    return value !== '' && value !== 'null' ? `${value} QA` : 'QA';
  }
  catch { return 'QA'; }
}

/**
 * Generate the single-file Allure report from the staged results with a temporary config
 * (no `historyPath`: history is neither read nor written). Returns the `index.html` bytes.
 */
export function generateAllure(staging: string, work: string, deps: Pick<Deps, 'runAllure' | 'repoRoot'>): Buffer {
  const config = join(work, 'allurerc.mjs');
  const output = join(work, 'out');
  const options = { name: reportName(deps.repoRoot), plugins: { awesome: { options: { singleFile: true, reportLanguage: 'es' } } } };
  writeFileSync(config, `export default ${JSON.stringify(options, null, 2)};\n`);
  const { code } = deps.runAllure(['generate', staging, '--config', config, '--output', output], deps.repoRoot);
  if (code !== 0) { throw new ShareError(`allure generate failed (exit ${code}); nothing written`); }
  const index = join(output, 'index.html');
  if (!existsSync(index)) { throw new ShareError('allure generate produced no index.html; nothing written'); }
  return readFileSync(index);
}

// ============================================
// LEEME
// ============================================

const dateOf = (now: Date): string => now.toISOString().slice(0, 10);
const windowText = (since: string | null): string => (since === null ? 'todos los resultados disponibles' : `los resultados desde el ${since}`);

/** Spanish publish instructions for the owner. */
export function buildLeeme(now: Date, since: string | null): string {
  return `# Reportes para compartir

Generado el ${dateOf(now)} por \`bun run reports:share\`. Este comando no publica, no sube y no hace push de nada: solo escribe esta carpeta, que git ignora.

Contenido del Allure: ${windowText(since)}. El reporte de Playwright es solo el de la última corrida.

## Cómo publicar a mano

1. Revisa las capturas de pantalla de \`qa-reports/\`: no se escanean y un correo visible en una imagen no se enmascara.
2. Copia la carpeta \`qa-reports/\` completa a \`docs/qa-reports/\` del repositorio. No copies este archivo ni \`${MARKER}\`.
3. Haz el commit y el push a mano.
4. En GitHub, en Settings > Pages, publica desde la rama principal y la carpeta \`/docs\`.
5. Las direcciones quedan como \`https://<usuario>.github.io/<repositorio>/qa-reports/allure/\` para Allure y \`https://<usuario>.github.io/<repositorio>/qa-reports/playwright/\` para Playwright..

## Advertencia: el repositorio es público

Todo lo que copies a \`docs/\` es visible para cualquiera, y el historial de git conserva lo publicado antes. El generador se detiene sin escribir nada si encuentra algo con forma de secreto, pero no cubre:

- Capturas de pantalla (PNG): no se leen.
- Archivos \`.zip\` de Allure: se excluyen y no se escanean.
- Un secreto sin forma conocida, o un valor escrito de menos de 8 caracteres.
- Nombres, teléfonos, nombres de tenant y URLs internas. Los dominios de correo quedan visibles.

Si el Allure pesa más de 25 MiB, la web de GitHub no lo deja subir: usa git push o un \`--since\` más reciente.
`;
}

// ============================================
// Output
// ============================================

/** Delete a marked output folder, retrying on Windows locks (open in a browser or Explorer). */
function removeOutput(target: string): void {
  try { rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 250 }); }
  catch (e) { throw new ShareError(`could not delete the previous output (${(e as NodeJS.ErrnoException).code ?? 'error'}); close anything that has it open and run again`); }
}

/** Build the whole tree in a temp sibling, then swap it in. A failure leaves the old output as it was. */
export function writeOutput(out: string, files: Map<string, string | Buffer>): void {
  const target = resolve(out);
  mkdirSync(dirname(target), { recursive: true });
  const temp = join(dirname(target), `.${basename(target)}.tmp-${process.pid}-${Date.now()}`);
  try {
    mkdirSync(temp, { recursive: true });
    writeFileSync(join(temp, MARKER), 'Generated by scripts/reports-share.ts. This folder is replaced on every run.\n');
    for (const [path, content] of files) {
      const file = join(temp, ...path.split('/'));
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, content);
    }
    if (existsSync(target)) { removeOutput(target); }
    renameSync(temp, target);
  }
  finally { rmSync(temp, { recursive: true, force: true }); }
}

// ============================================
// Entry
// ============================================

function requireFolder(path: string, label: string): void {
  if (!existsSync(path) || !statSync(path).isDirectory()) { throw new ShareError(`${label} folder not found: ${toPosix(path)}`); }
}

function logHits(hits: SecretHit[], log: (line: string) => void): void {
  for (const hit of hits) {
    const shapes = hit.shapes === undefined ? '' : ` shapes: ${hit.shapes.join(', ')}`;
    log(`x possible secret (${hit.pattern}) in ${hit.file}: ${hit.count} match(es)${shapes}`);
  }
  log('x nothing written; run "bun run test:clean" and a fresh test run, or pass a later --since');
}

/** Stage, scan, redact, re-scan and write. Returns the process exit code. */
export function run(argv: string[], deps: Partial<Deps> = {}): number {
  const log = deps.log ?? console.error;
  const full: Deps = { log, now: deps.now ?? (() => new Date()), checkIgnored: deps.checkIgnored ?? gitIgnored, runAllure: deps.runAllure ?? bunxAllure, repoRoot: deps.repoRoot ?? REPO_ROOT };
  const temps: string[] = [];
  const temp = (): string => { const dir = mkdtempSync(join(tmpdir(), 'reports-share-')); temps.push(dir); return dir; };
  try {
    const opts = parseArgs(argv);
    if (opts.help) { log(USAGE); return 0; }
    const results = resolve(full.repoRoot, opts.results);
    const playwright = resolve(full.repoRoot, opts.playwright);
    checkOut(opts.out, opts, full);
    requireFolder(results, 'Allure results');
    requireFolder(playwright, 'Playwright report');

    const staging = temp();
    const since = opts.since === null ? null : sinceDate(opts.since);
    const stats = stageResults(results, staging, since);
    const first = scanDir(staging);
    if (first.length > 0) { logHits(first, log); return 1; }

    const redacted = redactDir(staging);
    const second = scanDir(staging);
    const leftover = textFiles(staging).reduce((sum, file) => sum + leftoverEmails(readFileSync(join(staging, file), 'latin1')), 0);
    if (second.length > 0 || leftover > 0) {
      logHits(second, log);
      if (leftover > 0) { log(`x ${leftover} e-mail(s) survived the redaction`); }
      if (second.length === 0) { log('x nothing written'); }
      return 1;
    }

    const pwStage = temp();
    const pw = preparePlaywright(playwright, pwStage);
    if (pw.hits.length > 0) { logHits(pw.hits, log); return 1; }

    const allure = generateAllure(staging, temp(), full);
    if (allure.length >= ALLURE_WARN_BYTES) {
      log(`! Allure index.html is ${(allure.length / 1024 / 1024).toFixed(1)} MiB: GitHub web upload caps at 25 MiB; use git push or a later --since`);
    }

    const now = full.now();
    const files = new Map<string, string | Buffer>([
      ['LEEME.md', buildLeeme(now, opts.since)],
      [`${PAYLOAD}/allure/index.html`, allure],
    ]);
    for (const rel of allFiles(pwStage)) { files.set(`${PAYLOAD}/playwright/${rel}`, readFileSync(join(pwStage, ...rel.split('/')))); }
    writeOutput(opts.out, files);
    log(`+ staged ${stats.copied} files (${stats.excludedZips} zip excluded, ${stats.skippedOld} older than --since skipped), redacted ${redacted.emails} e-mails and ${redacted.paths} paths`);
    log(`+ playwright report: ${pw.stats.files} files, redacted ${pw.stats.emails} e-mails and ${pw.stats.paths} paths; allure: ${(allure.length / 1024 / 1024).toFixed(1)} MiB`);
    log(`+ output written to ${toPosix(opts.out)} (nothing published)`);
    return 0;
  }
  catch (error) {
    if (error instanceof ShareError) { log(`x ${error.message}`); return 1; }
    throw error;
  }
  finally { for (const dir of temps) { rmSync(dir, { recursive: true, force: true }); } }
}

if (import.meta.main) { process.exit(run(process.argv.slice(2))); }
