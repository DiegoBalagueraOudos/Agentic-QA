/**
 * @fileoverview Suggested `board.statuses` buckets for the workflow statuses no
 * bucket lists yet (ADR-0019 follow-up), read by `bun run agents:setup`.
 *
 * The Jira status category (`new` / `indeterminate` / `done`, mirrored in
 * `.agents/jira-workflows.json`) cannot tell "ready for QA" from "ready for dev"
 * (both `new`), so the slug decides inside a category. A suggestion is only a
 * default the person confirms: a slug already in a bucket is never moved, and
 * `board:check` still validates the result.
 *
 * `applyStatusSuggestions` writes the accepted slugs into the flow lists of
 * `board.statuses.<domain>.<bucket>` by rewriting those lines only: a `null`
 * bucket (how the template ships) becomes a list, an existing list is appended
 * to, and every comment and every other line stays byte for byte.
 */

import type { WorkflowCatalog } from './config.ts';
import type { BugBucket, TicketBucket } from './types.ts';

import { BUG_WORK_TYPES, TICKET_WORK_TYPES } from './config.ts';

export type StatusDomain = 'tickets' | 'bugs';

export interface StatusSuggestion {
  domain: StatusDomain
  slug: string
  /** The display name in the catalog. */
  name: string
  category: string | null
  bucket: TicketBucket | BugBucket
}

/** What the yaml holds now: `null` = the bucket is not filled yet. */
export type CurrentBuckets = Record<StatusDomain, Record<string, readonly string[] | null>>;

const CANCELLED_TICKET = /abort|cancel|reject|duplicat|won_?t|obsolete|invalid/;
const CANCELLED_BUG = /abort|cancel|reject|duplicat|cannot_reproduce|not_reproducible|won_?t|not_a_bug|invalid|enhancement|obsolete/;
const IN_TEST = /(?:^|_)(?:ready_for_(?:qa|test(?:ing)?)|in_(?:qa|test(?:ing)?)|testing|qa_in_progress|under_test)(?:$|_)/;
const AWAITING_RETEST = /ready_for_(?:qa|test|retest)|retest|in_test|in_qa|fixed|verif/;

export function suggestTicketBucket(slug: string, category: string | null): TicketBucket {
  if (/block/.test(slug)) { return 'blocked'; }
  if (category === 'done') { return CANCELLED_TICKET.test(slug) ? 'dropped' : 'tested'; }
  if (/shift_left/.test(slug)) { return 'not_ready'; }
  return IN_TEST.test(slug) ? 'in_test' : 'not_ready';
}

export function suggestBugBucket(slug: string, category: string | null): BugBucket {
  if (category === 'done') { return CANCELLED_BUG.test(slug) ? 'discarded' : 'resolved'; }
  return AWAITING_RETEST.test(slug) ? 'fixed' : 'open';
}

/** Every workflow status of each domain's work types that no bucket lists yet, with a suggested bucket. */
export function suggestStatusBuckets(catalog: WorkflowCatalog, current: CurrentBuckets): StatusSuggestion[] {
  const out: StatusSuggestion[] = [];
  const domains: Array<[StatusDomain, readonly string[]]> = [['tickets', TICKET_WORK_TYPES], ['bugs', BUG_WORK_TYPES]];
  for (const [domain, workTypes] of domains) {
    const listed = new Set(Object.values(current[domain] ?? {}).flatMap(ids => ids ?? []));
    const seen = new Set<string>();
    for (const workType of workTypes) {
      for (const [slug, status] of Object.entries(catalog[workType]?.statuses ?? {})) {
        if (listed.has(slug) || seen.has(slug)) { continue; }
        seen.add(slug);
        const category = status.category ?? null;
        out.push({ domain, slug, name: status.name ?? slug, category, bucket: domain === 'tickets' ? suggestTicketBucket(slug, category) : suggestBugBucket(slug, category) });
      }
    }
  }
  return out;
}

/** `board.statuses` as the yaml holds it, for `suggestStatusBuckets`. Missing parts read as empty. */
export function currentBuckets(root: unknown): CurrentBuckets {
  const statuses = (root as { board?: { statuses?: Record<string, unknown> } } | null)?.board?.statuses ?? {};
  const read = (domain: StatusDomain): Record<string, readonly string[] | null> => {
    const lists = statuses[domain];
    if (lists === null || typeof lists !== 'object' || Array.isArray(lists)) { return {}; }
    return Object.fromEntries(Object.entries(lists as Record<string, unknown>).map(([bucket, ids]) => [bucket, Array.isArray(ids) ? ids.map(String) : null]));
  };
  return { tickets: read('tickets'), bugs: read('bugs') };
}

export type ApplyResult = { ok: true, text: string, applied: number } | { ok: false, error: string };

const indentOf = (line: string): number => line.length - line.trimStart().length;
const isContent = (line: string): boolean => line.trim() !== '' && !line.trimStart().startsWith('#');

/** The line index of `key:` among the direct children of the block that starts at `from` (exclusive) with indent `parent`. */
function childLine(lines: string[], from: number, parent: number, key: string): number {
  let childIndent: number | null = null;
  for (let i = from + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!isContent(line)) { continue; }
    const indent = indentOf(line);
    if (indent <= parent) { return -1; }
    childIndent ??= indent;
    if (indent === childIndent && line.trimStart().startsWith(`${key}:`)) { return i; }
  }
  return -1;
}

/** `key: <value> # comment` split into its parts; `value` is `''` when the key holds nothing on its line. */
function splitLeaf(line: string): { head: string, value: string, tail: string } | null {
  const colon = line.indexOf(':');
  if (colon < 0 || !/^\s*[\w-]+$/.test(line.slice(0, colon))) { return null; }
  const rest = line.slice(colon + 1);
  const hash = rest.search(/(?:^|[ \t])#/);
  const body = hash < 0 ? rest : rest.slice(0, hash);
  return { head: line.slice(0, colon + 1), value: body.trim(), tail: hash < 0 ? '' : rest.slice(hash) };
}

/** Append the suggestions to their bucket lines; refuses a bucket it cannot rewrite in place (a block list, a missing key). */
export function applyStatusSuggestions(text: string, suggestions: readonly StatusSuggestion[]): ApplyResult {
  const lines = text.split('\n');
  const board = lines.findIndex(l => /^board:[ \t]*(?:#.*)?$/.test(l));
  if (board < 0) { return { ok: false, error: 'no top-level board: block in the yaml' }; }
  const statuses = childLine(lines, board, 0, 'statuses');
  if (statuses < 0) { return { ok: false, error: 'board.statuses: not found' }; }

  const byLine = new Map<number, string[]>();
  for (const s of suggestions) {
    const domain = childLine(lines, statuses, indentOf(lines[statuses]), s.domain);
    if (domain < 0) { return { ok: false, error: `board.statuses.${s.domain}: not found` }; }
    const bucket = childLine(lines, domain, indentOf(lines[domain]), s.bucket);
    if (bucket < 0) { return { ok: false, error: `board.statuses.${s.domain}.${s.bucket}: not found; add the key, then run setup again` }; }
    byLine.set(bucket, [...(byLine.get(bucket) ?? []), s.slug]);
  }

  for (const [index, slugs] of byLine) {
    const leaf = splitLeaf(lines[index]);
    const next = lines.slice(index + 1).find(isContent);
    if (leaf !== null && leaf.value === '' && next !== undefined && indentOf(next) >= indentOf(lines[index]) && next.trimStart().startsWith('-')) {
      return { ok: false, error: `line ${index + 1} (${lines[index].trim()}): a block list; add ${slugs.join(', ')} by hand` };
    }
    const flow = leaf !== null && (/^\[[^\]]*\]$/.test(leaf.value) || ['', 'null', '~'].includes(leaf.value));
    if (leaf === null || !flow) { return { ok: false, error: `line ${index + 1} (${lines[index].trim()}): not a null or one-line list; add ${slugs.join(', ')} by hand` }; }
    const { head, value, tail } = leaf;
    const existing = value.startsWith('[') ? value.slice(1, -1).split(',').map(x => x.trim()).filter(Boolean) : [];
    const merged = [...existing, ...slugs.filter(slug => !existing.includes(slug))];
    lines[index] = `${head} [${merged.join(', ')}]${tail}`;
  }
  return { ok: true, text: lines.join('\n'), applied: suggestions.length };
}
