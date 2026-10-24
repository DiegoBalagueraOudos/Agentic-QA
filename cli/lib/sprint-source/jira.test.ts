import type { BoardConfig, Catalogs, FieldCatalog, WorkflowCatalog } from './config.ts';
import type { Transport } from './transport.ts';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';

import { resolveBoardConfig } from './config.ts';
import { CatalogStatusError, statusSlug } from './jira-common.ts';
import { createJiraNativeSource } from './jira-native.ts';
import { createJiraXraySource, TEST_RUNS_QUERY } from './jira-xray.ts';
import { UnknownStatusError } from './status-map.ts';

/** Awaits a promise expected to reject and hands `toThrow` a function rethrowing its reason. */
async function rejection(promise: Promise<unknown>): Promise<() => never> {
  const reason = await promise.then(() => new Error('expected a rejection, the promise resolved'), (err: unknown) => err);
  return () => { throw reason; };
}

const RECORDED = join(import.meta.dir, 'fixtures', 'recorded');
const recorded = (name: string): unknown => JSON.parse(readFileSync(join(RECORDED, name), 'utf8'));
const catalogs: Catalogs = {
  workflows: recorded('workflows.json') as WorkflowCatalog,
  fields: recorded('fields.json') as FieldCatalog,
};
const NOW = new Date('2026-01-14T16:00:00Z');
const SPRINT_JQL = 'project = ACME AND sprint in openSprints() AND issuetype = Story';

function config(tmsCli: string, overrides: Record<string, unknown> = {}): BoardConfig {
  const result = resolveBoardConfig({
    project: { project_name: 'Acme Store', project_key: 'ACME' },
    issue_tracker: { atlassian_url: 'https://company.atlassian.net' },
    testing: { default_env: 'staging', tms_cli: tmsCli },
    board: {
      source: 'auto',
      jql: SPRINT_JQL,
      statuses: {
        tickets: { not_ready: ['to_do'], in_test: ['in_test'], tested: ['qa_approved'], blocked: ['blocked'], dropped: ['aborted'] },
        bugs: { open: ['open'], fixed: ['ready_for_qa'], resolved: ['closed'], discarded: ['rejected'] },
        ...overrides,
      },
    },
  }, catalogs);
  if (result.state !== 'ok') { throw new Error(JSON.stringify(result)); }
  return result.config;
}

/** Replays the recorded responses; any request it does not recognise fails the test. */
function replay(): Transport & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async jira<T>(path: string, body?: unknown): Promise<T> {
      const jql = (body as { jql?: string } | undefined)?.jql ?? '';
      calls.push(`jira ${path} ${jql}`);
      if (path !== '/rest/api/3/search/jql') { throw new Error(`unexpected path ${path}`); }
      if (jql === SPRINT_JQL) { return recorded('jira-search-tickets.json') as T; }
      if (jql.startsWith('key in (ACME-1, ACME-2)')) { return recorded('jira-search-tickets.json') as T; }
      if (jql.startsWith('key in (ACME-11, ACME-12, ACME-13)')) { return recorded('jira-search-tests.json') as T; }
      if (jql.startsWith('key in (ACME-21)')) { return recorded('jira-search-bugs.json') as T; }
      throw new Error(`unexpected jql ${jql}`);
    },
    async xray<T>(query: string, variables: Record<string, unknown>): Promise<T> {
      calls.push(`xray ${JSON.stringify(variables)}`);
      if (query !== TEST_RUNS_QUERY) { throw new Error('unexpected query'); }
      return recorded('xray-test-runs.json') as T;
    },
  };
}

describe('status slug lookup', () => {
  test('a display name resolves to the slug of the issue\'s own work type', () => {
    expect(statusSlug(catalogs.workflows, 'ACME-1', 'Story', 'In Test')).toBe('in_test');
    expect(statusSlug(catalogs.workflows, 'ACME-1', 'Story', 'qa approved')).toBe('qa_approved');
  });

  test('a name the catalog does not know fails loud', () => {
    expect(() => statusSlug(catalogs.workflows, 'ACME-1', 'Story', 'In UAT')).toThrow(CatalogStatusError);
  });
});

describe('jira-native source', () => {
  test('tickets, tests from the test_status field, linked bugs, denominators', async () => {
    const transport = replay();
    const snapshot = await createJiraNativeSource(config('acli'), transport).snapshot({ now: NOW });
    expect(snapshot.source).toBe('jira-native');
    expect(snapshot.searched).toEqual({ tickets: 2, tests: 3, bugs: 1 });

    const one = snapshot.tickets['ACME-1'];
    expect(one).toMatchObject({
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
    expect(one.tests.map(t => [t.id, t.status, t.rawStatus])).toEqual([['ACME-11', 'PASSED', 'passed'], ['ACME-12', 'FAILED', 'failed']]);
    expect(snapshot.tickets['ACME-2'].tests).toEqual([{ id: 'ACME-13', name: 'Next page keeps filters', status: 'NOT RUN', rawStatus: null, updatedAt: '2026-01-13T10:00:00.000+0000' }]);
    expect(snapshot.tickets['ACME-2']).toMatchObject({ bucket: 'tested', module: null, developer: null, qaOwner: null });
    expect(snapshot.bugs['ACME-21']).toMatchObject({ bucket: 'open', statusKey: 'open', tickets: ['ACME-1'], createdAt: '2026-01-14T10:35:00.000+0000' });
    expect(transport.calls.some(c => c.startsWith('xray'))).toBe(false);
  });

  test('a workflow status no bucket lists fails the snapshot', async () => {
    const partial = config('acli', { tickets: { not_ready: ['to_do'], in_test: [], tested: ['qa_approved'], blocked: [], dropped: [] } });
    expect(await rejection(createJiraNativeSource(partial, replay()).snapshot({ now: NOW }))).toThrow(UnknownStatusError);
  });

  test('keys narrow the query and discover lists sprint rows the board does not track', async () => {
    const transport = replay();
    const sprint = recorded('jira-search-sprint.json');
    const withSprint: Transport = {
      ...transport,
      jira: async <T>(path: string, body?: unknown) => ((body as { jql?: string }).jql === SPRINT_JQL ? sprint as T : transport.jira<T>(path, body)),
    };
    const snapshot = await createJiraNativeSource(config('acli'), withSprint).snapshot({ now: NOW, keys: ['ACME-1', 'ACME-2'], discover: true });
    expect(snapshot.discover).toEqual({ at: NOW.toISOString(), sprintRows: 3, untracked: [{ id: 'ACME-3', title: 'Search suggests spelling fixes', status: 'To Do', qaOwner: 'Rowan QA' }] });
  });
});

describe('jira-xray source', () => {
  test('a test\'s outcome is its latest run; no run = NOT RUN with no raw status', async () => {
    const transport = replay();
    const snapshot = await createJiraXraySource(config('bun xray'), transport).snapshot({ now: NOW });
    expect(snapshot.source).toBe('jira-xray');
    expect(snapshot.searched).toEqual({ tickets: 2, tests: 3, bugs: 1 });
    expect(snapshot.tickets['ACME-1'].tests.map(t => [t.id, t.status, t.rawStatus, t.updatedAt])).toEqual([
      ['ACME-11', 'PASSED', 'PASSED', '2026-01-14T09:12:00Z'],
      ['ACME-12', 'NOT RUN', 'TODO', '2026-01-14T10:30:00.000+0000'],
    ]);
    expect(snapshot.tickets['ACME-2'].tests[0]).toMatchObject({ id: 'ACME-13', status: 'NOT RUN', rawStatus: null });
    expect(transport.calls).toContain('xray {"testIssueIds":["1011","1012","1013"],"limit":100,"start":0}');
  });

  test('a run status the config does not list (a custom Xray status) fails the snapshot', async () => {
    const custom: Transport = {
      ...replay(),
      xray: async <T>() => ({ getTestRuns: { total: 1, results: [{ id: 'r9', status: { name: 'RETEST' }, finishedOn: '2026-01-14T09:00:00Z', test: { issueId: '1011' } }] } }) as T,
    };
    expect(await rejection(createJiraXraySource(config('bun xray'), custom).snapshot({ now: NOW }))).toThrow(/ACME-11: status "RETEST" is in no bucket of board\.statuses\.tests/);
  });
});
