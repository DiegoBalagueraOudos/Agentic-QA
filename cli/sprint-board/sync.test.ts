/**
 * `sync` against the sprint source (`cli/lib/sprint-source/`), with a throwaway SPRINT_BOARD_DIR:
 * the demo `tickets.yaml` through the `none` source, and an injected source for the failure paths.
 * No network.
 */
import type { BoardConfig, Catalogs, Source, SourceSnapshot, Transport } from '../lib/sprint-source/index.ts';
import type { BoardEvent, TrackerSnapshot } from './model.ts';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';

const DIR = mkdtempSync(join(tmpdir(), 'sprint-board-sync-'));
process.env.SPRINT_BOARD_DIR = DIR;
process.env.SPRINT_BOARD_PROJECT_YAML = join(import.meta.dir, 'demo', 'project.yaml');
// Imported after the env is set: the store resolves its directory at load time.
const { appendEvent, BOARD_DIR, readTracker, setCurrent, writeSprint } = await import('./store.ts');
const { boardConfig, syncFromSource } = await import('./sync.ts');
const { SCHEMA } = await import('./model.ts');
const { resolveBoardConfig, UnknownStatusError } = await import('../lib/sprint-source/index.ts');
const { createJiraNativeSource } = await import('../lib/sprint-source/jira-native.ts');

const NOW = new Date('2026-01-14T16:00:00Z');

/**
 * `bun test` runs every file in one process and the store fixes its directory when it is first
 * loaded. When another file loaded it first, this file reruns itself in a child process, so a sync
 * never writes outside its own throwaway directory.
 */
const ISOLATED = BOARD_DIR === DIR;
const suite = ISOLATED ? describe : describe.skip;
if (!ISOLATED) {
  delete process.env.SPRINT_BOARD_DIR;
  delete process.env.SPRINT_BOARD_PROJECT_YAML;
  test('sync runs in its own process (the store directory was already fixed)', () => {
    const r = Bun.spawnSync(['bun', 'test', import.meta.path], { env: { ...process.env }, timeout: 60_000 });
    if (r.exitCode !== 0) { throw new Error(`${r.stdout.toString()}${r.stderr.toString()}`); }
    expect(r.exitCode).toBe(0);
  });
}

/** Awaits a promise expected to reject and hands `toThrow` a function rethrowing its reason. */
async function rejection(promise: Promise<unknown>): Promise<() => never> {
  const reason = await promise.then(() => new Error('expected a rejection, the promise resolved'), (err: unknown) => err);
  return () => { throw reason; };
}
let slug = '';
let seq = 0;

const events = (): BoardEvent[] => readFileSync(join(DIR, 'sprints', slug, 'events.ndjson'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
const quiet = async (fn: () => Promise<void>) => {
  const log = console.log;
  const warn = console.warn;
  console.log = () => {};
  console.warn = () => {};
  try { await fn(); }
  finally { console.log = log; console.warn = warn; }
};

beforeEach(() => {
  if (!ISOLATED) { return; }
  slug = `sprint-${++seq}`;
  writeSprint({ v: SCHEMA, slug, number: seq, name: 'Sprint 7', env: 'staging', qa: 'Rowan QA', startedAt: '2026-01-12T09:00:00Z' });
  setCurrent(slug);
  appendEvent(slug, { kind: 'sprint', text: 'opened' });
});

afterAll(() => {
  rmSync(DIR, { recursive: true, force: true });
});

suite('sync through the none source (the demo tickets.yaml)', () => {
  test('--discover adds the QA owner\'s rows, stores buckets and lists untracked rows in test', async () => {
    appendEvent(slug, { kind: 'scope.add', ticket: 'DEMO-101', text: 'added' });
    await quiet(async () => syncFromSource(slug, { discover: true, now: NOW }));
    const t = readTracker(slug)!;
    expect(t.source).toBe('none');
    expect(Object.keys(t.tickets).sort()).toEqual(['DEMO-101', 'DEMO-102', 'DEMO-103', 'DEMO-104', 'DEMO-105', 'DEMO-106']);
    expect(t.tickets['DEMO-101']).toMatchObject({ status: 'In Test', statusKey: 'In Test', bucket: 'in_test', dev: 'Avery Dev', qa: 'Rowan QA', module: 'Checkout', bugs: ['DEMO-201'] });
    expect(t.tickets['DEMO-101'].tcs.map(x => `${x.id}:${x.status}`)).toEqual(['DEMO-101-T1:PASSED', 'DEMO-101-T2:FAILED', 'DEMO-101-T3:NOT RUN']);
    expect(t.bugs['DEMO-201']).toMatchObject({ status: 'Open', bucket: 'open', createdAt: '2026-01-14T14:45:00Z' });
    // DEMO-107 has no QA owner: it stays off the board and is listed as untracked in test.
    expect(t.discover?.untracked).toEqual([{ id: 'DEMO-107', title: 'Saved addresses can be edited', status: 'Ready for QA', bucket: 'in_test', qa: undefined }]);
    expect(t.discover?.sprintRows).toBe(7);
    expect(t.discover?.bugs).toBeUndefined();
    expect(t.searched).toEqual({ tickets: 6, tcs: 12, bugs: 1 });
    expect(events().filter(e => e.kind === 'scope.add').map(e => e.ticket).sort()).toEqual(['DEMO-101', 'DEMO-102', 'DEMO-103', 'DEMO-104', 'DEMO-105', 'DEMO-106']);
  });

  test('a status that moved since the last sync is a tracker event carrying the bucket it moved into', async () => {
    appendEvent(slug, { kind: 'scope.add', ticket: 'DEMO-103', text: 'added' });
    await quiet(async () => syncFromSource(slug, { now: NOW }));
    // Pretend the previous read saw it still in progress.
    const { writeTracker } = await import('./store.ts');
    const prev = readTracker(slug)!;
    writeTracker(slug, { ...prev, tickets: { ...prev.tickets, 'DEMO-103': { ...prev.tickets['DEMO-103'], status: 'In Progress', bucket: 'not_ready' } } });
    await quiet(async () => syncFromSource(slug, { now: NOW }));
    const moved = events().filter(e => e.kind === 'tracker');
    expect(moved).toHaveLength(1);
    expect(moved[0]).toMatchObject({ ticket: 'DEMO-103', text: 'tickets.yaml status In Progress -> Ready for QA', data: { from: 'In Progress', to: 'Ready for QA', bucket: 'in_test' } });
  });

  test('the sprint keeps a copy of board.evidence.allowed_hosts for the pure fold', async () => {
    await quiet(async () => syncFromSource(slug, { now: NOW }));
    const sprint = JSON.parse(readFileSync(join(DIR, 'sprints', slug, 'sprint.json'), 'utf8'));
    expect(sprint.evidenceHosts).toEqual(['claude.ai']);
  });
});

suite('sync failures keep the last good source.json', () => {
  const failing = (err: Error): ((c: BoardConfig) => Source) => () => ({ kind: 'none', snapshot: async () => { throw err; } });

  test('an unknown status fails the read and writes nothing', async () => {
    appendEvent(slug, { kind: 'scope.add', ticket: 'DEMO-101', text: 'added' });
    await quiet(async () => syncFromSource(slug, { now: NOW }));
    const before = JSON.stringify(readTracker(slug));
    const err = new UnknownStatusError('tickets', 'DEMO-101', 'Wontfix', '.agents/project.yaml');
    expect(await rejection(syncFromSource(slug, { now: NOW, createSource: failing(err) }))).toThrow(UnknownStatusError);
    expect(JSON.stringify(readTracker(slug))).toBe(before);
  });

  test('a closed board is never rewritten', async () => {
    writeSprint({ v: SCHEMA, slug, number: seq, name: 'Sprint 7', startedAt: '2026-01-12T09:00:00Z', closedAt: '2026-01-20T00:00:00Z' });
    expect(await rejection(syncFromSource(slug, { now: NOW }))).toThrow('is closed');
  });

  test('a ticket the source does not return keeps its previous row and is counted missing', async () => {
    appendEvent(slug, { kind: 'scope.add', ticket: 'DEMO-101', text: 'added' });
    appendEvent(slug, { kind: 'scope.add', ticket: 'DEMO-999', text: 'added' });
    const empty = (): Source => ({ kind: 'none', snapshot: async (): Promise<SourceSnapshot> => ({ source: 'none', syncedAt: NOW.toISOString(), searched: { tickets: 0, tests: 0, bugs: 0 }, tickets: {}, bugs: {} }) });
    const lines: string[] = [];
    const warn = console.warn;
    const log = console.log;
    console.warn = (m: string) => lines.push(m);
    console.log = (m: string) => lines.push(m);
    try { await syncFromSource(slug, { now: NOW, createSource: empty }); }
    finally { console.warn = warn; console.log = log; }
    expect(lines).toContain('sync: DEMO-999 not found in tickets.yaml');
    expect(lines.at(-1)).toContain('(2 missing)');
    expect((readTracker(slug) as TrackerSnapshot).tickets).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// jira-native, replaying the sprint source's recorded responses (no network)
// ---------------------------------------------------------------------------

const RECORDED = join(import.meta.dir, '..', 'lib', 'sprint-source', 'fixtures', 'recorded');
/** A recorded response; the Jira search ones are `{ issues: [...] }`. */
const recorded = <T = { issues: { key: string }[] }>(name: string): T => JSON.parse(readFileSync(join(RECORDED, name), 'utf8')) as T;
const SPRINT_JQL = 'project = ACME AND sprint in openSprints() AND issuetype = Story';

function jiraConfig(): BoardConfig {
  const catalogs: Catalogs = {
    workflows: recorded('workflows.json'),
    fields: recorded('fields.json'),
    linkTypes: recorded('link-types.json'),
  };
  const r = resolveBoardConfig({
    project: { project_name: 'Acme Store', project_key: 'ACME' },
    issue_tracker: { atlassian_url: 'https://company.atlassian.net' },
    testing: { default_env: 'staging', tms_cli: 'acli' },
    board: {
      source: 'auto',
      jql: SPRINT_JQL,
      statuses: {
        tickets: { not_ready: ['to_do'], in_test: ['in_test'], tested: ['qa_approved', 'completed'], blocked: ['blocked'], dropped: ['aborted'] },
        bugs: { open: ['open'], fixed: ['ready_for_qa'], resolved: ['closed'], discarded: ['rejected'] },
      },
    },
  }, catalogs);
  if (r.state !== 'ok') { throw new Error(JSON.stringify(r)); }
  return r.config;
}

/** The recorded Jira reads; any other request fails the test. */
function replay(): Transport {
  const tickets = recorded('jira-search-tickets.json');
  const sprint = recorded('jira-search-sprint.json');
  const withAcme3 = { ...tickets, issues: [...tickets.issues, sprint.issues.find(i => i.key === 'ACME-3')] };
  return {
    async jira<T>(path: string, body?: unknown): Promise<T> {
      const jql = (body as { jql?: string } | undefined)?.jql ?? '';
      if (path !== '/rest/api/3/search/jql') { throw new Error(`unexpected path ${path}`); }
      if (jql === SPRINT_JQL) { return sprint as T; }
      if (jql.startsWith('key in (ACME-1, ACME-2, ACME-3)')) { return withAcme3 as T; }
      if (jql.startsWith('key in (ACME-1, ACME-2)')) { return tickets as T; }
      if (jql.startsWith('key in (ACME-31)')) { return recorded('jira-search-sets.json'); }
      if (jql.startsWith('key in (ACME-11, ACME-12')) { return recorded('jira-search-tests.json'); }
      if (jql.startsWith('key in (ACME-41, ACME-42, ACME-43)')) { return recorded('jira-search-executions.json'); }
      if (jql.startsWith('key in (ACME-21)')) { return recorded('jira-search-bugs.json'); }
      throw new Error(`unexpected jql ${jql}`);
    },
    async xray<T>(): Promise<T> { throw new Error('jira-native never calls Xray'); },
  };
}

suite('sync through jira-native (recorded responses)', () => {
  test('tracked tickets with their tests, bucket and link; --discover adds the QA owner\'s sprint row', async () => {
    appendEvent(slug, { kind: 'scope.add', ticket: 'ACME-1', text: 'added' });
    appendEvent(slug, { kind: 'scope.add', ticket: 'ACME-2', text: 'added' });
    const config = jiraConfig();
    await quiet(async () => syncFromSource(slug, { discover: true, now: NOW, config, createSource: c => createJiraNativeSource(c, replay()) }));
    const t = readTracker(slug)!;
    expect(t.source).toBe('jira-native');
    expect(t.tickets['ACME-1']).toMatchObject({ status: 'In Test', statusKey: 'in_test', bucket: 'in_test', priority: 'High', module: 'Search', dev: 'Avery Dev', qa: 'Rowan QA', link: 'https://company.atlassian.net/browse/ACME-1', bugs: ['ACME-21'] });
    expect(t.tickets['ACME-1'].tcs.map(x => x.id)).toEqual(['ACME-11', 'ACME-12']);
    expect(t.tickets['ACME-2']).toMatchObject({ status: 'QA Approved', bucket: 'tested' });
    // ACME-3 sat untracked with QA owner Rowan QA, the board's QA: it joins the board.
    expect(t.tickets['ACME-3']).toMatchObject({ status: 'To Do', bucket: 'not_ready' });
    expect(events().some(e => e.kind === 'scope.add' && e.ticket === 'ACME-3' && e.text.includes('found in Jira'))).toBe(true);
    expect(t.bugs['ACME-21']).toMatchObject({ bucket: 'open', statusKey: 'open' });
    expect(t.discover?.sprintRows).toBe(3);
    expect(t.discover?.untracked).toEqual([]);
  });
});

suite('the config', () => {
  test('--source and --tickets override board.source and board.tickets_file for one run', () => {
    const c = boardConfig({ source: 'none', ticketsFile: 'some/tickets.yaml' });
    expect(c.source).toBe('none');
    expect(c.ticketsFile).toBe(join(process.cwd(), 'some', 'tickets.yaml'));
    expect(() => boardConfig({ source: 'bogus' as never })).toThrow('--source must be one of');
  });
});
