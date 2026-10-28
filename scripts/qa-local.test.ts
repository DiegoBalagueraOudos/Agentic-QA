/**
 * Regression tests for `scripts/qa-local.ts`, the local QA case store. What
 * they guard:
 *   1. `check`: schema and enum errors, id == filename, duplicate ids, illegal
 *      verdict/lifecycle pairs, WARN/INFO never failing the exit code.
 *   2. `next`: the ordering (ola, prioridad, tipo, id) and the exclusion rules;
 *      legacy manual-run fields are tolerated and ignored (decision D1).
 *   3. `verdict` / `status` / `defect`: legal and illegal changes, the reason
 *      rule, and that a write touches ONE line (every other byte, CRLF
 *      included, is identical).
 *   4. `results`: PASS/FAIL/SKIP folding, EXPECTED_FAIL / UNEXPECTED_PASS and
 *      `--accept`.
 *   5. `--dry-run` writes nothing; `index` renders estado.md.
 * Every fixture lives in a temp directory created here; the real
 * `.context/QA` is only READ by the last test.
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import * as qaLocal from './qa-local.ts';
import { parseIndexOrder, run } from './qa-local.ts';

let root: string;
let printed: string[];
const out = (line: string): void => { printed.push(line); };
// Every call gets an empty manifest of its own unless the test passes one, so the
// result never depends on the ATCs the real kata-manifest.json holds at that moment.
const qa = (...args: string[]): number => run(
  [...args, '--root', root, ...(args.includes('--manifest') ? [] : ['--manifest', join(root, 'default-manifest.json')])],
  out,
);
const output = (): string => printed.join('\n');

interface Fixture { id: string, ola?: number, prioridad?: string, tipo?: string, [key: string]: string | number | undefined }

/** Write a case file the way the converter does (CRLF), with a body that must never change. */
function writeCase(fixture: Fixture): string {
  const base: Record<string, string | number | undefined> = {
    bloque: '"BLOQUE 1"',
    tipo: '"P"',
    prioridad: '"A"',
    ola: 1,
    funcionalidad: '"FEAT-001 Authentication"',
    automatizacion: 'candidate',
    automatizacion_motivo: '""',
    estado_automatizacion: 'pendiente',
    origen: 'MATRIZ.xlsx / Casos de prueba',
  };
  const merged: Record<string, string | number | undefined> = { id: fixture.id, ...base };
  for (const [key, value] of Object.entries(fixture)) {
    if (value !== undefined && (key === 'tipo' || key === 'prioridad')) { merged[key] = `"${String(value)}"`; }
    else { merged[key] = value; }
  }
  const prefix = fixture.id.split('-')[0];
  const dir = join(root, 'cases', prefix);
  mkdirSync(dir, { recursive: true });
  const frontmatter = Object.entries(merged).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}: ${v}`);
  const body = ['', `# ${fixture.id}`, '', '## Escenario', '', 'Texto con tildes: autenticación – ok', '', '## Resultado esperado', '', 'Sesión creada', ''];
  const file = join(dir, `${fixture.id}.md`);
  writeFileSync(file, ['---', ...frontmatter, '---', ...body].join('\r\n'));
  return file;
}

const read = (id: string): string => readFileSync(join(root, 'cases', id.split('-')[0], `${id}.md`), 'utf8');

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'qa-local-'));
  writeFileSync(join(root, 'default-manifest.json'), JSON.stringify({ components: { api: [], ui: [] } }));
  printed = [];
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const LEGACY_FALLO = { ejecucion_manual: 'fallo', id_defecto: '""', ejecutado_por: '"Ana"', fecha_ejecucion: '"2026-01-02"' };
const LEGACY_BLOQUEADO = { ejecucion_manual: 'bloqueado', id_defecto: '""', ejecutado_por: '"Ana"', fecha_ejecucion: '"2026-01-02"', bloqueo: '"falta biometria"' };

describe('check', () => {
  it('passes a clean tree and prints the summary', () => {
    writeCase({ id: 'AUT-001' });
    expect(qa('check')).toBe(0);
    expect(output()).toContain('Resumen: 0 ERROR, 0 WARN, 0 INFO');
  });

  it('fails on enum and schema errors', () => {
    writeCase({ id: 'AUT-001', automatizacion: 'maybe', prioridad: 'Z' });
    writeCase({ id: 'AUT-002', ola: '"uno"' as unknown as number });
    writeCase({ id: 'AUT-003', tipo: undefined });
    expect(qa('check')).toBe(1);
    expect(output()).toContain('automatizacion="maybe"');
    expect(output()).toContain('prioridad="Z"');
    expect(output()).toContain('ola="uno"');
    expect(output()).toContain('falta el campo obligatorio "tipo"');
  });

  it('fails when the id differs from the filename', () => {
    const file = writeCase({ id: 'AUT-001' });
    writeFileSync(file, readFileSync(file, 'utf8').replace('id: AUT-001', 'id: AUT-999'));
    expect(qa('check')).toBe(1);
    expect(output()).toContain('distinto del nombre de archivo');
  });

  it('fails on duplicate ids', () => {
    writeCase({ id: 'AUT-001' });
    const other = writeCase({ id: 'AUT-002' });
    writeFileSync(other, readFileSync(other, 'utf8').replace('id: AUT-002', 'id: AUT-001'));
    expect(qa('check')).toBe(1);
    expect(output()).toContain('id duplicado');
  });

  it('fails on an illegal verdict/lifecycle pair', () => {
    writeCase({ id: 'AUT-001', automatizacion: 'manual', automatizacion_motivo: '"hardware"', estado_automatizacion: 'automatizado' });
    expect(qa('check')).toBe(1);
    expect(output()).toContain('par ilegal');
  });

  it('keeps exit 0 with a WARN for a missing motivo', () => {
    writeCase({ id: 'AUT-001', automatizacion: 'manual' });
    expect(qa('check')).toBe(0);
    expect(output()).toContain('WARN AUT-001: automatizacion=manual sin automatizacion_motivo');
  });

  it('tolerates legacy manual-run fields: no ERROR/WARN, even with unknown values', () => {
    writeCase({ id: 'AUT-001', ...LEGACY_FALLO });
    writeCase({ id: 'AUT-002', ...LEGACY_BLOQUEADO });
    writeCase({ id: 'AUT-003', ejecucion_manual: 'whatever' });
    expect(qa('check')).toBe(0);
    expect(output()).toContain('Resumen: 0 ERROR, 0 WARN, 0 INFO');
    expect(output()).not.toContain('ejecucion_manual');
  });

  it('checks automatizado against the manifest and manifest ids against the cases', () => {
    writeCase({ id: 'AUT-001', estado_automatizacion: 'automatizado', automation: '{surface: e2e, spec: "x.spec.ts", atc: "AUT-001"}' });
    writeCase({ id: 'AUT-002', estado_automatizacion: 'automatizado' });
    const manifest = join(root, 'manifest.json');
    writeFileSync(manifest, JSON.stringify({ components: { ui: [{ atcs: [{ id: 'AUT-001' }, { id: 'AUT-404' }, { id: 'PROJ-1' }] }] } }));
    expect(qa('check', '--manifest', manifest)).toBe(1);
    expect(output()).toContain('ERROR AUT-002: automatizado sin automation.atc');
    expect(output()).toContain('ERROR AUT-404');
    expect(output()).not.toContain('PROJ-1');
    expect(output()).not.toContain('ERROR AUT-001');
  });

  it('reports INFO (never failing) when next diverges from the index file', () => {
    writeCase({ id: 'AUT-001', prioridad: 'B' });
    writeCase({ id: 'AUT-002', prioridad: 'A' });
    writeFileSync(join(root, 'prioridad-automatizacion.md'), '### Ola 1\n\n| Caso |\n|---|\n| [AUT-001](cases/AUT/AUT-001.md) |\n| [AUT-002](cases/AUT/AUT-002.md) |\n');
    expect(qa('check')).toBe(0);
    expect(output()).toContain('INFO ola 1');
  });
});

describe('next', () => {
  const ids = (): string[] => printed.filter(l => /^\s*\d+\./.test(l)).map(l => l.trim().split(/\s+/)[1]);

  it('orders by ola (0 last), prioridad, tipo (S, then N, then the rest incl. L-only) and id', () => {
    writeCase({ id: 'AUT-010', ola: 0, prioridad: 'A', tipo: 'S' });
    writeCase({ id: 'AUT-011', ola: 2, prioridad: 'A', tipo: 'S' });
    writeCase({ id: 'AUT-012', ola: 1, prioridad: 'B', tipo: 'S' });
    writeCase({ id: 'AUT-013', ola: 1, prioridad: 'M', tipo: 'P' });
    writeCase({ id: 'AUT-014', ola: 1, prioridad: 'A', tipo: 'P' });
    writeCase({ id: 'AUT-015', ola: 1, prioridad: 'A', tipo: 'L/N' });
    writeCase({ id: 'AUT-016', ola: 1, prioridad: 'A', tipo: 'N/S' });
    writeCase({ id: 'AUT-017', ola: 1, prioridad: 'A', tipo: 'S' });
    writeCase({ id: 'AUT-018', ola: 1, prioridad: 'A', tipo: 'L' });
    writeCase({ id: 'AUT-019', ola: 1, prioridad: 'A', tipo: 'N' });
    expect(qa('next', '20')).toBe(0);
    expect(ids()).toEqual(['AUT-016', 'AUT-017', 'AUT-015', 'AUT-019', 'AUT-014', 'AUT-018', 'AUT-013', 'AUT-012', 'AUT-011', 'AUT-010']);
  });

  it('queues legacy fallo and bloqueado cases exactly like files without manual state', () => {
    writeCase({ id: 'AUT-001' });
    writeCase({ id: 'AUT-002', ...LEGACY_FALLO });
    writeCase({ id: 'AUT-003', ...LEGACY_BLOQUEADO });
    writeCase({ id: 'AUT-004', ejecucion_manual: 'fallo', id_defecto: '"HAL-09"' });
    expect(qa('next')).toBe(0);
    expect(ids()).toEqual(['AUT-001', 'AUT-002', 'AUT-003', 'AUT-004']);
  });

  it('excludes non-candidates and non-pendiente, and filters by ola/prefix/N', () => {
    writeCase({ id: 'AUT-001' });
    writeCase({ id: 'AUT-002', automatizacion: 'manual', automatizacion_motivo: '"hw"' });
    writeCase({ id: 'AUT-003', estado_automatizacion: 'en_automatizacion' });
    writeCase({ id: 'AUT-004', ...LEGACY_BLOQUEADO });
    writeCase({ id: 'TEN-001', ola: 2 });
    expect(qa('next')).toBe(0);
    expect(ids()).toEqual(['AUT-001', 'AUT-004', 'TEN-001']);
    printed = [];
    expect(qa('next', '1', '--prefix', 'TEN')).toBe(0);
    expect(ids()).toEqual(['TEN-001']);
    printed = [];
    expect(qa('next', '5', '--ola', '1')).toBe(0);
    expect(ids()).toEqual(['AUT-001', 'AUT-004']);
    expect(output()).not.toContain('sin id_defecto');
    expect(qa('next', 'x')).toBe(1);
  });
});

describe('writes', () => {
  it('status writes one line and leaves every other byte (CRLF and body) identical', () => {
    writeCase({ id: 'AUT-001' });
    const before = read('AUT-001');
    expect(qa('status', 'AUT-001', 'en_automatizacion')).toBe(0);
    const after = read('AUT-001');
    const a = before.split('\r\n');
    const b = after.split('\r\n');
    expect(b.length).toBe(a.length);
    const changed = a.map((line, i) => (line === b[i] ? -1 : i)).filter(i => i >= 0);
    expect(changed).toHaveLength(1);
    expect(b[changed[0]]).toBe('estado_automatizacion: en_automatizacion');
    expect(after.slice(after.indexOf('\r\n---\r\n'))).toBe(before.slice(before.indexOf('\r\n---\r\n')));
  });

  it('accepts legal status transitions and rejects illegal ones', () => {
    writeCase({ id: 'AUT-001' });
    expect(qa('status', 'AUT-001', 'automatizado')).toBe(1);
    expect(output()).toContain('transicion ilegal pendiente -> automatizado');
    expect(qa('status', 'AUT-001', 'en_automatizacion', '--atc', 'AUT-001', '--spec', 'tests/e2e/a.spec.ts', '--surface', 'e2e')).toBe(0);
    expect(read('AUT-001')).toContain('automation: {surface: "e2e", spec: "tests/e2e/a.spec.ts", atc: "AUT-001"}');
    expect(qa('status', 'AUT-001', 'pendiente')).toBe(0);
    expect(qa('status', 'AUT-001', 'en_automatizacion')).toBe(0);
    expect(qa('status', 'AUT-001', 'automatizado')).toBe(0);
    expect(qa('status', 'AUT-001', 'en_automatizacion')).toBe(1);
    expect(qa('status', 'AUT-001', 'nope')).toBe(1);
    expect(qa('status', 'AUT-404', 'pendiente')).toBe(1);
  });

  it('rejects a lifecycle change on a non-candidate', () => {
    writeCase({ id: 'AUT-001', automatizacion: 'manual', automatizacion_motivo: '"hw"' });
    expect(qa('status', 'AUT-001', 'en_automatizacion')).toBe(1);
  });

  it('verdict requires a reason for manual, deferred and no_aplica, and stores it', () => {
    writeCase({ id: 'AUT-001' });
    for (const verdict of ['manual', 'deferred', 'no_aplica']) {
      expect(qa('verdict', 'AUT-001', verdict)).toBe(1);
      expect(output()).toContain('requiere --reason');
    }
    expect(read('AUT-001')).toContain('automatizacion: candidate');
    expect(qa('verdict', 'AUT-001', 'manual', '--reason', 'biometria "real"')).toBe(0);
    expect(read('AUT-001')).toContain('automatizacion: manual\r\n');
    expect(read('AUT-001')).toContain('automatizacion_motivo: "biometria \\"real\\""\r\n');
    expect(qa('verdict', 'AUT-001', 'candidate')).toBe(0);
    expect(qa('check')).toBe(0);
    expect(qa('verdict', 'AUT-001', 'bogus')).toBe(1);
  });

  it('verdict refuses to leave candidate while the case is being automated', () => {
    writeCase({ id: 'AUT-001', estado_automatizacion: 'en_automatizacion' });
    expect(qa('verdict', 'AUT-001', 'manual', '--reason', 'x')).toBe(1);
  });

  it('defect refuses a case without a failing automated run and accepts one with last_run FAIL', () => {
    writeCase({ id: 'AUT-001', last_run: '{date: "2026-10-23", result: FAIL, run: "2026-10-23-ola-1"}' });
    writeCase({ id: 'AUT-002', ...LEGACY_FALLO });
    writeCase({ id: 'AUT-003', last_run: '{date: "2026-10-23", result: PASS, run: "r"}' });
    writeCase({ id: 'AUT-004', automatizacion: 'manual', automatizacion_motivo: '"hw"', last_run: '{date: "2026-10-23", result: FAIL, run: "r"}' });
    const before = read('AUT-001');
    for (const id of ['AUT-002', 'AUT-003', 'AUT-004']) {
      printed = [];
      expect(qa('defect', id, 'HAL-10')).toBe(1);
      expect(output()).toContain('el caso no tiene una corrida automatizada fallida');
    }
    expect(qa('defect', 'AUT-001', '')).toBe(1);
    expect(read('AUT-001')).toBe(before);
    expect(qa('defect', 'AUT-001', 'HAL-09')).toBe(0);
    const after = read('AUT-001');
    expect(after).toContain('id_defecto: "HAL-09"\r\n');
    expect(after).toContain('defecto_conocido: true\r\n---\r\n');
    const a = before.split('\r\n');
    const b = after.split('\r\n');
    expect(b).toHaveLength(a.length + 2);
    expect(b.filter(line => !a.includes(line))).toEqual(['id_defecto: "HAL-09"', 'defecto_conocido: true']);
    expect(after.replace('id_defecto: "HAL-09"\r\n', '').replace('defecto_conocido: true\r\n', '')).toBe(before);
    expect(after.replace(/\r\n/g, '')).not.toContain('\n');
  });

  it('defect on a legacy file with an empty id_defecto replaces only that line', () => {
    writeCase({ id: 'AUT-001', ...LEGACY_FALLO, last_run: '{date: "2026-10-23", result: FAIL, run: "r"}' });
    const before = read('AUT-001');
    expect(qa('defect', 'AUT-001', 'HAL-09')).toBe(0);
    const after = read('AUT-001');
    expect(after.replace('id_defecto: "HAL-09"', 'id_defecto: ""').replace('defecto_conocido: true\r\n', '')).toBe(before);
  });

  it('--dry-run writes nothing for every writing verb', () => {
    writeCase({ id: 'AUT-001', last_run: '{date: "2026-10-23", result: FAIL, run: "r"}' });
    const before = read('AUT-001');
    expect(qa('verdict', 'AUT-001', 'manual', '--reason', 'x', '--dry-run')).toBe(0);
    expect(qa('status', 'AUT-001', 'en_automatizacion', '--dry-run')).toBe(0);
    expect(qa('defect', 'AUT-001', 'HAL-09', '--dry-run')).toBe(0);
    expect(qa('index', '--dry-run')).toBe(0);
    expect(output()).toContain('[dry-run]');
    expect(read('AUT-001')).toBe(before);
    expect(existsSync(join(root, 'estado.md'))).toBe(false);
  });
});

describe('results', () => {
  const resultsFile = (): string => join(root, 'atc_results.json');
  const entry = (status: string): object => ({ testId: 'x', methodName: 'm', className: 'C', status, error: null, executedAt: '', duration: 1, softFail: false });
  const report = (map: Record<string, string[]>): void => {
    const results: Record<string, object[]> = {};
    for (const [id, statuses] of Object.entries(map)) { results[id] = statuses.map(entry); }
    writeFileSync(resultsFile(), JSON.stringify({ generatedAt: '', summary: {}, results }));
  };
  const resultsRun = (...extra: string[]): number => qa('results', '--file', resultsFile(), '--date', '2026-10-23', ...extra);

  it('prints a clear message and changes nothing when the file is absent', () => {
    writeCase({ id: 'AUT-001' });
    expect(resultsRun()).toBe(0);
    expect(output()).toContain('no existe');
    expect(existsSync(join(root, 'runs'))).toBe(false);
  });

  it('folds PASS/FAIL/SKIP into last_run and runs/<date>-<scope>', () => {
    writeCase({ id: 'AUT-001' });
    writeCase({ id: 'AUT-002' });
    writeCase({ id: 'AUT-003' });
    report({ 'AUT-001': ['PASS', 'PASS'], 'AUT-002': ['PASS', 'FAIL'], 'AUT-003': ['SKIP'], 'ZZZ-1': ['PASS'] });
    expect(resultsRun()).toBe(0);
    expect(read('AUT-001')).toContain('last_run: {date: "2026-10-23", result: PASS, run: "2026-10-23-ola-1"}');
    expect(read('AUT-002')).toContain('result: FAIL');
    expect(read('AUT-003')).toContain('result: SKIP');
    const runJson = JSON.parse(readFileSync(join(root, 'runs', '2026-10-23-ola-1', 'run.json'), 'utf8')) as { ignored: string[], results: unknown[] };
    expect(runJson.results).toHaveLength(3);
    expect(runJson.ignored).toEqual(['ZZZ-1']);
    expect(readFileSync(join(root, 'runs', '2026-10-23-ola-1', 'run.md'), 'utf8')).toContain('| AUT-002 | FAIL | FAIL | 2 |');
    expect(qa('check')).toBe(0);
  });

  it('maps known defects to EXPECTED_FAIL / UNEXPECTED_PASS and flags the latter in estado.md', () => {
    writeCase({ id: 'AUT-001', id_defecto: '"HAL-09"', defecto_conocido: 'true' });
    writeCase({ id: 'AUT-002', id_defecto: '"HAL-10"', defecto_conocido: 'true' });
    report({ 'AUT-001': ['FAIL'], 'AUT-002': ['PASS'] });
    expect(resultsRun()).toBe(0);
    expect(read('AUT-001')).toContain('result: EXPECTED_FAIL');
    expect(read('AUT-002')).toContain('result: UNEXPECTED_PASS');
    expect(qa('index', '--date', '2026-10-23')).toBe(0);
    const estado = readFileSync(join(root, 'estado.md'), 'utf8');
    expect(estado).toContain('## UNEXPECTED_PASS');
    expect(estado).toContain('- AUT-002 (HAL-10): defecto probablemente corregido');
  });

  it('--accept moves en_automatizacion to automatizado only for PASS or EXPECTED_FAIL', () => {
    writeCase({ id: 'AUT-001', estado_automatizacion: 'en_automatizacion' });
    writeCase({ id: 'AUT-002', estado_automatizacion: 'en_automatizacion' });
    writeCase({ id: 'AUT-003', estado_automatizacion: 'en_automatizacion', id_defecto: '"HAL-09"', defecto_conocido: 'true' });
    writeCase({ id: 'AUT-004', estado_automatizacion: 'en_automatizacion', id_defecto: '"HAL-10"', defecto_conocido: 'true' });
    writeCase({ id: 'AUT-005' });
    report({ 'AUT-001': ['PASS'], 'AUT-002': ['FAIL'], 'AUT-003': ['FAIL'], 'AUT-004': ['PASS'], 'AUT-005': ['PASS'] });
    expect(resultsRun()).toBe(0);
    expect(read('AUT-001')).toContain('estado_automatizacion: en_automatizacion');
    expect(resultsRun('--accept')).toBe(0);
    expect(read('AUT-001')).toContain('estado_automatizacion: automatizado');
    expect(read('AUT-001')).toContain('atc: "AUT-001"');
    expect(read('AUT-002')).toContain('estado_automatizacion: en_automatizacion');
    expect(read('AUT-003')).toContain('estado_automatizacion: automatizado');
    expect(read('AUT-004')).toContain('estado_automatizacion: en_automatizacion');
    expect(read('AUT-005')).toContain('estado_automatizacion: pendiente');
  });

  it('--dry-run writes neither cases nor run files', () => {
    writeCase({ id: 'AUT-001', estado_automatizacion: 'en_automatizacion' });
    const before = read('AUT-001');
    report({ 'AUT-001': ['PASS'] });
    expect(resultsRun('--accept', '--dry-run')).toBe(0);
    expect(read('AUT-001')).toBe(before);
    expect(existsSync(join(root, 'runs'))).toBe(false);
    expect(output()).toContain('[dry-run]');
  });
});

describe('index', () => {
  it('renders waves, prefixes, known defects (only defecto_conocido), UNEXPECTED_PASS and the next queue', () => {
    writeCase({ id: 'AUT-001' });
    writeCase({ id: 'AUT-002', estado_automatizacion: 'automatizado' });
    writeCase({ id: 'AUT-003', id_defecto: '"HAL-09"', defecto_conocido: 'true' });
    writeCase({ id: 'AUT-004', ...LEGACY_FALLO });
    writeCase({ id: 'TEN-001', ola: 0, automatizacion: 'manual', automatizacion_motivo: '"hw"', ...LEGACY_BLOQUEADO });
    expect(qa('index', '--date', '2026-10-23')).toBe(0);
    const estado = readFileSync(join(root, 'estado.md'), 'utf8');
    expect(estado).toContain('GENERADO por `bun run qa:local index` el 2026-10-23');
    expect(estado).toContain('| Ola 1 | 4 | 3 | 0 | 1 | 0 | 0 | 0 | - |');
    expect(estado).toContain('| Sin ola | 1 | 0 | 0 | 0 | 1 | 0 | 0 | - |');
    expect(estado).toContain('| TEN | 1 |');
    expect(estado).toContain('## Defectos conocidos (1)');
    expect(estado).toContain('- AUT-003: HAL-09');
    expect(estado).toContain('## UNEXPECTED_PASS');
    expect(estado).not.toMatch(/bloqueados/i);
    expect(estado).not.toContain('Defectos sin referencia');
    expect(estado).not.toContain('falta biometria');
    expect(estado).not.toContain('- AUT-004:');
    expect(estado).toContain('1. AUT-001 (ola 1, A, P)');
    expect(estado).toContain('3. AUT-004 (ola 1, A, P)');
    expect(existsSync(join(root, 'prioridad-automatizacion.md'))).toBe(false);
  });
});

describe('verb dispatch', () => {
  it('rejects unknown verbs and options and prints usage with no verb', () => {
    writeCase({ id: 'AUT-001' });
    expect(qa('frobnicate')).toBe(1);
    expect(qa('check', '--wat')).toBe(1);
    expect(run([], out)).toBe(1);
    expect(output()).toContain('Uso:');
  });
});

describe('against the real prioridad-automatizacion.md', () => {
  const realRoot = join(import.meta.dir, '..', '.context', 'QA');
  const indexFile = join(realRoot, 'prioridad-automatizacion.md');

  it.skipIf(!existsSync(indexFile))('next --ola 1 follows the Ola 1 order of the index', () => {
    const lines: string[] = [];
    expect(run(['next', '1000', '--ola', '1', '--root', realRoot], l => lines.push(l))).toBe(0);
    const mine = lines.filter(l => /^\s*\d+\./.test(l)).map(l => l.trim().split(/\s+/)[1]);
    const theirs = (parseIndexOrder(readFileSync(indexFile, 'utf8')).get(1) ?? []).filter(id => mine.includes(id));
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.slice(0, 10)).toEqual(theirs.slice(0, 10));
  });
});

// ============================================
// bug new | status | check
// ============================================

describe('bug', () => {
  const bugsDir = (): string => join(root, 'bugs');
  const reportPath = (id: string): string => join(bugsDir(), id, 'report.md');
  const readReport = (id: string): string => readFileSync(reportPath(id), 'utf8');
  const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzZWNyZXRvIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV';

  /** Case whose body carries a "Resultado esperado" section, so the copy can be asserted. */
  const caseWithExpected = (id: string): string => writeCase({ id });

  const newBug = (caseId: string, ...extra: string[]): string => {
    printed = [];
    expect(qa('bug', 'new', caseId, '--date', '2026-10-23', ...extra)).toBe(0);
    return output().split('\n')[0].trim();
  };

  describe('new', () => {
    it('numbers bugs with one global consecutive counter across cases', () => {
      caseWithExpected('AUT-001');
      caseWithExpected('AUT-002');
      expect(newBug('AUT-001')).toContain('AUT-001-BUG-1');
      expect(newBug('AUT-001')).toContain('AUT-001-BUG-2');
      expect(newBug('AUT-002')).toContain('AUT-002-BUG-3');
      expect(readdirSync(bugsDir()).sort()).toEqual(['AUT-001-BUG-1', 'AUT-001-BUG-2', 'AUT-002-BUG-3']);
      expect(output()).toContain(join(bugsDir(), 'AUT-002-BUG-3'));
    });

    it('continues after the highest existing folder (a pre-created -BUG-2 makes the next one 3, for any case)', () => {
      caseWithExpected('AUT-001');
      caseWithExpected('AUT-002');
      mkdirSync(join(bugsDir(), 'AUT-001-BUG-2'), { recursive: true });
      expect(newBug('AUT-002')).toContain('AUT-002-BUG-3');
      expect(existsSync(reportPath('AUT-002-BUG-3'))).toBe(true);
    });

    it('counts a folder of another case (AUT-002-BUG-5 makes the next AUT-001 bug 6)', () => {
      caseWithExpected('AUT-001');
      mkdirSync(join(bugsDir(), 'AUT-002-BUG-5'), { recursive: true });
      expect(newBug('AUT-001')).toContain('AUT-001-BUG-6');
    });

    it('retries with the next number when another session wins the mkdir (EEXIST)', () => {
      const bugs = join(root, 'bugs');
      mkdirSync(bugs, { recursive: true });
      const calls: string[] = [];
      const allocated = qaLocal.allocateBugFolder(bugs, 'AUT-001', (path: string) => {
        calls.push(path);
        // Another session creates the folder between the number computation and our mkdir.
        if (calls.length === 1) { mkdirSync(path); }
        mkdirSync(path);
      });
      expect(allocated.n).toBe(2);
      expect(allocated.dir).toBe(join(bugs, 'AUT-001-BUG-2'));
      expect(calls).toEqual([join(bugs, 'AUT-001-BUG-1'), join(bugs, 'AUT-001-BUG-2')]);
      expect(existsSync(join(bugs, 'AUT-001-BUG-1'))).toBe(true);
      expect(existsSync(join(bugs, 'AUT-001-BUG-2'))).toBe(true);
    });

    it('refuses an unknown case and creates nothing', () => {
      caseWithExpected('AUT-001');
      expect(qa('bug', 'new', 'AUT-404')).toBe(1);
      expect(output()).toContain('ERROR:');
      expect(output()).toContain('AUT-404');
      expect(existsSync(bugsDir())).toBe(false);
    });

    it('--dry-run prints the id it would allocate and writes nothing, folder included', () => {
      caseWithExpected('AUT-001');
      mkdirSync(join(bugsDir(), 'AUT-002-BUG-1'), { recursive: true });
      expect(qa('bug', 'new', 'AUT-001', '--dry-run')).toBe(0);
      expect(output()).toContain('[dry-run]');
      expect(output()).toContain('AUT-001-BUG-2');
      expect(readdirSync(bugsDir())).toEqual(['AUT-002-BUG-1']);
      rmSync(bugsDir(), { recursive: true });
      printed = [];
      expect(qa('bug', 'new', 'AUT-001', '--dry-run')).toBe(0);
      expect(output()).toContain('AUT-001-BUG-1');
      expect(existsSync(bugsDir())).toBe(false);
    });

    it('writes a CRLF skeleton that the qa-local reader parses, with priority derived from severity', () => {
      caseWithExpected('AUT-001');
      const pairs: [string, string][] = [['Critical', 'Highest'], ['Major', 'High'], ['Moderate', 'Medium'], ['Minor', 'Low'], ['Trivial', 'Lowest']];
      for (const [severity] of pairs) { newBug('AUT-001', '--severity', severity, '--title', `T ${severity}`); }
      const bugs = qaLocal.loadBugs(root);
      expect(bugs).toHaveLength(5);
      pairs.forEach(([severity, priority], i) => {
        const fm = bugs[i].report?.fm ?? {};
        expect(fm.severity).toBe(severity);
        expect(fm.priority).toBe(priority);
        expect(fm.id).toBe(`AUT-001-BUG-${i + 1}`);
        expect(fm.case).toBe('AUT-001');
        expect(fm.title).toBe(`T ${severity}`);
        expect(fm.status).toBe('open');
        expect(fm.found_on).toBe('2026-10-23');
        expect(fm.visual).toBe(false);
        expect(fm.evidence).toEqual([]);
      });
      const text = readReport('AUT-001-BUG-1');
      expect(text.replace(/\r\n/g, '')).not.toContain('\n');
      for (const heading of ['Resumen', 'Pasos para reproducir', 'Resultado actual', 'Resultado esperado', 'Analisis tecnico', 'Impacto', 'Causa raiz', 'Workaround', 'Evidencia', 'Casos relacionados']) {
        expect(text).toContain(`## ${heading}\r\n`);
      }
    });

    it('honours the metadata flags (type, error type, environment, run, visual)', () => {
      caseWithExpected('AUT-001');
      newBug('AUT-001', '--type', 'Bug', '--error-type', 'Visual', '--environment', 'QA', '--run', '2026-10-23-ola-1', '--visual');
      const fm = qaLocal.loadBugs(root)[0].report?.fm ?? {};
      expect(fm.type).toBe('Bug');
      expect(fm.error_type).toBe('Visual');
      expect(fm.environment).toBe('QA');
      expect(fm.found_by).toBe('2026-10-23-ola-1');
      expect(fm.visual).toBe(true);
      expect(qa('bug', 'new', 'AUT-001', '--severity', 'Huge')).toBe(1);
      expect(qa('bug', 'new', 'AUT-001', '--type', 'Nope')).toBe(1);
      expect(readdirSync(bugsDir())).toHaveLength(1);
    });

    it('copies the case Resultado esperado and never touches the case file', () => {
      const file = caseWithExpected('AUT-001');
      const before = readFileSync(file);
      newBug('AUT-001');
      const body = readReport('AUT-001-BUG-1');
      expect(body).toMatch(/## Resultado esperado\r\n\r\nSesión creada\r\n/);
      expect(Buffer.compare(readFileSync(file), before)).toBe(0);
    });
  });

  describe('status', () => {
    it('applies legal moves changing exactly one line and keeping CRLF', () => {
      caseWithExpected('AUT-001');
      newBug('AUT-001');
      const id = 'AUT-001-BUG-1';
      const moves: [string, string][] = [['fixed', 'open'], ['verified', 'fixed'], ['open', 'verified'], ['fixed', 'open'], ['open', 'fixed']];
      for (const [target, previous] of moves) {
        const before = readReport(id);
        printed = [];
        expect(qa('bug', 'status', id, target)).toBe(0);
        const after = readReport(id);
        const a = before.split('\r\n');
        const b = after.split('\r\n');
        expect(b).toHaveLength(a.length);
        const changed = a.map((line, i) => (line === b[i] ? -1 : i)).filter(i => i >= 0);
        expect(changed).toHaveLength(1);
        expect(a[changed[0]]).toBe(`status: ${previous}`);
        expect(b[changed[0]]).toBe(`status: ${target}`);
        expect(after.replace(/\r\n/g, '')).not.toContain('\n');
      }
    });

    it('rejects illegal moves, prints sin cambios for the same status and fails on an unknown bug', () => {
      caseWithExpected('AUT-001');
      newBug('AUT-001');
      const id = 'AUT-001-BUG-1';
      const before = readReport(id);
      expect(qa('bug', 'status', id, 'verified')).toBe(1);
      expect(output()).toContain('transicion ilegal');
      expect(qa('bug', 'status', id, 'bogus')).toBe(1);
      printed = [];
      expect(qa('bug', 'status', id, 'open')).toBe(0);
      expect(output()).toContain('sin cambios');
      expect(qa('bug', 'status', 'AUT-001-BUG-9', 'fixed')).toBe(1);
      expect(readReport(id)).toBe(before);
    });

    it('--dry-run writes nothing', () => {
      caseWithExpected('AUT-001');
      newBug('AUT-001');
      const before = readReport('AUT-001-BUG-1');
      expect(qa('bug', 'status', 'AUT-001-BUG-1', 'fixed', '--dry-run')).toBe(0);
      expect(output()).toContain('[dry-run]');
      expect(readReport('AUT-001-BUG-1')).toBe(before);
    });
  });

  describe('check', () => {
    it('prints sin bugs and exits 0 with no bugs folder or an empty one, even with no cases', () => {
      expect(qa('bug', 'check')).toBe(0);
      expect(output()).toContain('sin bugs');
      mkdirSync(bugsDir());
      printed = [];
      expect(qa('bug', 'check')).toBe(0);
      expect(output()).toContain('sin bugs');
    });

    it('passes a clean bug and writes nothing', () => {
      caseWithExpected('AUT-001');
      newBug('AUT-001');
      writeFileSync(join(bugsDir(), 'AUT-001-BUG-1', 'AUT-001-BUG-1-failure.png'), 'png');
      const id = 'AUT-001-BUG-1';
      const file = reportPath(id);
      writeFileSync(file, readFileSync(file, 'utf8').replace('evidence: []', 'evidence: ["AUT-001-BUG-1-failure.png"]'));
      const listing = readdirSync(join(bugsDir(), id)).sort();
      printed = [];
      expect(qa('bug', 'check')).toBe(0);
      expect(output()).toContain('0 ERROR');
      expect(qa('bug', 'check', id)).toBe(0);
      expect(readdirSync(join(bugsDir(), id)).sort()).toEqual(listing);
    });

    it('flags a planted JWT, Set-Cookie, a trace.zip, a missing evidence file and a bad enum, never printing the token', () => {
      caseWithExpected('AUT-001');
      newBug('AUT-001');
      const dir = join(bugsDir(), 'AUT-001-BUG-1');
      writeFileSync(join(dir, 'notes.txt'), `error con token ${JWT}\r\nSet-Cookie: sid=abc123xyz\r\n`);
      writeFileSync(join(dir, 'trace.zip'), 'zip');
      const file = reportPath('AUT-001-BUG-1');
      writeFileSync(file, readFileSync(file, 'utf8')
        .replace('evidence: []', 'evidence: ["missing.png"]')
        .replace('severity: Moderate', 'severity: Huge'));
      printed = [];
      expect(qa('bug', 'check')).toBe(1);
      const text = output();
      expect(text).toContain('ERROR AUT-001-BUG-1');
      expect(text).toContain('notes.txt');
      expect(text).toContain('trace.zip');
      expect(text).toContain('missing.png');
      expect(text).toContain('severity');
      expect(text).not.toContain(JWT);
      expect(text).not.toContain('eyJ');
      expect(text).not.toContain('abc123xyz');
    });

    it('flags Bearer, Cookie and password/refresh_token/csrf values without echoing them', () => {
      caseWithExpected('AUT-001');
      newBug('AUT-001');
      const dir = join(bugsDir(), 'AUT-001-BUG-1');
      writeFileSync(join(dir, 'a.txt'), 'Authorization: Bearer Zm9vYmFyYmF6cXV4\r\n');
      writeFileSync(join(dir, 'b.txt'), 'Cookie: session=SUPERVALOR99\r\n');
      writeFileSync(join(dir, 'c.json'), '{"password": "hunter2hunter2", "refresh_token": "RT-777-xyz", "csrf": "CSRF-555"}');
      printed = [];
      expect(qa('bug', 'check', 'AUT-001-BUG-1')).toBe(1);
      for (const name of ['a.txt', 'b.txt', 'c.json']) { expect(output()).toContain(name); }
      for (const secret of ['Zm9vYmFyYmF6cXV4', 'SUPERVALOR99', 'hunter2hunter2', 'RT-777-xyz', 'CSRF-555']) { expect(output()).not.toContain(secret); }
    });

    it('flags a mismatched id, an unknown case, a missing report and the other forbidden files', () => {
      caseWithExpected('AUT-001');
      newBug('AUT-001');
      newBug('AUT-001');
      newBug('AUT-001');
      const one = reportPath('AUT-001-BUG-1');
      writeFileSync(one, readFileSync(one, 'utf8').replace('id: AUT-001-BUG-1', 'id: AUT-001-BUG-7'));
      const two = reportPath('AUT-001-BUG-2');
      writeFileSync(two, readFileSync(two, 'utf8').replace('case: AUT-001', 'case: AUT-404'));
      rmSync(reportPath('AUT-001-BUG-3'));
      for (const name of ['x.har', 'x.webm', 'x.env', 'x.trace']) { writeFileSync(join(bugsDir(), 'AUT-001-BUG-2', name), 'x'); }
      printed = [];
      expect(qa('bug', 'check')).toBe(1);
      const text = output();
      expect(text).toContain('ERROR AUT-001-BUG-1');
      expect(text).toContain('distinto de la carpeta');
      expect(text).toContain('AUT-404');
      expect(text).toContain('report.md');
      for (const name of ['x.har', 'x.webm', 'x.env', 'x.trace']) { expect(text).toContain(name); }
    });

    it('fails on an unknown bug id given as an argument', () => {
      caseWithExpected('AUT-001');
      expect(qa('bug', 'check', 'AUT-001-BUG-1')).toBe(1);
    });
  });

  describe('dispatch', () => {
    it('rejects an unknown or missing bug action', () => {
      caseWithExpected('AUT-001');
      expect(qa('bug')).toBe(1);
      expect(qa('bug', 'frobnicate')).toBe(1);
    });
  });

  describe('estado.md', () => {
    it('lists open and fixed bugs, not verified ones, with the counts in the heading', () => {
      caseWithExpected('AUT-001');
      caseWithExpected('AUT-002');
      newBug('AUT-001', '--severity', 'Major');
      newBug('AUT-001', '--severity', 'Minor');
      newBug('AUT-002', '--severity', 'Critical');
      expect(qa('bug', 'status', 'AUT-001-BUG-2', 'fixed')).toBe(0);
      expect(qa('bug', 'status', 'AUT-002-BUG-3', 'fixed')).toBe(0);
      expect(qa('bug', 'status', 'AUT-002-BUG-3', 'verified')).toBe(0);
      expect(qa('index', '--date', '2026-10-23')).toBe(0);
      const estado = readFileSync(join(root, 'estado.md'), 'utf8');
      expect(estado).toContain('## Bugs (open 1, fixed pending verification 1)');
      expect(estado).toContain('- AUT-001-BUG-1: Major, open, caso AUT-001');
      expect(estado).toContain('- AUT-001-BUG-2: Minor, fixed, caso AUT-001');
      expect(estado).not.toContain('AUT-002-BUG-3');
    });

    it('shows _Ninguno._ with no bugs folder, and renderEstado keeps its two-argument form', () => {
      caseWithExpected('AUT-001');
      expect(qa('index', '--date', '2026-10-23')).toBe(0);
      const estado = readFileSync(join(root, 'estado.md'), 'utf8');
      expect(estado).toMatch(/## Bugs \(open 0, fixed pending verification 0\)\n\n_Ninguno\._/);
      const cases = qaLocal.loadCases(root).cases;
      expect(qaLocal.renderEstado(cases, '2026-10-23')).toBe(qaLocal.renderEstado(cases, '2026-10-23', []));
    });
  });
});

describe('case', () => {
  const casePath = (id: string): string => join(root, 'cases', id.split('-')[0], `${id}.md`);

  describe('new', () => {
    it('creates the folder and numbers cases per prefix from 001', () => {
      expect(qa('case', 'new', 'TEN', '--title', 'Crear tenant')).toBe(0);
      expect(printed[0]).toBe('TEN-001');
      printed = [];
      expect(qa('case', 'new', 'TEN', '--title', 'Editar tenant')).toBe(0);
      expect(printed[0]).toBe('TEN-002');
      printed = [];
      expect(qa('case', 'new', 'USR', '--title', 'Crear usuario')).toBe(0);
      expect(printed[0]).toBe('USR-001');
      expect(readdirSync(join(root, 'cases', 'TEN')).sort()).toEqual(['TEN-001.md', 'TEN-002.md']);
    });

    it('writes a file that passes check with the required fields and the given values', () => {
      expect(qa('case', 'new', 'TEN', '--title', 'Crear tenant', '--prioridad', 'A', '--ola', '2', '--tipo', 'N', '--origen', 'historia:HU-12', '--esperado', 'Se crea el tenant')).toBe(0);
      const file = readFileSync(casePath('TEN-001'), 'utf8');
      expect(file).toContain('id: TEN-001');
      expect(file).toContain('prioridad: "A"');
      expect(file).toContain('ola: 2');
      expect(file).toContain('tipo: "N"');
      expect(file).toContain('origen: "historia:HU-12"');
      expect(file).toContain('automatizacion: candidate');
      expect(file).toContain('estado_automatizacion: pendiente');
      expect(file).toContain('## Escenario\n\nCrear tenant');
      expect(file).toContain('## Resultado esperado\n\nSe crea el tenant');
      printed = [];
      expect(qa('check')).toBe(0);
      expect(output()).toContain('0 ERROR');
    });

    it('continues after the highest existing number, even with a gap', () => {
      writeCase({ id: 'TEN-007' });
      expect(qa('case', 'new', 'TEN', '--title', 'Otro')).toBe(0);
      expect(printed[0]).toBe('TEN-008');
    });

    it('--dry-run prints the next id and writes nothing', () => {
      expect(qa('case', 'new', 'TEN', '--title', 'X', '--dry-run')).toBe(0);
      expect(output()).toContain('TEN-001');
      expect(existsSync(join(root, 'cases', 'TEN'))).toBe(false);
    });

    it('rejects a bad prefix, a missing title and a bad priority', () => {
      expect(qa('case', 'new', 'ten', '--title', 'X')).toBe(1);
      expect(qa('case', 'new', 'A', '--title', 'X')).toBe(1);
      expect(qa('case', 'new', 'TEN')).toBe(1);
      expect(qa('case', 'new', 'TEN', '--title', 'X', '--prioridad', 'Z')).toBe(1);
      expect(qa('case', 'new', 'TEN', '--title', 'X', '--oraculo', 'confirmado')).toBe(1);
    });

    it('retries with the next number when another session wins the exclusive create (EEXIST)', () => {
      const dir = join(root, 'cases', 'TEN');
      let first = true;
      const result = qaLocal.allocateCaseFile(dir, 'TEN', id => id, (path, content) => {
        if (first) {
          first = false;
          writeFileSync(path, 'x');
          const error: NodeJS.ErrnoException = new Error('exists');
          error.code = 'EEXIST';
          throw error;
        }
        writeFileSync(path, content, { flag: 'wx' });
      });
      expect(result.id).toBe('TEN-002');
    });
  });

  describe('oraculo', () => {
    it('keeps an observed case out of the queue until a person confirms it', () => {
      expect(qa('case', 'new', 'TEN', '--title', 'Inferido', '--oraculo', 'observado')).toBe(0);
      expect(qa('case', 'new', 'TEN', '--title', 'De la historia')).toBe(0);
      printed = [];
      expect(qa('next')).toBe(0);
      expect(output()).toContain('TEN-002');
      expect(output()).not.toContain('TEN-001');
      printed = [];
      expect(qa('case', 'confirm', 'TEN-001')).toBe(0);
      expect(readFileSync(casePath('TEN-001'), 'utf8')).toContain('oraculo: confirmado');
      printed = [];
      expect(qa('next')).toBe(0);
      expect(output()).toContain('TEN-001');
    });

    it('confirm refuses a case that is not observed, and check rejects an unknown value', () => {
      expect(qa('case', 'new', 'TEN', '--title', 'De la historia')).toBe(0);
      expect(qa('case', 'confirm', 'TEN-001')).toBe(1);
      writeCase({ id: 'TEN-009', oraculo: 'dudoso' });
      printed = [];
      expect(qa('check')).toBe(1);
      expect(output()).toContain('oraculo="dudoso"');
    });
  });

  it('rejects an unknown case action', () => {
    expect(qa('case', 'borrar')).toBe(1);
  });
});
