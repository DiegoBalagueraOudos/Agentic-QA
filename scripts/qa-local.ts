#!/usr/bin/env bun
/**
 * qa-local.ts — local QA case store: validate, queue, transition and report on
 * the Markdown cases under `.context/QA/` without Jira, Xray or any network.
 *
 * The cases come from a converter, so each file is `key: value` frontmatter plus
 * a Markdown body. This script reads it with a small purpose-built reader and
 * WRITES with line-targeted edits: one frontmatter line is replaced (or one line
 * is appended before the closing `---`), every other byte of the file, line
 * endings included, is left alone. YAML is never re-serialised.
 *
 * Verbs:
 *   check                          read-only validation (exit 1 only on ERROR)
 *   index                          regenerate <root>/estado.md
 *   next [N] [--ola K] [--prefix P]  ordered queue of candidate + pendiente cases
 *   verdict <ID> <candidate|manual|deferred|no_aplica> [--reason "..."]
 *   status  <ID> <pendiente|en_automatizacion|automatizado> [--atc X --spec P --surface e2e|api]
 *   defect  <ID> <ref>             only for a candidate whose last_run.result is FAIL
 *   results [--file reports/atc_results.json] [--accept] [--scope S]
 *   case new <PREFIX> --title T [...]  create the next <PREFIX>-<nnn> case file (oraculo historia|observado)
 *   case confirm <ID>              oraculo observado -> confirmado (a person decided)
 *   bug new <ID> [--title T --type Bug|Defect|Improvement --severity S --error-type E --environment ENV --run R --visual]
 *   bug status <bug id> <open|fixed|verified>
 *   bug check [<bug id>]           read-only: enums, links, forbidden files, secrets (counts only)
 *
 * `bug` works on <root>/bugs/<case id>-BUG-<n>/report.md. It never edits a case file;
 * the bug number is one global consecutive number across all cases, allocated by a
 * non-recursive mkdir (EEXIST -> next number).
 *
 * The manual-run fields of legacy files (ejecucion_manual, ejecutado_por,
 * fecha_ejecucion, id_defecto, bloqueo) are tolerated and ignored, never validated.
 *
 * Options: --root <dir> (default .context/QA), --manifest <file> (default
 * kata-manifest.json), --date YYYY-MM-DD, --dry-run (every writing verb: print
 * what would change, write nothing).
 *
 * Usage:
 *   bun scripts/qa-local.ts <verb> [args] [options]
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';

// ============================================
// Types and constants
// ============================================

/** A string written without quotes, the way the converter writes enum tokens. */
class Bare {
  constructor(readonly token: string) {}
}
const bare = (token: string): Bare => new Bare(token);

type Value = string | number | boolean | null | Value[] | { [key: string]: Value } | Bare;
type Level = 'ERROR' | 'WARN' | 'INFO';
type Out = (line: string) => void;

interface Issue { level: Level, id: string, message: string }

interface QaCase {
  id: string
  fileId: string
  prefix: string
  file: string
  lines: string[]
  fmEnd: number
  fm: Record<string, Value>
}

interface Edit { key: string, value: Value }

interface Options {
  positional: string[]
  values: Record<string, string>
  flags: Set<string>
}

const VERDICTS = ['candidate', 'manual', 'deferred', 'no_aplica'] as const;
const LIFECYCLE = ['pendiente', 'en_automatizacion', 'automatizado'] as const;
const PRIORITIES = ['A', 'M', 'B'] as const;
const ORACLES = ['historia', 'observado', 'confirmado'] as const;
const RESULTS = ['PASS', 'FAIL', 'SKIP', 'EXPECTED_FAIL', 'UNEXPECTED_PASS'] as const;
const NEEDS_REASON = new Set(['manual', 'deferred', 'no_aplica']);
const LEGAL_STATUS: Record<string, string[]> = {
  pendiente: ['en_automatizacion'],
  en_automatizacion: ['automatizado', 'pendiente'],
  automatizado: [],
};
const REQUIRED_KEYS = ['id', 'ola', 'prioridad', 'tipo', 'automatizacion', 'estado_automatizacion'];
const VALUE_OPTIONS = new Set(['root', 'manifest', 'ola', 'prefix', 'reason', 'file', 'date', 'scope', 'atc', 'spec', 'surface', 'title', 'type', 'severity', 'error-type', 'environment', 'run', 'tipo', 'prioridad', 'bloque', 'seccion', 'funcionalidad', 'riesgo', 'origen', 'oraculo', 'escenario', 'esperado']);
const FLAG_OPTIONS = new Set(['accept', 'dry-run', 'visual']);
const DEFAULT_ROOT = '.context/QA';
const DEFAULT_MANIFEST = 'kata-manifest.json';
const DEFAULT_RESULTS = 'reports/atc_results.json';

class UsageError extends Error {}

// ============================================
// Frontmatter reader (simple `key: value`, flow maps and one-level blocks)
// ============================================

const KEY_LINE = /^([a-z_][\w-]*):(?: (.*))?$/i;
const BOM = String.fromCharCode(0xFEFF);
const stripEol = (line: string): string => line.replace(/\r?\n$/, '');
const eolOf = (line: string): string => (line.endsWith('\r\n') ? '\r\n' : line.endsWith('\n') ? '\n' : '');

/** Split on top-level commas, ignoring commas inside quotes, brackets and braces. */
function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote = '';
  let current = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      current += ch;
      if (ch === '\\' && quote === '"') { current += text[++i] ?? ''; }
      else if (ch === quote) { quote = ''; }
      continue;
    }
    if (ch === '"' || ch === '\'') { quote = ch; }
    else if (ch === '{' || ch === '[') { depth++; }
    else if (ch === '}' || ch === ']') { depth--; }
    else if (ch === ',' && depth === 0) { parts.push(current); current = ''; continue; }
    current += ch;
  }
  if (current.trim() !== '') { parts.push(current); }
  return parts;
}

export function parseValue(raw: string): Value {
  const text = raw.trim();
  if (text === '' || text === '~' || text === 'null') { return text === '' ? '' : null; }
  if (text.startsWith('"')) {
    try { return JSON.parse(text) as string; }
    catch { return text.slice(1, text.endsWith('"') ? -1 : undefined); }
  }
  if (text.startsWith('\'')) { return text.slice(1, text.endsWith('\'') ? -1 : undefined).replace(/''/g, '\''); }
  if (text.startsWith('[') && text.endsWith(']')) { return splitTopLevel(text.slice(1, -1)).map(parseValue); }
  if (text.startsWith('{') && text.endsWith('}')) {
    const map: Record<string, Value> = {};
    for (const part of splitTopLevel(text.slice(1, -1))) {
      const at = part.indexOf(':');
      if (at > 0) { map[part.slice(0, at).trim()] = parseValue(part.slice(at + 1)); }
    }
    return map;
  }
  if (text === 'true') { return true; }
  if (text === 'false') { return false; }
  if (/^-?\d+(?:\.\d+)?$/.test(text)) { return Number(text); }
  return text;
}

export function renderValue(value: Value): string {
  if (value instanceof Bare) { return value.token; }
  if (Array.isArray(value)) { return `[${value.map(renderValue).join(', ')}]`; }
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value).map(([k, v]) => `${k}: ${renderValue(v)}`).join(', ')}}`;
  }
  if (typeof value === 'string') { return JSON.stringify(value); }
  return String(value);
}

/** Lines of the file, each keeping its own line ending. */
const splitLines = (text: string): string[] => text.match(/[^\n]*\n|[^\n]+$/g) ?? [];

/** Index of the closing `---`, or -1 when the file has no frontmatter. */
function frontmatterEnd(lines: string[]): number {
  if (lines.length === 0 || stripEol(lines[0]).replace(BOM, '').trim() !== '---') { return -1; }
  for (let i = 1; i < lines.length; i++) {
    if (stripEol(lines[i]).trim() === '---') { return i; }
  }
  return -1;
}

function readFrontmatter(lines: string[], fmEnd: number): Record<string, Value> {
  const fm: Record<string, Value> = {};
  let block: { key: string, map: Record<string, Value> } | null = null;
  for (let i = 1; i < fmEnd; i++) {
    const line = stripEol(lines[i]);
    if (block && /^\s+\S/.test(line)) {
      const at = line.indexOf(':');
      if (at > 0) { block.map[line.slice(0, at).trim()] = parseValue(line.slice(at + 1)); }
      continue;
    }
    block = null;
    const match = KEY_LINE.exec(line);
    if (!match) { continue; }
    const rest = match[2] ?? '';
    if (rest === '') {
      block = { key: match[1], map: {} };
      fm[match[1]] = block.map;
      if (!/^\s+\S/.test(stripEol(lines[i + 1] ?? ''))) { fm[match[1]] = ''; block = null; }
    }
    else { fm[match[1]] = parseValue(rest); }
  }
  return fm;
}

function buildCase(file: string, prefix: string, lines: string[]): QaCase | null {
  const fmEnd = frontmatterEnd(lines);
  if (fmEnd < 0) { return null; }
  const fm = readFrontmatter(lines, fmEnd);
  const fileId = basename(file, '.md');
  return { id: typeof fm.id === 'string' && fm.id !== '' ? fm.id : fileId, fileId, prefix, file, lines, fmEnd, fm };
}

export function loadCases(root: string): { cases: QaCase[], unreadable: string[] } {
  const cases: QaCase[] = [];
  const unreadable: string[] = [];
  const casesDir = join(root, 'cases');
  if (!existsSync(casesDir)) { return { cases, unreadable }; }
  for (const prefix of readdirSync(casesDir).sort()) {
    const dir = join(casesDir, prefix);
    let names: string[];
    try { names = readdirSync(dir).filter(name => name.endsWith('.md')).sort(); }
    catch { continue; }
    for (const name of names) {
      const file = join(dir, name);
      const parsed = buildCase(file, prefix, splitLines(readFileSync(file, 'utf8')));
      if (parsed) { cases.push(parsed); }
      else { unreadable.push(file); }
    }
  }
  return { cases, unreadable };
}

// ============================================
// Field access
// ============================================

const text = (c: QaCase, key: string): string => {
  const value = c.fm[key];
  return value === undefined || value === null || typeof value === 'object' ? '' : String(value);
};
const objectOf = (c: QaCase, key: string): Record<string, Value> => {
  const value = c.fm[key];
  return value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Bare) ? value : {};
};
const olaOf = (c: QaCase): number => (typeof c.fm.ola === 'number' ? c.fm.ola : 0);
const isKnownDefect = (c: QaCase): boolean => c.fm.defecto_conocido === true;

// ============================================
// Line-targeted writes
// ============================================

/** Replace (or append before the closing fence) one top-level key; touch nothing else. */
export function editedLines(c: QaCase, edits: Edit[]): string[] {
  const lines = [...c.lines];
  let fmEnd = c.fmEnd;
  const fileEol = eolOf(lines[0]) || '\n';
  for (const { key, value } of edits) {
    const rendered = `${key}: ${renderValue(value)}`;
    let start = -1;
    for (let i = 1; i < fmEnd; i++) {
      const match = KEY_LINE.exec(stripEol(lines[i]));
      if (match && match[1] === key) { start = i; break; }
    }
    if (start < 0) {
      lines.splice(fmEnd, 0, rendered + fileEol);
      fmEnd++;
      continue;
    }
    let end = start + 1;
    while (end < fmEnd && /^\s+\S/.test(stripEol(lines[end]))) { end++; }
    lines.splice(start, end - start, rendered + (eolOf(lines[start]) || fileEol));
    fmEnd -= end - start - 1;
  }
  return lines;
}

interface WriteContext { dry: boolean, out: Out }

/** Apply edits to a case: print the change, write unless dry-run, refresh the in-memory case. */
function commit(c: QaCase, edits: Edit[], ctx: WriteContext): void {
  const plain = (v: Value): string => (typeof v === 'string' ? JSON.stringify(v) : renderValue(v));
  // A bare token and the same string read back from disk are the same value.
  const same = (a: Value, b: Value): boolean => plain(a instanceof Bare ? a.token : a) === plain(b instanceof Bare ? b.token : b);
  const changed = edits.filter(({ key, value }) => !(key in c.fm) || !same(c.fm[key], value));
  if (changed.length === 0) { ctx.out(`${c.id}: sin cambios`); return; }
  const lines = editedLines(c, changed);
  for (const { key, value } of changed) {
    ctx.out(`${ctx.dry ? '[dry-run] ' : ''}${c.id}: ${key}: ${key in c.fm ? renderValue(c.fm[key]) : '(ausente)'} -> ${renderValue(value)}`);
  }
  if (ctx.dry) { return; }
  writeFileSync(c.file, lines.join(''));
  const refreshed = buildCase(c.file, c.prefix, lines);
  if (refreshed) { Object.assign(c, refreshed); }
}

function writeText(path: string, content: string, ctx: WriteContext): void {
  if (ctx.dry) { ctx.out(`[dry-run] escribiria ${path} (${content.length} bytes)`); return; }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  ctx.out(`escrito ${path}`);
}

// ============================================
// Queue ordering
// ============================================

const PRIORITY_RANK: Record<string, number> = { A: 0, M: 1, B: 2 };

/** Same rule as the index generator: substring match, so `NF` counts as negative and `Smoke` as security. */
function tipoRank(tipo: string): number {
  if (tipo.includes('S')) { return 0; }
  return tipo.includes('N') ? 1 : 2;
}

const compareCases = (a: QaCase, b: QaCase): number => {
  const olaA = olaOf(a) === 0 ? Number.POSITIVE_INFINITY : olaOf(a);
  const olaB = olaOf(b) === 0 ? Number.POSITIVE_INFINITY : olaOf(b);
  if (olaA !== olaB) { return olaA < olaB ? -1 : 1; }
  const prio = (PRIORITY_RANK[text(a, 'prioridad')] ?? 3) - (PRIORITY_RANK[text(b, 'prioridad')] ?? 3);
  if (prio !== 0) { return prio; }
  const tipo = tipoRank(text(a, 'tipo')) - tipoRank(text(b, 'tipo'));
  if (tipo !== 0) { return tipo; }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
};

export function nextQueue(cases: QaCase[], filter: { ola?: number, prefix?: string } = {}): QaCase[] {
  return cases
    .filter(c => text(c, 'automatizacion') === 'candidate'
      && text(c, 'estado_automatizacion') === 'pendiente'
      && text(c, 'oraculo') !== 'observado'
      && (filter.ola === undefined || olaOf(c) === filter.ola)
      && (filter.prefix === undefined || c.prefix === filter.prefix))
    .sort(compareCases);
}

/** Case ids per wave in the order `prioridad-automatizacion.md` lists them ("Sin ola" = 0). */
export function parseIndexOrder(markdown: string): Map<number, string[]> {
  const waves = new Map<number, string[]>();
  let current: number | null = null;
  for (const line of markdown.split(/\r?\n/)) {
    const heading = /^###\s+(?:Ola\s+(\d+)|Sin ola)\s*$/i.exec(line);
    if (heading) { current = heading[1] ? Number(heading[1]) : 0; waves.set(current, []); continue; }
    if (/^#{1,3}\s/.test(line)) { current = null; continue; }
    const row = /^\|\s*\[([A-Z][A-Z0-9]*-\d+)\]/.exec(line);
    if (row && current !== null) { waves.get(current)?.push(row[1]); }
  }
  return waves;
}

// ============================================
// check
// ============================================

function manifestAtcIds(path: string): Set<string> | null {
  if (!existsSync(path)) { return null; }
  try {
    const manifest = JSON.parse(readFileSync(path, 'utf8')) as { components?: Record<string, { atcs?: { id?: string }[] }[]> };
    const ids = new Set<string>();
    for (const group of Object.values(manifest.components ?? {})) {
      for (const component of group) {
        for (const atc of component.atcs ?? []) { if (atc.id) { ids.add(atc.id); } }
      }
    }
    return ids;
  }
  catch { return null; }
}

export function checkCases(root: string, manifestPath: string): Issue[] {
  const { cases, unreadable } = loadCases(root);
  const issues: Issue[] = [];
  const add = (level: Level, id: string, message: string): void => { issues.push({ level, id, message }); };
  const manifest = manifestAtcIds(manifestPath);

  for (const file of unreadable) { add('ERROR', basename(file, '.md'), 'sin frontmatter (--- ... ---) al inicio del archivo'); }

  const seen = new Map<string, string>();
  for (const c of cases) {
    const previous = seen.get(c.id);
    if (previous) { add('ERROR', c.id, `id duplicado (tambien en ${previous})`); }
    else { seen.set(c.id, c.file); }

    for (const key of REQUIRED_KEYS) {
      if (!(key in c.fm) || text(c, key) === '') { add('ERROR', c.id, `falta el campo obligatorio "${key}"`); }
    }
    if (c.id !== c.fileId) { add('ERROR', c.id, `id "${c.id}" distinto del nombre de archivo "${c.fileId}"`); }

    const verdict = text(c, 'automatizacion');
    const lifecycle = text(c, 'estado_automatizacion');
    const enumCheck = (key: string, value: string, allowed: readonly string[]): void => {
      if (value !== '' && !allowed.includes(value)) { add('ERROR', c.id, `${key}="${value}" fuera de [${allowed.join('|')}]`); }
    };
    enumCheck('automatizacion', verdict, VERDICTS);
    enumCheck('estado_automatizacion', lifecycle, LIFECYCLE);
    enumCheck('prioridad', text(c, 'prioridad'), PRIORITIES);
    if ('ola' in c.fm && (!Number.isInteger(c.fm.ola) || (c.fm.ola as number) < 0)) {
      add('ERROR', c.id, `ola="${text(c, 'ola')}" debe ser un entero >= 0`);
    }

    if (VERDICTS.includes(verdict as typeof VERDICTS[number]) && verdict !== 'candidate' && lifecycle !== '' && lifecycle !== 'pendiente') {
      add('ERROR', c.id, `par ilegal: automatizacion=${verdict} con estado_automatizacion=${lifecycle} (solo "pendiente")`);
    }
    // Legacy files carry no reason for some non-candidates: a WARN here, required by `verdict`.
    if (NEEDS_REASON.has(verdict) && text(c, 'automatizacion_motivo').trim() === '') {
      add('WARN', c.id, `automatizacion=${verdict} sin automatizacion_motivo`);
    }

    const automation = objectOf(c, 'automation');
    if (lifecycle === 'automatizado') {
      const atc = typeof automation.atc === 'string' ? automation.atc : '';
      if (atc === '') { add('ERROR', c.id, 'automatizado sin automation.atc'); }
      else if (manifest && !manifest.has(atc)) { add('ERROR', c.id, `automation.atc="${atc}" no esta en kata-manifest.json`); }
    }
    if ('automation' in c.fm && automation.surface && !['e2e', 'api'].includes(String(automation.surface))) {
      add('ERROR', c.id, `automation.surface="${String(automation.surface)}" fuera de [e2e|api]`);
    }

    const lastRun = objectOf(c, 'last_run');
    if (lastRun.result && !RESULTS.includes(String(lastRun.result) as typeof RESULTS[number])) {
      add('ERROR', c.id, `last_run.result="${String(lastRun.result)}" fuera de [${RESULTS.join('|')}]`);
    }

    const roi = objectOf(c, 'roi');
    for (const [key, value] of Object.entries(roi)) {
      if (key !== 'prior_bug' && typeof value !== 'number') { add('ERROR', c.id, `roi.${key} debe ser numerico`); }
    }

    const oraculo = text(c, 'oraculo');
    if (oraculo !== '' && !ORACLES.includes(oraculo as typeof ORACLES[number])) {
      add('ERROR', c.id, `oraculo="${oraculo}" fuera de [${ORACLES.join('|')}]`);
    }
    if (oraculo === 'observado' && lifecycle !== 'pendiente') {
      add('WARN', c.id, `oraculo=observado con estado_automatizacion=${lifecycle}: el resultado esperado se infirio del sistema y ninguna persona lo confirmo`);
    }
  }

  if (manifest) {
    const prefixes = new Set(cases.map(c => c.prefix));
    for (const atc of [...manifest].sort()) {
      const match = /^([A-Z][A-Z0-9]*)-\d+$/.exec(atc);
      if (match && prefixes.has(match[1]) && !seen.has(atc)) { add('ERROR', atc, '@atc del manifest sin caso en .context/QA/cases'); }
    }
  }

  const indexFile = join(root, 'prioridad-automatizacion.md');
  if (existsSync(indexFile)) {
    const waves = parseIndexOrder(readFileSync(indexFile, 'utf8'));
    for (const [ola, indexIds] of waves) {
      const computed = nextQueue(cases).filter(c => olaOf(c) === ola).map(c => c.id);
      const common = new Set(computed.filter(id => indexIds.includes(id)));
      const mine = computed.filter(id => common.has(id));
      const theirs = indexIds.filter(id => common.has(id));
      const at = mine.findIndex((id, i) => id !== theirs[i]);
      if (at >= 0) { add('INFO', `ola ${ola}`, `el orden de \`next\` difiere de prioridad-automatizacion.md desde la posicion ${at + 1} (${mine[at]} vs ${theirs[at]})`); }
    }
  }
  return issues;
}

function runCheck(root: string, manifestPath: string, out: Out): number {
  const issues = checkCases(root, manifestPath);
  const order: Level[] = ['ERROR', 'WARN', 'INFO'];
  for (const level of order) {
    for (const issue of issues.filter(i => i.level === level)) { out(`${level} ${issue.id}: ${issue.message}`); }
  }
  const count = (level: Level): number => issues.filter(i => i.level === level).length;
  out(`Resumen: ${count('ERROR')} ERROR, ${count('WARN')} WARN, ${count('INFO')} INFO`);
  return count('ERROR') > 0 ? 1 : 0;
}

// ============================================
// index (estado.md)
// ============================================

export function renderEstado(cases: QaCase[], date: string, bugs: QaBug[] = []): string {
  const countBy = (list: QaCase[], key: string, value: string): number => list.filter(c => text(c, key) === value).length;
  const waves = [...new Set(cases.map(olaOf))].sort((a, b) => (a === 0 ? 99 : a) - (b === 0 ? 99 : b));
  const row = (label: string, list: QaCase[]): string => {
    const candidates = list.filter(c => text(c, 'automatizacion') === 'candidate');
    const cells = LIFECYCLE.map(state => countBy(candidates, 'estado_automatizacion', state));
    const others = ['manual', 'deferred', 'no_aplica'].map(v => countBy(list, 'automatizacion', v));
    const lastRuns = list.map(c => String(objectOf(c, 'last_run').date ?? '')).filter(Boolean).sort();
    return `| ${label} | ${list.length} | ${cells.join(' | ')} | ${others.join(' | ')} | ${lastRuns.at(-1) ?? '-'} |`;
  };
  const header = '| | Casos | pendiente | en_automatizacion | automatizado | manual | deferred | no_aplica | Ultima corrida |\n|---|---|---|---|---|---|---|---|---|';
  const out: string[] = [
    '# Estado de automatizacion',
    '',
    `<!-- GENERADO por \`bun run qa:local index\` el ${date}. No editar a mano. -->`,
    '',
    `Total: ${cases.length} casos. Lifecycle (pendiente / en_automatizacion / automatizado) solo cuenta casos con automatizacion=candidate.`,
    '',
    '## Por ola',
    '',
    header,
    ...waves.map(ola => row(ola === 0 ? 'Sin ola' : `Ola ${ola}`, cases.filter(c => olaOf(c) === ola))),
    '',
    '## Por prefijo',
    '',
    header,
    ...[...new Set(cases.map(c => c.prefix))].sort().map(prefix => row(prefix, cases.filter(c => c.prefix === prefix))),
    '',
  ];

  const section = (title: string, lines: string[], empty: string): void => {
    out.push(`## ${title}`, '', ...(lines.length > 0 ? lines : [empty]), '');
  };
  const failing = cases.filter(c => ['FAIL', 'EXPECTED_FAIL'].includes(String(objectOf(c, 'last_run').result)));
  section('Ultima corrida con fallos', failing.map(c => `- ${c.id}: ${String(objectOf(c, 'last_run').result)} (${String(objectOf(c, 'last_run').run ?? '')})`), '_Ninguno._');
  const unexpected = cases.filter(c => objectOf(c, 'last_run').result === 'UNEXPECTED_PASS');
  section('UNEXPECTED_PASS', unexpected.map(c => `- ${c.id} (${text(c, 'id_defecto')}): defecto probablemente corregido; quitar la anotacion, reverificar y actualizar id_defecto`), '_Ninguno._');
  const defects = cases.filter(isKnownDefect);
  section(`Defectos conocidos (${defects.length})`, defects.map(c => `- ${c.id}: ${text(c, 'id_defecto')}`), '_Ninguno._');
  const pending = bugs
    .filter(b => b.report && ['open', 'fixed'].includes(text(b.report, 'status')))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const countStatus = (status: string): number => pending.filter(b => b.report && text(b.report, 'status') === status).length;
  section(`Bugs (open ${countStatus('open')}, fixed pending verification ${countStatus('fixed')})`, pending.map(b => `- ${b.id}: ${text(b.report as QaCase, 'severity')}, ${text(b.report as QaCase, 'status')}, caso ${text(b.report as QaCase, 'case')}`), '_Ninguno._');
  const queue = nextQueue(cases).slice(0, 10);
  section('Siguientes 10', queue.map((c, i) => `${i + 1}. ${c.id} (ola ${olaOf(c)}, ${text(c, 'prioridad')}, ${text(c, 'tipo')})`), '_Cola vacia._');
  return `${out.join('\n').trimEnd()}\n`;
}

// ============================================
// results
// ============================================

interface AtcEntry { status?: string }

function aggregate(entries: AtcEntry[]): 'PASS' | 'FAIL' | 'SKIP' {
  if (entries.some(e => e.status === 'FAIL')) { return 'FAIL'; }
  if (entries.length > 0 && entries.every(e => e.status === 'SKIP')) { return 'SKIP'; }
  return 'PASS';
}

const localDate = (): string => {
  const now = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
};

function runResults(root: string, opts: Options, cases: QaCase[], ctx: WriteContext): number {
  const file = resolve(opts.values.file ?? DEFAULT_RESULTS);
  if (!existsSync(file)) {
    ctx.out(`No hay resultados que ingerir: ${file} no existe (correr la suite primero). Nada cambia.`);
    return 0;
  }
  let report: { results?: Record<string, AtcEntry[]> };
  try { report = JSON.parse(readFileSync(file, 'utf8')) as typeof report; }
  catch { throw new UsageError(`${file} no es JSON valido`); }

  const date = opts.values.date ?? localDate();
  const byId = new Map(cases.map(c => [c.id, c]));
  const matched: { c: QaCase, raw: string, result: string, executions: number }[] = [];
  const ignored: string[] = [];
  for (const [id, entries] of Object.entries(report.results ?? {})) {
    const c = byId.get(id);
    if (!c) { ignored.push(id); continue; }
    const raw = aggregate(entries);
    const result = isKnownDefect(c) && raw === 'FAIL' ? 'EXPECTED_FAIL' : isKnownDefect(c) && raw === 'PASS' ? 'UNEXPECTED_PASS' : raw;
    matched.push({ c, raw, result, executions: entries.length });
  }
  if (matched.length === 0) {
    ctx.out(`Ningun resultado de ${file} corresponde a un caso. Nada cambia.`);
    return 0;
  }

  const olas = new Set(matched.map(m => olaOf(m.c)));
  const prefixes = new Set(matched.map(m => m.c.prefix));
  const scope = opts.values.scope ?? (olas.size === 1 && !olas.has(0) ? `ola-${[...olas][0]}` : prefixes.size === 1 ? [...prefixes][0] : 'mixto');
  const run = `${date}-${scope}`;
  const accepted: string[] = [];

  for (const { c, result } of matched) {
    const edits: Edit[] = [{ key: 'last_run', value: { date, result: bare(result), run } }];
    const passing = result === 'PASS' || result === 'EXPECTED_FAIL';
    if (opts.flags.has('accept') && passing && text(c, 'estado_automatizacion') === 'en_automatizacion') {
      edits.push({ key: 'estado_automatizacion', value: bare('automatizado') });
      const automation = objectOf(c, 'automation');
      if (!automation.atc) { edits.push({ key: 'automation', value: { surface: automation.surface ?? '', spec: automation.spec ?? '', atc: c.id } }); }
      accepted.push(c.id);
    }
    commit(c, edits, ctx);
  }

  const runDir = join(root, 'runs', run);
  const runJson = {
    run,
    date,
    scope,
    source: file,
    accept: opts.flags.has('accept'),
    accepted,
    results: matched.map(m => ({ id: m.c.id, result: m.result, raw: m.raw, executions: m.executions })),
    ignored,
  };
  const runMd = [
    `# Corrida ${run}`,
    '',
    `Fuente: \`${file}\`. Aceptados (en_automatizacion -> automatizado): ${accepted.join(', ') || 'ninguno'}.`,
    '',
    '| Caso | Resultado | Crudo | Ejecuciones |',
    '|---|---|---|---|',
    ...matched.map(m => `| ${m.c.id} | ${m.result} | ${m.raw} | ${m.executions} |`),
    ...(matched.some(m => m.result === 'UNEXPECTED_PASS') ? ['', 'UNEXPECTED_PASS: defecto probablemente corregido; quitar la anotacion, reverificar y actualizar id_defecto.'] : []),
    '',
  ].join('\n');
  writeText(join(runDir, 'run.json'), `${JSON.stringify(runJson, null, 2)}\n`, ctx);
  writeText(join(runDir, 'run.md'), runMd, ctx);
  ctx.out(`Corrida ${run}: ${matched.length} casos${ignored.length > 0 ? `, ${ignored.length} ids sin caso ignorados` : ''}.`);
  return 0;
}

// ============================================
// bug (new | status | check): <root>/bugs/<case id>-BUG-<n>/report.md
// ============================================

const BUG_STATUSES = ['open', 'fixed', 'verified'] as const;
const LEGAL_BUG_STATUS: Record<string, string[]> = { open: ['fixed'], fixed: ['verified', 'open'], verified: ['open'] };
const BUG_TYPES = ['Bug', 'Defect', 'Improvement'] as const;
/** Severity matrix and priority mapping of reporting-templates.md 1.4 / 1.5. */
const SEVERITY_PRIORITY: Record<string, string> = { Critical: 'Highest', Major: 'High', Moderate: 'Medium', Minor: 'Low', Trivial: 'Lowest' };
const BUG_ERROR_TYPES = ['Functional', 'Visual', 'Content', 'Performance', 'Crash', 'Data', 'Integration', 'Security'] as const;
const BUG_ENVIRONMENTS = ['Dev', 'QA', 'UAT', 'Staging', 'Production'] as const;
const FORBIDDEN_BUG_FILE = /\.(?:zip|har|webm|env|trace)$/i;
const BINARY_FILE = /\.(?:png|jpe?g|gif|webp|bmp|ico|mp4|mov|pdf)$/i;
/** Secret shapes. Only the pattern NAME and the count are ever reported, never the match. */
const SECRET_PATTERNS: { name: string, re: RegExp }[] = [
  { name: 'jwt', re: /eyJ[\w-]+\.eyJ[\w-]+\.[\w-]+/g },
  { name: 'bearer', re: /\bBearer\s+[\w.~+/=-]{8,}/gi },
  { name: 'set-cookie', re: /Set-Cookie\s*:/gi },
  { name: 'cookie', re: /\bCookie\s*:\s*\S+/gi },
  { name: 'credencial', re: /\b(?:password|refresh_token|access_token|csrf)\w*["']?\s*[=:]\s*["']?[^\s"',;}]+/gi },
];

export interface QaBug { id: string, dir: string, report: QaCase | null }

const bugsDirOf = (root: string): string => join(root, 'bugs');

export function loadBugs(root: string): QaBug[] {
  const base = bugsDirOf(root);
  if (!existsSync(base)) { return []; }
  return readdirSync(base, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
    .map((name) => {
      const dir = join(base, name);
      const file = join(dir, 'report.md');
      return { id: name, dir, report: existsSync(file) ? buildCase(file, '', splitLines(readFileSync(file, 'utf8'))) : null };
    });
}

/** Highest existing `-BUG-<k>` folder number across ALL cases + 1 (1 when there is none). */
export function nextBugNumber(bugsDir: string): number {
  if (!existsSync(bugsDir)) { return 1; }
  const pattern = /^.+-BUG-(\d+)$/;
  let highest = 0;
  for (const name of readdirSync(bugsDir)) {
    const match = pattern.exec(name);
    if (match) { highest = Math.max(highest, Number(match[1])); }
  }
  return highest + 1;
}

/** Claim the next bug number with a NON-recursive mkdir; EEXIST means another session won it, so take the next. */
export function allocateBugFolder(
  bugsDir: string,
  caseId: string,
  mk: (path: string) => void = (path) => { mkdirSync(path); },
): { n: number, dir: string } {
  mkdirSync(bugsDir, { recursive: true });
  let n = nextBugNumber(bugsDir);
  for (;;) {
    const dir = join(bugsDir, `${caseId}-BUG-${n}`);
    try { mk(dir); return { n, dir }; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') { throw error; }
      n++;
    }
  }
}

/** The case's own `## Resultado esperado` text (empty when absent). */
function expectedResultOf(c: QaCase): string {
  const body = c.lines.slice(c.fmEnd + 1).map(stripEol);
  const start = body.findIndex(line => /^##\s+Resultado esperado\s*$/i.test(line));
  if (start < 0) { return ''; }
  const next = body.findIndex((line, i) => i > start && /^#{1,2}\s/.test(line));
  return body.slice(start + 1, next < 0 ? body.length : next).join('\n').trim();
}

function pickOption(opts: Options, name: string, allowed: readonly string[], fallback: string): string {
  const value = opts.values[name] ?? fallback;
  if (!allowed.includes(value)) { throw new UsageError(`--${name} invalido "${value}" (${allowed.join('|')})`); }
  return value;
}

function renderBugReport(fields: { id: string, caseId: string, title: string, type: string, severity: string, errorType: string, environment: string, run: string, date: string, visual: boolean, expected: string }): string {
  const pending = '(por completar)';
  const lines = [
    '---',
    `id: ${fields.id}`,
    `case: ${fields.caseId}`,
    `title: ${renderValue(fields.title)}`,
    `type: ${fields.type}`,
    `severity: ${fields.severity}`,
    `priority: ${SEVERITY_PRIORITY[fields.severity]}`,
    `error_type: ${fields.errorType}`,
    `environment: ${fields.environment}`,
    'status: open',
    `found_by: ${renderValue(fields.run)}`,
    `found_on: ${fields.date}`,
    `visual: ${fields.visual}`,
    'evidence: []',
    '---',
    '',
    `# ${fields.id}`,
    '',
    '## Resumen',
    '',
    pending,
    '',
    '## Pasos para reproducir',
    '',
    '1. ',
    '',
    '## Resultado actual',
    '',
    pending,
    '',
    '## Resultado esperado',
    '',
    ...(fields.expected === '' ? [pending] : fields.expected.split('\n').map(l => l.replace(/\r$/, ''))),
    '',
    '## Analisis tecnico',
    '',
    pending,
    '',
    '## Impacto',
    '',
    pending,
    '',
    '## Causa raiz',
    '',
    'por investigar',
    '',
    '## Workaround',
    '',
    pending,
    '',
    '## Evidencia',
    '',
    pending,
    '',
    '## Casos relacionados',
    '',
    fields.caseId,
    '',
  ];
  return lines.join('\r\n');
}

function runBugNew(root: string, opts: Options, caseId: string | undefined, cases: QaCase[], ctx: WriteContext): void {
  const c = findCase(cases, caseId);
  const type = pickOption(opts, 'type', BUG_TYPES, 'Defect');
  const severity = pickOption(opts, 'severity', Object.keys(SEVERITY_PRIORITY), 'Moderate');
  const errorType = pickOption(opts, 'error-type', BUG_ERROR_TYPES, 'Functional');
  const environment = pickOption(opts, 'environment', BUG_ENVIRONMENTS, 'Dev');
  const bugs = bugsDirOf(root);
  if (ctx.dry) {
    const n = nextBugNumber(bugs);
    ctx.out(`[dry-run] ${c.id}-BUG-${n} (carpeta ${join(bugs, `${c.id}-BUG-${n}`)}); no se escribe nada`);
    return;
  }
  const { n, dir } = allocateBugFolder(bugs, c.id);
  const id = `${c.id}-BUG-${n}`;
  const report = renderBugReport({
    id,
    caseId: c.id,
    title: opts.values.title ?? '(por completar)',
    type,
    severity,
    errorType,
    environment,
    run: opts.values.run ?? '',
    date: opts.values.date ?? localDate(),
    visual: opts.flags.has('visual'),
    expected: expectedResultOf(c),
  });
  try { writeFileSync(join(dir, 'report.md'), report); }
  catch (error) { rmdirSync(dir); throw error; }
  ctx.out(id);
  ctx.out(`carpeta: ${dir}`);
}

function runBugStatus(root: string, id: string | undefined, target: string | undefined, ctx: WriteContext): void {
  const bug = loadBugs(root).find(b => b.id === id);
  if (!id || !bug) { throw new UsageError(`bug no encontrado: ${id ?? ''}`); }
  if (!target || !BUG_STATUSES.includes(target as typeof BUG_STATUSES[number])) {
    throw new UsageError(`estado de bug invalido "${target ?? ''}" (${BUG_STATUSES.join('|')})`);
  }
  if (!bug.report) { throw new UsageError(`${id}: report.md ausente o sin frontmatter`); }
  const current = text(bug.report, 'status');
  if (current === target) { ctx.out(`${id}: sin cambios`); return; }
  if (!(LEGAL_BUG_STATUS[current] ?? []).includes(target)) {
    throw new UsageError(`transicion ilegal ${current || '(vacio)'} -> ${target} (permitidas desde ${current}: ${(LEGAL_BUG_STATUS[current] ?? []).join(', ') || 'ninguna'})`);
  }
  commit(bug.report, [{ key: 'status', value: bare(target) }], ctx);
}

function filesUnder(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) { found.push(...filesUnder(path)); }
    else { found.push(path); }
  }
  return found.sort();
}

/** Problems of one bug folder. Messages carry names and counts only, never matched text. */
function checkBug(bug: QaBug, caseIds: Set<string>): string[] {
  const problems: string[] = [];
  const report = bug.report;
  if (!report) { problems.push('report.md ausente o sin frontmatter'); }
  else {
    if (text(report, 'id') !== bug.id) { problems.push(`id "${text(report, 'id')}" distinto de la carpeta "${bug.id}"`); }
    const caseId = text(report, 'case');
    if (!caseIds.has(caseId)) { problems.push(`caso "${caseId}" sin archivo de caso`); }
    const enums: [string, readonly string[]][] = [['status', BUG_STATUSES], ['severity', Object.keys(SEVERITY_PRIORITY)], ['type', BUG_TYPES]];
    for (const [key, allowed] of enums) {
      if (!allowed.includes(text(report, key))) { problems.push(`${key}="${text(report, key)}" fuera de [${allowed.join('|')}]`); }
    }
    const evidence = Array.isArray(report.fm.evidence) ? report.fm.evidence : [];
    for (const item of evidence) {
      if (typeof item === 'string' && !existsSync(resolve(bug.dir, item))) { problems.push(`evidence lista un archivo ausente: ${item}`); }
    }
  }
  for (const file of filesUnder(bug.dir)) {
    const name = relative(bug.dir, file).replace(/\\/g, '/');
    if (FORBIDDEN_BUG_FILE.test(name)) { problems.push(`archivo prohibido en la carpeta: ${name}`); continue; }
    if (BINARY_FILE.test(name)) { continue; }
    const content = readFileSync(file, 'utf8');
    for (const { name: pattern, re } of SECRET_PATTERNS) {
      const hits = content.match(re)?.length ?? 0;
      if (hits > 0) { problems.push(`posible secreto (${pattern}) en ${name}: ${hits} coincidencia(s)`); }
    }
  }
  return problems;
}

function runBugCheck(root: string, id: string | undefined, out: Out): number {
  const all = loadBugs(root);
  const selected = id === undefined ? all : all.filter(b => b.id === id);
  if (id !== undefined && selected.length === 0) { throw new UsageError(`bug no encontrado: ${id}`); }
  if (selected.length === 0) { out('sin bugs'); return 0; }
  const caseIds = new Set(loadCases(root).cases.map(c => c.id));
  let errors = 0;
  for (const bug of selected) {
    for (const problem of checkBug(bug, caseIds)) { out(`ERROR ${bug.id}: ${problem}`); errors++; }
  }
  out(`Resumen: ${selected.length} bugs, ${errors} ERROR`);
  return errors > 0 ? 1 : 0;
}

function runBug(root: string, opts: Options, args: string[], ctx: WriteContext): number {
  const [action, first, second] = args;
  switch (action) {
    case 'new':
      runBugNew(root, opts, first, loadCases(root).cases, ctx);
      return 0;
    case 'status':
      runBugStatus(root, first, second, ctx);
      return 0;
    case 'check':
      return runBugCheck(root, first, ctx.out);
    default:
      throw new UsageError(`accion de bug desconocida: ${action ?? '(ninguna)'} (new|status|check)`);
  }
}

// ============================================
// case (new, confirm): create a case file, confirm an inferred expected result
// ============================================

const CASE_PREFIX = /^[A-Z][A-Z0-9]{1,5}$/;

/** Highest existing `<PREFIX>-<k>.md` number in the prefix folder + 1 (1 when there is none). */
export function nextCaseNumber(dir: string, prefix: string): number {
  if (!existsSync(dir)) { return 1; }
  const pattern = new RegExp(`^${prefix}-(\\d+)\\.md$`);
  let highest = 0;
  for (const name of readdirSync(dir)) {
    const match = pattern.exec(name);
    if (match) { highest = Math.max(highest, Number(match[1])); }
  }
  return highest + 1;
}

const caseIdOf = (prefix: string, n: number): string => `${prefix}-${String(n).padStart(3, '0')}`;

/** Claim the next case file with an exclusive create; EEXIST means another session won it, so take the next. */
export function allocateCaseFile(
  dir: string,
  prefix: string,
  render: (id: string) => string,
  write: (path: string, content: string) => void = (path, content) => { writeFileSync(path, content, { flag: 'wx' }); },
): { id: string, file: string } {
  mkdirSync(dir, { recursive: true });
  let n = nextCaseNumber(dir, prefix);
  for (;;) {
    const id = caseIdOf(prefix, n);
    const file = join(dir, `${id}.md`);
    try { write(file, render(id)); return { id, file }; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') { throw error; }
      n++;
    }
  }
}

interface NewCaseFields {
  id: string
  bloque: string
  seccion: string
  funcionalidad: string
  riesgo: string
  origen: string
  tipo: string
  prioridad: string
  ola: number
  oraculo: string
  title: string
  escenario: string
  esperado: string
}

function renderNewCase(f: NewCaseFields): string {
  const q = (v: string): string => JSON.stringify(v);
  const front = [
    '---',
    `id: ${f.id}`,
    `bloque: ${q(f.bloque)}`,
    `seccion: ${q(f.seccion)}`,
    `tipo: ${q(f.tipo)}`,
    `prioridad: ${q(f.prioridad)}`,
    `ola: ${f.ola}`,
    `funcionalidad: ${q(f.funcionalidad)}`,
    `riesgo_mapa: ${q(f.riesgo)}`,
    'automatizacion: candidate',
    'automatizacion_motivo: ""',
    'estado_automatizacion: pendiente',
    `origen: ${q(f.origen)}`,
    `oraculo: ${f.oraculo}`,
    '---',
  ];
  const body = [
    '',
    `# ${f.id}`,
    '',
    '## Escenario',
    '',
    f.escenario || f.title,
    '',
    '## Resultado esperado',
    '',
    f.esperado || '(por completar)',
    '',
    '## Observaciones / evidencia de la ejecucion manual',
    '',
    '(sin ejecucion manual)',
    '',
  ];
  return [...front, ...body].join('\n');
}

function runCaseNew(root: string, opts: Options, prefix: string | undefined, ctx: WriteContext): void {
  if (!prefix || !CASE_PREFIX.test(prefix)) {
    throw new UsageError(`prefijo invalido "${prefix ?? ''}" (mayusculas y digitos, 2 a 6 caracteres, empieza con letra: AUT, TEN2)`);
  }
  const title = (opts.values.title ?? '').trim();
  if (title === '') { throw new UsageError('falta --title "<titulo del caso>"'); }
  const prioridad = pickOption(opts, 'prioridad', PRIORITIES, 'M');
  const oraculo = pickOption(opts, 'oraculo', ORACLES.filter(o => o !== 'confirmado'), 'historia');
  const ola = opts.values.ola === undefined ? 0 : Number(opts.values.ola);
  if (!Number.isInteger(ola) || ola < 0) { throw new UsageError(`--ola invalido: ${opts.values.ola}`); }
  const dir = join(root, 'cases', prefix);
  const fields = (id: string): NewCaseFields => ({
    id,
    bloque: opts.values.bloque ?? '',
    seccion: opts.values.seccion ?? '',
    funcionalidad: opts.values.funcionalidad ?? '',
    riesgo: opts.values.riesgo ?? '',
    origen: opts.values.origen ?? '',
    tipo: opts.values.tipo ?? 'P',
    prioridad,
    ola,
    oraculo,
    title,
    escenario: opts.values.escenario ?? '',
    esperado: opts.values.esperado ?? '',
  });
  if (ctx.dry) {
    ctx.out(`[dry-run] ${caseIdOf(prefix, nextCaseNumber(dir, prefix))} (carpeta ${dir}); no se escribe nada`);
    return;
  }
  const { id, file } = allocateCaseFile(dir, prefix, id => renderNewCase(fields(id)));
  ctx.out(id);
  ctx.out(`archivo: ${file}`);
}

function runCaseConfirm(c: QaCase, ctx: WriteContext): void {
  if (text(c, 'oraculo') !== 'observado') {
    throw new UsageError(`${c.id}: oraculo=${text(c, 'oraculo') || '(ausente)'}; solo un caso con oraculo=observado se confirma`);
  }
  commit(c, [{ key: 'oraculo', value: bare('confirmado') }], ctx);
}

function runCase(root: string, opts: Options, args: string[], ctx: WriteContext): number {
  const [action, first] = args;
  switch (action) {
    case 'new':
      runCaseNew(root, opts, first, ctx);
      return 0;
    case 'confirm':
      runCaseConfirm(findCase(loadCases(root).cases, first), ctx);
      return 0;
    default:
      throw new UsageError(`accion de case desconocida: ${action ?? '(ninguna)'} (new|confirm)`);
  }
}

// ============================================
// Argument parsing and verb dispatch
// ============================================

export function parseArgs(argv: string[]): Options {
  const opts: Options = { positional: [], values: {}, flags: new Set() };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const name = arg.slice(2);
      if (VALUE_OPTIONS.has(name)) {
        const value = argv[++i];
        if (value === undefined) { throw new UsageError(`--${name} requiere un valor`); }
        opts.values[name] = value;
      }
      else if (FLAG_OPTIONS.has(name)) { opts.flags.add(name); }
      else { throw new UsageError(`opcion desconocida: ${arg}`); }
    }
    else { opts.positional.push(arg); }
  }
  return opts;
}

const USAGE = [
  'Uso: bun run qa:local <verbo> [args] [--root <dir>] [--dry-run]',
  '  check | index | next [N] [--ola K] [--prefix P]',
  '  verdict <ID> <candidate|manual|deferred|no_aplica> [--reason "..."]',
  '  status <ID> <pendiente|en_automatizacion|automatizado> [--atc X --spec P --surface e2e|api]',
  '  defect <ID> <ref>   (solo tras una corrida automatizada fallida: last_run.result=FAIL)',
  '  results [--file reports/atc_results.json] [--accept] [--scope S]',
  '  bug new <ID> [--title T --type Bug|Defect|Improvement --severity Critical|Major|Moderate|Minor|Trivial',
  '                --error-type E --environment ENV --run R --visual]   (--dry-run: solo imprime el id)',
  '  case new <PREFIX> --title T [--tipo P --prioridad A|M|B --ola K --bloque B --seccion S --funcionalidad F',
  '               --riesgo R --origen O --oraculo historia|observado --escenario "..." --esperado "..."]   (--dry-run: solo imprime el id)',
  '  case confirm <ID>   (oraculo observado -> confirmado, tras la decision de una persona)',
  '  bug status <bug id> <open|fixed|verified>',
  '  bug check [<bug id>]   (solo lectura: enums, enlaces, archivos prohibidos, secretos; sin imprimir el valor)',
].join('\n');

function findCase(cases: QaCase[], id: string | undefined): QaCase {
  if (!id) { throw new UsageError('falta el <ID> del caso'); }
  const found = cases.find(c => c.id === id);
  if (!found) { throw new UsageError(`caso no encontrado: ${id}`); }
  return found;
}

function runVerdict(c: QaCase, verdict: string | undefined, reason: string | undefined, ctx: WriteContext): void {
  if (!verdict || !VERDICTS.includes(verdict as typeof VERDICTS[number])) {
    throw new UsageError(`veredicto invalido "${verdict ?? ''}" (${VERDICTS.join('|')})`);
  }
  if (NEEDS_REASON.has(verdict) && (reason ?? '').trim() === '') {
    throw new UsageError(`el veredicto ${verdict} requiere --reason "<motivo>"`);
  }
  if (verdict !== 'candidate' && text(c, 'estado_automatizacion') !== 'pendiente') {
    throw new UsageError(`${c.id} esta en ${text(c, 'estado_automatizacion')}: volver a pendiente antes de cambiar el veredicto a ${verdict}`);
  }
  const edits: Edit[] = [{ key: 'automatizacion', value: bare(verdict) }];
  if (reason !== undefined || verdict !== 'candidate') { edits.push({ key: 'automatizacion_motivo', value: reason ?? '' }); }
  commit(c, edits, ctx);
}

function runStatus(c: QaCase, target: string | undefined, opts: Options, ctx: WriteContext): void {
  if (!target || !LIFECYCLE.includes(target as typeof LIFECYCLE[number])) {
    throw new UsageError(`estado invalido "${target ?? ''}" (${LIFECYCLE.join('|')})`);
  }
  const current = text(c, 'estado_automatizacion');
  if (text(c, 'automatizacion') !== 'candidate') {
    throw new UsageError(`${c.id} tiene automatizacion=${text(c, 'automatizacion')}: solo los candidate cambian de estado`);
  }
  if (current === target) { ctx.out(`${c.id}: ya esta en ${target}`); return; }
  if (!(LEGAL_STATUS[current] ?? []).includes(target)) {
    throw new UsageError(`transicion ilegal ${current} -> ${target} (permitidas desde ${current}: ${(LEGAL_STATUS[current] ?? []).join(', ') || 'ninguna'})`);
  }
  const edits: Edit[] = [{ key: 'estado_automatizacion', value: bare(target) }];
  if (opts.values.atc || opts.values.spec || opts.values.surface) {
    const surface = opts.values.surface ?? '';
    if (surface && !['e2e', 'api'].includes(surface)) { throw new UsageError('--surface debe ser e2e o api'); }
    const previous = objectOf(c, 'automation');
    edits.push({ key: 'automation', value: {
      surface: surface || previous.surface || '',
      spec: opts.values.spec ?? previous.spec ?? '',
      atc: opts.values.atc ?? previous.atc ?? c.id,
    } });
  }
  commit(c, edits, ctx);
}

/** Run one verb. Returns the process exit code; every message goes through `out`. */
export function run(argv: string[], out: Out = console.log): number {
  try {
    const opts = parseArgs(argv);
    const [verb, ...args] = opts.positional;
    if (!verb) { out(USAGE); return 1; }
    const root = resolve(opts.values.root ?? DEFAULT_ROOT);
    const manifestPath = resolve(opts.values.manifest ?? DEFAULT_MANIFEST);
    const ctx: WriteContext = { dry: opts.flags.has('dry-run'), out };
    if (!['check', 'index', 'next', 'verdict', 'status', 'defect', 'results', 'bug', 'case'].includes(verb)) {
      throw new UsageError(`verbo desconocido: ${verb}`);
    }
    if (verb === 'check') { return runCheck(root, manifestPath, out); }
    if (verb === 'bug') { return runBug(root, opts, args, ctx); }
    if (verb === 'case') { return runCase(root, opts, args, ctx); }

    const { cases } = loadCases(root);
    if (cases.length === 0) { throw new UsageError(`no hay casos en ${join(root, 'cases')}`); }

    switch (verb) {
      case 'next': {
        const limit = args[0] === undefined ? 10 : Number(args[0]);
        if (!Number.isInteger(limit) || limit < 1) { throw new UsageError(`N invalido: ${args[0]}`); }
        const ola = opts.values.ola === undefined ? undefined : Number(opts.values.ola);
        if (ola !== undefined && !Number.isInteger(ola)) { throw new UsageError(`--ola invalido: ${opts.values.ola}`); }
        const queue = nextQueue(cases, { ola, prefix: opts.values.prefix });
        out(`Cola: ${queue.length} casos candidate+pendiente; mostrando ${Math.min(limit, queue.length)}.`);
        queue.slice(0, limit).forEach((c, i) => {
          out(`${String(i + 1).padStart(3)}. ${c.id}  ola ${olaOf(c)}  ${text(c, 'prioridad')}  ${text(c, 'tipo')}  ${text(c, 'funcionalidad')}`);
        });
        return 0;
      }
      case 'index':
        writeText(join(root, 'estado.md'), renderEstado(cases, opts.values.date ?? localDate(), loadBugs(root)), ctx);
        return 0;
      case 'verdict':
        runVerdict(findCase(cases, args[0]), args[1], opts.values.reason, ctx);
        return 0;
      case 'status':
        runStatus(findCase(cases, args[0]), args[1], opts, ctx);
        return 0;
      case 'defect': {
        const c = findCase(cases, args[0]);
        const ref = (args[1] ?? '').trim();
        if (ref === '') { throw new UsageError('falta la referencia del defecto'); }
        if (text(c, 'automatizacion') !== 'candidate' || objectOf(c, 'last_run').result !== 'FAIL') {
          throw new UsageError(`${c.id}: el caso no tiene una corrida automatizada fallida (last_run.result=FAIL en un candidate); correr \`qa:local results\` primero`);
        }
        commit(c, [{ key: 'id_defecto', value: ref }, { key: 'defecto_conocido', value: true }], ctx);
        return 0;
      }
      default:
        return runResults(root, opts, cases, ctx);
    }
  }
  catch (error) {
    if (error instanceof UsageError) { out(`ERROR: ${error.message}`); return 1; }
    throw error;
  }
}

if (import.meta.main) {
  process.exit(run(process.argv.slice(2)));
}
