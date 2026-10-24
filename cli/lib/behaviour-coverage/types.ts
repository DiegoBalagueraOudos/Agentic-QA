/**
 * @fileoverview The shapes of `project-context` mode `coverage`
 * (`.agents/skills/project-context/references/coverage.md`).
 *
 * Three files, three owners: `collect.json` (the script reads the maps, the
 * KATA manifest and the TMS), `judgments.json` (the agent says which behaviour
 * a test covers and whether its assertions exercise it) and `gap-list.json`
 * (the script buckets, orders and diffs). The JSON keys are snake_case because
 * other skills read these files: the future exploratory skill dedupes against
 * `covered_by` and `tests[].covers`. A key renamed here is a `SCHEMA_VERSION`
 * bump, never a refactor.
 */

import type { SourceKind } from '../sprint-source/types.ts';

export const SCHEMA_VERSION = 1;

/** Exactly one per behaviour; order = strongest coverage first. */
export const BUCKETS = ['automated', 'manual-only', 'weak', 'uncovered'] as const;
export type Bucket = (typeof BUCKETS)[number];

/** A gap is a behaviour the regression repository does not exercise. */
export const GAP_BUCKETS: ReadonlySet<Bucket> = new Set<Bucket>(['weak', 'uncovered']);

/** The Master Test Plan's own levels, most severe first; no translation to another scale. */
export const RISK_LEVELS = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

/** The three behaviour sources, by the short name a behaviour id starts with. */
export const BEHAVIOUR_MAPS = {
  e2e: 'business-e2e-context',
  api: 'business-api-context',
  data: 'business-data-context',
} as const;
export type MapKey = keyof typeof BEHAVIOUR_MAPS;

/** `<map>#<section-id>[/<LOCAL-ID>]`, e.g. `e2e#feature-billing/BR-012`. */
export const BEHAVIOUR_ID = /^(e2e|api|data)#([a-z0-9][a-z0-9-]*)(?:\/([A-Za-z0-9][A-Za-z0-9-]*))?$/;

export interface BehaviourRef { map: MapKey, section: string, local_id: string | null }

/** The one order every list in these files uses: UTF-16 code units, the same on every machine and locale. */
export function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function parseBehaviourId(id: string): BehaviourRef | null {
  const m = BEHAVIOUR_ID.exec(id);
  return m ? { map: m[1] as MapKey, section: m[2], local_id: m[3] ?? null } : null;
}

// ============================================================================
// collect.json
// ============================================================================

export type MapState = 'no-skill' | 'no-map' | 'placeholder' | 'generated';

export interface MapSource {
  map: MapKey
  skill: string
  state: MapState
  /** Every section id of a generated map, sorted; empty otherwise. */
  sections: string[]
}

/** A candidate behaviour read from a map; the agent decides which ones count. */
export interface SeedBehaviour {
  id: string
  title: string
  /** sha256 of the text it was read from; a change marks its judgment stale. */
  hash: string
}

export interface InventoryTest {
  key: string
  title: string
  /** `automated` = an ATC with this id is in the production manifest. */
  kind: 'automated' | 'manual'
  in_manifest: boolean
  in_tms: boolean
  /** Workflow slug of the TMS Test (`.agents/jira-workflows.json` `test_case`); null when not read. */
  status: string | null
  deprecated: boolean
  /** In a design status (the catalog's create and `start_design` targets): not an approved Test yet. */
  in_design: boolean
  /** RTP member (jira-xray) or a regression label (jira-native); null when the TMS was not read. */
  in_regression: boolean | null
  components: string[]
  /** Coverable keys reached through the cascade (ATS link, direct link). */
  coverables: string[]
  atc: { file: string, line: number, method: string } | null
  /** Changes when the test changes: TMS `updated`, else the ATC's `file:line:method`. */
  fingerprint: string
}

/** An existing coverage Tech Story and the gap ids its description names. */
export interface Anchor { key: string, title: string, gap_ids: string[] }

export interface TmsSource {
  modality: SourceKind | 'none'
  state: 'read' | 'unavailable'
  reason: string | null
}

export interface ManifestSource {
  state: 'read' | 'missing'
  /** Where it was read: `<branch>@<commit>` or `working-tree`. */
  ref: string | null
  production: string | null
  warning: string | null
}

export interface MtpSource { state: 'present' | 'missing', path: string }

export interface CollectSources {
  maps: MapSource[]
  tms: TmsSource
  manifest: ManifestSource
  mtp: MtpSource
}

export interface CollectResult {
  schema_version: number
  collected_at: string
  sources: CollectSources
  seed: SeedBehaviour[]
  tests: InventoryTest[]
  anchors: Anchor[]
  /** A TMS status `automated` with no ATC in the production manifest, and similar. */
  warnings: string[]
}

// ============================================================================
// judgments.json (written by the agent)
// ============================================================================

export type Verdict = 'exercises' | 'weak';

export interface JudgedCoverage {
  test: string
  verdict: Verdict
  /** One line: the assertion (or manual step) that does or does not exercise the behaviour. */
  evidence: string
  /** Copied from collect.json `tests[].fingerprint` when judged. */
  test_fingerprint?: string
}

export interface JudgedBehaviour {
  id: string
  title: string
  module: string
  /** Copied from collect.json `seed[].hash` when judged. */
  seed_hash?: string
  risk: { level: RiskLevel, flow: string } | null
  covered_by: JudgedCoverage[]
  tech_story?: string | null
}

export interface Judgments {
  schema_version: number
  behaviours: JudgedBehaviour[]
}

// ============================================================================
// gap-list.json
// ============================================================================

export interface CoverageRow {
  test: string
  kind: 'automated' | 'manual'
  verdict: Verdict
  evidence: string
  judged_by: 'agent'
  /** False = the row does not count (reason says why); the bucket ignores it. */
  counted: boolean
  reason: string | null
  /** A manual Test outside the regression repository. */
  outside_regression: boolean
  /** The test changed since it was judged. */
  stale: boolean
  /** False = the key is not in the inventory (the TMS was not read): the row does not count. */
  verified: boolean
}

/** One entry of the inverse view: a behaviour a test claims, with the verdict of that claim. */
export interface Cover { id: string, verdict: Verdict }

export interface ClassifiedBehaviour {
  id: string
  title: string
  module: string
  source: BehaviourRef
  risk: { level: RiskLevel, flow: string } | null
  bucket: Bucket
  covered_by: CoverageRow[]
  /** The behaviour's map text changed since it was judged. */
  stale: boolean
  tech_story: string | null
}

export interface BucketChange { id: string, from: Bucket, to: Bucket }

export interface RunDiff {
  previous_run: string | null
  closed: BucketChange[]
  regressed: BucketChange[]
  changed: BucketChange[]
  added: string[]
  removed: string[]
}

export interface GapList {
  schema_version: number
  run_id: string
  generated_at: string
  sources: CollectSources
  denominators: {
    behaviours: number
    seed: number
    seed_unjudged: number
    tests: { inventory: number, automated: number, manual: number }
    buckets: Record<Bucket, number>
    gaps: number
    /** True when manual coverage could not be verified (TMS not read): the real gap count may be lower. */
    gaps_upper_bound: boolean
  }
  /** Every behaviour, sorted by id (stable diffs). */
  behaviours: ClassifiedBehaviour[]
  /** Gap ids in priority order: risk, then bucket, then module, then id. */
  gaps: string[]
  /** The inverse view: which behaviours each test claims (counted rows only), each with its verdict: a `weak` cover is not coverage. */
  tests: Array<{ key: string, kind: 'automated' | 'manual', covers: Cover[] }>
  /** Structured seed rows (BR / FEAT ids) no judgment names yet. */
  unjudged_seed: string[]
  warnings: string[]
  diff: RunDiff
}
