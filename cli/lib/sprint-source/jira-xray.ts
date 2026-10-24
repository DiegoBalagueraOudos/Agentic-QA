/**
 * @fileoverview The `jira-xray` source: Jira with Xray Cloud.
 *
 * A test case is a Test issue linked to the ticket; its outcome is the status
 * of its LATEST test run (by `finishedOn`, else `startedOn`), read through the
 * Xray GraphQL API. A test with no run yet has no status (`rawStatus: null`,
 * NOT RUN); any run status the config does not list, a custom one included,
 * fails the snapshot.
 */

import type { BoardConfig } from './config.ts';
import type { TestReader } from './jira-common.ts';
import type { Transport } from './transport.ts';
import type { Source, TestCase } from './types.ts';

import { createJiraSource, issuesByKey, issueTypeNames } from './jira-common.ts';
import { classifyTest } from './status-map.ts';

export const TEST_RUNS_QUERY = `
  query SprintTestRuns($testIssueIds: [String], $limit: Int!, $start: Int) {
    getTestRuns(testIssueIds: $testIssueIds, limit: $limit, start: $start) {
      total
      results {
        id
        status { name }
        startedOn
        finishedOn
        test { issueId }
      }
    }
  }
`;

const PAGE = 100;

interface TestRunsPage {
  getTestRuns?: {
    total?: number
    results?: Array<{ id?: string, status?: { name?: string }, startedOn?: string | null, finishedOn?: string | null, test?: { issueId?: string } }>
  }
}

export function createJiraXraySource(config: BoardConfig, transport: Transport): Source {
  const readTests: TestReader = async (linked) => {
    const out = new Map<string, TestCase>();
    if (linked.length === 0) { return out; }

    const latest = new Map<string, { status: string, at: string }>();
    const ids = linked.map(t => t.id);
    for (let start = 0; ; start += PAGE) {
      const page = await transport.xray<TestRunsPage>(TEST_RUNS_QUERY, { testIssueIds: ids, limit: PAGE, start });
      const results = page.getTestRuns?.results ?? [];
      for (const run of results) {
        const issueId = run.test?.issueId;
        const status = run.status?.name;
        const at = run.finishedOn ?? run.startedOn ?? '';
        if (!issueId || !status) { continue; }
        const seen = latest.get(issueId);
        if (!seen || at > seen.at) { latest.set(issueId, { status, at }); }
      }
      if (results.length < PAGE || start + results.length >= (page.getTestRuns?.total ?? 0)) { break; }
    }

    const byKey = new Map(linked.map(t => [t.key, t.id]));
    for (const issue of await issuesByKey(transport, linked.map(t => t.key), ['summary', 'updated'])) {
      const run = latest.get(byKey.get(issue.key) ?? issue.id) ?? null;
      out.set(issue.key, {
        id: issue.key,
        name: issue.fields.summary ?? issue.key,
        status: classifyTest(config.statusMap, issue.key, run?.status ?? null),
        rawStatus: run?.status ?? null,
        updatedAt: run?.at || issue.fields.updated || null,
      });
    }
    return out;
  };
  return createJiraSource({
    kind: 'jira-xray',
    config,
    transport,
    testTypeNames: issueTypeNames(config.catalogs.workflows, ['test_case'], 'Test'),
    readTests,
  });
}
