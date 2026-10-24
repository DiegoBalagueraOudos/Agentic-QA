import type { BugBucket, TicketBucket } from '../lib/sprint-source/types.ts';
import type { TrackerSnapshot } from './model.ts';
/**
 * Tests write tracker snapshots the way a person reads a board (display statuses); `sync` would
 * have stored each one's bucket from `board.statuses`. `bucketed` fills it in with this fixed map,
 * the statuses of `demo/project.yaml` plus the ones the ported tests use. Tests only.
 */

const TICKET_BUCKET: Record<string, TicketBucket> = {
  'To Do': 'not_ready',
  'Backlog': 'not_ready',
  'In Progress': 'not_ready',
  'Code Review': 'not_ready',
  'Ready for QA': 'in_test',
  'In Test': 'in_test',
  'QA Approved': 'tested',
  'Released': 'tested',
  'Done': 'tested',
  'Blocked': 'blocked',
  'Cancelled': 'dropped',
};

const BUG_BUCKET: Record<string, BugBucket> = {
  'Open': 'open',
  'Backlog': 'open',
  'Prioritized': 'open',
  'In Progress': 'open',
  'Ready for Retest': 'fixed',
  'Ready for QA': 'fixed',
  'Closed': 'resolved',
  'QA Approved': 'resolved',
  'Done': 'resolved',
  'Rejected': 'discarded',
  'Duplicate': 'discarded',
  'Cancelled': 'discarded',
};

export const ticketBucketOf = (status?: string): TicketBucket | undefined => (status ? TICKET_BUCKET[status] ?? 'not_ready' : undefined);
export const bugBucketOf = (status?: string): BugBucket | undefined => (status ? BUG_BUCKET[status] ?? 'open' : undefined);

/** The snapshot with every ticket, bug and untracked row's bucket set from its status (an explicit bucket wins). */
export function bucketed<T extends TrackerSnapshot | null | undefined>(s: T): T {
  if (!s) { return s; }
  const tickets = Object.fromEntries(Object.entries(s.tickets).map(([id, t]) => [id, { ...t, bucket: t.bucket ?? ticketBucketOf(t.status) }]));
  const bugs = Object.fromEntries(Object.entries(s.bugs ?? {}).map(([id, b]) => [id, { ...b, bucket: b.bucket ?? bugBucketOf(b.status) }]));
  const discover = s.discover && {
    ...s.discover,
    untracked: s.discover.untracked.map(r => ({ ...r, bucket: r.bucket ?? ticketBucketOf(r.status) })),
    bugs: s.discover.bugs?.map(b => ({ ...b, bucket: b.bucket ?? bugBucketOf(b.status) })),
  };
  return { ...s, tickets, bugs, ...(discover ? { discover } : {}) };
}
