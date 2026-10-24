/**
 * @fileoverview The one shape every sprint module reads (ADR-0019).
 *
 * A `Source` turns a tracker (or a hand-edited `tickets.yaml`) into a
 * `SourceSnapshot`. The board, the Merge Line and the evidence page consume
 * the snapshot and never the tracker, so swapping Jira+Xray for Jira-native or
 * for no tracker at all changes one adapter and nothing downstream.
 *
 * The bucket and status names below are a contract: later modules fold on
 * them. Renaming one is a superseding ADR, not a refactor.
 */

/** The three implementations (D14). `auto` in the config resolves to one of the first two. */
export const SOURCE_KINDS = ['jira-xray', 'jira-native', 'none'] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

/** Where a ticket stands for QA. Every ticket status sits in exactly one. */
export const TICKET_BUCKETS = ['not_ready', 'in_test', 'tested', 'blocked', 'dropped'] as const;
export type TicketBucket = (typeof TICKET_BUCKETS)[number];

/** Where a bug stands. `fixed` = waiting for its retest. */
export const BUG_BUCKETS = ['open', 'fixed', 'resolved', 'discarded'] as const;
export type BugBucket = (typeof BUG_BUCKETS)[number];

/**
 * A test case's latest outcome, whatever the TMS calls it.
 *
 * The canonical execution outcomes are PASSED and FAILED, both only on
 * observation; anything else is NOT RUN with a reason
 * (`agentic-qa-core/references/discovery-driven-doctrine.md` §5). BLOCKED
 * (the blocking ladder is open) and DEFERRED are two of those reasons, kept as
 * their own values because the board shows them apart. DEFERRED is exactly the
 * doctrine's `DEFERRED (execution)`: QA deferred the case and recorded the
 * follow-up. It is never the ROI `Deferred` verdict of test documentation,
 * which says a scenario does not enter the regression repository.
 *
 * Count with `countedOutcome`, never with `status` directly: a count of
 * `status === 'NOT RUN'` misses the BLOCKED and DEFERRED cases.
 */
export const TEST_STATUSES = ['PASSED', 'FAILED', 'NOT RUN', 'BLOCKED', 'DEFERRED'] as const;
export type TestStatus = (typeof TEST_STATUSES)[number];

/** The three outcomes every count uses (doctrine §5.1). */
export type CountedOutcome = 'PASSED' | 'FAILED' | 'NOT RUN';

/** BLOCKED and DEFERRED are reasons a case is NOT RUN, never separate outcomes for counting. */
export function countedOutcome(status: TestStatus): CountedOutcome {
  return status === 'PASSED' || status === 'FAILED' ? status : 'NOT RUN';
}

export interface TestCase {
  id: string
  name: string
  status: TestStatus
  /** What the source said before mapping; `null` = the source holds no status (never run). */
  rawStatus: string | null
  updatedAt: string | null
}

/** Fields a ticket and a bug share. */
interface WorkItem {
  id: string
  title: string
  /** Display status, as the source shows it. */
  status: string
  /** The identifier the config buckets by: a workflow slug (Jira) or the file's own string (`none`). */
  statusKey: string
  priority: string | null
  type: string | null
  sprint: string | null
  /** Module / component; the first one when the source holds several. */
  module: string | null
  developer: string | null
  qaOwner: string | null
  updatedAt: string | null
  link: string | null
}

export interface Ticket extends WorkItem {
  bucket: TicketBucket
  tests: TestCase[]
  /** Ids of the bugs linked to this ticket, keys of `SourceSnapshot.bugs`. */
  bugs: string[]
}

export interface Bug extends WorkItem {
  bucket: BugBucket
  createdAt: string | null
  /** Ids of the tickets this bug is linked to. */
  tickets: string[]
}

export interface UntrackedRow {
  id: string
  title: string
  status: string
  /** Classified exactly like a tracked ticket's, so the board can tell which untracked rows are in test. */
  statusKey: string
  /**
   * `null` when `board.statuses` (or the catalog) does not know the row's status: the row is
   * listed as unclassified with `unclassified` saying why, and the discover read does not fail.
   * A TRACKED ticket in such a status still fails the snapshot.
   */
  bucket: TicketBucket | null
  unclassified?: string
  qaOwner: string | null
}

export interface UnclassifiedBugRow {
  id: string
  status: string
  reason: string
}

export interface SourceSnapshot {
  source: SourceKind
  syncedAt: string
  /**
   * Denominators, always present, zero included: a count is never shown without
   * what it was counted from. Each counts DISTINCT items in this snapshot: a test
   * case or a bug linked to two tickets counts once.
   */
  searched: { tickets: number, tests: number, bugs: number }
  tickets: Record<string, Ticket>
  bugs: Record<string, Bug>
  /** Sprint rows the board does not track yet; only when `discover` was asked for. */
  discover?: {
    at: string
    sprintRows: number
    untracked: UntrackedRow[]
    /**
     * The sprint's own bug rows (the Bugs view's second source), whatever they link to.
     * Absent when the source has no bug query (a jira source whose `board.jql` yields no
     * `board.bug_jql`): the view then says "not checked", never zero.
     */
    bugs?: Bug[]
    /** Bug rows in a status no bug bucket lists, or not of a bug work type: named, never counted (not in `bugs`). */
    unclassifiedBugs?: UnclassifiedBugRow[]
  }
  /**
   * Ids asked for in `bugKeys` that the source could not find: named, and still counted in
   * `searched.bugs`, so a bug the board links is never silently left open.
   */
  missing?: { bugs: string[] }
}

export interface SnapshotOptions {
  /** Clock for `syncedAt`; tests pin it. */
  now?: Date
  /** The tickets the board tracks. Absent = whatever the source's own query returns. */
  keys?: readonly string[]
  /** Also list the sprint rows that are not in `keys`. */
  discover?: boolean
  /**
   * Bugs the board links to its tickets, read too whatever the tracker links: their status
   * reaches `bugs` and they count in `searched.bugs`; an id not found lands in `missing.bugs`.
   */
  bugKeys?: readonly string[]
}

export interface Source {
  readonly kind: SourceKind
  snapshot: (options?: SnapshotOptions) => Promise<SourceSnapshot>
}
