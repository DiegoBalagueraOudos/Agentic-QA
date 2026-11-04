/**
 * Tests for `scripts/reports-share.ts`, the report preparation tool. What they guard:
 *   1. Arguments and `--out` guards: defaults, bad `--since`, every refused target and
 *      every accepted one, a custom in-repo `--out` that git does not ignore.
 *   2. Staging: `--since` by mtime, metadata always kept, zips excluded and counted,
 *      the source tree byte-identical afterwards.
 *   3. Scan and redaction: each detector, shapes without values, e-mail and path
 *      rewrite (idempotent, JSON still parses), the double pass, and the rule that a
 *      refused run writes nothing and leaves an existing output untouched.
 *   4. Output: layout, Spanish landing page without scripts, byte-identical re-run, no
 *      secret value in the log or in any written file.
 * Every fixture lives in a temp directory created here; the real `allure-results/`
 * and `playwright-report/` are never read.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { buildLanding, buildLeeme, checkOut, crc32, leftoverEmails, leftoverFileLines, neutralizeFileLines, parseArgs, preparePlaywright, readZip, redactDir, redactText, redactZipPayload, reportName, run, scanDir, scanText, sinceDate, stageResults, writeZip } from './reports-share.ts';

// Built from parts so this file never holds a complete secret-shaped literal.
const SENTINEL = ['Zz9', 'Qq8', 'Ww7!'].join('');
const JWT = ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiJ4In0', 'c2lnbmF0dXJl'].join('.');
const NOW = new Date('2026-10-29T12:00:00Z');

let base: string;
let repo: string;
let results: string;
let printed: string[];
let ignored: boolean;
let allureCalls: string[][];
let allureCode: number;
let allureBytes: number;
const log = (line: string): void => { printed.push(line); };
/** Fake generator: records the call and, on success, writes the single-file report where `--output` points. */
const fakeAllure = (args: string[]): { code: number } => {
  allureCalls.push([...args, `config=${readFileSync(args[args.indexOf('--config') + 1], 'utf8')}`]);
  if (allureCode === 0) {
    const dir = args[args.indexOf('--output') + 1];
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'index.html'), Buffer.alloc(allureBytes, 'a'));
  }
  return { code: allureCode };
};
const deps = (): { log: typeof log, now: () => Date, checkIgnored: () => boolean, runAllure: typeof fakeAllure, repoRoot: string } => ({ log, now: () => NOW, checkIgnored: () => ignored, runAllure: fakeAllure, repoRoot: repo });

/** Synthetic Playwright report: `index.html` with an embedded base64 zip, as the real reporter lays it out. */
function payloadOf(report: string): string {
  return writeZip([{ name: 'report.json', data: Buffer.from(report, 'latin1') }, { name: 'shot.png', data: Buffer.from([1, 2, 3, 4]) }]).toString('base64');
}
function fakeReport(dir: string, report: string): void {
  put(join(dir, 'index.html'), `<html><body><script>window.playwrightReportBase64 = "data:application/zip;base64,${payloadOf(report)}";</script></body></html>`);
  put(join(dir, 'data', 'a.md'), 'step by admin@sistema.com');
  put(join(dir, 'data', 'b.png'), Buffer.from([137, 80, 78, 71]));
}
const CLEAN_REPORT = JSON.stringify({ steps: ['locator.fill("QAX-ok-01")'], who: 'admin@sistema.com', path: 'C:\\Users\\diego\\repo' });
const share = (...extra: string[]): number => run(['--out', join(base, 'out'), ...extra], deps());

function put(file: string, content: string | Buffer, mtime?: Date): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
  if (mtime !== undefined) { utimesSync(file, mtime, mtime); }
}

function walk(dir: string, prefix = ''): string[] {
  const names: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) { names.push(...walk(join(dir, entry.name), rel)); }
    else { names.push(rel); }
  }
  return names;
}

/** sha256 over every relative path and byte of a tree. */
function treeHash(dir: string): string {
  const hash = createHash('sha256');
  for (const rel of walk(dir)) { hash.update(rel).update(readFileSync(join(dir, ...rel.split('/')))); }
  return hash.digest('hex');
}

const OLD = new Date('2026-10-01T10:00:00');
const FRESH = new Date('2026-10-28T10:00:00');

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'reports-share-test-'));
  repo = join(base, 'repo');
  results = join(repo, 'allure-results');
  printed = [];
  ignored = true;
  allureCalls = [];
  allureCode = 0;
  allureBytes = 64;
  mkdirSync(results, { recursive: true });
  fakeReport(join(repo, 'playwright-report'), CLEAN_REPORT);
});

afterEach(() => { rmSync(base, { recursive: true, force: true }); });

describe('parseArgs', () => {
  it('defaults and both option forms', () => {
    expect(parseArgs([])).toMatchObject({ out: 'share-reports', since: null, results: 'allure-results', playwright: 'playwright-report', help: false });
    expect(parseArgs(['--out', 'x', '--since=2026-10-28']).since).toBe('2026-10-28');
    expect(parseArgs(['--help']).help).toBe(true);
  });

  it('rejects unknown options, stray arguments, missing values and bad dates', () => {
    expect(() => parseArgs(['--nope', 'x'])).toThrow();
    expect(() => parseArgs(['stray'])).toThrow();
    expect(() => parseArgs(['--out'])).toThrow();
    expect(() => parseArgs(['--since', '28-10-2026'])).toThrow();
    expect(() => parseArgs(['--since', '2026-02-30'])).toThrow();
    expect(sinceDate('2026-10-28')?.getDate()).toBe(28);
    expect(() => parseArgs(['--since', '2026-10-27T25:00'])).toThrow();
    expect(() => parseArgs(['--since', '2026-10-27T13:00'])).not.toThrow();
  });

  it('--since accepts a time of day: the cutoff can fall right after a leak fix inside one day', () => {
    const cutoff = sinceDate('2026-10-27T13:30');
    expect([cutoff?.getHours(), cutoff?.getMinutes()]).toEqual([13, 30]);
    expect(sinceDate('2026-10-27')?.getHours()).toBe(0);
    expect(sinceDate('2026-10-27T24:00')).toBeNull();
  });
});

describe('checkOut', () => {
  const check = (out: string): void => checkOut(out, { results: 'allure-results', playwright: 'playwright-report' }, deps());

  it('refuses the repo root, its parents, empty and dot', () => {
    for (const bad of [repo, base, dirname(base), '', '.']) { expect(() => check(bad)).toThrow(); }
  });

  it('refuses protected folders, the sources and anything inside them', () => {
    for (const name of ['.git', 'docs', 'scripts', 'tests', '.context', '.context/QA', 'docs/qa-reports', 'allure-results', 'playwright-report/data']) {
      expect(() => check(join(repo, name))).toThrow();
    }
  });

  it('refuses a folder that contains a source', () => {
    expect(() => checkOut(join(base, 'out'), { results: join(base, 'out', 'results'), playwright: 'playwright-report' }, deps())).toThrow();
  });

  it('refuses a file and a non-empty folder without the marker', () => {
    put(join(base, 'file'), 'x');
    expect(() => check(join(base, 'file'))).toThrow();
    put(join(base, 'full', 'keep.txt'), 'x');
    expect(() => check(join(base, 'full'))).toThrow();
  });

  it('accepts an absent, an empty and a marked folder', () => {
    check(join(base, 'absent'));
    mkdirSync(join(base, 'empty'));
    check(join(base, 'empty'));
    put(join(base, 'marked', '.reports-share-generated'), '');
    put(join(base, 'marked', 'old.txt'), 'x');
    check(join(base, 'marked'));
  });

  it('exits 1 when an in-repo out is not ignored by git, and passes when it is', () => {
    ignored = false;
    expect(() => check(join(repo, 'custom-out'))).toThrow(/gitignore/);
    ignored = true;
    check(join(repo, 'custom-out'));
  });
});

describe('stageResults', () => {
  it('copies only files on or after --since, keeps metadata, excludes and counts zips, leaves the source alone', () => {
    put(join(results, 'old-result.json'), '{"a":1}', OLD);
    put(join(results, 'new-result.json'), '{"b":2}', FRESH);
    put(join(results, 'environment.properties'), 'a=b', OLD);
    put(join(results, 'categories.json'), '[]', OLD);
    put(join(results, 'x-attachment.zip'), 'PK', FRESH);
    const before = treeHash(results);
    const dest = join(base, 'staging');
    const stats = stageResults(results, dest, sinceDate('2026-10-28'));
    expect(walk(dest)).toEqual(['categories.json', 'environment.properties', 'new-result.json']);
    expect(stats).toEqual({ copied: 3, excludedZips: 1, skippedOld: 1 });
    expect(treeHash(results)).toBe(before);
  });

  it('copies everything but zips without --since', () => {
    put(join(results, 'old-result.json'), '{}', OLD);
    put(join(results, 'a.zip'), 'PK', OLD);
    const dest = join(base, 'staging');
    expect(stageResults(results, dest, null)).toEqual({ copied: 1, excludedZips: 1, skippedOld: 0 });
  });
});

describe('scanText', () => {
  const names = (text: string): string[] => scanText(text).map(hit => hit.pattern);

  it('finds the shared secret shapes and an authorization value', () => {
    expect(names(`token ${JWT}`)).toContain('jwt');
    expect(names('Authorization: Bearer abcdefghijkl')).toContain('bearer');
    expect(names(`password: ${SENTINEL}`)).toContain('credencial');
    expect(names('authorization: abcdefghijklmnop')).toContain('authorization');
    expect(names('authorization: Bearer abcdefghijkl')).not.toContain('authorization');
  });

  it('typed values: e-mail, QAX..., "QA ..." and short values pass; others fail', () => {
    expect(names('getByLabel("Email").fill("someone@sistema.com")')).toEqual([]);
    expect(names('locator.fill("QAX-generated-01")')).toEqual([]);
    expect(names('Fill "QA Cliente Uno"')).toEqual([]);
    expect(names('locator.fill("short1!")')).toEqual([]);
    expect(names(`locator.fill("${SENTINEL}")`)).toEqual(['typed-value']);
    expect(names(`Fill \\"${SENTINEL}\\"`)).toEqual(['typed-value']);
  });

  it('credential keys: masks, functions and words are not secrets; a letter+digit value is', () => {
    expect(names('Password: "***" })')).toEqual([]);
    expect(names('{\\"Password\\":\\"***\\"}')).toEqual([]);
    expect(names('csrfToken: [Function]')).toEqual([]);
    expect(names('password === \'admin\'')).toEqual([]);
    expect(names('csrf_token: maxAge=900 path=/')).toEqual([]);
    expect(names(`{\\"password\\":\\"${SENTINEL}\\"}`)).toEqual(['credencial']);
    expect(names('password=Abcd1234')).toEqual(['credencial']);
  });

  it('generated data typed in forms is allowed: operator codes, qa-sec.invalid URLs and markup payloads', () => {
    expect(names('Fill "Q2HX1QNSX"')).toEqual([]);
    expect(names('Fill "QARCSXX7HZKE"')).toEqual([]);
    expect(names('Fill "q2hx1qnsx"')).toEqual([]);
    expect(names('Fill "https://qa-sec.invalid/abc123"')).toEqual([]);
    expect(names('Fill "<img src=x onerror=1>"')).toEqual([]);
    expect(names('Fill "Abcd1234Efgh"')).toEqual(['typed-value']);
  });

  it('reports shapes without any character of the value', () => {
    const [hit] = scanText(`locator.fill("${SENTINEL}")`, 'a.json');
    expect(hit).toMatchObject({ file: 'a.json', pattern: 'typed-value', count: 1, shapes: ['len8-12 lower+upper+digit+symbol'] });
    expect(JSON.stringify(hit)).not.toContain(SENTINEL);
  });
});

describe('redactText', () => {
  it('rewrites real e-mails and keeps generated-test domains', () => {
    const { text, emails } = redactText('a.b+c@sistema.com x@example.com y@z.invalid y@z.test y@z.example y@z.localhost');
    expect(text).toBe('[correo]@sistema.com x@example.com y@z.invalid y@z.test y@z.example y@z.localhost');
    expect(emails).toBe(1);
  });

  it('is idempotent', () => {
    const once = redactText('mail admin@sistema.com in C:\\Users\\diego\\repo').text;
    const twice = redactText(once);
    expect(twice.text).toBe(once);
    expect(twice.emails + twice.paths).toBe(0);
  });

  it('rewrites Windows user paths in plain, forward-slash and JSON-escaped forms and the JSON still parses', () => {
    const json = JSON.stringify({ a: 'C:\\Users\\diego\\repo\\x', b: 'C:/Users/diego/repo/y', c: 'admin@sistema.com' });
    const { text, paths } = redactText(json);
    expect(paths).toBe(2);
    expect(text).not.toMatch(/Users/);
    expect(JSON.parse(text)).toEqual({ a: '<repo>\\repo\\x', b: '<repo>/repo/y', c: '[correo]@sistema.com' });
  });

  it('leftoverEmails counts only non-generated domains', () => {
    expect(leftoverEmails('a@sistema.com b@example.com')).toBe(1);
    expect(leftoverEmails(redactText('a@sistema.com').text)).toBe(0);
  });
});

describe('run', () => {
  const out = (): string => join(base, 'out');
  const clean = (): void => { put(join(results, 'ok-result.json'), JSON.stringify({ name: 'Login', who: 'admin@sistema.com', path: 'C:\\Users\\diego\\repo' }), FRESH); };

  it('--help prints usage and exits 0; a bad option exits 1', () => {
    expect(run(['--help'], deps())).toBe(0);
    expect(run(['--bogus'], deps())).toBe(1);
  });

  it('exits 1 when a source folder is missing', () => {
    rmSync(results, { recursive: true });
    expect(share()).toBe(1);
    expect(existsSync(out())).toBe(false);
  });

  it('a clean run writes the layout, redacts counts into the log and leaves the staging gone', () => {
    clean();
    expect(share('--since', '2026-10-28')).toBe(0);
    expect(walk(out())).toEqual(['.reports-share-generated', 'LEEME.md', 'qa-reports/allure/index.html', 'qa-reports/index.html', 'qa-reports/playwright/data/a.md', 'qa-reports/playwright/data/b.png', 'qa-reports/playwright/index.html']);
    expect(printed.join('\n')).toContain('redacted 1 e-mails and 1 paths');
    expect(readdirSync(tmpdir()).filter(name => name.startsWith('reports-share-') && !name.includes('test'))).toEqual([]);
  });

  it('refuses without --since when a result holds a JWT, a password or a typed value', () => {
    for (const body of [`token ${JWT}`, `password: ${SENTINEL}`, `locator.fill("${SENTINEL}")`]) {
      put(join(results, 'bad-result.json'), body, FRESH);
      expect(share()).toBe(1);
      expect(existsSync(out())).toBe(false);
    }
    expect(printed.join('\n')).toContain('test:clean');
  });

  it('with --since an old dirty file is excluded, a new dirty file refuses', () => {
    clean();
    put(join(results, 'old-result.json'), `token ${JWT}`, OLD);
    expect(share('--since', '2026-10-28')).toBe(0);
    rmSync(out(), { recursive: true });
    put(join(results, 'new-result.json'), `token ${JWT}`, FRESH);
    expect(share('--since', '2026-10-28')).toBe(1);
    expect(existsSync(out())).toBe(false);
  });

  it('a refused run leaves an existing marked output byte-identical', () => {
    clean();
    expect(share()).toBe(0);
    const before = treeHash(out());
    put(join(results, 'bad-result.json'), `token ${JWT}`, FRESH);
    expect(share()).toBe(1);
    expect(treeHash(out())).toBe(before);
    expect(readdirSync(base).filter(name => name.startsWith('.out.tmp'))).toEqual([]);
  });

  it('never prints or writes a secret value', () => {
    clean();
    put(join(results, 'bad-result.json'), `password: ${SENTINEL} locator.fill("${SENTINEL}")`, FRESH);
    expect(share()).toBe(1);
    rmSync(join(results, 'bad-result.json'));
    expect(share()).toBe(0);
    expect(printed.join('\n')).not.toContain(SENTINEL);
    for (const rel of walk(out())) { expect(readFileSync(join(out(), ...rel.split('/')), 'utf8')).not.toContain(SENTINEL); }
  });

  it('a redacted staging copy passes the second pass with no leftover e-mail', () => {
    put(join(results, 'ok-result.json'), 'mail admin@sistema.com', FRESH);
    const staged = join(base, 'staging');
    stageResults(results, staged, null);
    redactDir(staged);
    expect(scanDir(staged)).toEqual([]);
    expect(leftoverEmails(readFileSync(join(staged, 'ok-result.json'), 'latin1'))).toBe(0);
  });

  it('an in-repo --out that git does not ignore exits 1 and writes nothing', () => {
    clean();
    ignored = false;
    expect(run(['--out', join(repo, 'custom-out')], deps())).toBe(1);
    expect(existsSync(join(repo, 'custom-out'))).toBe(false);
  });

  it('two runs with a fixed clock are byte-identical', () => {
    clean();
    expect(share()).toBe(0);
    const first = treeHash(out());
    expect(share()).toBe(0);
    expect(treeHash(out())).toBe(first);
  });
});

describe('Allure step', () => {
  const out = (): string => join(base, 'out');
  const clean = (): void => { put(join(results, 'ok-result.json'), '{"name":"Login"}', FRESH); };

  it('calls the injected runner with a temp config: single file, Spanish, no history', () => {
    clean();
    expect(share('--since', '2026-10-28')).toBe(0);
    expect(allureCalls).toHaveLength(1);
    const call = allureCalls[0];
    expect(call[0]).toBe('generate');
    expect(call).toContain('--config');
    expect(call).toContain('--output');
    const config = call[call.length - 1];
    expect(config).toContain('"singleFile": true');
    expect(config).toContain('"reportLanguage": "es"');
    expect(config).not.toMatch(/history/i);
    expect(readFileSync(join(out(), 'qa-reports', 'allure', 'index.html')).length).toBe(64);
  });

  it('a failing runner exits 1 and writes nothing', () => {
    clean();
    allureCode = 2;
    expect(share()).toBe(1);
    expect(existsSync(out())).toBe(false);
    expect(printed.join('\n')).toContain('allure generate failed');
  });

  it('a runner that produces no index.html exits 1 and writes nothing', () => {
    clean();
    const noOutput = deps();
    noOutput.runAllure = () => ({ code: 0 });
    expect(run(['--out', out()], noOutput)).toBe(1);
    expect(existsSync(out())).toBe(false);
  });

  it('warns from 24 MiB and not below', () => {
    clean();
    allureBytes = 24 * 1024 * 1024;
    expect(share()).toBe(0);
    expect(printed.join('\n')).toContain('25 MiB');
    printed = [];
    allureBytes = 1024;
    expect(share()).toBe(0);
    expect(printed.join('\n')).not.toContain('25 MiB');
  });
});

describe('zip reader and writer', () => {
  it('round-trips entries, including binary data', () => {
    const entries = [{ name: 'a.json', data: Buffer.from('{"x":1}') }, { name: 'b.bin', data: Buffer.from([0, 255, 7]) }];
    expect(readZip(writeZip(entries))).toEqual(entries);
  });

  it('reads a stored (method 0) zip built by hand', () => {
    const data = Buffer.from('hello');
    const name = Buffer.from('h.txt');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034B50, 0);
    local.writeUInt32LE(crc32(data), 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014B50, 0);
    central.writeUInt32LE(crc32(data), 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054B50, 0);
    end.writeUInt16LE(1, 8);
    end.writeUInt16LE(1, 10);
    end.writeUInt32LE(central.length + name.length, 12);
    end.writeUInt32LE(local.length + name.length + data.length, 16);
    const zip = Buffer.concat([local, name, data, central, name, end]);
    expect(readZip(zip)).toEqual([{ name: 'h.txt', data }]);
  });

  it('throws on garbage and on a corrupted entry', () => {
    expect(() => readZip(Buffer.from('not a zip at all, definitely'))).toThrow(/cannot be parsed/);
    const zip = writeZip([{ name: 'a.json', data: Buffer.from('{"x":1,"y":2,"z":3}') }]);
    zip[zip.indexOf(Buffer.from('a.json')) + 8] ^= 0xFF;
    expect(() => readZip(zip)).toThrow();
  });

  it('redactZipPayload rewrites e-mails and paths inside the zip and the result re-reads clean', () => {
    const result = redactZipPayload(payloadOf(CLEAN_REPORT));
    const [report, shot] = readZip(Buffer.from(result.payload, 'base64'));
    expect(result.emails).toBe(1);
    expect(result.paths).toBe(1);
    expect(report.data.toString('latin1')).toContain('[correo]@sistema.com');
    expect(report.data.toString('latin1')).not.toContain('diego');
    expect(shot.data).toEqual(Buffer.from([1, 2, 3, 4]));
  });
});

describe('Playwright step', () => {
  const out = (): string => join(base, 'out');
  const pwDir = (): string => join(repo, 'playwright-report');
  const clean = (): void => { put(join(results, 'ok-result.json'), '{"name":"Login"}', FRESH); };
  const innerReport = (file: string): string => {
    const html = readFileSync(file, 'utf8');
    const payload = /base64,([A-Za-z0-9+/=]+)/.exec(html)?.[1] ?? '';
    return readZip(Buffer.from(payload, 'base64'))[0].data.toString('latin1');
  };

  it('writes a redacted copy: zip content, text files and binaries', () => {
    clean();
    expect(share()).toBe(0);
    const base64Out = join(out(), 'qa-reports', 'playwright');
    expect(innerReport(join(base64Out, 'index.html'))).toContain('[correo]@sistema.com');
    expect(innerReport(join(base64Out, 'index.html'))).not.toContain('Users');
    expect(readFileSync(join(base64Out, 'data', 'a.md'), 'utf8')).toBe('step by [correo]@sistema.com');
    expect(readFileSync(join(base64Out, 'data', 'b.png'))).toEqual(Buffer.from([137, 80, 78, 71]));
  });

  it('leaves the source report untouched', () => {
    clean();
    const before = treeHash(pwDir());
    expect(share()).toBe(0);
    expect(treeHash(pwDir())).toBe(before);
  });

  it('a secret typed inside the zip refuses the run, prints shapes only and writes nothing', () => {
    clean();
    fakeReport(pwDir(), JSON.stringify({ steps: [`locator.fill("${SENTINEL}")`] }));
    expect(share()).toBe(1);
    expect(existsSync(out())).toBe(false);
    expect(printed.join('\n')).toContain('typed-value');
    expect(printed.join('\n')).not.toContain(SENTINEL);
    expect(allureCalls).toHaveLength(0);
  });

  it('a secret in a plain data file refuses the run', () => {
    clean();
    put(join(pwDir(), 'data', 'c.md'), `password: ${SENTINEL}`);
    expect(share()).toBe(1);
    expect(existsSync(out())).toBe(false);
  });

  it('fails closed when the payload is not a zip, or when index.html has none', () => {
    clean();
    put(join(pwDir(), 'index.html'), '<html>data:application/zip;base64,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA</html>');
    expect(share()).toBe(1);
    expect(printed.join('\n')).toContain('cannot be parsed');
    expect(existsSync(out())).toBe(false);
    put(join(pwDir(), 'index.html'), '<html>no payload here</html>');
    printed = [];
    expect(share()).toBe(1);
    expect(printed.join('\n')).toContain('no embedded report payload');
    expect(existsSync(out())).toBe(false);
  });

  it('rewrites path:line citations in published .md files, so the docs lint stays green', () => {
    clean();
    put(join(pwDir(), 'data', 'd.md'), '- Location: tests\\integration\\usr\\user-roles.test.ts:13:3\nrange foo.ts:4-9');
    expect(share()).toBe(0);
    const text = readFileSync(join(out(), 'qa-reports', 'playwright', 'data', 'd.md'), 'utf8');
    expect(text).toContain('user-roles.test.ts (L13)');
    expect(text).toContain('foo.ts (L4)');
    expect(leftoverFileLines(text)).toBe(0);
  });

  it('preparePlaywright is deterministic for the same input', () => {
    const a = join(base, 'pw-a');
    const b = join(base, 'pw-b');
    expect(preparePlaywright(pwDir(), a).hits).toEqual([]);
    expect(preparePlaywright(pwDir(), b).hits).toEqual([]);
    expect(treeHash(a)).toBe(treeHash(b));
  });
});

describe('reportName', () => {
  const projectYaml = (text: string): string => {
    const dir = mkdtempSync(join(tmpdir(), 'report-name-test-'));
    mkdirSync(join(dir, '.agents'), { recursive: true });
    writeFileSync(join(dir, '.agents', 'project.yaml'), text);
    return dir;
  };

  it('uses the project name from project.yaml, plain QA when it is empty, null or missing', () => {
    const named = projectYaml('project:\n  project_name: Acme Portal # the name\n');
    const empty = projectYaml('project:\n  project_name: null\n');
    const missing = mkdtempSync(join(tmpdir(), 'report-name-test-'));
    try {
      expect(reportName(named)).toBe('Acme Portal QA');
      expect(reportName(empty)).toBe('QA');
      expect(reportName(missing)).toBe('QA');
    }
    finally {
      for (const dir of [named, empty, missing]) { rmSync(dir, { recursive: true, force: true }); }
    }
  });
});

describe('neutralizeFileLines', () => {
  it('rewrites file:line and file:line:column, leaves other colons and is idempotent', () => {
    const once = neutralizeFileLines('a.test.ts:13:3 and b.md:2-5, time 10:30, url http://x:8080');
    expect(once).toBe('a.test.ts (L13) and b.md (L2), time 10:30, url http://x:8080');
    expect(neutralizeFileLines(once)).toBe(once);
    expect(leftoverFileLines(once)).toBe(0);
  });
});

describe('landing page and LEEME', () => {
  it('landing has a meta description (docs lint)', () => {
    expect(buildLanding(NOW, null)).toContain('<meta name="description"');
  });

  it('landing is Spanish, dated from the injected clock, has relative links and no script', () => {
    const html = buildLanding(NOW, '2026-10-28');
    expect(html).not.toMatch(/<script/i);
    expect(html).toContain('lang="es"');
    expect(html).toContain('2026-10-29');
    expect(html).toContain('href="allure/index.html"');
    expect(html).toContain('href="playwright/index.html"');
    expect(html).toContain('desde el 2026-10-28');
  });

  it('LEEME gives the publish steps and the public warning', () => {
    const text = buildLeeme(NOW, null);
    expect(text).toContain('docs/qa-reports/');
    expect(text).toContain('público');
    expect(text).toContain('todos los resultados');
    expect(text).toContain('/qa-reports/');
  });
});
