/**
 * @fileoverview What the two Jira sources share: the search, the status-slug
 * lookup, the ticket and bug rows. They differ only in where a test's outcome
 * lives (the `test_status` field vs the latest Xray run), which each passes in
 * as a `TestReader`.
 *
 * Statuses are bucketed by the workflow SLUG of `.agents/jira-workflows.json`,
 * never by the display name: a status name the catalog does not know throws
 * `CatalogStatusError` (the mirror is stale), a slug no bucket lists throws
 * `UnknownStatusError` (the config is incomplete). Neither is ever counted.
 */

import type { BoardConfig, WorkflowCatalog } from './config.ts';
import type { Transport } from './transport.ts';
import type { Bug, SnapshotOptions, Source, SourceKind, SourceSnapshot, TestCase, Ticket, UntrackedRow } from './types.ts';

import { BUG_WORK_TYPES, WORKFLOWS_CATALOG } from './config.ts';
import { classifyBug, classifyTicket } from './status-map.ts';

// ============================================================================
// JIRA SHAPES (only the fields read)
// ============================================================================

export interface JiraLinkedIssue {
  id: string
  key: string
  fields?: { summary?: string, issuetype?: { name?: string }, status?: { name?: string } }
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
    issuelinks?: Array<{ type?: { name?: string }, inwardIssue?: JiraLinkedIssue, outwardIssue?: JiraLinkedIssue }>
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
      `${item}: status "${statusName}" (${issueType}) is not in ${WORKFLOWS_CATALOG}. `
      + 'The mirror is stale or the issue type is not catalogued: run `bun run jira:sync-workflows`, then map the new slug in board.statuses.',
    );
    this.name = 'CatalogStatusError';
  }
}

// ============================================================================
// HELPERS
// ============================================================================

const BASE_FIELDS = ['summary', 'status', 'priority', 'issuetype', 'components', 'assignee', 'updated', 'created', 'issuelinks'];
const KEY_CHUNK = 50;

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
export function issueTypeNames(catalog: WorkflowCatalog | null, workTypes: readonly string[], fallback: string): Set<string> {
  const names = new Set<string>();
  for (const workType of workTypes) {
    const name = catalog?.[workType]?.jira_issue_type?.name;
    if (name) { names.add(name); }
  }
  if (names.size === 0) { names.add(fallback); }
  return names;
}

/**
 * Status display name -> workflow slug. The issue's own work type is tried
 * first; otherwise the name must resolve to exactly one slug across the
 * catalog, or the lookup fails loud.
 */
export function statusSlug(catalog: WorkflowCatalog | null, item: string, issueType: string, statusName: string): string {
  const match = (statuses: Record<string, { name?: string }> | undefined): string[] =>
    Object.entries(statuses ?? {}).filter(([, s]) => s.name?.toLowerCase() === statusName.toLowerCase()).map(([slug]) => slug);
  const entries = Object.values(catalog ?? {});
  for (const workType of entries) {
    if (workType.jira_issue_type?.name !== issueType) { continue; }
    const own = match(workType.statuses);
    if (own.length === 1) { return own[0]; }
  }
  const anywhere = new Set(entries.flatMap(w => match(w.statuses)));
  if (anywhere.size === 1) { return [...anywhere][0]; }
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

/** Linked issues of the given issue types, deduplicated, in link order. */
export function linkedOfType(issue: JiraIssue, typeNames: ReadonlySet<string>): JiraLinkedIssue[] {
  const seen = new Set<string>();
  const out: JiraLinkedIssue[] = [];
  for (const link of issue.fields.issuelinks ?? []) {
    const other = link.outwardIssue ?? link.inwardIssue;
    if (!other || seen.has(other.key) || !typeNames.has(other.fields?.issuetype?.name ?? '')) { continue; }
    seen.add(other.key);
    out.push(other);
  }
  return out;
}

// ============================================================================
// THE SOURCE
// ============================================================================

/** Reads the outcome of every linked test; one call per snapshot, keyed by test key. */
export type TestReader = (tests: JiraLinkedIssue[]) => Promise<Map<string, TestCase>>;

export interface JiraSourceParts {
  kind: Exclude<SourceKind, 'none'>
  config: BoardConfig
  transport: Transport
  testTypeNames: ReadonlySet<string>
  readTests: TestReader
}

export function createJiraSource(parts: JiraSourceParts): Source {
  const { kind, config, transport, testTypeNames, readTests } = parts;
  const catalog = config.catalogs.workflows;
  const bugTypeNames = issueTypeNames(catalog, BUG_WORK_TYPES, 'Bug');
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
      }

      const linkedTests = new Map<string, JiraLinkedIssue>();
      const linkedBugs = new Map<string, string[]>();
      for (const issue of issues) {
        for (const test of linkedOfType(issue, testTypeNames)) { linkedTests.set(test.key, test); }
        for (const bug of linkedOfType(issue, bugTypeNames)) { linkedBugs.set(bug.key, [...(linkedBugs.get(bug.key) ?? []), issue.key]); }
      }
      const testCases = await readTests([...linkedTests.values()]);

      const tickets: Record<string, Ticket> = {};
      for (const issue of issues) {
        const row = common(issue);
        tickets[issue.key] = {
          ...row,
          bucket: classifyTicket(config.statusMap, issue.key, row.statusKey),
          tests: linkedOfType(issue, testTypeNames).map(t => testCases.get(t.key)).filter((t): t is TestCase => t !== undefined),
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

      const snapshot: SourceSnapshot = {
        source: kind,
        syncedAt: now.toISOString(),
        searched: { tickets: issues.length, tests: linkedTests.size, bugs: Object.keys(bugs).length },
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
