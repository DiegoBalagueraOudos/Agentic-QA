/**
 * @fileoverview What the two Jira sources share: the search, the status-slug
 * lookup, the coverage cascade, the ticket and bug rows. They differ only in
 * where a test's outcome lives (the `test_status` field vs the latest Xray run)
 * and in whether a Test Plan's membership is readable (Xray only), which each
 * passes in.
 *
 * Statuses are bucketed by the workflow SLUG of `.agents/jira-workflows.json`,
 * never by the display name: a status the issue's own work type does not
 * declare throws `CatalogStatusError` (the mirror is stale), a slug no bucket
 * lists throws `UnknownStatusError` (the config is incomplete). Neither is ever
 * counted.
 *
 * A ticket's tests follow the resolution cascade of
 * `agentic-qa-core/references/traceability-linking.md` §3, every rung, deduped:
 * the members of each Test Set linked to it by the `test` link (its ATS: the
 * member TC carries a `TC -> ATS` link in both modalities), then the members of
 * each linked Test Plan (Xray membership, jira-xray only), then Tests linked to
 * it directly (the last rung).
 */

import type { BoardConfig, WorkflowCatalog } from './config.ts';
import type { Transport } from './transport.ts';
import type { Bug, SnapshotOptions, Source, SourceKind, SourceSnapshot, TestCase, Ticket, UntrackedRow } from './types.ts';

import { BUG_WORK_TYPES, TICKET_WORK_TYPES, WORKFLOWS_CATALOG } from './config.ts';
import { classifyBug, classifyTicket } from './status-map.ts';

// ============================================================================
// JIRA SHAPES (only the fields read)
// ============================================================================

export interface JiraLinkedIssue {
  id: string
  key: string
  fields?: { summary?: string, issuetype?: { name?: string }, status?: { name?: string } }
}

export interface JiraLink {
  type?: { name?: string }
  inwardIssue?: JiraLinkedIssue
  outwardIssue?: JiraLinkedIssue
}

export interface JiraIssue {
  id: string
  key: string
  fields: Record<string, unknown> & {
    summary?: string
    status?: { name?: string }
    priority?: { name?: string } | null
    issuetype?: { name?: string }
    components?: Array<{ name?: string }>
    assignee?: { displayName?: string } | null
    updated?: string
    created?: string
    issuelinks?: JiraLink[]
  }
}

interface SearchPage {
  issues?: JiraIssue[]
  nextPageToken?: string
  isLast?: boolean
}

export class CatalogStatusError extends Error {
  constructor(readonly item: string, readonly issueType: string, readonly statusName: string) {
    super(
      `${item}: status "${statusName}" is not a status of work type "${issueType}" in ${WORKFLOWS_CATALOG}. `
      + 'The mirror is stale or the issue type is not catalogued: run `bun run jira:sync-workflows`, then map the new slug in board.statuses.',
    );
    this.name = 'CatalogStatusError';
  }
}

// ============================================================================
// HELPERS
// ============================================================================

const BASE_FIELDS = ['summary', 'status', 'priority', 'issuetype', 'components', 'assignee', 'updated', 'created', 'issuelinks'];
export const KEY_CHUNK = 50;

/** Every page of a JQL search (`POST /rest/api/3/search/jql`, token-paged). */
export async function searchAll(transport: Transport, jql: string, fields: readonly string[]): Promise<JiraIssue[]> {
  const out: JiraIssue[] = [];
  let nextPageToken: string | undefined;
  do {
    const page = await transport.jira<SearchPage>('/rest/api/3/search/jql', { jql, fields, maxResults: 100, ...(nextPageToken ? { nextPageToken } : {}) });
    out.push(...(page.issues ?? []));
    nextPageToken = page.isLast === false || (page.isLast === undefined && page.nextPageToken) ? page.nextPageToken : undefined;
  } while (nextPageToken);
  return out;
}

/** Issues by key, in chunks small enough for one JQL clause. */
export async function issuesByKey(transport: Transport, keys: readonly string[], fields: readonly string[]): Promise<JiraIssue[]> {
  const out: JiraIssue[] = [];
  for (let i = 0; i < keys.length; i += KEY_CHUNK) {
    const chunk = keys.slice(i, i + KEY_CHUNK);
    out.push(...await searchAll(transport, `key in (${chunk.join(', ')}) ORDER BY key`, fields));
  }
  return out;
}

/** The `jira_issue_type.name` of each work-type slug the catalog declares, with a fallback name. */
export function issueTypeNames(catalog: WorkflowCatalog | null, workTypes: readonly string[], fallback: readonly string[]): Set<string> {
  const names = new Set<string>();
  for (const workType of workTypes) {
    const name = catalog?.[workType]?.jira_issue_type?.name;
    if (name) { names.add(name); }
  }
  if (names.size === 0) { for (const name of fallback) { names.add(name); } }
  return names;
}

/**
 * Status display name -> workflow slug, looked up in the issue's OWN work
 * type only. A status that work type does not declare, or an issue type the
 * catalog does not hold, fails loud: borrowing a same-named slug from another
 * work type is how a stale mirror would miscount in silence.
 */
export function statusSlug(catalog: WorkflowCatalog | null, item: string, issueType: string, statusName: string): string {
  for (const workType of Object.values(catalog ?? {})) {
    if (workType.jira_issue_type?.name !== issueType) { continue; }
    const own = Object.entries(workType.statuses ?? {}).filter(([, s]) => s.name?.toLowerCase() === statusName.toLowerCase()).map(([slug]) => slug);
    if (own.length === 1) { return own[0]; }
  }
  throw new CatalogStatusError(item, issueType, statusName);
}

/** The id of a field slug in `.agents/jira-fields.json`, when catalogued. */
export function fieldId(config: BoardConfig, slug: string): string | null {
  return config.catalogs.fields?.[slug]?.id ?? null;
}

/** A sprint field value (a list of sprints) -> the active one's name, else the last one's. */
function sprintName(value: unknown): string | null {
  if (!Array.isArray(value) || value.length === 0) { return null; }
  const sprints = value as Array<{ name?: string, state?: string }>;
  return (sprints.find(s => s.state === 'active') ?? sprints[sprints.length - 1]).name ?? null;
}

function userName(value: unknown): string | null {
  return (value as { displayName?: string } | null | undefined)?.displayName ?? null;
}

/**
 * Linked issues of the given issue types, deduplicated, in link order. With a
 * `linkName`, only links of that type count (the `test` link for coverage);
 * `null` accepts any link type (an instance whose link catalog is absent).
 */
export function linkedOfType(issue: { fields?: { issuelinks?: JiraLink[] } }, typeNames: ReadonlySet<string>, linkName: string | null = null): JiraLinkedIssue[] {
  const seen = new Set<string>();
  const out: JiraLinkedIssue[] = [];
  for (const link of issue.fields?.issuelinks ?? []) {
    const other = link.outwardIssue ?? link.inwardIssue;
    if (!other || seen.has(other.key) || !typeNames.has(other.fields?.issuetype?.name ?? '')) { continue; }
    if (linkName !== null && link.type?.name !== linkName) { continue; }
    seen.add(other.key);
    out.push(other);
  }
  return out;
}

// ============================================================================
// THE SOURCE
// ============================================================================

/** What a test reader receives for one ticket: its tests, and the executions linked to it. */
export interface TicketTests {
  ticket: string
  tests: JiraLinkedIssue[]
  /** Test Execution issues linked to the ticket (its ATR, re-test executions). */
  executions: JiraLinkedIssue[]
}

/** Reads every ticket's test outcomes in one pass; ticket key -> its test cases, in input order. */
export type TestReader = (requests: TicketTests[]) => Promise<Map<string, TestCase[]>>;

/** Members of each Test Plan, keyed by plan key (Xray membership; jira-native has none). */
export type PlanReader = (plans: JiraLinkedIssue[]) => Promise<Map<string, JiraLinkedIssue[]>>;

export interface JiraSourceParts {
  kind: Exclude<SourceKind, 'none'>
  config: BoardConfig
  transport: Transport
  readTests: TestReader
  readPlans?: PlanReader
}

/** The issue type names the cascade walks, from the catalog with stock fallbacks. */
export function coverageTypes(config: BoardConfig): { tests: Set<string>, sets: Set<string>, plans: Set<string>, executions: Set<string> } {
  const catalog = config.catalogs.workflows;
  return {
    tests: issueTypeNames(catalog, ['test_case'], ['Test']),
    sets: issueTypeNames(catalog, ['test_set'], ['Test Set']),
    plans: issueTypeNames(catalog, ['test_plan'], ['Test Plan']),
    executions: issueTypeNames(catalog, ['test_execution', 're_test_execution'], ['Test Execution']),
  };
}

export function createJiraSource(parts: JiraSourceParts): Source {
  const { kind, config, transport, readTests, readPlans } = parts;
  const catalog = config.catalogs.workflows;
  const ticketTypeNames = issueTypeNames(catalog, TICKET_WORK_TYPES, ['Story']);
  const bugTypeNames = issueTypeNames(catalog, BUG_WORK_TYPES, ['Bug']);
  const types = coverageTypes(config);
  const testLink = config.catalogs.linkTypes?.test?.name ?? null;
  const sprintField = fieldId(config, 'sprint');
  const qaField = fieldId(config, 'qa_assignee');
  const fields = [...BASE_FIELDS, ...(sprintField ? [sprintField] : []), ...(qaField ? [qaField] : [])];
  const link = (key: string): string | null => (config.jiraHost ? `${config.jiraHost}/browse/${key}` : null);

  const common = (issue: JiraIssue): Omit<Ticket, 'bucket' | 'tests' | 'bugs'> => {
    const f = issue.fields;
    return {
      id: issue.key,
      title: f.summary ?? issue.key,
      status: f.status?.name ?? '',
      statusKey: statusSlug(catalog, issue.key, f.issuetype?.name ?? '', f.status?.name ?? ''),
      priority: f.priority?.name ?? null,
      type: f.issuetype?.name ?? null,
      sprint: sprintField ? sprintName(f[sprintField]) : null,
      module: f.components?.[0]?.name ?? null,
      developer: userName(f.assignee),
      qaOwner: qaField ? userName(f[qaField]) : null,
      updatedAt: f.updated ?? null,
      link: link(issue.key),
    };
  };

  return {
    kind,
    async snapshot(options: SnapshotOptions = {}): Promise<SourceSnapshot> {
      const now = options.now ?? new Date();
      const keys = options.keys ? [...options.keys] : null;
      const issues = keys ? await issuesByKey(transport, keys, fields) : await searchAll(transport, config.jql as string, fields);

      for (const issue of issues) {
        if (!config.ticketKeyPattern.test(issue.key)) {
          throw new Error(`${issue.key}: does not match board.ticket_key_pattern (${config.ticketKeyPattern.source}); narrow board.jql or widen the pattern`);
        }
        const type = issue.fields.issuetype?.name ?? '';
        if (!ticketTypeNames.has(type)) {
          throw new Error(`${issue.key}: issue type "${type}" is not a ticket work type (${[...ticketTypeNames].join(', ')}); narrow board.jql to tickets`);
        }
      }

      // --- the coverage cascade, rung by rung
      const setsByTicket = new Map(issues.map(i => [i.key, linkedOfType(i, types.sets, testLink)]));
      const setKeys = [...new Set([...setsByTicket.values()].flat().map(s => s.key))];
      const setMembers = new Map<string, JiraLinkedIssue[]>();
      for (const set of await issuesByKey(transport, setKeys, ['issuelinks'])) {
        setMembers.set(set.key, linkedOfType(set, types.tests, testLink));
      }
      const plansByTicket = new Map(issues.map(i => [i.key, readPlans ? linkedOfType(i, types.plans, testLink) : []]));
      const allPlans = [...new Map([...plansByTicket.values()].flat().map(p => [p.key, p])).values()];
      const planMembers = readPlans && allPlans.length > 0 ? await readPlans(allPlans) : new Map<string, JiraLinkedIssue[]>();

      const requests: TicketTests[] = issues.map((issue) => {
        const tests = new Map<string, JiraLinkedIssue>();
        for (const set of setsByTicket.get(issue.key) ?? []) { for (const t of setMembers.get(set.key) ?? []) { tests.set(t.key, tests.get(t.key) ?? t); } }
        for (const plan of plansByTicket.get(issue.key) ?? []) { for (const t of planMembers.get(plan.key) ?? []) { tests.set(t.key, tests.get(t.key) ?? t); } }
        for (const t of linkedOfType(issue, types.tests, testLink)) { tests.set(t.key, tests.get(t.key) ?? t); }
        return { ticket: issue.key, tests: [...tests.values()], executions: linkedOfType(issue, types.executions, testLink) };
      });
      const testCases = await readTests(requests);

      const linkedBugs = new Map<string, string[]>();
      for (const issue of issues) {
        for (const bug of linkedOfType(issue, bugTypeNames)) { linkedBugs.set(bug.key, [...(linkedBugs.get(bug.key) ?? []), issue.key]); }
      }

      const tickets: Record<string, Ticket> = {};
      for (const issue of issues) {
        const row = common(issue);
        tickets[issue.key] = {
          ...row,
          bucket: classifyTicket(config.statusMap, issue.key, row.statusKey),
          tests: testCases.get(issue.key) ?? [],
          bugs: linkedOfType(issue, bugTypeNames).map(b => b.key),
        };
      }

      const bugs: Record<string, Bug> = {};
      for (const issue of await issuesByKey(transport, [...linkedBugs.keys()], fields)) {
        const row = common(issue);
        bugs[issue.key] = {
          ...row,
          bucket: classifyBug(config.statusMap, issue.key, row.statusKey),
          createdAt: issue.fields.created ?? null,
          tickets: linkedBugs.get(issue.key) ?? [],
        };
      }

      const distinctTests = new Set(requests.flatMap(r => r.tests.map(t => t.key)));
      const snapshot: SourceSnapshot = {
        source: kind,
        syncedAt: now.toISOString(),
        searched: { tickets: issues.length, tests: distinctTests.size, bugs: Object.keys(bugs).length },
        tickets,
        bugs,
      };
      if (options.discover) {
        const rows = keys ? await searchAll(transport, config.jql as string, fields) : issues;
        const tracked = new Set(issues.map(i => i.key));
        const untracked: UntrackedRow[] = rows
          .filter(r => !tracked.has(r.key))
          .map(r => ({ id: r.key, title: r.fields.summary ?? r.key, status: r.fields.status?.name ?? '', qaOwner: qaField ? userName(r.fields[qaField]) : null }));
        snapshot.discover = { at: now.toISOString(), sprintRows: rows.length, untracked };
      }
      return snapshot;
    },
  };
}
