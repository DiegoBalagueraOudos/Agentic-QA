#!/usr/bin/env bun
/**
 * @fileoverview Serves the installer page for a demo, over the REAL server path
 * (`cli/lib/ui/browser-sink.ts`: token, SSE, replay from Last-Event-ID).
 *
 *   bun scripts/ui-replay.ts [journal.json] [--speed 1] [--port 4380] [--lang es|en] [--open]
 *   bun scripts/ui-replay.ts --scenario concurrent [--port 4381] [--open]
 *
 * Journal mode plays a recorded journal (default: the real `up --dry-run` one) with
 * its original pacing, starting when the first page connects; a page opened later
 * replays everything it missed. Scenario `concurrent` drives a live `Reporter`
 * whose questions are answered from the page while a download lane streams in
 * the background (owner answer Q2). The server stays up until Ctrl-C.
 */

import type { JournalEntry, Lang } from '../cli/lib/ui/events.ts';

import { startBrowserSink } from '../cli/lib/ui/browser-sink.ts';
import { Journal } from '../cli/lib/ui/events.ts';
import { openBrowser } from '../cli/lib/ui/open-browser.ts';
import { renderPage } from '../cli/lib/ui/page.ts';
import { Reporter } from '../cli/lib/ui/reporter.ts';
import { pickLang } from '../cli/lib/ui/strings.ts';

const DEFAULT_JOURNAL = 'cli/lib/fixtures/ui-up-dry-run.journal.json';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
}

const sleep = async (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

async function waitForClient(hasClient: () => boolean): Promise<void> {
  while (!hasClient()) { await sleep(200); }
  await sleep(600);
}

async function replay(file: string, opts: { speed: number, port?: number, open: boolean }): Promise<void> {
  const entries = JSON.parse(await Bun.file(file).text()) as JournalEntry[];
  const start = entries.find(e => e.t === 'run.start');
  const lang: Lang = start && start.t === 'run.start' ? start.lang : 'es';
  const journal = new Journal();
  const sink = await startBrowserSink({ journal, page: ({ token }) => renderPage({ mode: 'live', note: 'replay', lang, token }), port: opts.port, stopAfterEndMs: null });
  process.stdout.write(`page: ${sink.url}\n(replay of ${file}, ${entries.length} events, starts when the page connects; Ctrl-C to stop)\n`);
  if (opts.open) { await openBrowser(sink.url, { checkout: process.cwd() }); }
  await waitForClient(sink.hasClient);
  let prev = 0;
  for (const e of entries) {
    // Original pacing, a long silent stretch capped at 4 s so the demo never looks frozen.
    await sleep(Math.min(4000, Math.max(0, e.ts - prev)) / opts.speed);
    prev = e.ts;
    journal.appendRecorded(e);
  }
  process.stdout.write('replay finished; the page keeps the final state. Ctrl-C to stop.\n');
}

async function concurrent(opts: { port?: number, open: boolean, lang: Lang }): Promise<void> {
  const reporter = new Reporter({
    cmd: 'setup',
    repo: 'acme-qa',
    version: 'demo',
    mode: 'interactive',
    lang: opts.lang,
    phases: [
      { id: 'install', title: 'Instalar', hint: 'dependencias, navegador, skills' },
      { id: 'project', title: 'Tu proyecto', hint: 'nombre, entornos, URLs' },
      { id: 'creds', title: 'Credenciales', hint: 'dónde y cuáles' },
      { id: 'done', title: 'Listo', hint: 'resumen' },
    ],
  });
  const sink = await startBrowserSink({
    journal: reporter.journal,
    answer: (id, value) => reporter.answer(id, value, 'page'),
    page: ({ token }) => renderPage({ mode: 'live', lang: opts.lang, token }),
    port: opts.port,
    stopAfterEndMs: null,
  });
  reporter.attachClientProbe(sink.hasClient);
  process.stdout.write(`page: ${sink.url}\n(synthetic concurrent run: questions while downloads stream; Ctrl-C to stop)\n`);
  if (opts.open) { await openBrowser(sink.url, { checkout: process.cwd() }); }
  await waitForClient(sink.hasClient);

  reporter.start();
  reporter.phaseStart('install', { why: 'Las descargas largas corren en segundo plano mientras respondes las preguntas del proyecto. [[lane|Cómo?]]' });
  const stream = async (title: string, lines: string[], every: number): Promise<void> => {
    const s = reporter.step({ phase: 'install', title, lane: 'descargas' });
    for (const l of lines) { await sleep(every); s.log(l); }
    s.end('ok', `${lines.length} pasos`);
  };
  const downloads = Promise.all([
    stream('Dependencias (`bun install`)', Array.from({ length: 14 }, (_, i) => `bun install · ${(i + 1) * 37} paquetes`), 900),
    stream('Navegador Chromium de [[playwright|Playwright]]', Array.from({ length: 18 }, (_, i) => `chromium ${Math.min(100, (i + 1) * 6)}% de 152 MB`), 1100),
  ]);

  await sleep(1500);
  reporter.phaseStart('project', { why: 'Mientras tanto, los datos que el resto necesita.' });
  const [name, key] = await reporter.ask<string[]>({
    kind: 'text',
    phase: 'project',
    kicker: 'Identidad',
    title: 'Cómo se llama el proyecto?',
    spec: { fields: [{ id: 'name', label: 'Nombre', short: 'Nombre', required: true, placeholder: 'Acme QA' }, { id: 'key', label: 'Clave de Jira', short: 'Clave', required: true, pattern: '^[A-Z][A-Z0-9]{1,9}$', patternMsg: 'Mayúsculas y números, 2 a 10 caracteres.', placeholder: 'ACME' }] },
  });
  reporter.notice('info', `Proyecto \`${name}\` con clave \`${key}\`.`, 'project');
  await reporter.ask({
    kind: 'select',
    phase: 'project',
    kicker: 'Entorno',
    title: 'Qué entorno se prueba por defecto?',
    spec: { options: [{ value: 'staging', label: 'staging', rec: true, desc: 'Lo habitual: datos de prueba, sin clientes reales.' }, { value: 'local', label: 'local', desc: 'Tu máquina, `http://localhost:3000`.' }] },
    default: 'staging',
  });
  reporter.phaseEnd('project');
  reporter.phaseStart('creds', { why: 'Se piden una vez y se escriben una vez en [[env|.env]].' });
  await reporter.ask({
    kind: 'secret',
    phase: 'creds',
    kicker: 'Secreto',
    title: 'Token de API de Atlassian',
    g: 'token',
    spec: { varName: 'ATLASSIAN_API_TOKEN', label: 'Token', secondary: [{ value: 'later', label: 'Lo haré después' }] },
  });
  reporter.phaseEnd('creds');
  await downloads;
  reporter.phaseEnd('install');
  reporter.phaseStart('done');
  reporter.report({ title: 'Listo: las descargas terminaron mientras respondías.', tone: 'good', tiles: [{ n: '2', label: 'descargas en paralelo', tone: 'good' }, { n: '3', label: 'preguntas respondidas' }], next: [{ title: 'Empieza a probar', cmd: 'bun run test' }] });
  reporter.phaseEnd('done');
  reporter.end('done', 0);
  process.stdout.write('scenario finished; Ctrl-C to stop.\n');
}

const speed = Number(arg('--speed') ?? '1') || 1;
const port = arg('--port') ? Number(arg('--port')) : undefined;
const open = process.argv.includes('--open');
if (arg('--scenario') === 'concurrent') {
  const lang = (arg('--lang') as Lang | undefined) ?? pickLang(process.env);
  await concurrent({ port, open, lang });
}
else {
  const file = process.argv.slice(2).find(a => a.endsWith('.json')) ?? DEFAULT_JOURNAL;
  await replay(file, { speed, port, open });
}
await new Promise(() => {});
