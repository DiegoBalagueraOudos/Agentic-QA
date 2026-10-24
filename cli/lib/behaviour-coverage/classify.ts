/**
 * @fileoverview The arithmetic of `project-context` mode `coverage`: validate
 * the agent's judgments against what `collect` read, put every behaviour in
 * exactly one bucket, order the gaps by MTP risk and diff against the previous
 * run. Pure: same inputs, same gap list, which is what makes it recomputable.
 *
 * Fail-closed (AGENTS.md §3 FAIL-CLOSED GATES): a coverage row with no
 * evidence, on a deprecated Test, on a Test still in design, or on a key nobody
 * could verify (TMS not read) does not count; a test key the inventory does not
 * hold when the TMS WAS read, or a section the map does not have, is an error.
 * A risk level whose MTP flow the cache does not name is dropped to unranked.
 */

import type {
  Bucket,
  BucketChange,
  ClassifiedBehaviour,
  CollectResult,
  Cover,
  CoverageRow,
  GapList,
  InventoryTest,
  JudgedBehaviour,
  Judgments,
  RiskLevel,
  RunDiff,
} from './types.ts';

import { BEHAVIOUR_MAPS, BUCKETS, compareIds, GAP_BUCKETS, parseBehaviourId, RISK_LEVELS, SCHEMA_VERSION } from './types.ts';

/** A `BR-NNN` / `FEAT-NNN` style id: the map promises these are stable. */
export const STRUCTURED_LOCAL_ID = /^[A-Z]+-\d+$/;

export class JudgmentError extends Error {
  constructor(readonly errors: string[]) {
    super(`judgments.json has ${errors.length} error(s):\n${errors.map(e => `  - ${e}`).join('\n')}`);
    this.name = 'JudgmentError';
  }
}

/** Run id from a clock: sortable, filename-safe, one per second. */
export function runIdFor(now: Date): string {
  return now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

/** Exactly one bucket from the rows that count (strongest coverage wins). */
export function bucketFor(rows: readonly Pick<CoverageRow, 'counted' | 'verdict' | 'kind'>[]): Bucket {
  const counted = rows.filter(r => r.counted);
  if (counted.length === 0) { return 'uncovered'; }
  const exercising = counted.filter(r => r.verdict === 'exercises');
  if (exercising.length === 0) { return 'weak'; }
  return exercising.some(r => r.kind === 'automated') ? 'automated' : 'manual-only';
}

/** Every error in the judgments, empty when they can be classified. */
export function validateJudgments(collect: CollectResult, judgments: Judgments): string[] {
  const errors: string[] = [];
  if (judgments.schema_version !== SCHEMA_VERSION) {
    errors.push(`schema_version ${String(judgments.schema_version)} is not ${SCHEMA_VERSION}`);
  }
  if (!Array.isArray(judgments.behaviours)) { return [...errors, 'behaviours: expected a list']; }
  const maps = new Map(collect.sources.maps.map(m => [m.map, m]));
  const seed = new Set(collect.seed.map(s => s.id));
  const tests = new Set(collect.tests.map(t => t.key));
  const tmsRead = collect.sources.tms.state === 'read';
  const seen = new Set<string>();

  for (const b of judgments.behaviours) {
    const where = `behaviour ${b.id ?? '(no id)'}`;
    const ref = typeof b.id === 'string' ? parseBehaviourId(b.id) : null;
    if (!ref) { errors.push(`${where}: id is not <e2e|api|data>#<section-id>[/<LOCAL-ID>]`); continue; }
    if (seen.has(b.id)) { errors.push(`${where}: duplicate id`); }
    seen.add(b.id);
    const map = maps.get(ref.map);
    if (!map || map.state !== 'generated') {
      errors.push(`${where}: cites the ${BEHAVIOUR_MAPS[ref.map]} map, which is ${map?.state ?? 'not collected'}`);
    }
    else if (!map.sections.includes(ref.section)) {
      errors.push(`${where}: the ${BEHAVIOUR_MAPS[ref.map]} map has no section \`${ref.section}\``);
    }
    else if (ref.local_id && STRUCTURED_LOCAL_ID.test(ref.local_id) && !seed.has(b.id)) {
      errors.push(`${where}: ${ref.local_id} is not in section \`${ref.section}\``);
    }
    if (typeof b.title !== 'string' || b.title.trim() === '') { errors.push(`${where}: title is empty`); }
    if (typeof b.module !== 'string' || b.module.trim() === '') { errors.push(`${where}: module is empty (it becomes the Tech Story component)`); }
    if (b.risk !== null && b.risk !== undefined) {
      if (!(RISK_LEVELS as readonly string[]).includes(b.risk.level)) { errors.push(`${where}: risk level ${String(b.risk.level)} is not one of ${RISK_LEVELS.join(', ')}`); }
      if (typeof b.risk.flow !== 'string' || b.risk.flow.trim() === '') { errors.push(`${where}: risk has no MTP flow`); }
    }
    if (!Array.isArray(b.covered_by)) { errors.push(`${where}: covered_by: expected a list`); continue; }
    const rowTests = new Set<string>();
    for (const row of b.covered_by) {
      if (row.verdict !== 'exercises' && row.verdict !== 'weak') { errors.push(`${where}: ${row.test}: verdict must be exercises or weak`); }
      if (rowTests.has(row.test)) { errors.push(`${where}: ${row.test} listed twice`); }
      rowTests.add(row.test);
      // Without the TMS a key outside the manifest cannot be checked: it stays in the report, not counted (classifyRow).
      if (!tests.has(row.test) && tmsRead) { errors.push(`${where}: ${row.test} is not in the test inventory`); }
    }
  }
  return errors;
}

export const NOT_VERIFIED = 'not verified: TMS not read';

const plural = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? '' : 's'}`;

function classifyRow(row: JudgedBehaviour['covered_by'][number], test: InventoryTest | undefined): CoverageRow {
  const evidence = typeof row.evidence === 'string' ? row.evidence.trim() : '';
  let reason: string | null = null;
  if (evidence === '') { reason = 'no evidence: a coverage claim without evidence does not count'; }
  // Only reachable when the TMS was not read (validation rejects an unknown key otherwise): fail closed.
  else if (!test) { reason = NOT_VERIFIED; }
  else if (test.deprecated) { reason = 'the Test is deprecated in the TMS'; }
  else if (test.in_design) { reason = `the Test is still in design (status \`${test.status}\`), not an approved Test`; }
  const kind = test?.kind ?? 'manual';
  return {
    test: row.test,
    kind,
    verdict: row.verdict,
    evidence,
    judged_by: 'agent',
    counted: reason === null,
    reason,
    outside_regression: kind === 'manual' && test?.in_regression === false,
    stale: Boolean(test && row.test_fingerprint && row.test_fingerprint !== test.fingerprint),
    verified: test !== undefined,
  };
}

const riskRank = (level: RiskLevel | undefined): number => (level ? RISK_LEVELS.indexOf(level) : RISK_LEVELS.length);

const plainCell = (cell: string): string => cell.replace(/[*`_]/g, '').trim().toLowerCase();

/**
 * Where the MTP cache names a flow: a table row with a cell equal to the flow
 * (`level` is the row's own CRITICAL / HIGH / MEDIUM / LOW cell, null when it
 * has none), else a heading that contains it. Prose mentions do not count: a
 * flow named only in passing is not a ranked flow.
 */
export function mtpFlow(mtpText: string, flow: string): { found: 'row', level: RiskLevel | null } | { found: 'heading' } | null {
  const wanted = plainCell(flow);
  if (wanted === '') { return null; }
  let heading = false;
  for (const raw of mtpText.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('|')) {
      const cells = line.replace(/^\||\|$/g, '').split('|').map(plainCell);
      if (!cells.includes(wanted)) { continue; }
      const level = cells.map(c => c.toUpperCase()).find((c): c is RiskLevel => (RISK_LEVELS as readonly string[]).includes(c)) ?? null;
      return { found: 'row', level };
    }
    if (line.startsWith('#') && plainCell(line.replace(/^#+/, '')).includes(wanted)) { heading = true; }
  }
  return heading ? { found: 'heading' } : null;
}

/** Gap priority: risk, then uncovered before weak, then module, then id. */
export function compareGaps(a: ClassifiedBehaviour, b: ClassifiedBehaviour): number {
  return riskRank(a.risk?.level) - riskRank(b.risk?.level)
    || BUCKETS.indexOf(b.bucket) - BUCKETS.indexOf(a.bucket)
    || compareIds(a.module, b.module)
    || compareIds(a.id, b.id);
}

export function diffRuns(previous: GapList | null, current: readonly ClassifiedBehaviour[]): RunDiff {
  if (!previous) { return { previous_run: null, closed: [], regressed: [], changed: [], added: [], removed: [] }; }
  const before = new Map(previous.behaviours.map(b => [b.id, b.bucket]));
  const now = new Set(current.map(b => b.id));
  const changed: BucketChange[] = [];
  const added: string[] = [];
  for (const b of current) {
    const from = before.get(b.id);
    if (from === undefined) { added.push(b.id); }
    else if (from !== b.bucket) { changed.push({ id: b.id, from, to: b.bucket }); }
  }
  return {
    previous_run: previous.run_id,
    closed: changed.filter(c => GAP_BUCKETS.has(c.from) && !GAP_BUCKETS.has(c.to)),
    regressed: changed.filter(c => !GAP_BUCKETS.has(c.from) && GAP_BUCKETS.has(c.to)),
    changed,
    added,
    removed: [...before.keys()].filter(id => !now.has(id)).sort(compareIds),
  };
}

export interface ClassifyInput {
  collect: CollectResult
  judgments: Judgments
  /** The MTP cache text; null when the cache is missing. */
  mtpText: string | null
  previous: GapList | null
  now: Date
}

/** Validate, bucket, order, diff. Throws `JudgmentError` on an invalid judgment. */
export function classify(input: ClassifyInput): GapList {
  const { collect, judgments, mtpText, previous, now } = input;
  const errors = validateJudgments(collect, judgments);
  if (errors.length > 0) { throw new JudgmentError(errors); }

  const warnings = [...collect.warnings];
  const tests = new Map(collect.tests.map(t => [t.key, t]));
  const seedHashes = new Map(collect.seed.map(s => [s.id, s.hash]));
  // A gap an existing coverage Tech Story names keeps its key, even before the judgment records it.
  const anchored = new Map<string, string>();
  for (const anchor of collect.anchors) { for (const id of anchor.gap_ids) { anchored.set(id, anchor.key); } }
  const mtp = mtpText;
  const tmsRead = collect.sources.tms.state === 'read';
  if (mtp === null && judgments.behaviours.some(b => b.risk)) {
    warnings.push(`MTP cache missing (${collect.sources.mtp.path}): every behaviour is unranked`);
  }
  if (previous && previous.sources.tms.state !== collect.sources.tms.state) {
    warnings.push(`the previous run \`${previous.run_id}\` read the TMS as ${previous.sources.tms.state} and this one as ${collect.sources.tms.state}: the diff compares verified with unverified coverage, so a gap it calls closed may rest on a key nobody checked`);
  }

  const behaviours: ClassifiedBehaviour[] = judgments.behaviours.map((b) => {
    const source = parseBehaviourId(b.id)!;
    const rows = b.covered_by.map(row => classifyRow(row, tests.get(row.test)));
    let risk = b.risk ?? null;
    if (risk && mtp === null) { risk = null; }
    else if (risk && mtp !== null) {
      const found = mtpFlow(mtp, risk.flow);
      if (found === null) {
        warnings.push(`${b.id}: MTP flow "${risk.flow}" is not a row or heading of the MTP cache: unranked`);
        risk = null;
      }
      else if (found.found === 'row' && found.level !== null && found.level !== risk.level) {
        warnings.push(`${b.id}: judged ${risk.level}, but the MTP row of "${risk.flow}" says ${found.level}: the MTP level is used`);
        risk = { level: found.level, flow: risk.flow };
      }
    }
    // A free kebab local id has no seed row of its own: its map text is the section's.
    const seedHash = seedHashes.get(b.id) ?? seedHashes.get(`${source.map}#${source.section}`) ?? null;
    // Stale detection needs the fingerprints copied at judgment time; without them it is off, and said so.
    const missing = [
      ...(b.seed_hash ? [] : ['seed_hash']),
      ...b.covered_by.filter(r => !r.test_fingerprint && tests.has(r.test)).map(r => `test_fingerprint of ${r.test}`),
    ];
    if (missing.length > 0) { warnings.push(`${b.id}: no ${missing.join(', ')}: stale detection is off for it`); }
    return {
      id: b.id,
      title: b.title.trim(),
      module: b.module.trim(),
      source,
      risk,
      bucket: bucketFor(rows),
      covered_by: [...rows].sort((x, y) => compareIds(x.test, y.test)),
      stale: Boolean(b.seed_hash && seedHash && b.seed_hash !== seedHash),
      tech_story: b.tech_story ?? anchored.get(b.id) ?? null,
    };
  }).sort((a, b) => compareIds(a.id, b.id));

  const covers = new Map<string, { kind: CoverageRow['kind'], covers: Cover[] }>();
  for (const b of behaviours) {
    for (const row of b.covered_by.filter(r => r.counted)) {
      const entry = covers.get(row.test) ?? { kind: row.kind, covers: [] };
      entry.covers.push({ id: b.id, verdict: row.verdict });
      covers.set(row.test, entry);
    }
  }

  const judgedIds = new Set(behaviours.map(b => b.id));
  const unjudged = collect.seed
    .map(s => s.id)
    .filter((id) => {
      const local = parseBehaviourId(id)?.local_id;
      return Boolean(local && STRUCTURED_LOCAL_ID.test(local)) && !judgedIds.has(id);
    })
    .sort(compareIds);
  if (behaviours.length === 0 && collect.seed.length > 0) {
    warnings.push(`${plural(collect.seed.length, 'behaviour')} not judged yet: nothing is classified, so this list is not a clean slate`);
  }
  else if (unjudged.length > 0) {
    warnings.push(`${plural(unjudged.length, 'behaviour')} not judged yet (structured rule ids): the gap list is incomplete`);
  }

  const buckets = Object.fromEntries(BUCKETS.map(k => [k, 0])) as Record<Bucket, number>;
  for (const b of behaviours) { buckets[b.bucket] += 1; }
  const gaps = behaviours.filter(b => GAP_BUCKETS.has(b.bucket)).sort(compareGaps);

  return {
    schema_version: SCHEMA_VERSION,
    run_id: runIdFor(now),
    generated_at: now.toISOString(),
    sources: collect.sources,
    denominators: {
      behaviours: behaviours.length,
      seed: collect.seed.length,
      seed_unjudged: unjudged.length,
      tests: {
        inventory: collect.tests.length,
        automated: collect.tests.filter(t => t.kind === 'automated').length,
        manual: collect.tests.filter(t => t.kind === 'manual').length,
      },
      buckets,
      gaps: gaps.length,
      gaps_upper_bound: !tmsRead,
    },
    behaviours,
    gaps: gaps.map(b => b.id),
    tests: [...covers.entries()].map(([key, v]) => ({ key, kind: v.kind, covers: v.covers })).sort((a, b) => compareIds(a.key, b.key)),
    unjudged_seed: unjudged,
    warnings,
    diff: diffRuns(previous, behaviours),
  };
}
