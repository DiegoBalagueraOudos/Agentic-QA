/**
 * @fileoverview Status identifier -> bucket, with no default (ADR-0019).
 *
 * The reference implementation kept its "tested" set, its "arrived in the test
 * environment" literal and its bug buckets in code, so a status it did not
 * know was counted as nothing and the report still rendered, with wrong
 * numbers. Here a status no bucket lists throws `UnknownStatusError`, naming
 * the config path that would fix it. There is no fallback bucket on purpose.
 */

import type { BugBucket, TestStatus, TicketBucket } from './types.ts';

import { BUG_BUCKETS, TEST_STATUSES, TICKET_BUCKETS } from './types.ts';

export type StatusDomain = 'tickets' | 'bugs' | 'tests';

/** `board.statuses` after validation: every bucket is a list (possibly empty). */
export interface BoardStatuses {
  tickets: Record<TicketBucket, string[]>
  bugs: Record<BugBucket, string[]>
  tests: Record<TestStatus, string[]>
}

export interface StatusMap {
  tickets: ReadonlyMap<string, TicketBucket>
  bugs: ReadonlyMap<string, BugBucket>
  tests: ReadonlyMap<string, TestStatus>
}

export class UnknownStatusError extends Error {
  constructor(
    readonly domain: StatusDomain,
    /** The ticket, bug or test that carried the status. */
    readonly item: string,
    readonly raw: string,
  ) {
    super(
      `${item}: status "${raw}" is in no bucket of board.statuses.${domain} in .agents/project.yaml. `
      + 'Add it to the bucket it belongs to; an unmapped status is never counted.',
    );
    this.name = 'UnknownStatusError';
  }
}

/** One domain's lists -> a lookup, plus one error per identifier listed in two buckets. */
function invert<B extends string>(domain: StatusDomain, buckets: readonly B[], lists: Record<B, string[]>, errors: string[]): Map<string, B> {
  const map = new Map<string, B>();
  for (const bucket of buckets) {
    for (const id of lists[bucket]) {
      const already = map.get(id);
      if (already !== undefined && already !== bucket) {
        errors.push(`board.statuses.${domain}: "${id}" is listed in both ${already} and ${bucket}; a status belongs to exactly one bucket`);
        continue;
      }
      map.set(id, bucket);
    }
  }
  return map;
}

export function buildStatusMap(statuses: BoardStatuses): { map: StatusMap, errors: string[] } {
  const errors: string[] = [];
  const map: StatusMap = {
    tickets: invert('tickets', TICKET_BUCKETS, statuses.tickets, errors),
    bugs: invert('bugs', BUG_BUCKETS, statuses.bugs, errors),
    tests: invert('tests', TEST_STATUSES, statuses.tests, errors),
  };
  return { map, errors };
}

export function classifyTicket(map: StatusMap, item: string, raw: string): TicketBucket {
  const bucket = map.tickets.get(raw);
  if (bucket === undefined) { throw new UnknownStatusError('tickets', item, raw); }
  return bucket;
}

export function classifyBug(map: StatusMap, item: string, raw: string): BugBucket {
  const bucket = map.bugs.get(raw);
  if (bucket === undefined) { throw new UnknownStatusError('bugs', item, raw); }
  return bucket;
}

/**
 * `null` = the source holds no status for this test (a Test nobody ran, an
 * Xray test with no run yet). That is the one value that needs no mapping:
 * it is NOT RUN by definition, and `rawStatus: null` keeps it visible.
 */
export function classifyTest(map: StatusMap, item: string, raw: string | null): TestStatus {
  if (raw === null) { return 'NOT RUN'; }
  const status = map.tests.get(raw);
  if (status === undefined) { throw new UnknownStatusError('tests', item, raw); }
  return status;
}
