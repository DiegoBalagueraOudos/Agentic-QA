/**
 * @fileoverview Coverage Tech Story proposals from a gap list
 * (`agentic-qa-core/references/discovery-driven-doctrine.md` §3).
 *
 * DRY RUN by construction: this builds the payloads and never calls a tracker.
 * Creating them is an outward write a person approves; the agent then runs
 * `/acli` with each payload. Every description carries one
 * `coverage-gap-id: <id>` line per gap, which is how the next `collect`
 * recognises an existing anchor and stops proposing it again.
 */

import type { Anchor, ClassifiedBehaviour, GapList } from './types.ts';

import { BEHAVIOUR_MAPS } from './types.ts';

export const COVERAGE_LABEL = 'coverage-gap';
export const GAP_ID_LINE = /coverage-gap-id:\s*(\S+)/g;
const SUMMARY_MAX = 250;

export type Grain = 'gap' | 'module';

export interface ProposalOptions {
  grain: Grain
  projectKey: string | null
  /** `qa.qa_epics.test_repository_epic.key`; null = resolve or create it first. */
  parentKey: string | null
  /** The Jira name of the `tech_story` work type. */
  techStoryType: string
  anchors: readonly Anchor[]
}

export interface Proposal {
  id: string
  grain: Grain
  summary: string
  module: string
  gap_ids: string[]
  description_md: string
  /** `acli jira workitem create --from-json` keys; `description` is added as ADF at create time. */
  payload: { projectKey: string | null, type: string, summary: string, labels: string[], parentIssueId: string | null }
  /** Not settable through acli: set with the REST PUT `/acli` documents, right after create. */
  components: string[]
}

export interface ProposalResult {
  proposals: Proposal[]
  /** Gaps that already have an anchor, with the key. */
  skipped: Array<{ id: string, tech_story: string }>
}

/** The gap ids a Tech Story description names. */
export function gapIdsIn(text: string): string[] {
  return [...text.matchAll(GAP_ID_LINE)].map(m => m[1]);
}

function cut(text: string): string {
  return text.length <= SUMMARY_MAX ? text : `${text.slice(0, SUMMARY_MAX - 3)}...`;
}

function riskCell(b: ClassifiedBehaviour): string {
  return b.risk ? `${b.risk.level} (${b.risk.flow})` : 'unranked';
}

function describe(gaps: readonly ClassifiedBehaviour[]): string {
  const lines = [
    '## Coverage gap',
    '',
    'Anchors regression coverage for behaviour that runs in production with no Story (discovery-driven doctrine §3). Found by `project-context` mode `coverage`.',
    '',
    '| Gap id | Behaviour | Bucket | Risk | Source |',
    '|---|---|---|---|---|',
    ...gaps.map(b => `| \`${b.id}\` | ${b.title} | ${b.bucket} | ${riskCell(b)} | ${BEHAVIOUR_MAPS[b.source.map]} section \`${b.source.section}\` |`),
  ];
  const weak = gaps.flatMap(b => b.covered_by.filter(r => r.counted && r.verdict === 'weak').map(r => `- \`${r.test}\` on \`${b.id}\`: ${r.evidence}`));
  if (weak.length > 0) { lines.push('', '### Tests that touch it without exercising it', '', ...weak); }
  lines.push(
    '',
    '### Oracle',
    '',
    'Expected results are `oracle: observed` until a person confirms them (discovery-driven doctrine §4). No ROI verdict while a scenario is observed.',
    '',
    ...gaps.map(b => `coverage-gap-id: ${b.id}`),
  );
  return `${lines.join('\n')}\n`;
}

/** One proposal per gap, or one per module, for every gap no Tech Story anchors yet. */
export function proposeTechStories(list: GapList, options: ProposalOptions): ProposalResult {
  const anchored = new Map<string, string>();
  for (const anchor of options.anchors) { for (const id of anchor.gap_ids) { anchored.set(id, anchor.key); } }
  const byId = new Map(list.behaviours.map(b => [b.id, b]));
  const skipped: ProposalResult['skipped'] = [];
  const open: ClassifiedBehaviour[] = [];
  for (const id of list.gaps) {
    const b = byId.get(id);
    if (!b) { continue; }
    const key = b.tech_story ?? anchored.get(id) ?? null;
    if (key) { skipped.push({ id, tech_story: key }); }
    else { open.push(b); }
  }

  const groups = new Map<string, ClassifiedBehaviour[]>();
  for (const b of open) {
    const group = options.grain === 'gap' ? b.id : `module:${b.module}`;
    groups.set(group, [...(groups.get(group) ?? []), b]);
  }

  const proposals = [...groups.entries()].map(([id, gaps]): Proposal => {
    const module = gaps[0].module;
    const summary = cut(options.grain === 'gap'
      ? `Coverage: ${module}: ${gaps[0].title}`
      : `Coverage: ${module}: behaviours without regression coverage`);
    return {
      id,
      grain: options.grain,
      summary,
      module,
      gap_ids: gaps.map(b => b.id),
      description_md: describe(gaps),
      payload: { projectKey: options.projectKey, type: options.techStoryType, summary, labels: [COVERAGE_LABEL], parentIssueId: options.parentKey },
      components: [module],
    };
  });
  return { proposals, skipped };
}
