/**
 * The automated-outcome chip (ADR-0020, ADR-0023 amendment): the board reads
 * `reports/test-outcomes.json` and shows each TC's automated status BESIDE its
 * TMS status in the ticket drawer. It never changes a lane, a count or a
 * metric, and it never reaches a share or report snapshot.
 */
import type { BoardEvent, Sprint, TrackerSnapshot } from './model.ts';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { ctxOf, drawer } from './app/views.ts';
import { applyAutomated, AUTOMATED_SCHEMA, fold as foldRaw, metrics, SCHEMA, toReportState, toShareState } from './model.ts';
import { readAutomatedFile } from './sources.ts';
import { bucketed } from './test-fixtures.ts';

const fold = (i: Parameters<typeof foldRaw>[0]) => foldRaw({ ...i, tracker: bucketed(i.tracker) });

const sprint: Sprint = { v: SCHEMA, slug: 'sprint-7', number: 7, name: 'Sprint 7', startedAt: '2026-10-01T00:00:00Z', env: 'staging' };
const tracker: TrackerSnapshot = {
  v: SCHEMA,
  syncedAt: '2026-10-05T00:00:00Z',
  searched: { tickets: 1, tcs: 3, bugs: 0 },
  bugs: {},
  tickets: { 'DEMO-7301': { title: 'Checkout tax', status: 'Ready for QA', module: 'checkout', tcs: [
    { id: 'DEMO-7311', status: 'PASSED', name: 'Tax on a single item' },
    { id: 'DEMO-7312', status: 'NOT RUN', name: 'Tax on a discount' },
    { id: 'DEMO-7313', status: 'PASSED', name: 'Tax exempt' },
  ] } },
};
const events: BoardEvent[] = [];
const base = () => fold({ sprint, tracker, events, now: '2026-10-05T12:00:00Z' });

const record = (testStatus: string, atcIds: string[]) => ({ testStatus, atcIds });
const doc = (env: string, records: { testStatus: string, atcIds: string[] }[], schema = AUTOMATED_SCHEMA) => ({
  schema,
  generatedAt: '2026-10-05T09:30:00Z',
  run: { environment: env },
  records,
});

describe('applyAutomated', () => {
  test('attaches the automated status to the TCs a record names, worst of several records', () => {
    const s = applyAutomated(base(), doc('staging', [
      record('PASSED', ['DEMO-7311']),
      record('FAILED', ['DEMO-7313']),
      record('PASSED', ['DEMO-7313']),
      record('BLOCKED', ['DEMO-7312']),
      record('PASSED', ['DEMO-7999']),
    ]));
    const tcs = s.tickets[0].tcs;
    expect(tcs.find(x => x.id === 'DEMO-7311')?.automated).toEqual({ status: 'PASSED', records: 1, at: '2026-10-05T09:30:00Z', env: 'staging' });
    expect(tcs.find(x => x.id === 'DEMO-7313')?.automated?.status).toBe('FAILED');
    expect(tcs.find(x => x.id === 'DEMO-7313')?.automated?.records).toBe(2);
    expect(tcs.find(x => x.id === 'DEMO-7312')?.automated?.status).toBe('BLOCKED');
    // The TMS status is untouched: the chip sits beside it.
    expect(tcs.find(x => x.id === 'DEMO-7313')?.status).toBe('PASSED');
    expect(s.warnings).toEqual(base().warnings);
  });

  test('a run in another environment, or a board with none, shows nothing', () => {
    expect(applyAutomated(base(), doc('local', [record('PASSED', ['DEMO-7311'])])).tickets[0].tcs.some(x => x.automated)).toBe(false);
    const noEnv = fold({ sprint: { ...sprint, env: undefined }, tracker, events, now: '2026-10-05T12:00:00Z' });
    expect(applyAutomated(noEnv, doc('staging', [record('PASSED', ['DEMO-7311'])])).tickets[0].tcs.some(x => x.automated)).toBe(false);
  });

  test('another schema, or a malformed file, is refused with one warning', () => {
    const wrong = applyAutomated(base(), doc('staging', [record('PASSED', ['DEMO-7311'])], 'test-outcomes/2.0'));
    expect(wrong.tickets[0].tcs.some(x => x.automated)).toBe(false);
    expect(wrong.warnings).toEqual([...base().warnings, 'reports/test-outcomes.json ignored: schema test-outcomes/2.0, the board reads test-outcomes/1.0']);
    const bad = applyAutomated(base(), { schema: AUTOMATED_SCHEMA, run: { environment: 'staging' }, records: [{ testStatus: 'GREEN', atcIds: ['DEMO-7311'] }] });
    expect(bad.tickets[0].tcs.some(x => x.automated)).toBe(false);
    expect(bad.warnings.at(-1)).toContain('reports/test-outcomes.json ignored');
    expect(applyAutomated(base(), null)).toEqual(base());
  });

  test('lanes, counts and metrics are the same with and without the chip', () => {
    const before = base();
    const after = applyAutomated(before, doc('staging', [record('FAILED', ['DEMO-7311', 'DEMO-7312', 'DEMO-7313'])]));
    expect(after.tickets.map(t => [t.id, t.lane, t.atRisk])).toEqual(before.tickets.map(t => [t.id, t.lane, t.atRisk]));
    expect(metrics(after)).toEqual(metrics(before));
  });

  test('share and report snapshots never carry it', () => {
    const s = applyAutomated(base(), doc('staging', [record('FAILED', ['DEMO-7311'])]));
    expect(JSON.stringify(toShareState(s))).not.toContain('automated');
    expect(JSON.stringify(toReportState(s))).not.toContain('automated');
  });
});

describe('the drawer', () => {
  const ctx = (s: ReturnType<typeof base>) => ctxOf(s, { filter: '', canWrite: true, img: p => `/files/${p}`, sprints: [], archives: [] });

  test('shows the automated chip beside the TMS pill, with the run line, only when a record names the TC', () => {
    const s = applyAutomated(base(), doc('staging', [record('FAILED', ['DEMO-7313'])]));
    const html = drawer(s.tickets[0], ctx(s));
    expect(html).toContain('<span class="pill source"');
    expect(html).toContain('>automated</span> <span class="pill FAILED">FAILED</span>');
    expect(html).toMatch(/Automated run \d{4}-\d{2}-\d{2} \d{2}:\d{2}Z? · staging/);
    expect(html.match(/>automated</g)?.length).toBe(1);
  });

  test('no automated record, no chip and no run line', () => {
    const html = drawer(base().tickets[0], ctx(base()));
    expect(html).not.toContain('>automated<');
    expect(html).not.toContain('Automated run');
  });
});

describe('readAutomatedFile', () => {
  test('a missing file is null, an unparseable one is a value the fold refuses', () => {
    const dir = mkdtempSync(join(tmpdir(), 'board-automated-'));
    try {
      expect(readAutomatedFile(join(dir, 'none.json'))).toBeNull();
      writeFileSync(join(dir, 'bad.json'), '{ not json');
      expect(readAutomatedFile(join(dir, 'bad.json'))).toEqual({ unreadable: true });
      writeFileSync(join(dir, 'ok.json'), JSON.stringify(doc('staging', [])));
      expect(readAutomatedFile(join(dir, 'ok.json'))).toEqual(doc('staging', []));
    }
    finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
