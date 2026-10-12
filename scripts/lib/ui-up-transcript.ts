/**
 * @fileoverview Turns the terminal output of a real `bun sync` run into a page
 * journal (`cli/lib/ui/events.ts`), keeping the time each line arrived.
 *
 * Transitional on purpose. Delivery 1 of the installer page must not change what
 * `bun sync` does, so the journal is recorded OUT of process: the real updater
 * runs with its stdout piped (`scripts/ui-record-up.ts`) and this module reads
 * what it printed. Delivery 2 wires the updater's `ReportSink` to the reporter,
 * and the journal is then produced natively; this translator goes away with it.
 *
 * It reads the glyphs `cli/lib/tui.ts` (clack) prints with colours off:
 *   `● msg` step / info · `◇ msg` spinner stop · `▲ msg` warning · `■ msg` error
 *   `── PHASE n — LABEL ──` phase · `── LABEL ──` sub-phase
 *   "Estado por superficie" table · COPY PROMPT block · the closing summary box
 */

import type { JournalEntry, ParityFinding, PhaseDef, RunEvent, Surface, Tile } from '../../cli/lib/ui/events.ts';

import { Journal } from '../../cli/lib/ui/events.ts';

export interface TranscriptLine {
  /** ms since the recording started. */
  ms: number
  text: string
}

export interface TranscriptMeta {
  repo: string
  args: string[]
}

// eslint-disable-next-line no-control-regex
const ANSI = /\x1B\[[0-9;?]*[A-Z]/gi;

export function stripAnsi(s: string): string {
  return s.replace(ANSI, '');
}

const PHASES_READONLY: PhaseDef[] = [
  { id: 'fetch', title: 'Traer novedades', hint: 'desde upstream' },
  { id: 'self', title: 'Actualizar el actualizador', hint: 'si cambió' },
  { id: 'detect', title: 'Detectar cambios', hint: 'qué es nuevo y qué es tuyo' },
  { id: 'scope', title: 'Aplicar todo', hint: 'sin preguntas' },
  { id: 'apply', title: 'Aplicar y verificar', hint: 'escribir, comprobar' },
  { id: 'report', title: 'Reporte', hint: 'paridad y resumen' },
];

const PHASE_WHY: Record<string, string> = {
  fetch: 'Descargamos la versión actual del boilerplate ([[upstream|upstream]]) en una carpeta temporal. Tu proyecto no se toca todavía.',
  self: 'La versión nueva trae cambios en el propio actualizador. El proceso se reinicia con el código nuevo para que haga el resto. [[selfupdate|Por qué?]]',
  detect: 'Comparamos cada archivo con la versión anterior del boilerplate y con la tuya, para separar lo nuevo de lo que tú editaste.',
  scope: 'En modo automático se trae todo lo nuevo. Lo que exige decidir no se toca.',
  apply: 'Escribimos los cambios, mezclamos tu configuración sin borrar lo tuyo y corremos las comprobaciones del proyecto.',
  report: 'Lo que quedó distinto entre tu proyecto y el boilerplate, y por qué. [[parity|Qué es esto?]]',
};

/** Updater phase number (cli/lib/updater-core.ts) -> page phase id. 3 SCOPE and 4 FILES share one page phase. */
const PHASE_BY_NUMBER: Record<string, string> = { 1: 'fetch', 2: 'detect', 3: 'scope', 4: 'scope', 5: 'apply' };

const MSG = /^([●◇▲■◆])\s{2}(.*)$/u;
const PHASE_HEADER = /^── PHASE (\d) — .+ ─+$/u;
const SUBPHASE = /^── (.+?) ──$/u;
const VERSION = /Updater v([\w.-]+)/;

interface Message { glyph: string, text: string, ms: number }

/** Groups clack messages: a `│  ` line right after a message continues it. */
function messages(lines: TranscriptLine[]): Array<Message | { raw: string, ms: number }> {
  const out: Array<Message | { raw: string, ms: number }> = [];
  for (const { ms, text } of lines) {
    const line = stripAnsi(text).replace(/\s+$/, '');
    const m = MSG.exec(line);
    if (m) { out.push({ glyph: m[1], text: m[2], ms }); continue; }
    const last = out[out.length - 1];
    if (last && 'glyph' in last && /^│ {2}\S/u.test(line) && !/│\s*$/u.test(line)) { last.text += `\n${line.slice(3)}`; continue; }
    out.push({ raw: line, ms });
  }
  return out;
}

function parseSurfaceRow(line: string): Surface | null {
  const cells = line.split('│').map(c => c.trim());
  if (cells.length < 5) { return null; }
  const [, mark, label, detail] = cells;
  const state = mark === '[ok]' ? 'ok' : mark === '[!]' ? 'warn' : mark === '[x]' ? 'blocked' : null;
  return state && label ? { state, label, detail: detail ?? '' } : null;
}

function parseFindingRow(line: string): ParityFinding | null {
  const cells = line.split('|').slice(1, -1).map(c => c.trim());
  if (cells.length !== 6 || !/^\d+$/.test(cells[0])) { return null; }
  const [n, surface, file, now, evidence, suggested] = cells;
  return { n: Number(n), surface, file, now, evidence, suggested, blocking: /BLOCKING/.test(suggested) };
}

export function translateUpTranscript(lines: TranscriptLine[], meta: TranscriptMeta): JournalEntry[] {
  let clock = 0;
  const journal = new Journal({ now: () => clock });
  const emit = (ms: number, ev: RunEvent): void => { clock = ms; journal.append(ev); };

  const dryRun = meta.args.includes('--dry-run');
  const versions = lines.map(l => VERSION.exec(stripAnsi(l.text))?.[1]).filter((v): v is string => Boolean(v));
  emit(0, { t: 'run.start', cmd: 'up', args: meta.args, repo: meta.repo, version: versions[0] ?? '', mode: 'readonly', lang: 'es', phases: PHASES_READONLY });
  if (dryRun) { emit(0, { t: 'notice', level: 'info', text: 'Vista previa ([[dryrun|--dry-run]]): el actualizador calcula todo lo que haría y no escribe ningún archivo de tu proyecto.' }); }

  let phase: string | null = null;
  let phaseWarned = false;
  const seenNotices = new Set<string>();
  let restarted = false;
  let banners = 0;
  let stepN = 0;
  const surfaces: Surface[] = [];
  const findings: ParityFinding[] = [];
  const tiles: Tile[] = [];
  let advanced = '';
  const prompt: string[] = [];
  let inPrompt = false;
  let inTable = false;
  let inBox = false;
  let lastMs = 0;
  let ended = false;

  const enter = (id: string, ms: number): void => {
    if (phase === id) { return; }
    if (phase) { emit(ms, { t: 'phase.end', id: phase, status: phaseWarned ? 'warn' : 'done' }); }
    phase = id;
    phaseWarned = false;
    emit(ms, { t: 'phase.start', id, why: PHASE_WHY[id] });
  };
  // A printed line marks the END of the work it reports: the step ran since the previous line.
  let prevMs = 0;
  const step = (title: string, ms: number, status: 'ok' | 'warn' = 'ok'): void => {
    stepN += 1;
    const id = `s${stepN}`;
    const from = Math.min(prevMs, ms);
    emit(from, { t: 'step.start', id, phase: phase ?? 'fetch', title });
    emit(ms, { t: 'step.end', id, status, ms: ms - from });
  };

  let lastMeaningful = 0;
  for (const item of messages(lines)) {
    lastMs = item.ms;
    // clack prints a bare `│` with every message, at the same instant: it is not a point in time of its own.
    prevMs = lastMeaningful;
    if ('glyph' in item || !['', '│'].includes(item.raw.trim())) { lastMeaningful = item.ms; }
    if ('glyph' in item) {
      const text = item.text;
      if (inBox) { continue; }
      if (item.glyph === '▲') {
        if (text.startsWith('Self-update pendiente')) { enter('self', item.ms); }
        phaseWarned = true;
        emit(item.ms, { t: 'notice', level: 'warn', text, ...(phase ? { phase } : {}) });
        continue;
      }
      if (item.glyph === '■') {
        phaseWarned = true;
        emit(item.ms, { t: 'notice', level: 'error', text, ...(phase ? { phase } : {}) });
        continue;
      }
      // The self-update child repeats the parent's opening lines (stdin notice, upstream HEAD): drop the repeats.
      if (seenNotices.has(text)) { continue; }
      seenNotices.add(text);
      if (!phase || phase === 'report') {
        // Before the first phase (the stdin notice) and around the parity table: notices, not steps.
        emit(item.ms, { t: 'notice', level: 'info', text, ...(phase ? { phase } : {}) });
        continue;
      }
      const applied = /^\[dry-run\] aplicaría: (.+)$/.exec(text);
      step(applied ? `\`${applied[1]}\`` : text, item.ms);
      continue;
    }

    const raw = item.raw;
    if (raw.includes('COPY PROMPT BELOW')) { inPrompt = true; continue; }
    if (raw.includes('COPY PROMPT ABOVE')) { inPrompt = false; continue; }
    if (inPrompt) {
      prompt.push(raw);
      const f = parseFindingRow(raw);
      if (f) { findings.push(f); }
      continue;
    }
    if (VERSION.test(raw)) {
      banners += 1;
      if (banners === 2 && !restarted) {
        restarted = true;
        emit(item.ms, { t: 'restart', reason: 'self-update', from: `v${versions[0] ?? '?'}`, to: `v${versions[1] ?? '?'}` });
      }
      continue;
    }
    const ph = PHASE_HEADER.exec(raw);
    if (ph) {
      const id = PHASE_BY_NUMBER[ph[1]] ?? phase ?? 'fetch';
      // The self-update child prints PHASE 1 again: its lines belong to the self-update phase.
      if (!(restarted && id === 'fetch' && phase === 'self')) { enter(id, item.ms); }
      continue;
    }
    const sub = SUBPHASE.exec(raw);
    if (sub) { step(sub[1].charAt(0) + sub[1].slice(1).toLowerCase(), item.ms); continue; }
    if (raw.trim() === 'Estado por superficie') { enter('report', item.ms); inTable = true; continue; }
    if (inTable) {
      if (raw.startsWith('└')) { inTable = false; continue; }
      const s = parseSurfaceRow(raw);
      if (s) { surfaces.push(s); }
      continue;
    }
    if (raw.startsWith('╭')) { inBox = true; continue; }
    if (inBox) {
      if (raw.startsWith('╰')) { inBox = false; continue; }
      const row = raw.startsWith('│') && raw.endsWith('│') ? raw.slice(1, -1).trim() : '';
      const colon = row.indexOf(':');
      if (colon > 0) {
        const k = row.slice(0, colon).trim();
        const v = row.slice(colon + 1).trim();
        if (/^\d+$/.test(v)) { tiles.push({ n: v, label: k.toLowerCase(), tone: k.startsWith('Aplicados') ? 'good' : k.startsWith('Con error') && v !== '0' ? 'bad' : '' }); }
        else if (k.startsWith('Avanzados')) { advanced = v; }
      }
      continue;
    }
    if (/^└ {2}/u.test(raw)) {
      const blocking = findings.filter(f => f.blocking).length;
      const applied = tiles.find(t => t.label.startsWith('aplicados'))?.n ?? '0';
      const post = prompt.find(l => l.startsWith('Post-merge:'))?.replace(/^Post-merge:\s*/, '');
      if (phase !== 'report') { enter('report', item.ms); }
      emit(item.ms, {
        t: 'report',
        title: dryRun
          ? `Vista previa: ${applied} archivos se aplicarían${advanced ? ` (${advanced})` : ''}. Nada se escribió.`
          : `${applied} archivos aplicados${advanced ? ` (${advanced})` : ''}.`,
        tone: blocking > 0 ? 'warn' : 'good',
        tiles: findings.length ? [...tiles, { n: String(findings.length), label: 'hallazgos de paridad', tone: blocking ? 'warn' : '' }] : tiles,
        surfaces,
        findings,
        next: [
          ...(dryRun ? [{ title: 'Aplicar esta actualización', text: 'La corrida real escribe estos cambios y regenera lo que la vista previa marca como resuelto al aplicar.', cmd: 'bun sync' }] : []),
          ...(findings.length ? [{ title: 'Resolver los hallazgos de paridad', text: 'Pásale el prompt de paridad a tu agente: lista cada fila y espera tu decisión antes de tocar nada.' }] : []),
          ...(post ? [{ title: 'Después de resolverlos', cmd: post }] : []),
        ],
        ...(prompt.length ? { prompt: prompt.join('\n').trim() } : {}),
      });
      emit(item.ms, { t: 'phase.end', id: 'report', status: blocking > 0 ? 'warn' : 'done' });
      phase = null;
      emit(item.ms, { t: 'run.end', status: 'done', exit: 0 });
      ended = true;
    }
  }
  if (!ended) {
    if (phase) { emit(lastMs, { t: 'phase.end', id: phase, status: 'failed' }); }
    emit(lastMs, { t: 'run.end', status: 'failed', exit: 1 });
  }
  return journal.all();
}
