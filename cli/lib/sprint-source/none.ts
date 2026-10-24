/**
 * @fileoverview The `none` source: no tracker, a `tickets.yaml` the owner edits.
 *
 * With no tracker that file IS the system of record, so it lives at a
 * versioned path (`board.tickets_file`, default `.context/sprint/tickets.yaml`).
 * Its statuses are its own strings and go through `board.statuses` exactly as
 * a Jira slug does: a string no bucket lists fails the snapshot.
 *
 * Shape (every field but `title` and `status` optional):
 *
 *   sprint: Sprint 7
 *   tickets:
 *     DEMO-101:
 *       title: Checkout applies a discount code
 *       status: in_test
 *       priority: High
 *       type: Story
 *       module: Checkout
 *       developer: Dana Dev
 *       qa: Quinn QA
 *       updated: <ISO timestamp>
 *       link: https://...
 *       tests:
 *         - { id: DEMO-101-T1, name: Valid code lowers the total, status: PASSED, updated: <ISO> }
 *       bugs: [DEMO-201]
 *   bugs:
 *     DEMO-201: { title: ..., status: open, created: <ISO>, ... }
 */

import type { BoardConfig } from './config.ts';
import type { Bug, SnapshotOptions, Source, SourceSnapshot, TestCase, Ticket } from './types.ts';

import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { parse as parseYaml } from 'yaml';

import { classifyBug, classifyTest, classifyTicket } from './status-map.ts';

type Mapping = Record<string, unknown>;

function isMapping(value: unknown): value is Mapping {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** A scalar field as text; dates parsed by the yaml loader come back as ISO strings. */
function text(value: unknown): string | null {
  if (value === undefined || value === null) { return null; }
  if (value instanceof Date) { return value.toISOString(); }
  if (typeof value === 'string') { return value.trim() === '' ? null : value.trim(); }
  if (typeof value === 'number' || typeof value === 'boolean') { return String(value); }
  return null;
}

export class TicketsFileError extends Error {
  constructor(file: string, problem: string) {
    super(`${file}: ${problem}`);
    this.name = 'TicketsFileError';
  }
}

/** The keys each row of the file may hold; anything else is a typo, never a silent default. */
const FILE_KEYS = ['sprint', 'tickets', 'bugs'];
const TICKET_KEYS = ['title', 'status', 'priority', 'type', 'sprint', 'module', 'developer', 'qa', 'updated', 'link', 'tests', 'bugs'];
const TEST_KEYS = ['id', 'name', 'status', 'updated'];
const BUG_KEYS = ['title', 'status', 'priority', 'type', 'sprint', 'module', 'developer', 'qa', 'created', 'updated', 'link'];

function rejectUnknownKeys(file: string, row: Mapping, allowed: readonly string[], path: string): void {
  const unknown = Object.keys(row).filter(k => !allowed.includes(k));
  if (unknown.length > 0) { throw new TicketsFileError(file, `${path}: unknown key(s) ${unknown.join(', ')} (expected one of: ${allowed.join(', ')})`); }
}

export interface NoneSourceOptions {
  /** Checkout root `board.tickets_file` is relative to. */
  repoRoot?: string
  /** Injected for tests. */
  readFile?: (path: string) => string
}

export function createNoneSource(config: BoardConfig, options: NoneSourceOptions = {}): Source {
  const repoRoot = options.repoRoot ?? process.cwd();
  const readFile = options.readFile ?? ((path: string) => readFileSync(path, 'utf8'));
  const file = config.ticketsFile;
  const path = isAbsolute(file) ? file : join(repoRoot, file);

  return {
    kind: 'none',
    async snapshot(snapshotOptions: SnapshotOptions = {}): Promise<SourceSnapshot> {
      const now = snapshotOptions.now ?? new Date();
      let doc: unknown;
      try { doc = parseYaml(readFile(path)); }
      catch (err) { throw new TicketsFileError(file, `cannot read or parse (${(err as Error).message})`); }
      if (!isMapping(doc)) { throw new TicketsFileError(file, 'expected a mapping with tickets: and bugs:'); }
      rejectUnknownKeys(file, doc, FILE_KEYS, '(top level)');
      const fileSprint = text(doc.sprint);
      const ticketRows = doc.tickets ?? {};
      const bugRows = doc.bugs ?? {};
      if (!isMapping(ticketRows)) { throw new TicketsFileError(file, 'tickets: expected a mapping keyed by ticket id'); }
      if (!isMapping(bugRows)) { throw new TicketsFileError(file, 'bugs: expected a mapping keyed by bug id'); }

      const wanted = snapshotOptions.keys ? new Set(snapshotOptions.keys) : null;
      const tickets: Record<string, Ticket> = {};
      const testIds = new Set<string>();

      for (const [id, row] of Object.entries(ticketRows)) {
        if (!config.ticketKeyPattern.test(id)) { throw new TicketsFileError(file, `ticket id "${id}" does not match board.ticket_key_pattern (${config.ticketKeyPattern.source})`); }
        if (!isMapping(row)) { throw new TicketsFileError(file, `tickets.${id}: expected a mapping`); }
        rejectUnknownKeys(file, row, TICKET_KEYS, `tickets.${id}`);
        if (wanted && !wanted.has(id)) { continue; }
        const title = text(row.title);
        const status = text(row.status);
        if (title === null || status === null) { throw new TicketsFileError(file, `tickets.${id}: title and status are required`); }
        const testRows = row.tests ?? [];
        if (!Array.isArray(testRows)) { throw new TicketsFileError(file, `tickets.${id}.tests: expected a list`); }
        const seenTests = new Set<string>();
        const tests: TestCase[] = testRows.map((t, i) => {
          const at = `tickets.${id}.tests[${i}]`;
          if (!isMapping(t) || text(t.id) === null) { throw new TicketsFileError(file, `${at}: expected a mapping with an id`); }
          rejectUnknownKeys(file, t, TEST_KEYS, at);
          const testId = text(t.id) as string;
          if (seenTests.has(testId)) { throw new TicketsFileError(file, `${at}: test "${testId}" is listed twice under tickets.${id}`); }
          seenTests.add(testId);
          // Required here, unlike a tracker: in a hand-edited system of record a
          // missing status is a typo, not "nobody ran it". Write `NOT RUN`.
          const raw = text(t.status);
          if (raw === null) { throw new TicketsFileError(file, `${at}.status: required (e.g. NOT RUN)`); }
          testIds.add(testId);
          return { id: testId, name: text(t.name) ?? testId, status: classifyTest(config.statusMap, testId, raw), rawStatus: raw, updatedAt: text(t.updated) };
        });
        const linked = row.bugs ?? [];
        if (!Array.isArray(linked)) { throw new TicketsFileError(file, `tickets.${id}.bugs: expected a list of bug ids`); }
        const bugIds = linked.map(b => String(b));
        const twice = bugIds.find((b, i) => bugIds.indexOf(b) !== i);
        if (twice !== undefined) { throw new TicketsFileError(file, `tickets.${id}.bugs: "${twice}" is listed twice`); }
        tickets[id] = {
          id,
          title,
          status,
          statusKey: status,
          bucket: classifyTicket(config.statusMap, id, status),
          priority: text(row.priority),
          type: text(row.type),
          sprint: text(row.sprint) ?? fileSprint,
          module: text(row.module),
          developer: text(row.developer),
          qaOwner: text(row.qa),
          updatedAt: text(row.updated),
          link: text(row.link),
          tests,
          bugs: bugIds,
        };
      }

      const bugs: Record<string, Bug> = {};
      for (const [id, row] of Object.entries(bugRows)) {
        if (!isMapping(row)) { throw new TicketsFileError(file, `bugs.${id}: expected a mapping`); }
        rejectUnknownKeys(file, row, BUG_KEYS, `bugs.${id}`);
        const title = text(row.title);
        const status = text(row.status);
        if (title === null || status === null) { throw new TicketsFileError(file, `bugs.${id}: title and status are required`); }
        const owners = Object.values(tickets).filter(t => t.bugs.includes(id)).map(t => t.id);
        if (wanted && owners.length === 0) { continue; }
        bugs[id] = {
          id,
          title,
          status,
          statusKey: status,
          bucket: classifyBug(config.statusMap, id, status),
          priority: text(row.priority),
          type: text(row.type) ?? 'Bug',
          sprint: text(row.sprint) ?? fileSprint,
          module: text(row.module),
          developer: text(row.developer),
          qaOwner: text(row.qa),
          createdAt: text(row.created),
          updatedAt: text(row.updated),
          link: text(row.link),
          tickets: owners,
        };
      }
      for (const ticket of Object.values(tickets)) {
        for (const bugId of ticket.bugs) {
          if (!(bugId in bugRows)) { throw new TicketsFileError(file, `tickets.${ticket.id}.bugs: "${bugId}" is not under bugs:`); }
        }
      }

      const snapshot: SourceSnapshot = {
        source: 'none',
        syncedAt: now.toISOString(),
        searched: { tickets: Object.keys(tickets).length, tests: testIds.size, bugs: Object.keys(bugs).length },
        tickets,
        bugs,
      };
      if (snapshotOptions.discover) {
        const untracked = Object.entries(ticketRows)
          .filter(([id]) => wanted !== null && !wanted.has(id))
          .map(([id, row]) => {
            const r = row as Mapping;
            return { id, title: text(r.title) ?? id, status: text(r.status) ?? '', qaOwner: text(r.qa) };
          });
        snapshot.discover = { at: now.toISOString(), sprintRows: Object.keys(ticketRows).length, untracked };
      }
      return snapshot;
    },
  };
}
