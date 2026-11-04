#!/usr/bin/env bun
/**
 * qa-wiki.ts — build a local folder of Markdown pages (an Azure DevOps CODE wiki
 * layout) from the local QA store under `.context/QA/`, so the owner can read the
 * reports on this machine before deciding what to publish. It publishes, pushes
 * and uploads NOTHING, makes no network call and reads no environment variable.
 *
 * Output (default `qa-wiki/`, gitignored):
 *   .qa-wiki-generated   marker: the generator only ever deletes a folder that holds it
 *   .order, Home.md, Casos.md, Corridas.md, Bugs.md, Reportes.md  (+ one folder each)
 *   .attachments/bugs/<bug id>/<image>
 * Every page name is ASCII `[A-Za-z0-9_-]` (Azure page-name rules) and every link is
 * relative. Page content is Spanish; the output has no clock, so two runs over the
 * same store are byte-identical.
 *
 * Safety (each point has a test in scripts/qa-wiki.test.ts):
 *   1. Whitelist reads: case files, `runs/<run>/run.json` (fallback `run.md`),
 *      `bugs/<bug>/report.md`, `.png|.jpg|.jpeg` directly inside a bug folder, the
 *      results file and `package.json`. Nothing else is listed or opened.
 *   2. Every generated TEXT page is scanned with the `qa:local bug check` secret
 *      patterns. A hit exits 1 naming file, pattern and count (never the match) and
 *      writes or deletes NOTHING.
 *   3. `--out` may not be the repo root, the QA root, a parent of either, a folder
 *      inside the QA root, or an existing non-empty folder without the marker.
 *   4. The QA store is read-only here: no write call targets it.
 *
 * `serve` previews that folder on 127.0.0.1 only (never another interface): the left tree
 * follows the `.order` files, tables, images and Mermaid pie charts are drawn offline by
 * scripts/lib/qa-wiki-render.ts, every page carries a Content-Security-Policy with no
 * script at all, and only .md, .png, .jpg and .jpeg files of the folder are ever served.
 * The preview is approximate: raw HTML (for example `<details>`) is shown escaped and
 * Mermaid types other than `pie` are shown as source.
 *
 * Usage:
 *   bun scripts/qa-wiki.ts [build] [--root <dir>] [--out <dir>] [--results <file>]
 *   bun scripts/qa-wiki.ts serve [--dir <dir>] [--port <n>] [--page <Page.md>] [--no-open]
 *
 * Exit codes: 0 ok (or --help, or a stopped server), 1 on any refusal.
 */

import { spawn } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { relativePosix, toPosix } from './lib/posix-path.ts';
import { escapeHtml, renderMarkdown } from './lib/qa-wiki-render.ts';
import { loadBugs, loadCases, SECRET_PATTERNS } from './qa-local.ts';

// ============================================
// Types and constants
// ============================================

type QaCase = ReturnType<typeof loadCases>['cases'][number];
type FmValue = QaCase['fm'][string];
type Page = string | Buffer;

export interface RunResult { id: string, result: string, executions: string }
export interface RunData {
  name: string
  date: string
  scope: string
  accept: boolean
  accepted: string[]
  results: RunResult[]
  /** Body of `run.md` (without its `Fuente:` line) when `run.json` is missing or unreadable. */
  fallback: string | null
}
export interface BugData { id: string, report: QaCase, images: { name: string, data: Buffer }[] }
export interface AtcSummary { generatedAt: string, total: string, passed: string, failed: string, skipped: string, executions: string }
export interface Store {
  cases: QaCase[]
  runs: RunData[]
  bugs: BugData[]
  summary: AtcSummary | null
  scripts: string[]
  warnings: string[]
  /** Base URL where the shareable reports are published (`--reports-url`); null = not published yet. */
  reportsUrl?: string | null
  /** Link to the SharePoint folder or file where the zipped reports are stored (`--sharepoint-url`). */
  sharepointUrl?: string | null
  /** Module name per prefix, from `<qa-root>/prefijos.md`. */
  prefixMeaning?: Record<string, string>
}
export interface Options {
  command: 'build' | 'serve'
  root: string
  out: string
  results: string
  dir: string
  port: number
  page: string
  reportsUrl: string | null
  sharepointUrl: string | null
  noOpen: boolean
  help: boolean
}
export interface SecretHit { file: string, pattern: string, count: number }

const REPO_ROOT = join(import.meta.dir, '..');
const DEFAULT_ROOT = '.context/QA';
const DEFAULT_OUT = 'qa-wiki';
const DEFAULT_RESULTS = 'reports/atc_results.json';
const DEFAULT_PORT = 4174;
const PORT_ATTEMPTS = 20;
const DEFAULT_PAGE = 'Home.md';
const MARKER = '.qa-wiki-generated';
const MAX_PAGE_BYTES = 18 * 1024 * 1024;
const MAX_IMAGE_BYTES = 19 * 1024 * 1024;
const MAX_PATH_CHARS = 235;
const IMAGE_NAME = /^[A-Z0-9][\w.-]*\.(?:png|jpe?g)$/i;
const BUILD_OPTIONS = new Set(['root', 'out', 'results', 'reports-url', 'sharepoint-url']);
const SERVE_OPTIONS = new Set(['dir', 'port', 'page']);
const IMAGE_TYPES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' };
const CSP = 'default-src \'none\'; img-src \'self\'; style-src \'unsafe-inline\'; base-uri \'none\'; form-action \'none\'; frame-ancestors \'none\'';
const SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy': CSP,
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
};
const RESULT_ORDER = ['PASS', 'FAIL', 'SKIP', 'EXPECTED_FAIL', 'UNEXPECTED_PASS'];
const STATE_ORDER = ['pendiente', 'en_automatizacion', 'automatizado'];

class WikiError extends Error {}

const USAGE = `qa-wiki: build a local Markdown wiki folder from the QA store (publishes nothing).

Usage:
  bun scripts/qa-wiki.ts [build] [--root <dir>] [--out <dir>] [--results <file>] [--reports-url <https url>] [--sharepoint-url <https url>]
  bun scripts/qa-wiki.ts serve [--dir <dir>] [--port <n>] [--page <Page.md>] [--no-open]

build:
  --root     QA store (default ${DEFAULT_ROOT}), read-only
  --out      output folder (default ${DEFAULT_OUT}); only an absent, empty or previously generated folder is replaced
  --results  Playwright ATC summary (default ${DEFAULT_RESULTS})
  --reports-url  https base URL where the shared reports are published; adds direct links to the Reportes page
  --sharepoint-url  https link to the SharePoint folder with the zipped reports; adds a download section to Reportes

serve (preview on 127.0.0.1 only; approximate: raw HTML is shown escaped, only pie charts are drawn):
  --dir      folder to preview (default ${DEFAULT_OUT})
  --port     first port to try (default ${DEFAULT_PORT}; the next ${PORT_ATTEMPTS - 1} are tried when busy)
  --page     page to open (default ${DEFAULT_PAGE})
  --no-open  do not open the browser

  --help     this text`;

// ============================================
// Arguments
// ============================================

export function parseArgs(argv: string[]): Options {
  const opts: Options = { command: 'build', root: DEFAULT_ROOT, out: DEFAULT_OUT, results: DEFAULT_RESULTS, dir: DEFAULT_OUT, port: DEFAULT_PORT, page: DEFAULT_PAGE, reportsUrl: null, sharepointUrl: null, noOpen: false, help: false };
  const args = [...argv];
  if (args[0] === 'build' || args[0] === 'serve') { opts.command = args.shift() as Options['command']; }
  const allowed = opts.command === 'serve' ? SERVE_OPTIONS : BUILD_OPTIONS;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') { opts.help = true; continue; }
    if (opts.command === 'serve' && arg === '--no-open') { opts.noOpen = true; continue; }
    if (!arg.startsWith('--')) { throw new WikiError(`unexpected argument: ${arg}`); }
    const eq = arg.indexOf('=');
    const name = eq < 0 ? arg.slice(2) : arg.slice(2, eq);
    if (!allowed.has(name)) { throw new WikiError(`unknown option: --${name}`); }
    const value = eq < 0 ? args[++i] : arg.slice(eq + 1);
    if (value === undefined || value === '' || value.startsWith('--')) { throw new WikiError(`--${name} needs a value`); }
    if (name === 'port') {
      const port = Number(value);
      if (!/^\d+$/.test(value) || port < 1 || port > 65535) { throw new WikiError(`--port needs an integer between 1 and 65535, got ${value}`); }
      opts.port = port;
    }
    else if (name === 'page') {
      const page = toPosix(value).replace(/^\/+/, '');
      if (!page.endsWith('.md') || page.split('/').some(part => part === '' || part === '..' || part === '.')) { throw new WikiError('--page needs a relative .md page path inside the wiki, for example Home.md'); }
      opts.page = page;
    }
    else if (name === 'reports-url') {
      if (!/^https:\/\/[^\s@?#]+$/.test(value)) { throw new WikiError('--reports-url needs an https URL without credentials, query or fragment, for example https://user.github.io/repo/qa-reports'); }
      opts.reportsUrl = value.replace(/\/+$/, '');
    }
    else if (name === 'sharepoint-url') {
      if (!/^https:\/\/[^\s@]+$/.test(value)) { throw new WikiError('--sharepoint-url needs an https URL without credentials or spaces'); }
      opts.sharepointUrl = value;
    }
    else { opts[name as 'root' | 'out' | 'results' | 'dir'] = value; }
  }
  return opts;
}

// ============================================
// Small helpers
// ============================================

const str = (value: FmValue | undefined): string => (value === undefined || value === null || typeof value === 'object' ? '' : String(value));
const eolless = (line: string): string => line.replace(/\r?\n$/, '');
const byName = (a: string, b: string): number => a.localeCompare(b, 'en', { numeric: true });
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Azure page names: ASCII `[A-Za-z0-9_-]`, no leading/trailing dash, unique inside one folder. */
function pageName(raw: string, used: Set<string>): string {
  const base = raw.replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '') || 'sin-nombre';
  let name = base;
  for (let n = 2; used.has(name); n++) { name = `${base}-${n}`; }
  used.add(name);
  return name;
}

/** One table cell: single line, pipe escaped, optionally truncated. */
function cell(raw: string, max = 0): string {
  let value = raw.replace(/\s+/g, ' ').trim();
  if (max > 0 && value.length > max) { value = `${value.slice(0, max - 1).trimEnd()}…`; }
  return value.replace(/\|/g, '\\|');
}

function table(headers: string[], rows: string[][]): string {
  const lines = [`| ${headers.join(' | ')} |`, `| ${headers.map(() => '---').join(' | ')} |`];
  for (const row of rows) { lines.push(`| ${row.join(' | ')} |`); }
  return lines.join('\n');
}

function tally(values: string[], order: string[]): [string, number][] {
  const counts = new Map<string, number>();
  for (const value of values) { counts.set(value, (counts.get(value) ?? 0) + 1); }
  const rank = (label: string): number => (order.includes(label) ? order.indexOf(label) : order.length);
  return [...counts.entries()].sort((a, b) => rank(a[0]) - rank(b[0]) || byName(a[0], b[0]));
}

/** Mermaid pie block (Azure renders ` ```mermaid `). Zero slices are left out. */
function pie(title: string, slices: [string, number][]): string {
  const body = slices.filter(([, n]) => n > 0).map(([label, n]) => `    "${label.replace(/"/g, '')}" : ${n}`);
  return ['```mermaid', `pie title ${title}`, ...body, '```'].join('\n');
}

/** Relative link between two generated pages (paths relative to the output root). */
const linkTo = (from: string, to: string): string => relativePosix(dirname(from), to);
const mdLink = (label: string, from: string, to: string): string => `[${label}](${linkTo(from, to)})`;

const caseIdOfBug = (bug: BugData): string => {
  const declared = str(bug.report.fm.case);
  if (declared !== '') { return declared; }
  return /^(.+)-BUG-\d+$/.exec(bug.id)?.[1] ?? '';
};

function scenarioOf(c: QaCase): string {
  const lines = c.lines.slice(c.fmEnd + 1).map(eolless);
  const start = lines.findIndex(line => /^##\s+Escenario\b/i.test(line));
  if (start < 0) { return ''; }
  const body: string[] = [];
  for (let i = start + 1; i < lines.length && !/^##\s/.test(lines[i]); i++) { body.push(lines[i]); }
  return body.join(' ');
}

const lastRunOf = (c: QaCase): { date: string, result: string } => {
  const run = c.fm.last_run;
  const map = isRecord(run) ? (run as Record<string, FmValue>) : {};
  return { date: str(map.date), result: str(map.result) };
};

// ============================================
// Store: whitelisted reads
// ============================================

function fileSize(file: string): number | null {
  try {
    const stat = lstatSync(file);
    return stat.isFile() ? stat.size : null;
  }
  catch { return null; }
}

function readText(file: string): string | null {
  return fileSize(file) === null ? null : readFileSync(file, 'utf8');
}

function readRuns(root: string, warnings: string[]): RunData[] {
  const base = join(root, 'runs');
  if (!existsSync(base)) { return []; }
  const runs: RunData[] = [];
  const entries = readdirSync(base, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name).sort(byName);
  for (const name of entries) {
    const dir = join(base, name);
    const dateFromName = /^\d{4}-\d{2}-\d{2}/.exec(name)?.[0] ?? '';
    let data: unknown = null;
    const json = readText(join(dir, 'run.json'));
    if (json !== null) {
      try { data = JSON.parse(json); }
      catch { warnings.push(`run.json unreadable, using run.md: runs/${name}`); }
    }
    if (isRecord(data)) {
      const results = Array.isArray(data.results) ? data.results.filter(isRecord).filter(r => typeof r.id === 'string') : [];
      runs.push({
        name,
        date: typeof data.date === 'string' ? data.date : dateFromName,
        scope: typeof data.scope === 'string' ? data.scope : '',
        accept: data.accept === true,
        accepted: Array.isArray(data.accepted) ? data.accepted.filter((id): id is string => typeof id === 'string') : [],
        results: results.map(r => ({
          id: String(r.id),
          result: typeof r.result === 'string' ? r.result : '',
          executions: Array.isArray(r.executions) ? String(r.executions.length) : typeof r.executions === 'number' ? String(r.executions) : '',
        })),
        fallback: null,
      });
      continue;
    }
    const md = readText(join(dir, 'run.md'));
    if (md === null) { warnings.push(`run without run.json or run.md skipped: runs/${name}`); continue; }
    const body = md.split(/\r?\n/).filter(line => !/^[\s*_>-]*Fuente[\s*_]*:/i.test(line)).join('\n');
    runs.push({ name, date: dateFromName, scope: '', accept: false, accepted: [], results: [], fallback: body });
  }
  return runs.sort((a, b) => byName(b.date, a.date) || byName(b.name, a.name));
}

function readBugs(root: string, warnings: string[]): BugData[] {
  const bugs: BugData[] = [];
  for (const bug of loadBugs(root)) {
    if (bug.report === null) { warnings.push(`bug without report.md skipped: ${bug.id}`); continue; }
    const images: BugData['images'] = [];
    const entries = readdirSync(bug.dir, { withFileTypes: true }).sort((a, b) => byName(a.name, b.name));
    for (const entry of entries) {
      if (entry.name === 'report.md') { continue; }
      const file = join(bug.dir, entry.name);
      if (!entry.isFile() || !IMAGE_NAME.test(entry.name)) { warnings.push(`file skipped (not a plain image): bugs/${bug.id}/${entry.name}`); continue; }
      if ((fileSize(file) ?? 0) > MAX_IMAGE_BYTES) { warnings.push(`image over 19 MB skipped: bugs/${bug.id}/${entry.name}`); continue; }
      images.push({ name: entry.name, data: readFileSync(file) });
    }
    bugs.push({ id: bug.id, report: bug.report, images });
  }
  return bugs;
}

function readSummary(file: string, warnings: string[]): AtcSummary | null {
  const raw = readText(file);
  if (raw === null) { warnings.push('results file not found: the Reportes page will say so'); return null; }
  try {
    const data: unknown = JSON.parse(raw);
    const summary = isRecord(data) && isRecord(data.summary) ? data.summary : {};
    const field = (key: string): string => (typeof summary[key] === 'number' ? String(summary[key]) : '-');
    return {
      generatedAt: isRecord(data) && typeof data.generatedAt === 'string' ? data.generatedAt : '',
      total: field('total'),
      passed: field('passed'),
      failed: field('failed'),
      skipped: field('skipped'),
      executions: field('executions'),
    };
  }
  catch {
    warnings.push('results file unreadable, ignored');
    return null;
  }
}

/** `<qa-root>/prefijos.md`: the Markdown table `Prefijo | Modulo | Alcance` that test-case-generation-local keeps. Absent file = no names. */
function readPrefixMeaning(root: string): Record<string, string> {
  const meaning: Record<string, string> = {};
  const raw = readText(join(root, 'prefijos.md'));
  if (raw === null) { return meaning; }
  for (const line of raw.split(/\r?\n/)) {
    const cells = line.split('|').map(cell => cell.trim());
    if (cells.length < 4) { continue; }
    const [, prefix, module] = cells;
    if (/^[A-Z][A-Z0-9]{1,5}$/.test(prefix) && module !== '') { meaning[prefix] = module; }
  }
  return meaning;
}

function readScripts(file: string): string[] {
  const raw = readText(file);
  if (raw === null) { return []; }
  try {
    const data: unknown = JSON.parse(raw);
    return isRecord(data) && isRecord(data.scripts) ? Object.keys(data.scripts) : [];
  }
  catch { return []; }
}

/** The only place that touches the disk for input. Everything it opens is named in the header. */
export function readStore(opts: { root: string, results: string, packageJson?: string, reportsUrl?: string | null, sharepointUrl?: string | null }): Store {
  const warnings: string[] = [];
  const { cases, unreadable } = loadCases(opts.root);
  for (const file of unreadable) { warnings.push(`case without frontmatter skipped: ${toPosix(file).split('/').slice(-2).join('/')}`); }
  cases.sort((a, b) => byName(a.prefix, b.prefix) || byName(a.id, b.id));
  return {
    cases,
    runs: readRuns(opts.root, warnings),
    bugs: readBugs(opts.root, warnings),
    summary: readSummary(opts.results, warnings),
    scripts: readScripts(opts.packageJson ?? join(REPO_ROOT, 'package.json')),
    warnings,
    reportsUrl: opts.reportsUrl ?? null,
    sharepointUrl: opts.sharepointUrl ?? null,
    prefixMeaning: readPrefixMeaning(opts.root),
  };
}

// ============================================
// Pages
// ============================================

const asLf = (text: string): string => `${text.replace(/\r\n?/g, '\n').replace(/\n+$/, '')}\n`;

function latestDate(store: Store): string {
  const dates = [
    ...store.cases.map(c => lastRunOf(c).date),
    ...store.runs.map(r => r.date),
    ...store.bugs.map(b => str(b.report.fm.found_on)),
    store.summary?.generatedAt.slice(0, 10) ?? '',
  ].filter(d => /^\d{4}-\d{2}-\d{2}/.test(d)).map(d => d.slice(0, 10));
  return dates.sort().at(-1) ?? '';
}

interface Names {
  prefixes: Map<string, string>
  runs: Map<string, string>
  bugs: Map<string, string>
  bugsByCase: Map<string, string[]>
  casePrefix: Map<string, string>
}

function assignNames(store: Store): Names {
  const prefixes = new Map<string, string>();
  const used = new Set<string>();
  for (const c of store.cases) { if (!prefixes.has(c.prefix)) { prefixes.set(c.prefix, pageName(c.prefix, used)); } }
  const runUsed = new Set<string>();
  const runs = new Map(store.runs.map(r => [r.name, pageName(r.name, runUsed)]));
  const bugUsed = new Set<string>();
  const bugs = new Map(store.bugs.map(b => [b.id, pageName(b.id, bugUsed)]));
  const bugsByCase = new Map<string, string[]>();
  for (const bug of store.bugs) {
    const caseId = caseIdOfBug(bug);
    bugsByCase.set(caseId, [...(bugsByCase.get(caseId) ?? []), bug.id]);
  }
  const casePrefix = new Map(store.cases.map(c => [c.id, c.prefix]));
  return { prefixes, runs, bugs, bugsByCase, casePrefix };
}

/** Bug ids tied to a case: by the bug's own `case`, or by the case's `id_defecto` naming a bug folder. */
function bugsOf(c: QaCase, names: Names): string[] {
  const ids = new Set(names.bugsByCase.get(c.id) ?? []);
  const declared = str(c.fm.id_defecto);
  if (declared !== '' && names.bugs.has(declared)) { ids.add(declared); }
  return [...ids].sort(byName);
}

const bugLinks = (ids: string[], from: string, names: Names): string => (
  ids.map(id => mdLink(id, from, `Bugs/${names.bugs.get(id)}.md`)).join(', ') || '-'
);

function homePage(store: Store, names: Names): string {
  const file = 'Home.md';
  const prefixes = [...names.prefixes.keys()];
  const rows = prefixes.map((prefix) => {
    const group = store.cases.filter(c => c.prefix === prefix);
    const count = (key: string, token: string): number => group.filter(c => str(c.fm[key]) === token).length;
    const results = (token: string): number => group.filter(c => lastRunOf(c).result === token).length;
    const failWithBug = group.filter(c => lastRunOf(c).result === 'FAIL' && (bugsOf(c, names).length > 0 || c.fm.defecto_conocido === true)).length;
    const lastRun = group.map(c => lastRunOf(c).date).filter(d => d !== '').sort().at(-1) ?? '-';
    return [
      mdLink(prefix, file, `Casos/${names.prefixes.get(prefix)}.md`),
      String(group.length),
      String(count('estado_automatizacion', 'pendiente')),
      String(count('estado_automatizacion', 'en_automatizacion')),
      String(count('estado_automatizacion', 'automatizado')),
      String(count('automatizacion', 'manual')),
      String(count('automatizacion', 'deferred')),
      String(count('automatizacion', 'no_aplica')),
      String(results('PASS')),
      String(failWithBug),
      String(results('EXPECTED_FAIL')),
      lastRun,
    ];
  });
  const states = tally(store.cases.map(c => str(c.fm.estado_automatizacion) || 'sin_estado'), STATE_ORDER);
  const outcomes = tally(store.cases.map(c => lastRunOf(c).result || 'SIN_CORRIDA'), RESULT_ORDER);
  const openBugs = store.bugs.filter(b => str(b.report.fm.status) === 'open');
  const bugRows = openBugs.map(b => [
    mdLink(b.id, file, `Bugs/${names.bugs.get(b.id)}.md`),
    cell(caseIdOfBug(b)),
    cell(str(b.report.fm.severity)),
    cell(str(b.report.fm.title), 120),
  ]);
  const recent = store.runs.slice(0, 5).map(r => `- ${mdLink(r.name, file, `Corridas/${names.runs.get(r.name)}.md`)}${r.date ? ` (${r.date})` : ''}`);
  const parts = [
    '# Home',
    '> Vista previa local, no publicado.',
    `Datos al: ${latestDate(store) || 'sin datos'}`,
    `Casos: ${store.cases.length} en ${prefixes.length} prefijos. Bugs: ${store.bugs.length}. Corridas: ${store.runs.length}.`,
    `Reportes interactivos: ${mdLink('ver la página de Reportes', file, 'Reportes.md')}`,
    '## Casos por prefijo',
    table(['Prefijo', 'Casos', 'Pendiente', 'En automatización', 'Automatizado', 'Manual', 'Deferred', 'No aplica', 'PASS', 'FAIL con defecto', 'EXPECTED_FAIL', 'Última corrida'], rows),
    '## Estado de automatización',
    pie('Estado de automatización', states),
    '## Últimos resultados',
    pie('Último resultado por caso', outcomes),
    '## Bugs abiertos',
    bugRows.length > 0 ? table(['Bug', 'Caso', 'Severidad', 'Título'], bugRows) : 'Sin bugs abiertos.',
    '## Últimas corridas',
    recent.length > 0 ? recent.join('\n') : 'Sin corridas.',
  ];
  return parts.join('\n\n');
}

function casesIndexPage(store: Store, names: Names): string {
  const file = 'Casos.md';
  const rows = [...names.prefixes.entries()].map(([prefix, name]) => [
    mdLink(store.prefixMeaning?.[prefix] != null ? `${prefix}: ${store.prefixMeaning[prefix]}` : prefix, file, `Casos/${name}.md`),
    String(store.cases.filter(c => c.prefix === prefix).length),
  ]);
  return ['# Casos', rows.length > 0 ? table(['Prefijo', 'Casos'], rows) : 'Sin casos.'].join('\n\n');
}

function casePage(store: Store, names: Names, prefix: string): string {
  const file = `Casos/${names.prefixes.get(prefix)}.md`;
  const rows = store.cases.filter(c => c.prefix === prefix).map((c) => {
    const last = lastRunOf(c);
    return [
      cell(c.id),
      cell(scenarioOf(c), 160),
      cell(str(c.fm.prioridad)),
      cell(str(c.fm.estado_automatizacion)),
      cell(last.result ? `${last.result}${last.date ? ` (${last.date})` : ''}` : '-'),
      bugLinks(bugsOf(c, names), file, names),
    ];
  });
  return [`# ${prefix}`, table(['Caso', 'Escenario', 'Prioridad', 'Automatización', 'Último resultado', 'Bug'], rows)].join('\n\n');
}

function runsIndexPage(store: Store, names: Names): string {
  const file = 'Corridas.md';
  const rows = store.runs.map(r => [mdLink(r.name, file, `Corridas/${names.runs.get(r.name)}.md`), r.date || '-', cell(r.scope) || '-']);
  return ['# Corridas', rows.length > 0 ? table(['Corrida', 'Fecha', 'Alcance'], rows) : 'Sin corridas.'].join('\n\n');
}

function runPage(store: Store, names: Names, run: RunData): string {
  const file = `Corridas/${names.runs.get(run.name)}.md`;
  if (run.fallback !== null) { return `# Corrida ${run.name}\n\n${run.fallback}`; }
  const caseById = new Map(store.cases.map(c => [c.id, c]));
  const rows = run.results.map((r) => {
    const c = caseById.get(r.id);
    const id = c ? mdLink(r.id, file, `Casos/${names.prefixes.get(c.prefix)}.md`) : cell(r.id);
    return [id, cell(r.result), cell(r.executions) || '-', c ? bugLinks(bugsOf(c, names), file, names) : '-'];
  });
  return [
    `# Corrida ${run.name}`,
    table(['Campo', 'Valor'], [['Alcance', cell(run.scope) || '-'], ['Fecha', run.date || '-'], ['Aceptada', run.accept ? 'Sí' : 'No']]),
    `Casos aceptados: ${run.accepted.length > 0 ? run.accepted.map(id => `\`${id}\``).join(', ') : 'ninguno'}`,
    '## Resultados',
    rows.length > 0 ? table(['Caso', 'Resultado', 'Ejecuciones', 'Bug'], rows) : 'Sin resultados.',
  ].join('\n\n');
}

function bugsIndexPage(store: Store, names: Names): string {
  const file = 'Bugs.md';
  const rows = store.bugs.map(b => [
    mdLink(b.id, file, `Bugs/${names.bugs.get(b.id)}.md`),
    cell(caseIdOfBug(b)),
    cell(str(b.report.fm.severity)),
    cell(str(b.report.fm.status)),
    cell(str(b.report.fm.title), 120),
  ]);
  return ['# Bugs', rows.length > 0 ? table(['Bug', 'Caso', 'Severidad', 'Estado', 'Título'], rows) : 'Sin bugs.'].join('\n\n');
}

const BUG_FIELDS: [string, string][] = [
  ['id', 'ID'],
  ['case', 'Caso'],
  ['title', 'Título'],
  ['type', 'Tipo'],
  ['severity', 'Severidad'],
  ['priority', 'Prioridad'],
  ['error_type', 'Tipo de error'],
  ['environment', 'Ambiente'],
  ['status', 'Estado'],
  ['found_by', 'Encontrado por'],
  ['found_on', 'Fecha'],
  ['visual', 'Visual'],
  ['evidence', 'Evidencia'],
];

function bugPage(names: Names, bug: BugData): string {
  const name = names.bugs.get(bug.id) as string;
  const kept = new Set(bug.images.map(image => image.name));
  const rows: string[][] = [];
  for (const [key, label] of BUG_FIELDS) {
    const raw = bug.report.fm[key];
    if (raw === undefined) { continue; }
    const value = Array.isArray(raw) ? raw.map(item => str(item)).join(', ') : str(raw);
    rows.push([label, value.includes('@') ? '(omitido)' : cell(value) || '-']);
  }
  const body = bug.report.lines.slice(bug.report.fmEnd + 1).map(eolless).join('\n').replace(/^\n+/, '');
  const rewritten = body.replace(/(!?\[[^\]]*\]\()([^)\s]+)(\))/g, (whole, open: string, target: string, close: string) => (
    kept.has(target) ? `${open}../.attachments/bugs/${name}/${target}${close}` : whole
  ));
  return [`# ${bug.id}`, table(['Campo', 'Valor'], rows), rewritten].join('\n\n');
}

function reportsPage(store: Store): string {
  const wanted: [string, string][] = [
    ['allure:generate', 'genera el reporte Allure estático a partir de los resultados'],
    ['allure:open', 'abre el reporte Allure generado'],
    ['test:report', 'abre el reporte HTML de Playwright'],
    ['reports:share', 'prepara Allure y Playwright para compartir, con correos, rutas y credenciales redactados'],
  ];
  const commands = wanted.filter(([name]) => store.scripts.includes(name)).map(([name, what]) => `- \`bun run ${name}\`: ${what}`);
  const summary = store.summary
    ? table(['Campo', 'Valor'], [
        ['Generado', store.summary.generatedAt || '-'],
        ['Casos (ATC)', store.summary.total],
        ['Pasaron', store.summary.passed],
        ['Fallaron', store.summary.failed],
        ['Omitidos', store.summary.skipped],
        ['Ejecuciones', store.summary.executions],
      ])
    : 'Sin resultados de ejecución disponibles.';
  const url = store.reportsUrl ?? null;
  const links = url === null
    ? []
    : [
        '## Abrir los reportes',
        [
          `- [Portada de los reportes](${url}/)`,
          `- [Reporte Allure](${url}/allure/index.html)`,
          `- [Reporte Playwright](${url}/playwright/index.html)`,
        ].join('\n'),
      ];
  const download = store.sharepointUrl
    ? [
        '## Descargar desde SharePoint',
        [
          `- [Descargar los reportes (.zip) desde SharePoint](${store.sharepointUrl})`,
          '- SharePoint no muestra estos reportes en el navegador: descarga el `.zip`, descomprímelo y abre `index.html` en tu equipo.',
        ].join('\n'),
      ]
    : [];
  const publish = store.scripts.includes('reports:share')
    ? [
        '## Cómo publicarlos',
        [
          '1. `bun run reports:share --since <fecha>`: prepara el paquete en `share-reports/qa-reports/`.',
          '2. Copia `share-reports/qa-reports/` a `docs/qa-reports/` del repositorio.',
          '3. Haz commit y `git push`; con GitHub Pages activo sobre `/docs` quedan publicados.',
          '4. Regenera esta wiki con `bun run qa:wiki --reports-url <URL base de los reportes>` para que los enlaces apunten ahí.',
        ].join('\n'),
      ]
    : [];
  return [
    '# Reportes',
    url === null
      ? 'Los reportes interactivos se producen en la máquina de quien ejecuta las pruebas. Esta wiki no los incluye.'
      : 'Los reportes interactivos están publicados fuera de esta wiki. Ábrelos directamente desde estos enlaces.',
    ...links,
    ...download,
    '## Cómo producirlos',
    commands.length > 0 ? commands.join('\n') : 'Sin comandos de reporte disponibles.',
    ...publish,
    '## Últimos resultados de ejecución',
    'Resumen de la última ejecución registrada; puede cubrir solo una parte de las pruebas.',
    summary,
    ...(url === null
      ? ['## Enlace a los reportes interactivos', '> ENLACE PENDIENTE: decisión del dueño (adjunto comprimido, hosting estático o ninguno). Nada en esta wiki apunta a un reporte que no exista.']
      : []),
  ].join('\n\n');
}

/** Pure: store in, `path -> content` out. Paths are relative to the output folder and `/`-separated. */
export function buildWiki(store: Store): Map<string, Page> {
  const names = assignNames(store);
  const pages = new Map<string, Page>();
  const put = (path: string, text: string): void => { pages.set(path, asLf(text)); };
  const order = (dir: string, entries: string[]): void => {
    if (entries.length > 0) { put(`${dir}.order`, entries.join('\n')); }
  };

  put('Home.md', homePage(store, names));
  put('Casos.md', casesIndexPage(store, names));
  put('Corridas.md', runsIndexPage(store, names));
  put('Bugs.md', bugsIndexPage(store, names));
  put('Reportes.md', reportsPage(store));
  order('', ['Home', 'Casos', 'Corridas', 'Bugs', 'Reportes']);

  for (const [prefix, name] of names.prefixes) { put(`Casos/${name}.md`, casePage(store, names, prefix)); }
  order('Casos/', [...names.prefixes.values()]);

  for (const run of store.runs) { put(`Corridas/${names.runs.get(run.name)}.md`, runPage(store, names, run)); }
  order('Corridas/', store.runs.map(run => names.runs.get(run.name) as string));

  for (const bug of store.bugs) {
    const name = names.bugs.get(bug.id) as string;
    put(`Bugs/${name}.md`, bugPage(names, bug));
    for (const image of bug.images) { pages.set(`.attachments/bugs/${name}/${image.name}`, image.data); }
  }
  order('Bugs/', store.bugs.map(bug => names.bugs.get(bug.id) as string));

  for (const [path, content] of pages) {
    if (path.length > MAX_PATH_CHARS) { throw new WikiError(`page path over ${MAX_PATH_CHARS} characters: ${path.slice(0, 60)}...`); }
    if (typeof content === 'string' && Buffer.byteLength(content) > MAX_PAGE_BYTES) { throw new WikiError(`page over 18 MB: ${path}`); }
  }
  return pages;
}

// ============================================
// Secret scan and write
// ============================================

/** Pattern name + count per text page; the matched text is never kept. */
export function scanPages(pages: Map<string, Page>): SecretHit[] {
  const hits: SecretHit[] = [];
  for (const [file, content] of pages) {
    if (typeof content !== 'string') { continue; }
    for (const { name, re } of SECRET_PATTERNS) {
      const count = content.match(re)?.length ?? 0;
      if (count > 0) { hits.push({ file, pattern: name, count }); }
    }
  }
  return hits;
}

const inside = (child: string, parent: string): boolean => child === parent || child.startsWith(parent + sep);

/** Refuse any `out` that could clobber something that is not a previous wiki build. */
export function checkOutDir(out: string, root: string, repoRoot: string): void {
  const target = resolve(out);
  const qa = resolve(root);
  const repo = resolve(repoRoot);
  if (target === repo || inside(repo, target)) { throw new WikiError('--out may not be the repo root or one of its parents'); }
  if (inside(target, qa) || inside(qa, target)) { throw new WikiError('--out may not be the QA root, a parent of it or a folder inside it'); }
  if (!existsSync(target)) { return; }
  if (!statSync(target).isDirectory()) { throw new WikiError('--out exists and is not a folder'); }
  if (readdirSync(target).length === 0) { return; }
  if (fileSize(join(target, MARKER)) === null) { throw new WikiError(`--out is a non-empty folder without ${MARKER}: refusing to replace it`); }
}

/** Replace the output folder with the pages. Only a missing, empty or marked folder is ever deleted. */
export function writeWiki(out: string, pages: Map<string, Page>): void {
  const target = resolve(out);
  if (existsSync(target)) { rmSync(target, { recursive: true, force: true }); }
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, MARKER), 'Generated by scripts/qa-wiki.ts. This folder is replaced on every run.\n');
  for (const [path, content] of pages) {
    const file = join(target, ...path.split('/'));
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
}

// ============================================
// Preview server
// ============================================

interface TreeNode { name: string, page: string | null, children: TreeNode[] }

/** Names listed in a folder's `.order` file (one per line); empty when it is missing. */
function readOrder(dir: string): string[] {
  const raw = readText(join(dir, '.order'));
  return raw === null ? [] : raw.split(/\r?\n/).map(line => line.trim()).filter(line => /^[\w-]+$/.test(line));
}

/** Tree from the `.order` files: a page `X.md` and a folder `X/` share the node `X`. */
function buildTree(dir: string, prefix = ''): TreeNode[] {
  return readOrder(dir).map((name) => {
    const sub = join(dir, name);
    const isDir = existsSync(sub) && lstatSync(sub).isDirectory();
    return {
      name,
      page: fileSize(join(dir, `${name}.md`)) !== null ? `${prefix}${name}.md` : null,
      children: isDir ? buildTree(sub, `${prefix}${name}/`) : [],
    };
  }).filter(node => node.page !== null || node.children.length > 0);
}

const routeOf = (page: string): string => `/${page.split('/').map(encodeURIComponent).join('/')}`;

function renderTree(nodes: TreeNode[], current: string): string {
  if (nodes.length === 0) { return ''; }
  const items = nodes.map((node) => {
    const label = escapeHtml(node.name.replace(/-/g, ' '));
    const head = node.page === null
      ? `<span>${label}</span>`
      : `<a href="${routeOf(node.page)}"${node.page === current ? ' aria-current="page"' : ''}>${label}</a>`;
    return `<li>${head}${renderTree(node.children, current)}</li>`;
  });
  return `<ul>${items.join('')}</ul>`;
}

const SHELL_STYLE = `:root{color-scheme:light dark;--bg:#fff;--fg:#1f2328;--mut:#59636e;--line:#d1d9e0;--soft:#f6f8fa;--link:#0969da}
@media (prefers-color-scheme:dark){:root{--bg:#0d1117;--fg:#e6edf3;--mut:#9198a1;--line:#3d444d;--soft:#151b23;--link:#4493f8}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.55 system-ui,sans-serif}
.banner{padding:6px 16px;background:var(--soft);border-bottom:1px solid var(--line);color:var(--mut);font-size:13px}
.layout{display:flex;align-items:flex-start}nav{width:260px;flex:none;padding:12px 8px 24px 16px;border-right:1px solid var(--line);min-height:calc(100vh - 32px)}
nav ul{list-style:none;margin:0;padding-left:14px}nav>ul{padding-left:0}nav li{margin:2px 0}nav a{color:var(--fg);text-decoration:none}nav a:hover{text-decoration:underline}
nav a[aria-current]{color:var(--link);font-weight:600}nav span{color:var(--mut)}
main{flex:1;min-width:0;max-width:1100px;padding:16px 24px 48px}a{color:var(--link)}
table{border-collapse:collapse;display:block;overflow-x:auto;max-width:100%}th,td{border:1px solid var(--line);padding:4px 10px;text-align:left;vertical-align:top}th{background:var(--soft)}
pre{background:var(--soft);padding:12px;overflow-x:auto;border-radius:6px}code{background:var(--soft);padding:1px 4px;border-radius:4px}pre code{padding:0}
blockquote{margin:12px 0;padding:2px 14px;border-left:4px solid var(--line);color:var(--mut)}img{max-width:100%}
.chart{margin:12px 0}.note,.img-missing{color:var(--mut);font-size:13px}
@media (max-width:760px){.layout{flex-direction:column}nav{width:100%;border-right:0;border-bottom:1px solid var(--line);min-height:0}}`;

function pageResponse(title: string, tree: string, body: string, head: boolean): Response {
  const html = `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${SHELL_STYLE}</style>
</head>
<body>
<div class="banner">Vista previa local, no publicado. Aproximada: Azure DevOps puede mostrar algunas cosas distinto. La página de inicio es Home.</div>
<div class="layout">
<nav aria-label="Páginas">${tree}</nav>
<main>
${body}
</main>
</div>
</body>
</html>
`;
  return new Response(head ? null : html, { headers: { 'Content-Type': 'text/html; charset=utf-8', ...SECURITY_HEADERS } });
}

/** Plain 404 that echoes nothing from the request. */
const notFound = (): Response => new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8', ...SECURITY_HEADERS } });

/**
 * Request handler for a generated wiki folder. Exported so tests can call it with plain
 * `Request` objects, no socket. Serves only GET/HEAD of `.md` pages (rendered) and
 * `.png|.jpg|.jpeg` files; a dot-segment other than `.attachments`, a symlink, a path
 * that resolves outside the folder and any other file type is a 404.
 */
export function createWikiHandler(dir: string): (req: Request) => Response {
  const base = resolve(dir);
  return (req: Request): Response => {
    if (req.method !== 'GET' && req.method !== 'HEAD') { return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, HEAD', ...SECURITY_HEADERS } }); }
    const head = req.method === 'HEAD';
    const url = new URL(req.url);
    // Against DNS rebinding: a loopback server only answers for loopback host names.
    if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') { return new Response('Forbidden', { status: 403, headers: SECURITY_HEADERS }); }
    let path: string;
    try { path = decodeURIComponent(url.pathname); }
    catch { return new Response('Bad request', { status: 400, headers: SECURITY_HEADERS }); }
    if (path.includes('\0') || path.includes('\\')) { return notFound(); }
    const rel = path === '/' || path === '' ? DEFAULT_PAGE : path.replace(/^\/+/, '');
    const parts = rel.split('/');
    if (parts.some(part => part === '' || part === '.' || part === '..' || (part.startsWith('.') && part !== '.attachments'))) { return notFound(); }
    const ext = extname(rel).toLowerCase();
    const image = IMAGE_TYPES[ext];
    if (ext !== '.md' && image === undefined) { return notFound(); }
    const file = resolve(base, ...parts);
    if (!file.startsWith(base + sep) || fileSize(file) === null) { return notFound(); }
    if (image !== undefined) {
      return new Response(head ? null : readFileSync(file), { headers: { 'Content-Type': image, ...SECURITY_HEADERS } });
    }
    const body = renderMarkdown(readFileSync(file, 'utf8'), { page: rel });
    return pageResponse(`${rel.replace(/\.md$/, '')} - QA wiki`, renderTree(buildTree(base), rel), body, head);
  };
}

function openInBrowser(url: string, log: (line: string) => void): void {
  let command: string;
  let args: string[];
  if (process.platform === 'darwin') { command = 'open'; args = [url]; }
  // `start` is a cmd.exe builtin; the empty "" is the window title argument.
  else if (process.platform === 'win32') { command = 'cmd'; args = ['/c', 'start', '', url]; }
  else { command = 'xdg-open'; args = [url]; }
  try {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' });
    child.on('error', (e) => { log(`! could not open the browser (${command}): ${e.message}. Open ${url} manually.`); });
    child.unref();
  }
  catch (e) { log(`! could not open the browser (${command}): ${(e as Error).message}. Open ${url} manually.`); }
}

/** Bind 127.0.0.1 only, on `port` or the next free one (same scan as scripts/docs-serve.ts). */
export function listen(port: number, fetch: (req: Request) => Response): ReturnType<typeof Bun.serve> {
  let lastError: Error | null = null;
  for (let candidate = port; candidate < port + PORT_ATTEMPTS && candidate <= 65535; candidate++) {
    try { return Bun.serve({ hostname: '127.0.0.1', port: candidate, fetch }); }
    catch (e) {
      lastError = e as Error;
      if (!/EADDRINUSE|address already in use|in use/i.test(lastError.message)) { throw lastError; }
    }
  }
  throw new WikiError(`no free port between ${port} and ${port + PORT_ATTEMPTS - 1} (${lastError?.message ?? 'unknown'})`);
}

/** Start the preview. The caller owns the returned server and must stop it. */
export function startServe(opts: Options, log: (line: string) => void = console.error): ReturnType<typeof Bun.serve> {
  const dir = resolve(opts.dir);
  if (!existsSync(dir) || !statSync(dir).isDirectory() || fileSize(join(dir, ...opts.page.split('/'))) === null) {
    throw new WikiError(`nothing to preview at ${toPosix(opts.dir)} (no ${opts.page}): run "bun run qa:wiki" first`);
  }
  const server = listen(opts.port, createWikiHandler(dir));
  const url = `http://127.0.0.1:${server.port}${routeOf(opts.page)}`;
  if (server.port !== opts.port) { log(`! port ${opts.port} was busy, using ${server.port}`); }
  log(`+ previewing ${toPosix(opts.dir)} on ${url} (local only, Ctrl+C to stop)`);
  if (!opts.noOpen) { openInBrowser(url, log); }
  return server;
}

// ============================================
// Entry
// ============================================

/** Build the wiki, or start the preview. Returns the process exit code (0 with a live server for `serve`). */
export function run(argv: string[], log: (line: string) => void = console.error, repoRoot: string = REPO_ROOT): number {
  try {
    const opts = parseArgs(argv);
    if (opts.help) { log(USAGE); return 0; }
    if (opts.command === 'serve') {
      const server = startServe(opts, log);
      const stop = (): void => { void server.stop(); process.exit(0); };
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
      return 0;
    }
    if (!existsSync(opts.root) || !statSync(opts.root).isDirectory()) { throw new WikiError(`QA root not found: ${toPosix(opts.root)}`); }
    checkOutDir(opts.out, opts.root, repoRoot);
    const store = readStore({ root: opts.root, results: opts.results, packageJson: join(repoRoot, 'package.json'), reportsUrl: opts.reportsUrl, sharepointUrl: opts.sharepointUrl });
    for (const warning of store.warnings) { log(`! ${warning}`); }
    const pages = buildWiki(store);
    const hits = scanPages(pages);
    if (hits.length > 0) {
      for (const hit of hits) { log(`x possible secret (${hit.pattern}) in ${hit.file}: ${hit.count} match(es)`); }
      log('x nothing written; fix the source reports and run again');
      return 1;
    }
    writeWiki(opts.out, pages);
    const images = [...pages.keys()].filter(path => path.startsWith('.attachments/')).length;
    log(`+ wiki written to ${toPosix(opts.out)}: ${pages.size - images} text files, ${images} images (nothing published)`);
    return 0;
  }
  catch (error) {
    if (error instanceof WikiError) { log(`x ${error.message}`); return 1; }
    throw error;
  }
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const code = run(argv);
  // A running preview keeps the process alive; every other path ends here.
  if (code !== 0 || argv[0] !== 'serve' || argv.includes('--help') || argv.includes('-h')) { process.exit(code); }
}
