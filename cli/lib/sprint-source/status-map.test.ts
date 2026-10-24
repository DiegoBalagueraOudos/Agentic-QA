import type { BoardStatuses } from './status-map.ts';

import { describe, expect, test } from 'bun:test';

import { buildStatusMap, classifyBug, classifyTest, classifyTicket, UnknownStatusError } from './status-map.ts';
import { countedOutcome, TEST_STATUSES } from './types.ts';

const statuses: BoardStatuses = {
  tickets: { not_ready: ['to_do'], in_test: ['in_test'], tested: ['qa_approved'], blocked: [], dropped: ['aborted'] },
  bugs: { open: ['open'], fixed: ['ready_for_qa'], resolved: ['closed'], discarded: [] },
  tests: { 'PASSED': ['PASSED'], 'FAILED': ['FAILED'], 'NOT RUN': ['TODO'], 'BLOCKED': [], 'DEFERRED': [] },
};

describe('status map', () => {
  test('counts use three outcomes: BLOCKED and DEFERRED are NOT RUN reasons', () => {
    expect(TEST_STATUSES.map(countedOutcome)).toEqual(['PASSED', 'FAILED', 'NOT RUN', 'NOT RUN', 'NOT RUN']);
  });

  test('a mapped status lands in its bucket', () => {
    const { map, errors } = buildStatusMap(statuses, 'board.yaml');
    expect(errors).toEqual([]);
    expect(classifyTicket(map, 'X-1', 'qa_approved')).toBe('tested');
    expect(classifyBug(map, 'X-2', 'ready_for_qa')).toBe('fixed');
    expect(classifyTest(map, 'X-3', 'TODO')).toBe('NOT RUN');
  });

  test('a status no bucket lists throws, naming the item, the value and the config path', () => {
    const { map } = buildStatusMap(statuses, 'board.yaml');
    expect(() => classifyTicket(map, 'X-1', 'in_review')).toThrow(UnknownStatusError);
    expect(() => classifyTicket(map, 'X-1', 'in_review')).toThrow(/X-1: status "in_review" is in no bucket of board\.statuses\.tickets in board\.yaml/);
    expect(() => classifyBug(map, 'X-2', 'deferred')).toThrow(/board\.statuses\.bugs/);
    expect(() => classifyTest(map, 'X-3', 'EXECUTING')).toThrow(/board\.statuses\.tests/);
  });

  test('a test with no status at all is NOT RUN, the one value needing no mapping', () => {
    const { map } = buildStatusMap(statuses, 'board.yaml');
    expect(classifyTest(map, 'X-3', null)).toBe('NOT RUN');
  });

  test('a status listed in two buckets is a config error', () => {
    const { errors } = buildStatusMap({ ...statuses, tickets: { ...statuses.tickets, tested: ['qa_approved', 'in_test'] } }, 'board.yaml');
    expect(errors).toEqual(['board.statuses.tickets: "in_test" is listed in both in_test and tested; a status belongs to exactly one bucket']);
  });
});
