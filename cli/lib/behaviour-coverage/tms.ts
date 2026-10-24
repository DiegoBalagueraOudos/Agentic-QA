/**
 * @fileoverview The TMS half of the coverage test inventory: every Test of the
 * project, what it covers, whether it is in the regression repository, and the
 * coverage Tech Stories that already exist.
 *
 * It reuses the sprint source layer's Jira plumbing (ADR-0019: `Transport`,
 * the token-paged search, the link walk, the catalog name lookup) and NOT its
 * `Source`: a snapshot is sprint tickets, this is the whole repository, and it
 * must work on a project with no `board:` block. Both modalities share the
 * read; only regression membership differs: an `RTP:` Test Plan's Xray
 * membership (jira-xray) or a regression label (both).
 */

import type { WorkflowCatalog } from '../sprint-source/config.ts';
import type { JiraIssue } from '../sprint-source/jira-common.ts';
import type { Transport } from '../sprint-source/transport.ts';
import type { Anchor } from './types.ts';

import { CatalogStatusError, issuesByKey, issueTypeNames, linkedOfType, searchAll, statusSlug } from '../sprint-source/jira-common.ts';
import { TEST_PLAN_TESTS_QUERY } from '../sprint-source/jira-xray.ts';
import { COVERAGE_LABEL, gapIdsIn } from './propose.ts';

/** Work types with `coverable: true` in `.agents/jira-required.yaml`; a test keeps this list in step. */
export const COVERABLE_WORK_TYPES = ['story', 'bug', 'defect', 'improvement', 'tech_story', 'tech_debt'] as const;
const COVERABLE_FALLBACK = ['Story', 'Bug', 'Defect', 'Improvement', 'Tech Story', 'Tech Debt'];

/** Labels that put a Test in the regression repository (`test-documentation` promotion). */
export const REGRESSION_LABELS: ReadonlySet<string> = new Set(['regression', 'regression-candidate']);
/** The long-lived Regression Test Plan's title prefix (`test-documentation` "the RTP handoff"). */
export const RTP_PREFIX = 'RTP:';
export const DEPRECATED_SLUG = 'deprecated';

const TEST_FIELDS = ['summary', 'status', 'issuetype', 'labels', 'components', 'issuelinks', 'updated'];
const PAGE = 100;

export interface TmsTest {
  key: string
  title: string
  /** Workflow slug; null when the catalog does not hold the status (a warning says so). */
  status: string | null
  labels: string[]
  components: string[]
  coverables: string[]
  in_regression: boolean
  updated: string | null
}

export interface TmsInventory {
  tests: TmsTest[]
  anchors: Anchor[]
  warnings: string[]
}

export interface TmsReadOptions {
  transport: Transport
  projectKey: string
  modality: 'jira-xray' | 'jira-native'
  workflows: WorkflowCatalog | null
  /** The `test` link name from `.agents/jira-link-types.json`; null accepts any link type. */
  testLink: string | null
}

const quoted = (names: Iterable<string>): string => [...names].map(n => `"${n}"`).join(', ');

/** The plain text of an ADF document (or a string description). */
export function adfText(node: unknown): string {
  if (typeof node === 'string') { return node; }
  if (!node || typeof node !== 'object') { return ''; }
  const n = node as { text?: unknown, content?: unknown };
  if (typeof n.text === 'string') { return n.text; }
  return Array.isArray(n.content) ? n.content.map(adfText).join('\n') : '';
}

/** Members of the RTP plans, by Test key (Xray membership, paged). */
async function rtpMembers(transport: Transport, projectKey: string, planTypes: ReadonlySet<string>): Promise<Set<string>> {
  const plans = (await searchAll(transport, `project = ${projectKey} AND issuetype in (${quoted(planTypes)}) AND summary ~ "RTP" ORDER BY key`, ['summary']))
    .filter(p => (p.fields.summary ?? '').trim().startsWith(RTP_PREFIX));
  const members = new Set<string>();
  for (const plan of plans) {
    for (let start = 0; ; start += PAGE) {
      const page = (await transport.xray<{ getTestPlan?: { tests?: { total?: number, results?: Array<{ jira?: { key?: string } }> } } }>(
        TEST_PLAN_TESTS_QUERY,
        { issueId: plan.id, limit: PAGE, start },
      )).getTestPlan?.tests;
      const results = page?.results ?? [];
      for (const r of results) { if (r.jira?.key) { members.add(r.jira.key); } }
      if (results.length < PAGE || start + results.length >= (page?.total ?? Number.POSITIVE_INFINITY)) { break; }
    }
  }
  return members;
}

export async function readTmsInventory(options: TmsReadOptions): Promise<TmsInventory> {
  const { transport, projectKey, modality, workflows, testLink } = options;
  const testTypes = issueTypeNames(workflows, ['test_case'], ['Test']);
  const setTypes = issueTypeNames(workflows, ['test_set'], ['Test Set']);
  const planTypes = issueTypeNames(workflows, ['test_plan'], ['Test Plan']);
  const techStoryTypes = issueTypeNames(workflows, ['tech_story'], ['Tech Story']);
  const coverableTypes = issueTypeNames(workflows, COVERABLE_WORK_TYPES, COVERABLE_FALLBACK);
  const warnings: string[] = [];

  const issues = await searchAll(transport, `project = ${projectKey} AND issuetype in (${quoted(testTypes)}) ORDER BY key`, TEST_FIELDS);

  // The cascade, Test side: the coverables a Test links, plus the coverables its ATS links.
  const setsByTest = new Map(issues.map(t => [t.key, linkedOfType(t, setTypes, testLink)]));
  const setKeys = [...new Set([...setsByTest.values()].flat().map(s => s.key))];
  const setCoverables = new Map<string, string[]>();
  for (const set of await issuesByKey(transport, setKeys, ['issuelinks'])) {
    setCoverables.set(set.key, linkedOfType(set, coverableTypes, testLink).map(c => c.key));
  }

  const regression = modality === 'jira-xray' ? await rtpMembers(transport, projectKey, planTypes) : new Set<string>();

  const tests = issues.map((issue: JiraIssue): TmsTest => {
    const f = issue.fields;
    let status: string | null = null;
    try { status = statusSlug(workflows, issue.key, f.issuetype?.name ?? '', f.status?.name ?? ''); }
    catch (err) {
      if (!(err instanceof CatalogStatusError)) { throw err; }
      warnings.push(`${issue.key}: status "${f.status?.name ?? ''}" is not in .agents/jira-workflows.json (run \`bun run jira:sync-workflows\`); deprecation not checked`);
    }
    const labels = Array.isArray(f.labels) ? (f.labels as unknown[]).filter((l): l is string => typeof l === 'string') : [];
    const coverables = new Set(linkedOfType(issue, coverableTypes, testLink).map(c => c.key));
    for (const set of setsByTest.get(issue.key) ?? []) { for (const c of setCoverables.get(set.key) ?? []) { coverables.add(c); } }
    return {
      key: issue.key,
      title: f.summary ?? issue.key,
      status,
      labels: [...labels].sort(),
      components: (f.components ?? []).map(c => c.name ?? '').filter(Boolean).sort(),
      coverables: [...coverables].sort(),
      in_regression: regression.has(issue.key) || labels.some(l => REGRESSION_LABELS.has(l)),
      updated: f.updated ?? null,
    };
  });

  const anchors = (await searchAll(transport, `project = ${projectKey} AND issuetype in (${quoted(techStoryTypes)}) AND labels = "${COVERAGE_LABEL}" ORDER BY key`, ['summary', 'description']))
    .map((a): Anchor => ({ key: a.key, title: a.fields.summary ?? a.key, gap_ids: gapIdsIn(adfText(a.fields.description)).sort() }));

  return { tests, anchors, warnings };
}
