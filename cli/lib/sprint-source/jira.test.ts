import type { BoardConfig, Catalogs, FieldCatalog, LinkTypeCatalog, WorkflowCatalog } from './config.ts';
import type { Transport } from './transport.ts';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';

import { resolveBoardConfig } from './config.ts';
import { CatalogStatusError, searchAll, statusSlug } from './jira-common.ts';
import { createJiraNativeSource } from './jira-native.ts';
import { createJiraXraySource, TEST_PLAN_TESTS_QUERY, TEST_RUNS_QUERY } from './jira-xray.ts';
import { UnknownStatusError } from './status-map.ts';

const RECORDED = join(import.meta.dir, 'fixtures', 'recorded');

/** Awaits a promise expected to reject and hands `toThrow` a function rethrowing its reason. */
async function rejection(promise: Promise<unknown>): Promise<() => never> {
  const reason = await promise.then(() => new Error('expected a rejection, the promise resolved'), (err: unknown) => err);
  return () => { throw reason; };
}
const recorded = (name: string): unknown => JSON.parse(readFileSync(join(RECORDED, name), 'utf8'));
const catalogs: Catalogs = {
  workflows: recorded('workflows.json') as WorkflowCatalog,
  fields: recorded('fields.json') as FieldCatalog,
  linkTypes: recorded('link-types.json') as LinkTypeCatalog,
};
const NOW = new Date('2026-01-14T16:00:00Z');
const SPRINT_JQL = 'project = ACME AND sprint in openSprints() AND issuetype = Story';
const EMPTY = { isLast: true, issues: [] };

function config(tmsCli: string, overrides: Record<string, unknown> = {}, withCatalogs: Catalogs = catalogs): BoardConfig {
  const result = resolveBoardConfig({
    project: { project_name: 'Acme Store', project_key: 'ACME' },
    issue_tracker: { atlassian_url: 'https://company.atlassian.net' },
    testing: { default_env: 'staging', tms_cli: tmsCli },
    board: {
      source: 'auto',
      jql: SPRINT_JQL,
      statuses: {
        tickets: { not_ready: ['to_do'], in_test: ['in_test'], tested: ['qa_approved', 'completed'], blocked: ['blocked'], dropped: ['aborted'] },
        bugs: { open: ['open'], fixed: ['ready_for_qa'], resolved: ['closed'], discarded: ['rejected'] },
        ...overrides,
      },
    },
  }, withCatalogs);
  if (result.state !== 'ok') { throw new Error(JSON.stringify(result)); }
  return result.config;
}

/** Replays the recorded responses; any request it does not recognise fails the test. */
function replay(jqlOverrides: Record<string, unknown> = {}): Transport & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async jira<T>(path: string, body?: unknown): Promise<T> {
      const jql = (body as { jql?: string } | undefined)?.jql ?? '';
      calls.push(`jira ${jql}`);
      if (path !== '/rest/api/3/search/jql') { throw new Error(`unexpected path ${path}`); }
      if (jql in jqlOverrides) { return jqlOverrides[jql] as T; }
      if (jql === SPRINT_JQL || jql.startsWith('key in (ACME-1, ACME-2)')) { return recorded('jira-search-tickets.json') as T; }
      if (jql.startsWith('key in (ACME-31)')) { return recorded('jira-search-sets.json') as T; }
      if (jql.startsWith('key in (ACME-11, ACME-12')) { return recorded('jira-search-tests.json') as T; }
      if (jql.startsWith('key in (ACME-41, ACME-42, ACME-43)')) { return recorded('jira-search-executions.json') as T; }
      if (jql.startsWith('key in (ACME-21)')) { return recorded('jira-search-bugs.json') as T; }
      throw new Error(`unexpected jql ${jql}`);
    },
    async xray<T>(query: string, variables: Record<string, unknown>): Promise<T> {
      calls.push(`xray ${query === TEST_RUNS_QUERY ? 'runs' : 'plan'} ${JSON.stringify(variables)}`);
      if (query === TEST_RUNS_QUERY) { return recorded('xray-test-runs.json') as T; }
      if (query === TEST_PLAN_TESTS_QUERY) { return recorded('xray-test-plan.json') as T; }
      throw new Error('unexpected query');
    },
  };
}

const outcomes = (tests: Array<{ id: string, status: string, rawStatus: string | null }>): string[][] => tests.map(t => [t.id, t.status, String(t.rawStatus)]);

describe('status slug lookup', () => {
  test('a display name resolves to the slug of the issue\'s own work type', () => {
    expect(statusSlug(catalogs.workflows, 'ACME-1', 'Story', 'In Test')).toBe('in_test');
    expect(statusSlug(catalogs.workflows, 'ACME-1', 'Story', 'qa approved')).toBe('qa_approved');
    expect(statusSlug(catalogs.workflows, 'ACME-9', 'Tech Story', 'Completed')).toBe('completed');
  });

  test('a name the catalog does not know fails loud', () => {
    expect(() => statusSlug(catalogs.workflows, 'ACME-1', 'Story', 'In UAT')).toThrow(CatalogStatusError);
  });

  test('a status another work type declares is never borrowed (a stale mirror fails, it does not miscount)', () => {
    expect(() => statusSlug(catalogs.workflows, 'ACME-1', 'Story', 'Closed')).toThrow(/status "Closed" is not a status of work type "Story"/);
    expect(() => statusSlug(catalogs.workflows, 'ACME-1', 'Epic', 'Open')).toThrow(CatalogStatusError);
  });
});

describe('the coverage cascade (traceability-linking §3)', () => {
  test('ATS members count, a feature Test Set linked by another link type does not, direct links are the last rung', async () => {
    const transport = replay();
    const snapshot = await createJiraNativeSource(config('acli'), transport).snapshot({ now: NOW });
    // ACME-11 is reachable ONLY through the ATS ACME-31; ACME-12 through both, counted once.
    expect(snapshot.tickets['ACME-1'].tests.map(t => t.id)).toEqual(['ACME-11', 'ACME-12']);
    expect(transport.calls).toContain('jira key in (ACME-31) ORDER BY key');
    expect(transport.calls.some(c => c.includes('ACME-35'))).toBe(false);
  });

  test('a Story covered only through its ATS still counts its tests', async () => {
    const tickets = recorded('jira-search-tickets.json') as { issues: Array<{ key: string, fields: { issuelinks: Array<{ inwardIssue?: { key: string } }> } }> };
    const atsOnly = structuredClone(tickets);
    atsOnly.issues = atsOnly.issues.filter(i => i.key === 'ACME-1');
    atsOnly.issues[0].fields.issuelinks = atsOnly.issues[0].fields.issuelinks.filter(l => l.inwardIssue?.key === 'ACME-31');
    const transport = replay({ [SPRINT_JQL]: atsOnly });
    const snapshot = await createJiraNativeSource(config('acli'), transport).snapshot({ now: NOW });
    expect(snapshot.searched.tests).toBe(2);
    expect(outcomes(snapshot.tickets['ACME-1'].tests)).toEqual([['ACME-11', 'PASSED', 'passed'], ['ACME-12', 'FAILED', 'failed']]);
  });
});

describe('jira-native source', () => {
  test('tickets, tests from the test_status field, linked bugs, distinct denominators', async () => {
    const transport = replay();
    const snapshot = await createJiraNativeSource(config('acli'), transport).snapshot({ now: NOW });
    expect(snapshot.source).toBe('jira-native');
    expect(snapshot.searched).toEqual({ tickets: 2, tests: 3, bugs: 1 });
    expect(snapshot.tickets['ACME-1']).toMatchObject({
      title: 'Search filters by price range',
      status: 'In Test',
      statusKey: 'in_test',
      bucket: 'in_test',
      priority: 'High',
      sprint: 'Sprint 7',
      module: 'Search',
      developer: 'Avery Dev',
      qaOwner: 'Rowan QA',
      link: 'https://company.atlassian.net/browse/ACME-1',
      bugs: ['ACME-21'],
    });
    // No Test Plan membership in this modality: ACME-14 is not reached.
    expect(snapshot.tickets['ACME-2'].tests).toEqual([{ id: 'ACME-13', name: 'Next page keeps filters', status: 'NOT RUN', rawStatus: null, updatedAt: '2026-01-13T10:00:00.000+0000' }]);
    expect(snapshot.tickets['ACME-2']).toMatchObject({ bucket: 'tested', module: null, developer: null, qaOwner: null });
    expect(snapshot.bugs['ACME-21']).toMatchObject({ bucket: 'open', statusKey: 'open', tickets: ['ACME-1'], createdAt: '2026-01-14T10:35:00.000+0000' });
    expect(transport.calls.some(c => c.startsWith('xray'))).toBe(false);
  });

  test('a workflow status no bucket lists fails the snapshot', async () => {
    const partial = config('acli', { tickets: { not_ready: ['to_do'], in_test: [], tested: ['qa_approved'], blocked: [], dropped: [] } });
    expect(await rejection(createJiraNativeSource(partial, replay()).snapshot({ now: NOW }))).toThrow(UnknownStatusError);
  });

  test('without the test_status field in the catalog it stops, naming the sync to run', async () => {
    const noField = config('acli', {}, { ...catalogs, fields: { sprint: { id: 'customfield_10020' } } });
    expect(await rejection(createJiraNativeSource(noField, replay()).snapshot({ now: NOW }))).toThrow(/test_status field is not in \.agents\/jira-fields\.json/);
  });

  test('keys narrow the query and discover lists sprint rows the board does not track', async () => {
    const transport = replay({ [SPRINT_JQL]: recorded('jira-search-sprint.json') });
    const snapshot = await createJiraNativeSource(config('acli'), transport).snapshot({ now: NOW, keys: ['ACME-1', 'ACME-2'], discover: true });
    expect(snapshot.discover).toEqual({ at: NOW.toISOString(), sprintRows: 3, untracked: [{ id: 'ACME-3', title: 'Search suggests spelling fixes', status: 'To Do', qaOwner: 'Rowan QA' }] });
  });

  test('an empty sprint is all zeros, never an error', async () => {
    const transport = replay({ [SPRINT_JQL]: EMPTY });
    const snapshot = await createJiraNativeSource(config('acli'), transport).snapshot({ now: NOW });
    expect(snapshot.searched).toEqual({ tickets: 0, tests: 0, bugs: 0 });
    expect(snapshot.tickets).toEqual({});
  });

  test('a ticket key outside the pattern, or a non-ticket issue type in the query, fails and says to narrow board.jql', async () => {
    const tickets = recorded('jira-search-tickets.json') as { issues: Array<{ key: string, fields: { issuetype: { name: string } } }> };
    const foreign = structuredClone(tickets);
    foreign.issues[0].key = 'OPS-1';
    expect(await rejection(createJiraNativeSource(config('acli'), replay({ [SPRINT_JQL]: foreign })).snapshot({ now: NOW }))).toThrow(/OPS-1: does not match board\.ticket_key_pattern/);
    const bug = structuredClone(tickets);
    bug.issues[0].fields.issuetype.name = 'Bug';
    expect(await rejection(createJiraNativeSource(config('acli'), replay({ [SPRINT_JQL]: bug })).snapshot({ now: NOW }))).toThrow(/issue type "Bug" is not a ticket work type .*narrow board\.jql/);
  });

  test('more than one chunk of keys is searched in several key-in clauses', async () => {
    const keys = Array.from({ length: 60 }, (_, i) => `ACME-${100 + i}`);
    const transport = replay(Object.fromEntries([
      [`key in (${keys.slice(0, 50).join(', ')}) ORDER BY key`, EMPTY],
      [`key in (${keys.slice(50).join(', ')}) ORDER BY key`, EMPTY],
    ]));
    const snapshot = await createJiraNativeSource(config('acli'), transport).snapshot({ now: NOW, keys });
    expect(snapshot.searched.tickets).toBe(0);
    expect(transport.calls.filter(c => c.startsWith('jira key in (ACME-1'))).toHaveLength(2);
  });
});

describe('jira search paging', () => {
  test('follows nextPageToken until isLast', async () => {
    const pages = [
      { isLast: false, nextPageToken: 'p2', issues: [{ id: '1', key: 'ACME-1', fields: {} }] },
      { isLast: true, issues: [{ id: '2', key: 'ACME-2', fields: {} }] },
    ];
    const tokens: unknown[] = [];
    const transport: Transport = {
      jira: async <T>(_path: string, body?: unknown) => { tokens.push((body as { nextPageToken?: string }).nextPageToken); return pages[tokens.length - 1] as T; },
      xray: async <T>() => ({}) as T,
    };
    const issues = await searchAll(transport, 'project = ACME', ['summary']);
    expect(issues.map(i => i.key)).toEqual(['ACME-1', 'ACME-2']);
    expect(tokens).toEqual([undefined, 'p2']);
  });
});

describe('jira-xray source', () => {
  test('runs are scoped to the ticket\'s own executions and the newest execution wins', async () => {
    const transport = replay();
    const snapshot = await createJiraXraySource(config('bun xray'), transport).snapshot({ now: NOW });
    expect(snapshot.source).toBe('jira-xray');
    expect(snapshot.searched).toEqual({ tickets: 2, tests: 4, bugs: 1 });
    // ACME-11: PASSED in its ATR; the newer FAILED run belongs to an unrelated execution (1099) and is ignored.
    expect(outcomes(snapshot.tickets['ACME-1'].tests)).toEqual([['ACME-11', 'PASSED', 'PASSED'], ['ACME-12', 'NOT RUN', 'TODO']]);
    // ACME-14 comes from the Test Plan's Xray membership; ACME-13 PASSED in the old ATR but is
    // re-planned (TODO, never started) in the newer re-test execution: the re-plan wins.
    expect(outcomes(snapshot.tickets['ACME-2'].tests)).toEqual([['ACME-14', 'FAILED', 'FAILED'], ['ACME-13', 'NOT RUN', 'TODO']]);
    expect(transport.calls).toContain('xray plan {"issueId":"1051","limit":100,"start":0}');
    expect(transport.calls).toContain('xray runs {"testIssueIds":["1011","1012","1014","1013"],"testExecIssueIds":["1041","1042","1043"],"limit":100,"start":0}');
  });

  test('a ticket with no linked execution reads every test as NOT RUN with no raw status', async () => {
    const tickets = recorded('jira-search-tickets.json') as { issues: Array<{ key: string, fields: { issuelinks: Array<{ inwardIssue?: { fields?: { issuetype?: { name?: string } } } }> } }> };
    const noExec = structuredClone(tickets);
    noExec.issues = noExec.issues.filter(i => i.key === 'ACME-1');
    noExec.issues[0].fields.issuelinks = noExec.issues[0].fields.issuelinks.filter(l => l.inwardIssue?.fields?.issuetype?.name !== 'Test Execution');
    const transport = replay({ [SPRINT_JQL]: noExec });
    const snapshot = await createJiraXraySource(config('bun xray'), transport).snapshot({ now: NOW });
    expect(outcomes(snapshot.tickets['ACME-1'].tests)).toEqual([['ACME-11', 'NOT RUN', 'null'], ['ACME-12', 'NOT RUN', 'null']]);
    expect(transport.calls.some(c => c.startsWith('xray runs'))).toBe(false);
  });

  test('run paging continues past a full page even when the API sends no total', async () => {
    const filler = Array.from({ length: 100 }, (_, i) => ({ status: { name: 'FAILED' }, finishedOn: '2026-01-01T00:00:00Z', test: { issueId: `9${i}` }, testExecution: { issueId: '1041' } }));
    const pages = [filler, [{ status: { name: 'PASSED' }, finishedOn: '2026-01-14T09:00:00Z', test: { issueId: '1011' }, testExecution: { issueId: '1041' } }]];
    const base = replay();
    let runCalls = 0;
    const transport: Transport = {
      jira: base.jira,
      xray: async <T>(query: string, variables: Record<string, unknown>) => {
        if (query !== TEST_RUNS_QUERY) { return base.xray<T>(query, variables); }
        runCalls += 1;
        return { getTestRuns: { results: pages[(variables.start as number) / 100] ?? [] } } as T;
      },
    };
    const snapshot = await createJiraXraySource(config('bun xray'), transport).snapshot({ now: NOW });
    expect(snapshot.tickets['ACME-1'].tests[0]).toMatchObject({ id: 'ACME-11', status: 'PASSED' });
    expect(runCalls).toBe(2);
  });

  test('a run status the config does not list (a custom Xray status) fails the snapshot', async () => {
    const base = replay();
    const custom: Transport = {
      jira: base.jira,
      xray: async <T>(query: string, variables: Record<string, unknown>) => (query === TEST_RUNS_QUERY
        ? { getTestRuns: { total: 1, results: [{ status: { name: 'RETEST' }, finishedOn: '2026-01-14T09:00:00Z', test: { issueId: '1011' }, testExecution: { issueId: '1041' } }] } } as T
        : base.xray<T>(query, variables)),
    };
    expect(await rejection(createJiraXraySource(config('bun xray'), custom).snapshot({ now: NOW }))).toThrow(/ACME-11: status "RETEST" is in no bucket of board\.statuses\.tests/);
  });
});
