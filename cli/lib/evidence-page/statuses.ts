/**
 * @fileoverview The ONE status enum of the evidence page (ADR-0021).
 *
 * The pack schema, the validator, the page template and (later) the Sprint
 * Board all read these lists, so a status can never render in one place and be
 * unknown in another. Each field accepts only its own subset: a case marked
 * `RETEST PASSED` is refused by the validator instead of rendering neutral.
 *
 * Case statuses ARE the sprint source's `TestStatus` (ADR-0019), so a case and
 * a TMS test speak the same vocabulary: PASSED and FAILED only on observation,
 * BLOCKED and DEFERRED as reasons a test is NOT RUN.
 */

import type { BugBucket, TestStatus } from '../sprint-source/types.ts';

import { TEST_STATUSES } from '../sprint-source/types.ts';

export const CASE_STATUSES: readonly TestStatus[] = TEST_STATUSES;
export type CaseStatus = TestStatus;

export const VERDICTS = ['PASSED', 'FAILED', 'PENDING'] as const;
export type Verdict = (typeof VERDICTS)[number];

export const BUG_STATUSES = ['OPEN', 'FIXED', 'RETEST PASSED', 'RETEST FAILED'] as const;
export type BugStatus = (typeof BUG_STATUSES)[number];

export type EvidenceStatus = CaseStatus | Verdict | BugStatus;
export const EVIDENCE_STATUSES: readonly EvidenceStatus[] = [...new Set<EvidenceStatus>([...CASE_STATUSES, ...VERDICTS, ...BUG_STATUSES])];

export type Tone = 'ok' | 'defect' | 'pending' | 'neutral';

/** The colour of every status. A status without one is a compile error. */
export const TONE_OF = {
  'PASSED': 'ok',
  'FAILED': 'defect',
  'NOT RUN': 'neutral',
  'BLOCKED': 'pending',
  'DEFERRED': 'pending',
  'PENDING': 'pending',
  'OPEN': 'defect',
  'FIXED': 'pending',
  'RETEST PASSED': 'ok',
  'RETEST FAILED': 'defect',
} as const satisfies Record<EvidenceStatus, Tone>;

/** Where a bug status lands in the board's bug buckets (`board.statuses.bugs`). */
export const BUG_BUCKET_OF = {
  'OPEN': 'open',
  'FIXED': 'fixed',
  'RETEST PASSED': 'resolved',
  'RETEST FAILED': 'open',
} as const satisfies Record<BugStatus, BugBucket>;

export function isOneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (values as readonly string[]).includes(value);
}
