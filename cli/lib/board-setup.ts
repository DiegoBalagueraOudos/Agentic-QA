/**
 * @fileoverview Filling the `board:` block of `.agents/project.yaml` from setup:
 * the suggested status buckets, `[]` for every bucket left empty, and
 * `board.jql`. Shared by `bun run agents:setup` and the installer, so both
 * write the block the same way.
 *
 * ALL OR NOTHING. Writing any bucket moves the block from "unconfigured" (an
 * INFO line, `board:check` exits 0) to validated, and a validated block also
 * demands `board.jql`, a ticket key and the Atlassian host. So the filled text
 * is resolved with the same `resolveBoardConfig` `board:check` runs, and is
 * written only when it resolves `ok`: setup never turns a green `board:check`
 * red. Every line is rewritten in place; comments and every other byte stay.
 */

import type { Catalogs, FieldCatalog, LinkTypeCatalog, WorkflowCatalog } from './sprint-source/config.ts';
import type { StatusSuggestion } from './sprint-source/suggest-statuses.ts';

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

import { FIELDS_CATALOG, LINK_TYPES_CATALOG, resolveBoardConfig, WORKFLOWS_CATALOG } from './sprint-source/config.ts';
import { applyStatusSuggestions, currentBuckets, suggestStatusBuckets } from './sprint-source/suggest-statuses.ts';

/**
 * A catalog file, or null when it is missing, does not parse, or is the empty
 * `{}` placeholder the installer writes before any sync: none of those can
 * say which statuses a workflow has.
 */
export function readSyncedCatalog<T extends object>(path: string): T | null {
  if (!existsSync(path)) { return null; }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed) || Object.keys(parsed).length === 0) { return null; }
    return parsed as T;
  }
  catch { return null; }
}

/** The three Jira catalogs of a checkout, each null until a sync filled it. */
export function loadSyncedCatalogs(repoRoot: string): Catalogs {
  return {
    workflows: readSyncedCatalog<WorkflowCatalog>(join(repoRoot, WORKFLOWS_CATALOG)),
    fields: readSyncedCatalog<FieldCatalog>(join(repoRoot, FIELDS_CATALOG)),
    linkTypes: readSyncedCatalog<LinkTypeCatalog>(join(repoRoot, LINK_TYPES_CATALOG)),
  };
}

/** The sprint's stories of a project: the default `board.jql`. Null without a key, never `project = null`. */
export function defaultBoardJql(projectKey: string | null | undefined): string | null {
  const key = (projectKey ?? '').trim();
  return key === '' ? null : `project = ${key} AND sprint in openSprints() AND issuetype = Story`;
}

export interface BoardStatusPlan {
  suggestions: StatusSuggestion[]
  /** One line saying why there is nothing to suggest; null when there is no reason to say anything. */
  note: string | null
  /** `board.jql` is still null on a Jira source, so a filled block needs one. */
  needsJql: boolean
}

/**
 * The statuses no bucket lists yet, each with a suggested bucket, or the one
 * line that says why there is nothing to suggest. A `none` source buckets the
 * strings of its own tickets file, so it gets no suggestion.
 */
export function boardStatusPlan(rawText: string, workflows: WorkflowCatalog | null): BoardStatusPlan {
  let root: unknown;
  try { root = parseYaml(rawText); }
  catch { return { suggestions: [], note: null, needsJql: false }; }
  const board = (root as { board?: { source?: unknown, jql?: unknown } } | null)?.board;
  if (board === undefined || board === null) {
    return { suggestions: [], note: 'board.statuses: .agents/project.yaml has no board: block, so no bucket can be suggested. `bun sync` inserts it, or copy it from .agents/project.schema.yaml.', needsJql: false };
  }
  if (board.source === 'none') { return { suggestions: [], note: null, needsJql: false }; }
  const needsJql = board.jql === null || board.jql === undefined || String(board.jql).trim() === '';
  if (workflows === null) {
    return { suggestions: [], note: `board.statuses: ${WORKFLOWS_CATALOG} is not synced yet, so no bucket can be suggested. Run \`bun run jira:sync-workflows\`, then \`bun run agents:setup\` again.`, needsJql };
  }
  return { suggestions: suggestStatusBuckets(workflows, currentBuckets(root)), note: null, needsJql };
}

export type FillResult = { ok: true, text: string } | { ok: false, errors: string[] };

const indentOf = (line: string): number => line.length - line.trimStart().length;
const isContent = (line: string): boolean => line.trim() !== '' && !line.trimStart().startsWith('#');

/** The line of `key:` among the direct children of the line at `parent`; -1 when absent. */
function childLine(lines: string[], parent: number, key: string): number {
  const parentIndent = parent < 0 ? -1 : indentOf(lines[parent]);
  let childIndent: number | null = null;
  for (let i = parent + 1; i < lines.length; i++) {
    if (!isContent(lines[i])) { continue; }
    const indent = indentOf(lines[i]);
    if (indent <= parentIndent) { return -1; }
    childIndent ??= indent;
    if (indent === childIndent && lines[i].trimStart().startsWith(`${key}:`)) { return i; }
  }
  return -1;
}

/** `key: null  # comment` -> `key: <value>  # comment`; null when the line holds anything but null. */
function replaceNull(line: string, value: string): string | null {
  const m = line.match(/^(\s*[\w-]+:)[ \t]*(?:null|~)([ \t]+#.*)?$/);
  if (m === null) { return null; }
  return `${m[1]} ${value}${m[2] ?? ''}`;
}

/**
 * The accepted suggestions written, every ticket and bug bucket still `null`
 * set to `[]`, and `board.jql` set when it was null and a query is given.
 * Pure text in, text out; validation is `fillBoardIfValid`.
 */
export function fillBoardBlock(text: string, opts: { suggestions: readonly StatusSuggestion[], jql: string | null }): FillResult {
  let out = text;
  if (opts.suggestions.length > 0) {
    const applied = applyStatusSuggestions(out, opts.suggestions);
    if (!applied.ok) { return { ok: false, errors: [`board.statuses: ${applied.error}`] }; }
    out = applied.text;
  }
  const lines = out.split('\n');
  const board = lines.findIndex(l => /^board:[ \t]*(?:#.*)?$/.test(l));
  if (board < 0) { return { ok: false, errors: ['no top-level board: block in .agents/project.yaml'] }; }
  const statuses = childLine(lines, board, 'statuses');
  if (statuses < 0) { return { ok: false, errors: ['board.statuses: not found'] }; }
  for (const domain of ['tickets', 'bugs']) {
    const d = childLine(lines, statuses, domain);
    if (d < 0) { return { ok: false, errors: [`board.statuses.${domain}: not found`] }; }
    for (let i = d + 1; i < lines.length; i++) {
      if (!isContent(lines[i])) { continue; }
      if (indentOf(lines[i]) <= indentOf(lines[d])) { break; }
      const next = replaceNull(lines[i], '[]');
      if (next !== null) { lines[i] = next; }
    }
  }
  if (opts.jql !== null && opts.jql.trim() !== '') {
    const j = childLine(lines, board, 'jql');
    if (j >= 0) {
      const next = replaceNull(lines[j], stringifyYaml(opts.jql.trim()).trim());
      if (next !== null) { lines[j] = next; }
    }
  }
  return { ok: true, text: lines.join('\n') };
}

/** `fillBoardBlock`, kept only when the result is a block `board:check` accepts. */
export function fillBoardIfValid(text: string, opts: { suggestions: readonly StatusSuggestion[], jql: string | null }, catalogs: Catalogs): FillResult {
  const filled = fillBoardBlock(text, opts);
  if (!filled.ok) { return filled; }
  let root: unknown;
  try { root = parseYaml(filled.text); }
  catch (err) { return { ok: false, errors: [`.agents/project.yaml would not parse: ${(err as Error).message}`] }; }
  const result = resolveBoardConfig(root, catalogs);
  if (result.state === 'ok') { return filled; }
  return { ok: false, errors: result.state === 'invalid' ? result.errors : [result.reason] };
}
