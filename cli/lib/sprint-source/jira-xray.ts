/**
 * @fileoverview The `jira-xray` source: Jira with Xray Cloud.
 *
 * A test case is a Test issue reached through the coverage cascade
 * (`jira-common.ts`; here the Test Plan rung reads Xray membership too). Its
 * outcome is its run in the ticket's OWN Test Executions (the ATR and any
 * re-test execution linked to the ticket by the `test` link), never a run from
 * an unrelated execution such as a regression or an old sprint. When the test
 * ran in several of them, the run of the most recently CREATED execution wins,
 * even when that run has not started: a re-planned TODO is newer than the PASSED
 * it replaces, and reading the old PASSED would be false coverage. A ticket with
 * no linked execution, or a test with no run in one, is NOT RUN with no raw
 * status. A run status the config does not list, a custom one included, fails
 * the snapshot.
 */

import type { BoardConfig } from './config.ts';
import type { JiraLinkedIssue, PlanReader, TestReader } from './jira-common.ts';
import type { Transport } from './transport.ts';
import type { Source, TestCase } from './types.ts';

import { createJiraSource, issuesByKey } from './jira-common.ts';
import { classifyTest } from './status-map.ts';

export const TEST_RUNS_QUERY = `
  query SprintTestRuns($testIssueIds: [String], $testExecIssueIds: [String], $limit: Int!, $start: Int) {
    getTestRuns(testIssueIds: $testIssueIds, testExecIssueIds: $testExecIssueIds, limit: $limit, start: $start) {
      total
      results {
        id
        status { name }
        startedOn
        finishedOn
        test { issueId }
        testExecution { issueId }
      }
    }
  }
`;

export const TEST_PLAN_TESTS_QUERY = `
  query SprintTestPlanTests($issueId: String!, $limit: Int!, $start: Int) {
    getTestPlan(issueId: $issueId) {
      tests(limit: $limit, start: $start) {
        total
        results { issueId jira(fields: ["key", "summary"]) }
      }
    }
  }
`;

const PAGE = 100;

interface TestRun {
  status?: { name?: string }
  startedOn?: string | null
  finishedOn?: string | null
  test?: { issueId?: string }
  testExecution?: { issueId?: string }
}

interface Paged<T> {
  total?: number
  results?: T[]
}

/**
 * Every page of an Xray list. A page shorter than the limit ends it; `total`,
 * when the API sends it, ends it too. Without `total` the loop never stops on
 * page one by accident.
 */
async function allPages<T>(fetchPage: (start: number) => Promise<Paged<T> | undefined>): Promise<T[]> {
  const out: T[] = [];
  for (let start = 0; ; start += PAGE) {
    const page = await fetchPage(start);
    const results = page?.results ?? [];
    out.push(...results);
    if (results.length < PAGE || out.length >= (page?.total ?? Number.POSITIVE_INFINITY)) { return out; }
  }
}

export function createJiraXraySource(config: BoardConfig, transport: Transport): Source {
  const readTests: TestReader = async (requests) => {
    const out = new Map<string, TestCase[]>();
    const tests = [...new Map(requests.flatMap(r => r.tests).map(t => [t.key, t])).values()];
    const executions = [...new Map(requests.flatMap(r => r.executions).map(e => [e.key, e])).values()];

    // The execution's creation date orders the candidates; the Jira search is the only source of it.
    const createdById = new Map<string, string>();
    for (const issue of await issuesByKey(transport, executions.map(e => e.key), ['created'])) {
      createdById.set(issue.id, issue.fields.created ?? '');
    }

    const runs = tests.length > 0 && executions.length > 0
      ? await allPages<TestRun>(async start => (await transport.xray<{ getTestRuns?: Paged<TestRun> }>(TEST_RUNS_QUERY, {
          testIssueIds: tests.map(t => t.id),
          testExecIssueIds: executions.map(e => e.id),
          limit: PAGE,
          start,
        })).getTestRuns)
      : [];

    const names = new Map<string, { name: string, updated: string | null }>();
    for (const issue of await issuesByKey(transport, tests.map(t => t.key), ['summary', 'updated'])) {
      names.set(issue.key, { name: issue.fields.summary ?? issue.key, updated: issue.fields.updated ?? null });
    }

    for (const request of requests) {
      const own = new Set(request.executions.map(e => e.id));
      out.set(request.ticket, request.tests.map((test: JiraLinkedIssue): TestCase => {
        let best: { status: string, created: string, at: string } | null = null;
        for (const run of runs) {
          const exec = run.testExecution?.issueId;
          const status = run.status?.name;
          if (run.test?.issueId !== test.id || !exec || !own.has(exec) || !status) { continue; }
          const candidate = { status, created: createdById.get(exec) ?? '', at: run.finishedOn ?? run.startedOn ?? '' };
          if (!best || candidate.created > best.created || (candidate.created === best.created && candidate.at > best.at)) { best = candidate; }
        }
        const info = names.get(test.key);
        return {
          id: test.key,
          name: info?.name ?? test.fields?.summary ?? test.key,
          status: classifyTest(config.statusMap, test.key, best?.status ?? null),
          rawStatus: best?.status ?? null,
          updatedAt: best?.at || info?.updated || null,
        };
      }));
    }
    return out;
  };

  const readPlans: PlanReader = async (plans) => {
    const out = new Map<string, JiraLinkedIssue[]>();
    for (const plan of plans) {
      const members = await allPages<{ issueId?: string, jira?: { key?: string, summary?: string } }>(async start =>
        (await transport.xray<{ getTestPlan?: { tests?: Paged<{ issueId?: string, jira?: { key?: string, summary?: string } }> } }>(
          TEST_PLAN_TESTS_QUERY,
          { issueId: plan.id, limit: PAGE, start },
        )).getTestPlan?.tests);
      out.set(plan.key, members
        .filter(m => m.issueId && m.jira?.key)
        .map(m => ({ id: m.issueId as string, key: m.jira?.key as string, fields: { summary: m.jira?.summary } })));
    }
    return out;
  };

  return createJiraSource({ kind: 'jira-xray', config, transport, readTests, readPlans });
}
