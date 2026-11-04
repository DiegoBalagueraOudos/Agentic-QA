/**
 * Tests for `scripts/qa-wiki.ts`, the local QA wiki generator. What they guard:
 *   1. Model and pages: the five page kinds, `.order` files that list exactly the
 *      pages of their folder, relative links that all resolve to a generated file,
 *      images copied, escaped pipes, Mermaid pie totals equal to the case total.
 *   2. Safety: whitelist-only reads (decoys never reach the output), the secret scan
 *      (exit 1, names file and count, never the value, writes and deletes nothing),
 *      the `--out` guards, a read-only source tree, byte-identical re-runs, the
 *      `run.md` fallback without its `Fuente:` line.
 *   3. Preview: the `serve` handler (called with plain `Request`s) renders pages with
 *      the tree in `.order` order, serves only md/png/jpg, refuses traversal, dot files
 *      and foreign hosts, sends a CSP with no script, and binds 127.0.0.1 only.
 * Every fixture lives in a temp directory created here; the real `.context/QA` is
 * never read.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, posix } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { buildWiki, createWikiHandler, listen, parseArgs, readStore, run, scanPages, startServe } from './qa-wiki.ts';

const REPO_ROOT = join(import.meta.dir, '..');
const PNG = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 1, 2, 3]);

let base: string;
let root: string;
let out: string;
let resultsFile: string;
let printed: string[];
const log = (line: string): void => { printed.push(line); };
const generate = (...extra: string[]): number => run(['--root', root, '--out', out, '--results', resultsFile, ...extra], log);

function put(file: string, content: string | Buffer): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

function writeCase(id: string, extra: Record<string, string> = {}, scenario = 'Escenario simple'): void {
  const fm: Record<string, string> = {
    id: `"${id}"`,
    prioridad: '"A"',
    tipo: '"P"',
    ola: '1',
    automatizacion: 'candidate',
    estado_automatizacion: 'pendiente',
    ...extra,
  };
  const lines = Object.entries(fm).map(([k, v]) => `${k}: ${v}`);
  put(join(root, 'cases', id.split('-')[0], `${id}.md`), `---\n${lines.join('\n')}\n---\n\n# ${id}\n\n## Escenario\n\n${scenario}\n\n## Pasos\n\nirrelevante\n`);
}

function writeBug(id: string, caseId: string, status: string, body = 'Descripcion del bug.'): void {
  put(join(root, 'bugs', id, 'report.md'), `---\nid: ${id}\ncase: ${caseId}\ntitle: "Titulo de ${id}"\nseverity: Major\nstatus: ${status}\nfound_on: 2026-10-02\n---\n\n# ${id}\n\n${body}\n`);
}

function seed(): void {
  writeCase('AUT-001', { estado_automatizacion: 'automatizado', last_run: '{date: "2026-10-01", result: "PASS", run: "2026-10-01-smoke"}' });
  writeCase('AUT-002', { last_run: '{date: "2026-10-02", result: "FAIL", run: "2026-10-02-full"}', id_defecto: '"AUT-002-BUG-2"' }, 'Valida a | b en el formulario');
  writeCase('LOG-001', { automatizacion: 'manual', estado_automatizacion: 'pendiente' });
  writeCase('API-001', { estado_automatizacion: 'en_automatizacion' });
  put(join(root, 'runs', '2026-10-01-smoke', 'run.json'), JSON.stringify({
    run: '2026-10-01-smoke',
    date: '2026-10-01',
    scope: 'smoke',
    source: 'C:\\Users\\Someone\\proyecto\\reports\\atc_results.json',
    accept: false,
    accepted: [],
    results: [{ id: 'AUT-001', result: 'PASS', raw: 'PASSED', executions: 1 }],
  }));
  put(join(root, 'runs', '2026-10-02-full', 'run.md'), '# Corrida full\n\nFuente: C:\\Users\\Someone\\proyecto\\reports\\atc_results.json\n\n| Caso | Resultado |\n| --- | --- |\n| AUT-002 | FAIL |\n');
  writeBug('AUT-001-BUG-1', 'AUT-001', 'fixed', 'Se ve asi:\n\n![failure](AUT-001-BUG-1-failure.png)\n\n[Captura](AUT-001-BUG-1-failure.png)');
  put(join(root, 'bugs', 'AUT-001-BUG-1', 'AUT-001-BUG-1-failure.png'), PNG);
  writeBug('AUT-002-BUG-2', 'AUT-002', 'open');
  put(resultsFile, JSON.stringify({ generatedAt: '2026-10-02T10:00:00.000Z', summary: { total: 4, passed: 3, failed: 1, skipped: 0, executions: 5 } }));
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

const textOf = (rel: string): string => readFileSync(join(out, ...rel.split('/')), 'utf8');

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'qa-wiki-'));
  root = join(base, 'QA');
  out = join(base, 'wiki');
  resultsFile = join(base, 'atc_results.json');
  printed = [];
  mkdirSync(root, { recursive: true });
});

afterEach(() => { rmSync(base, { recursive: true, force: true }); });

describe('parseArgs', () => {
  it('defaults, build keyword and flag forms', () => {
    expect(parseArgs([])).toMatchObject({ command: 'build', root: '.context/QA', out: 'qa-wiki', results: 'reports/atc_results.json', help: false });
    expect(parseArgs(['build', '--out', 'x', '--root=y'])).toMatchObject({ out: 'x', root: 'y' });
    expect(parseArgs(['--help']).help).toBe(true);
  });

  it('rejects unknown options, stray arguments and missing values', () => {
    expect(() => parseArgs(['--nope', 'x'])).toThrow();
    expect(() => parseArgs(['stray'])).toThrow();
    expect(() => parseArgs(['--out'])).toThrow();
  });
});

describe('model and pages', () => {
  beforeEach(seed);

  it('builds the five page kinds with Azure-safe names', () => {
    const pages = buildWiki(readStore({ root, results: resultsFile }));
    const keys = [...pages.keys()];
    for (const page of ['Home.md', 'Casos.md', 'Corridas.md', 'Bugs.md', 'Reportes.md', 'Casos/AUT.md', 'Casos/LOG.md', 'Casos/API.md', 'Corridas/2026-10-01-smoke.md', 'Corridas/2026-10-02-full.md', 'Bugs/AUT-001-BUG-1.md', 'Bugs/AUT-002-BUG-2.md']) {
      expect(keys).toContain(page);
    }
    for (const key of keys.filter(k => !k.startsWith('.attachments/'))) {
      expect(key.split('/').every(part => part === '.order' || (/^[\w.-]+$/.test(part) && !part.endsWith('.')))).toBe(true);
    }
    expect(keys.every(k => k.length <= 235)).toBe(true);
  });

  it('every .order lists exactly the pages of its folder', () => {
    const pages = buildWiki(readStore({ root, results: resultsFile }));
    const dirs = ['', 'Casos/', 'Corridas/', 'Bugs/'];
    for (const dir of dirs) {
      const listed = (pages.get(`${dir}.order`) as string).trim().split('\n');
      const files = [...pages.keys()]
        .filter(k => k.startsWith(dir) && !k.slice(dir.length).includes('/') && k.endsWith('.md'))
        .map(k => k.slice(dir.length, -3));
      expect([...listed].sort()).toEqual([...files].sort());
    }
    expect((pages.get('.order') as string).trim().split('\n')).toEqual(['Home', 'Casos', 'Corridas', 'Bugs', 'Reportes']);
    expect((pages.get('Corridas/.order') as string).trim().split('\n')[0]).toBe('2026-10-02-full');
  });

  it('every relative link and image resolves to a generated file', () => {
    const pages = buildWiki(readStore({ root, results: resultsFile }));
    let checked = 0;
    for (const [path, content] of pages) {
      if (typeof content !== 'string') { continue; }
      for (const match of content.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)) {
        const target = posix.normalize(posix.join(posix.dirname(path), match[1]));
        expect(pages.has(target)).toBe(true);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(10);
    expect((pages.get('.attachments/bugs/AUT-001-BUG-1/AUT-001-BUG-1-failure.png') as Buffer).equals(PNG)).toBe(true);
    expect(pages.get('Bugs/AUT-001-BUG-1.md')).toContain('](../.attachments/bugs/AUT-001-BUG-1/AUT-001-BUG-1-failure.png)');
  });

  it('escapes the pipe of a scenario and links the known bug', () => {
    const casos = buildWiki(readStore({ root, results: resultsFile })).get('Casos/AUT.md') as string;
    expect(casos).toContain('Valida a \\| b en el formulario');
    expect(casos).toContain('[AUT-002-BUG-2](../Bugs/AUT-002-BUG-2.md)');
    expect(casos).toContain('FAIL (2026-10-02)');
  });

  it('Mermaid pie slices add up to the case total', () => {
    const home = buildWiki(readStore({ root, results: resultsFile })).get('Home.md') as string;
    const blocks = [...home.matchAll(/```mermaid\n([\s\S]*?)```/g)].map(m => m[1]);
    expect(blocks.length).toBe(2);
    for (const block of blocks) {
      const total = [...block.matchAll(/" : (\d+)/g)].reduce((sum, m) => sum + Number(m[1]), 0);
      expect(total).toBe(4);
    }
    expect(home).toContain('Vista previa local, no publicado');
    expect(home).toContain('Datos al: 2026-10-02');
  });

  it('Home lists open bugs only and Reportes carries the pending marker', () => {
    const pages = buildWiki(readStore({ root, results: resultsFile }));
    const openSection = (pages.get('Home.md') as string).split('## Bugs abiertos')[1].split('## Últimas corridas')[0];
    expect(openSection).toContain('AUT-002-BUG-2');
    expect(openSection).not.toContain('AUT-001-BUG-1');
    expect(pages.get('Reportes.md')).toContain('ENLACE PENDIENTE');
    expect(pages.get('Reportes.md')).toContain('bun run allure:generate');
  });

  it('--reports-url puts direct links in Home and Reportes and drops the pending marker', () => {
    const url = 'https://owner.github.io/repo/qa-reports';
    expect(parseArgs(['--reports-url', `${url}/`]).reportsUrl).toBe(url);
    const pages = buildWiki(readStore({ root, results: resultsFile, reportsUrl: url }));
    expect(pages.get('Reportes.md')).toContain(`[Reporte Allure](${url}/allure/index.html)`);
    expect(pages.get('Reportes.md')).toContain(`[Reporte Playwright](${url}/playwright/index.html)`);
    expect(pages.get('Reportes.md')).not.toContain('ENLACE PENDIENTE');
    expect(pages.get('Reportes.md')).toContain('## Abrir los reportes');
    expect(pages.get('Reportes.md')).toContain('bun run reports:share');
    expect(pages.get('Home.md')).toContain('](Reportes.md)');
    expect(pages.get('Home.md')).not.toContain(url);
    expect(pages.get('Reportes.md')).not.toContain('Descargar desde SharePoint');
  });

  it('names each prefix from prefijos.md of the QA root, and shows the bare prefix without it', () => {
    const bare = buildWiki(readStore({ root, results: resultsFile })).get('Casos.md') as string;
    expect(bare).not.toContain('AUT: ');
    writeFileSync(join(root, 'prefijos.md'), '# Prefijos\n\n| Prefijo | Modulo | Alcance |\n| --- | --- | --- |\n| AUT | Autenticación | Login y sesión |\n| bad | Ignorado | x |\n');
    const named = buildWiki(readStore({ root, results: resultsFile })).get('Casos.md') as string;
    expect(named).toContain('AUT: Autenticación');
    expect(named).not.toContain('Ignorado');
  });

  it('--sharepoint-url adds a download section to Reportes only', () => {
    const sp = 'https://contoso.sharepoint.com/sites/qa/Documentos/Reportes%20QA?e=abc';
    expect(parseArgs(['--sharepoint-url', sp]).sharepointUrl).toBe(sp);
    for (const bad of ['http://x.com/a', 'https://u:p@x.com/a', 'ftp://x.com/a', 'https://x .com']) {
      expect(() => parseArgs(['--sharepoint-url', bad])).toThrow('--sharepoint-url');
    }
    const pages = buildWiki(readStore({ root, results: resultsFile, sharepointUrl: sp }));
    expect(pages.get('Reportes.md')).toContain('## Descargar desde SharePoint');
    expect(pages.get('Reportes.md')).toContain(`(${sp})`);
    expect(pages.get('Home.md')).not.toContain('sharepoint');
  });

  it('--reports-url refuses anything but a plain https URL', () => {
    for (const bad of ['http://x.io/a', 'https://user:pw@x.io/a', 'https://x.io/a?token=1', 'https://x.io/a#b', 'javascript:alert(1)', 'https://x .io']) {
      expect(() => parseArgs(['--reports-url', bad])).toThrow('--reports-url');
    }
  });

  it('run pages come from run.json without the absolute source path', () => {
    const pages = buildWiki(readStore({ root, results: resultsFile }));
    const page = pages.get('Corridas/2026-10-01-smoke.md') as string;
    expect(page).toContain('[AUT-001](../Casos/AUT.md)');
    for (const content of pages.values()) {
      if (typeof content === 'string') { expect(content).not.toMatch(/Someone|C:\\Users|Fuente/); }
    }
  });

  it('only LF line endings, one trailing newline', () => {
    for (const content of buildWiki(readStore({ root, results: resultsFile })).values()) {
      if (typeof content !== 'string') { continue; }
      expect(content).not.toContain('\r');
      expect(content.endsWith('\n') && !content.endsWith('\n\n')).toBe(true);
    }
  });
});

describe('safety', () => {
  beforeEach(seed);

  it('never lets decoy files reach the output', () => {
    const marker = 'DECOY-CONTENT-ZZZ';
    put(join(root, 'allure-results', 'x.json'), marker);
    put(join(root, '.env'), marker);
    put(join(root, '.auth', 's.json'), marker);
    put(join(root, 'trace.zip'), marker);
    put(join(root, 'a.har'), marker);
    put(join(root, 'error-context.md'), marker);
    put(join(root, 'test-results', 'results.json'), marker);
    put(join(root, 'automation', 'x', 'automation-plan.md'), marker);
    put(join(root, '_tools', 'tool.md'), marker);
    put(join(root, 'bugs', 'AUT-001-BUG-1', 'evidence.zip'), marker);
    put(join(root, 'bugs', 'AUT-001-BUG-1', '.hidden.png'), marker);
    put(join(root, 'bugs', 'AUT-001-BUG-1', 'trace.zip'), marker);
    put(join(root, 'bugs', 'AUT-001-BUG-1', 'sub', 'deep.png'), marker);
    put(join(root, 'bugs', 'AUT-001-BUG-1', 'error-context.md'), marker);
    expect(generate()).toBe(0);
    const names = walk(out);
    expect(names.some(n => /allure|\.env|\.auth|\.zip|\.har|error-context|test-results|automation|_tools|hidden|deep/.test(n))).toBe(false);
    for (const name of names) {
      if (!name.endsWith('.png')) { expect(textOf(name)).not.toContain(marker); }
    }
    expect(names).toContain('.attachments/bugs/AUT-001-BUG-1/AUT-001-BUG-1-failure.png');
    expect(printed.join('\n')).not.toContain(marker);
  });

  it('a secret in a report exits 1, names file and count, and writes nothing', () => {
    writeBug('AUT-002-BUG-2', 'AUT-002', 'open', 'Authorization: Bearer abcdefgh12345678\n\ntoken eyJhbGciOi.eyJzdWIiOi.sig-123\n\npassword: hunter2');
    expect(generate()).toBe(1);
    const message = printed.join('\n');
    expect(message).toContain('Bugs/AUT-002-BUG-2.md');
    expect(message).toMatch(/bearer\) in Bugs\/AUT-002-BUG-2\.md: 1 match/);
    expect(message).toMatch(/jwt\) in Bugs\/AUT-002-BUG-2\.md: 1 match/);
    expect(message).toMatch(/credencial\) in Bugs\/AUT-002-BUG-2\.md: 1 match/);
    expect(message).not.toMatch(/abcdefgh12345678|hunter2|eyJhbGciOi/);
    expect(existsSync(out)).toBe(false);
  });

  it('a secret trip leaves an existing generated folder untouched', () => {
    expect(generate()).toBe(0);
    const before = treeHash(out);
    writeBug('AUT-002-BUG-2', 'AUT-002', 'open', 'password: hunter2');
    expect(generate()).toBe(1);
    expect(treeHash(out)).toBe(before);
  });

  it('scanPages reports counts per pattern and skips binary pages', () => {
    const hits = scanPages(new Map<string, string | Buffer>([['a.md', 'Bearer abcdefgh1\nBearer abcdefgh2'], ['b.png', Buffer.from('password: x')]]));
    expect(hits).toEqual([{ file: 'a.md', pattern: 'bearer', count: 2 }]);
  });

  it('leaves the source tree untouched', () => {
    const before = treeHash(root);
    expect(generate()).toBe(0);
    expect(treeHash(root)).toBe(before);
  });

  it('two runs give byte-identical trees, and the marker is written', () => {
    expect(generate()).toBe(0);
    const first = treeHash(out);
    expect(existsSync(join(out, '.qa-wiki-generated'))).toBe(true);
    expect(generate()).toBe(0);
    expect(treeHash(out)).toBe(first);
  });

  it('a re-run replaces a removed bug', () => {
    expect(generate()).toBe(0);
    expect(existsSync(join(out, 'Bugs', 'AUT-002-BUG-2.md'))).toBe(true);
    rmSync(join(root, 'bugs', 'AUT-002-BUG-2'), { recursive: true });
    expect(generate()).toBe(0);
    expect(existsSync(join(out, 'Bugs', 'AUT-002-BUG-2.md'))).toBe(false);
    expect(textOf('Bugs/.order')).not.toContain('AUT-002-BUG-2');
  });

  it('refuses a dangerous --out and deletes nothing', () => {
    put(join(base, 'precious', 'keep.txt'), 'keep');
    const targets = [root, join(root, 'inside'), base, REPO_ROOT, dirname(REPO_ROOT), join(base, 'precious')];
    for (const target of targets) {
      printed = [];
      expect(run(['--root', root, '--out', target, '--results', resultsFile], log)).toBe(1);
      expect(printed.join('\n')).toContain('--out');
    }
    expect(readFileSync(join(base, 'precious', 'keep.txt'), 'utf8')).toBe('keep');
    expect(existsSync(join(root, 'cases'))).toBe(true);
    expect(existsSync(join(root, 'inside'))).toBe(false);
  });

  it('replaces an empty folder and refuses a missing QA root', () => {
    mkdirSync(out, { recursive: true });
    expect(generate()).toBe(0);
    printed = [];
    expect(run(['--root', join(base, 'nope'), '--out', out], log)).toBe(1);
    expect(printed.join('\n')).toContain('QA root not found');
  });

  it('run.md fallback drops the Fuente line', () => {
    expect(generate()).toBe(0);
    const page = textOf('Corridas/2026-10-02-full.md');
    expect(page).toContain('| AUT-002 | FAIL |');
    expect(page).not.toContain('Fuente');
    expect(page).not.toContain('Someone');
  });

  it('works without a results file and prints no values from --help', () => {
    rmSync(resultsFile);
    expect(generate()).toBe(0);
    expect(textOf('Reportes.md')).toContain('Sin resultados de ejecución disponibles');
    printed = [];
    expect(run(['--help'], log)).toBe(0);
    expect(printed.join('\n')).toContain('Usage');
  });
});

describe('preview server', () => {
  const get = (handler: (req: Request) => Response, path: string, init?: RequestInit): Response => handler(new Request(`http://127.0.0.1:4174${path}`, init));
  let handler: (req: Request) => Response;

  beforeEach(() => {
    seed();
    expect(generate()).toBe(0);
    handler = createWikiHandler(out);
  });

  it('serves Home at / with the banner, the CSP and no script', async () => {
    const res = get(handler, '/');
    expect(res.status).toBe(200);
    const csp = res.headers.get('content-security-policy') ?? '';
    expect(csp).toContain('default-src \'none\'');
    expect(csp).not.toContain('script-src');
    expect(csp).not.toContain('\'unsafe-eval\'');
    const html = await res.text();
    expect(html).toContain('Vista previa local, no publicado');
    expect(html).toContain('<svg');
    expect(html).not.toContain('<script');
    expect(html).toContain('<a href="/Casos/AUT.md">AUT</a>');
  });

  it('renders a linked page, and the left tree follows .order', async () => {
    const html = await get(handler, '/Bugs/AUT-001-BUG-1.md').text();
    expect(html).toContain('<img src="/.attachments/bugs/AUT-001-BUG-1/AUT-001-BUG-1-failure.png"');
    const tree = html.slice(html.indexOf('<nav'), html.indexOf('</nav>'));
    const order = ['Home', 'Casos', 'Corridas', 'Bugs', 'Reportes'].map(name => tree.indexOf(`>${name}</a>`));
    expect(order.every(i => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(tree).toContain('href="/Bugs/AUT-002-BUG-2.md"');
    expect(tree).toContain('aria-current="page"');
  });

  it('serves a png and refuses every other file type', async () => {
    const png = get(handler, '/.attachments/bugs/AUT-001-BUG-1/AUT-001-BUG-1-failure.png');
    expect(png.status).toBe(200);
    expect(png.headers.get('content-type')).toBe('image/png');
    expect(Buffer.from(await png.arrayBuffer()).equals(PNG)).toBe(true);
    for (const path of ['/.order', '/.qa-wiki-generated', '/x.json', '/Home', '/Casos/.order', '/nope.md', '/.attachments/bugs/AUT-001-BUG-1']) {
      expect(get(handler, path).status).toBe(404);
    }
  });

  it('refuses traversal, encoded traversal, backslashes and null bytes', () => {
    writeFileSync(join(base, 'secret.md'), '# secret');
    writeFileSync(join(base, '.env'), 'X=1');
    for (const path of ['/../secret.md', '/%2e%2e/secret.md', '/..%2fsecret.md', '/Casos/../../secret.md', '/..\secret.md', '/%2e%2e%5csecret.md', '/Home.md%00.png', '/../.env']) {
      expect(get(handler, path).status).toBe(404);
    }
    expect(get(handler, '/%E0%A4%A').status).toBe(400);
  });

  it('answers only GET and HEAD, and only for loopback host names', async () => {
    expect(get(handler, '/', { method: 'POST' }).status).toBe(405);
    const head = get(handler, '/Home.md', { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
    expect(handler(new Request('http://evil.example:4174/')).status).toBe(403);
    expect(handler(new Request('http://localhost:4174/')).status).toBe(200);
  });

  it('escapes hostile page content instead of rendering it', async () => {
    put(join(out, 'Evil.md'), '# <script>alert(1)</script>\n\n[x](javascript:alert(1)) <img src=x onerror=alert(1)>');
    const html = await get(handler, '/Evil.md').text();
    expect(html).not.toContain('<script');
    expect(html).not.toContain('javascript:');
    expect(html).not.toContain('<img src=x');
  });

  it('startServe binds 127.0.0.1, scans past a busy port and refuses a missing build', () => {
    const opts = { ...parseArgs(['serve', '--dir', out, '--no-open']), port: 47310 };
    const first = startServe(opts, log);
    try {
      expect(first.hostname).toBe('127.0.0.1');
      const second = startServe(opts, log);
      try {
        expect(second.port).not.toBe(first.port);
        expect(second.hostname).toBe('127.0.0.1');
      }
      finally { void second.stop(true); }
      expect(printed.join('\n')).toContain('was busy');
    }
    finally { void first.stop(true); }
    expect(() => startServe({ ...opts, dir: join(base, 'absent') }, log)).toThrow('qa:wiki');
  });

  it('listen takes the next port when the first is busy', () => {
    const blocker = listen(47340, () => new Response('x'));
    const next = listen(47340, () => new Response('x'));
    try { expect(next.port).toBe((blocker.port ?? 0) + 1); }
    finally { void next.stop(true); void blocker.stop(true); }
  });

  it('parses serve options', () => {
    expect(parseArgs(['serve'])).toMatchObject({ command: 'serve', dir: 'qa-wiki', port: 4174, page: 'Home.md', noOpen: false });
    expect(parseArgs(['serve', '--port=5000', '--page', 'Bugs/X.md', '--no-open'])).toMatchObject({ port: 5000, page: 'Bugs/X.md', noOpen: true });
    expect(() => parseArgs(['serve', '--port', '99999'])).toThrow();
    expect(() => parseArgs(['serve', '--page', '../x.md'])).toThrow();
    expect(() => parseArgs(['serve', '--out', 'x'])).toThrow();
    expect(() => parseArgs(['build', '--no-open'])).toThrow();
  });
});
