/**
 * The installer page in a real browser (plan §12, "Page" row): Playwright against
 * the page served by `cli/lib/ui/browser-sink.ts` and fed by a fake run driven
 * through the real `Reporter`. Lives in `scripts/` because it needs
 * `@playwright/test`, and `cli/lib/ui/` must load with node built-ins only.
 *
 * Skips (with a message) when Chromium is not installed: `bun run pw:install`.
 *
 * The browser tests run in a CHILD `bun test` process (this file again, with
 * UI_PAGE_BROWSER_CHILD=1); the shared run only spawns it and checks its result. Chromium
 * launched through Playwright's pipe transport under Bun leaves a stale handle that closes
 * the same fd numbers again later, at a random moment; in the shared process one of those
 * numbers was by then the snapshot file `bun test` keeps open between two snapshot test files,
 * and `cli/lib/ui/installer-run.test.ts` failed with FailedToWriteSnapshotFile. In a child of
 * its own, the stale handle dies with the child.
 */

import type { Browser, Page } from '@playwright/test';
import type { BrowserSink } from '../cli/lib/ui/browser-sink.ts';
import type { Lang } from '../cli/lib/ui/events.ts';

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { chromium, expect as pw } from '@playwright/test';
import { afterAll, afterEach, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';

import { startBrowserSink } from '../cli/lib/ui/browser-sink.ts';
import { Journal } from '../cli/lib/ui/events.ts';
import { renderPage } from '../cli/lib/ui/page.ts';
import { Reporter } from '../cli/lib/ui/reporter.ts';
import { writeSummary } from '../cli/lib/ui/summary.ts';

const HAVE_CHROMIUM = (() => {
  try { return existsSync(chromium.executablePath()); }
  catch { return false; }
})();
if (!HAVE_CHROMIUM) { process.stderr.write('ui-page.test.ts: Chromium not installed, page tests skipped (bun run pw:install)\n'); }

setDefaultTimeout(30_000);

/** Set in the child this file spawns: only there does Chromium start. */
const CHILD = process.env.UI_PAGE_BROWSER_CHILD === '1';
/** The browser tests below, counted from this file, so the parent can tell the child ran every one. */
const BROWSER_TESTS = (readFileSync(import.meta.path, 'utf8').match(/^ {2}test\(/gm) ?? []).length;

if (!CHILD) {
  test.skipIf(!HAVE_CHROMIUM)('the browser tests run in their own process and all pass', async () => {
    const child = Bun.spawn(['bun', 'test', import.meta.path], { env: { ...process.env, UI_PAGE_BROWSER_CHILD: '1' }, stdout: 'pipe', stderr: 'pipe' });
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    const count = (word: string): number => Number(new RegExp(`^\\s*(\\d+) ${word}$`, 'm').exec(err)?.[1] ?? 0);
    if (code !== 0 || count('fail') > 0 || count('pass') !== BROWSER_TESTS) { throw new Error(`browser child: exit ${code}, ${count('pass')} of ${BROWSER_TESTS} passed\n${out}${err}`); }
    process.stderr.write(`ui-page.test.ts: ${count('pass')} of ${BROWSER_TESTS} browser tests passed in the child process\n`);
    expect(count('pass')).toBe(BROWSER_TESTS);
    expect(count('skip')).toBe(0);
  }, 300_000);
}

let browser: Browser;
const sinks: BrowserSink[] = [];
const dirs: string[] = [];

beforeAll(async () => {
  if (HAVE_CHROMIUM && CHILD) { browser = await chromium.launch(); }
});
afterAll(async () => {
  await browser?.close();
});
afterEach(async () => {
  for (const s of sinks.splice(0)) { await s.stop(); }
  for (const d of dirs.splice(0)) { rmSync(d, { recursive: true, force: true }); }
});

async function fakeRun(opts: { lang?: Lang, mode?: 'interactive' | 'readonly', port?: number, token?: string, journal?: Journal } = {}): Promise<{ r: Reporter, sink: BrowserSink }> {
  const lang = opts.lang ?? 'es';
  const r = new Reporter({ cmd: 'setup', repo: 'acme-qa', version: '1', mode: opts.mode ?? 'interactive', lang, phases: [{ id: 'install', title: 'Instalar' }, { id: 'project', title: 'Tu proyecto' }], journal: opts.journal });
  const sink = await startBrowserSink({ journal: r.journal, answer: (id, v) => r.answer(id, v, 'page'), page: ({ token }) => renderPage({ mode: 'live', lang, token }), port: opts.port ?? 0, portWalk: 0, token: opts.token, stopAfterEndMs: null });
  r.attachClientProbe(sink.hasClient);
  sinks.push(sink);
  return { r, sink };
}

async function open(url: string, viewport = { width: 1200, height: 900 }): Promise<{ page: Page, errors: string[] }> {
  const page = await browser.newPage({ viewport, reducedMotion: 'reduce' });
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') { errors.push(m.text()); } });
  await page.goto(url);
  return { page, errors };
}

const card = (page: Page, id: string) => page.locator(`[data-ask="${id}"]`);

describe.skipIf(!HAVE_CHROMIUM || !CHILD)('installer page in a browser', () => {
  test('every ask kind is answered from the page and resolves the core promise', async () => {
    const { r, sink } = await fakeRun();
    const { page, errors } = await open(sink.url);
    r.start();
    r.phaseStart('project');

    const go = r.ask<boolean>({ id: 'confirm', kind: 'confirm', title: 'Empezamos?', spec: { yes: 'Empezar', no: 'Todavía no' } });
    await card(page, 'confirm').getByRole('button', { name: 'Empezar' }).click();
    expect(await go).toBe(true);
    await pw(card(page, 'confirm').locator('.answer-line')).toHaveText(/Empezar/);

    const env = r.ask<string>({ id: 'select', kind: 'select', title: 'Entorno', spec: { options: [{ value: 'staging', label: 'staging' }, { value: 'local', label: 'local' }] }, default: 'staging' });
    await card(page, 'select').getByRole('radio', { name: /local/ }).click();
    await card(page, 'select').getByRole('button', { name: 'Continuar' }).click();
    expect(await env).toBe('local');

    const agents = r.ask<string[]>({ id: 'multi', kind: 'multi', title: 'Agentes', spec: { options: [{ value: 'claude', label: 'Claude Code', checked: true }, { value: 'codex', label: 'Codex' }], min: 1 } });
    await card(page, 'multi').getByRole('checkbox', { name: /Codex/ }).click();
    await card(page, 'multi').getByRole('button', { name: 'Continuar' }).click();
    expect(await agents).toEqual(['claude', 'codex']);

    const name = r.ask<string[]>({ id: 'text', kind: 'text', title: 'Proyecto', spec: { fields: [{ id: 'name', label: 'Nombre', required: true }, { id: 'key', label: 'Clave', required: true, pattern: '^[A-Z]{2,10}$', patternMsg: 'Solo mayúsculas.' }] } });
    await card(page, 'text').getByLabel('Nombre').fill('Acme');
    await card(page, 'text').getByLabel('Clave').fill('acme');
    await card(page, 'text').getByRole('button', { name: 'Continuar' }).click();
    await pw(card(page, 'text').getByText('Solo mayúsculas.')).toBeVisible();
    await card(page, 'text').getByLabel('Clave').fill('ACME');
    await card(page, 'text').getByLabel('Clave').press('Enter');
    expect(await name).toEqual(['Acme', 'ACME']);

    const token = r.ask<string>({ id: 'secret', kind: 'secret', title: 'Token de API', spec: { varName: 'ATLASSIAN_API_TOKEN', label: 'Token' } });
    const field = card(page, 'secret').getByLabel('Token');
    await pw(field).toHaveAttribute('type', 'password');
    await field.fill('ATATT-page-secret-42');
    await card(page, 'secret').getByRole('button', { name: 'Continuar' }).click();
    expect(await token).toBe('ATATT-page-secret-42');
    await pw(field).toHaveValue('');
    await pw(card(page, 'secret').locator('.answer-line')).toContainText('ATLASSIAN_API_TOKEN guardado');
    expect(await page.content()).not.toContain('ATATT-page-secret-42');

    const files = r.ask<string[]>({ id: 'files', kind: 'files', title: 'Archivos', spec: { files: [{ path: 'a.md', add: 3, del: 1, kind: 'mod', kindLabel: 'Modificado', diff: ['@@ -1 +1 @@', '-old', '+new'] }, { path: 'b.md', kind: 'new', kindLabel: 'Nuevo' }] } });
    await card(page, 'files').getByRole('button', { name: 'Ver cambios' }).click();
    await pw(card(page, 'files').locator('.diff .add')).toHaveText('+new');
    await card(page, 'files').getByRole('checkbox', { name: 'b.md' }).uncheck();
    await card(page, 'files').getByRole('button', { name: 'Continuar' }).click();
    expect(await files).toEqual(['a.md']);

    const dels = r.ask<string[]>({ id: 'deletions', kind: 'deletions', title: 'Borrados', spec: { files: [{ path: 'old.sh', why: 'reemplazado' }, { path: 'old.md' }] } });
    await card(page, 'deletions').getByRole('checkbox', { name: 'old.sh' }).check();
    await card(page, 'deletions').getByRole('button', { name: 'Continuar' }).click();
    expect(await dels).toEqual(['old.sh']);

    const merge = r.ask<string>({ id: 'divergence', kind: 'divergence', title: 'agent-project.md', spec: { mine: ['+ mine'], theirs: ['+ theirs'], options: [{ value: 'merge', label: 'Combinar' }, { value: 'mine', label: 'Lo mío' }] }, default: 'merge' });
    await pw(card(page, 'divergence').locator('.split .side')).toHaveCount(2);
    await card(page, 'divergence').getByRole('button', { name: 'Continuar' }).click();
    expect(await merge).toBe('merge');

    const keys = r.ask<string[]>({ id: 'pkg', kind: 'package-keys', title: 'Scripts nuevos', spec: { options: [{ value: 'browser:profiles', label: 'browser:profiles' }] } });
    await card(page, 'pkg').getByRole('checkbox', { name: /browser:profiles/ }).click();
    await card(page, 'pkg').getByRole('button', { name: 'Continuar' }).click();
    expect(await keys).toEqual(['browser:profiles']);

    const next = r.fail({ id: 'fail', step: 'jira', title: 'Jira rechazó el token', what: 'Respuesta `401`.', how: ['Crea un token nuevo.'], cmd: 'acli jira auth login', actions: [{ value: 'retry', label: 'Reintentar' }, { value: 'skip', label: 'Saltar' }] });
    await pw(page.locator('#state')).toHaveText('Necesita tu ayuda');
    await card(page, 'fail').getByRole('button', { name: 'Saltar' }).click();
    expect(await next).toBe('skip');

    r.end('done', 0);
    await pw(page.locator('#state')).toHaveText('Terminado');
    expect(errors).toEqual([]);
    await page.close();
  });

  test('a second tab sees the question answered in the first one', async () => {
    const { r, sink } = await fakeRun();
    const a = await open(sink.url);
    const b = await open(sink.url);
    r.start();
    const q = r.ask<boolean>({ id: 'go', kind: 'confirm', title: 'Go?' });
    await pw(card(b.page, 'go')).toBeVisible();
    await card(a.page, 'go').getByRole('button', { name: 'Sí' }).click();
    expect(await q).toBe(true);
    await pw(card(b.page, 'go')).toHaveClass(/answered/);
    await pw(card(b.page, 'go').locator('.answer-line')).toContainText('Sí');
    await a.page.close();
    await b.page.close();
  });

  test('a download lane keeps streaming in the background while a question waits (owner answer Q2)', async () => {
    const { r, sink } = await fakeRun();
    const { page } = await open(sink.url);
    r.start();
    r.phaseStart('install');
    const dl = r.step({ phase: 'install', title: 'Chromium', lane: 'descargas' });
    r.phaseStart('project');
    const q = r.ask<boolean>({ id: 'go', kind: 'confirm', title: 'Go?' });
    dl.log('chromium 40%');
    await pw(page.locator('#lanes')).toBeVisible();
    await pw(page.locator('#lanes .lane-row')).toContainText('chromium 40%');
    await pw(page.locator('#state')).toHaveText('Te toca responder');
    dl.log('chromium 100%');
    dl.end('ok');
    await pw(page.locator('#lanes')).toBeHidden();
    await card(page, 'go').getByRole('button', { name: 'Sí' }).click();
    expect(await q).toBe(true);
    await page.close();
  });

  test('read-only run: badge and explanation, nothing to answer', async () => {
    const { r, sink } = await fakeRun({ mode: 'readonly' });
    const { page } = await open(sink.url);
    r.start();
    await pw(page.locator('#state')).toHaveText('Solo lectura');
    await pw(page.locator('.card.info')).toContainText('Modo automático');
    await page.close();
  });

  test('event text is never HTML', async () => {
    const { r, sink } = await fakeRun();
    const { page } = await open(sink.url);
    r.start();
    r.notice('warn', '<img src=x onerror="window.__pwned=1"> and `code`');
    const s = r.step({ phase: 'install', title: 'child' });
    s.log('<script>window.__pwned=2</script>');
    await pw(page.locator('.notice.warn')).toContainText('<img src=x');
    await pw(page.locator('.notice.warn code')).toHaveText('code');
    expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
    await page.close();
  });

  test('English run, dark scheme, 400 px wide, reduced motion: no horizontal scroll', async () => {
    const { r, sink } = await fakeRun({ lang: 'en' });
    const page = await browser.newPage({ viewport: { width: 400, height: 860 }, colorScheme: 'dark', reducedMotion: 'reduce' });
    await page.goto(sink.url);
    r.start();
    r.phaseStart('install');
    r.step({ phase: 'install', title: 'A very long step title that would overflow a phone screen if the layout did not wrap it properly at all' }).log('x'.repeat(300));
    void r.ask({ id: 'q', kind: 'select', title: 'Pick', spec: { options: [{ value: 'a', label: 'Alpha', desc: 'long '.repeat(40) }] } });
    await pw(page.locator('#state')).toHaveText('Your turn');
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(400);
    expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgb(10, 14, 20)');
    await page.getByRole('button', { name: 'Light' }).click();
    expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgb(238, 241, 245)');
    expect(await page.evaluate(() => getComputedStyle(document.querySelector('.card')!).animationDuration)).toBe('1e-06s');
    await page.close();
  });

  test('after a self-update restart the page reconnects to the new process, reloads once and loses nothing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ui-page-restart-'));
    dirs.push(dir);
    const parent = await fakeRun();
    const { page } = await open(parent.sink.url);
    parent.r.start();
    parent.r.notice('info', 'before restart');
    parent.r.restart('8.5', '8.6');
    await pw(page.locator('.banner')).toContainText('Reiniciando');
    const file = join(dir, 'journal.json');
    parent.r.journal.writeFile(file);
    const { port, token } = parent.sink;
    await parent.sink.stop();
    sinks.splice(sinks.indexOf(parent.sink), 1);
    await pw(page.locator('#state')).toHaveText('Sin conexión');

    const reloaded = page.waitForEvent('load');
    const child = await fakeRun({ port, token, journal: new Journal({ resume: Journal.readFile(file) }) });
    child.r.notice('info', 'after restart');
    await reloaded;
    await pw(page.locator('.notice').filter({ hasText: 'after restart' })).toBeVisible();
    await pw(page.locator('.notice').filter({ hasText: 'before restart' })).toBeVisible();
    await pw(page.locator('.banner.good')).toContainText('Reconectado');
    await page.close();
  });

  test('the saved summary opens from disk and shows the finished run', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ui-page-saved-'));
    dirs.push(dir);
    const { r } = await fakeRun();
    r.start();
    r.phaseStart('install');
    r.step({ phase: 'install', title: 'deps' }).end('ok');
    r.phaseEnd('install');
    r.report({ title: 'Listo', tiles: [{ n: '7', label: 'archivos' }], next: [{ title: 'Commit', cmd: 'git commit' }] });
    r.end('done', 0);
    const rel = writeSummary({ repoRoot: dir, cmd: 'setup', lang: 'es', journal: r.journal.all() });
    const { page, errors } = await open(`file://${join(dir, rel)}`);
    await pw(page.locator('#state')).toHaveText('Terminado');
    await pw(page.locator('.tile .n')).toHaveText('7');
    await pw(page.locator('#foot-note')).toContainText('Copia guardada');
    expect(errors.filter(e => !/fonts\.g/.test(e))).toEqual([]);
    await page.close();
  });

  test('the recorded real up --dry-run journal replays to its final report', async () => {
    const entries = JSON.parse(await Bun.file(new URL('../cli/lib/fixtures/ui-up-dry-run.journal.json', import.meta.url)).text());
    const journal = new Journal();
    const sink = await startBrowserSink({ journal, page: ({ token }) => renderPage({ mode: 'live', note: 'replay', lang: 'es', token }), port: 0, portWalk: 0, stopAfterEndMs: null });
    sinks.push(sink);
    const { page, errors } = await open(sink.url);
    for (const e of entries) { journal.appendRecorded(e); }
    await pw(page.locator('#state')).toHaveText('Terminado');
    await pw(page.locator('#cmd')).toContainText('bun sync --dry-run');
    await pw(page.locator('.ph.done, .ph.warn')).toHaveCount(6);
    await pw(page.locator('.banner.good')).toContainText('Reconectado');
    await pw(page.locator('table.rep').last().locator('tbody tr')).toHaveCount(3);
    expect(errors).toEqual([]);
    await page.close();
  });
});
