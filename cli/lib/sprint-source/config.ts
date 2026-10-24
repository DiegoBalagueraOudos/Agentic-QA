/**
 * @fileoverview The `board:` block of `.agents/project.yaml`, resolved and
 * validated (ADR-0019).
 *
 * DERIVE, NEVER REPEAT. Half of the values a sprint board needs already have a
 * home in `project.yaml`: the ticket key (`project.project_key`),
 * the environment (`testing.default_env`), the mainline branch
 * (`git_strategy.branches.production`), the required approvals
 * (`git_strategy.policy.require_pr_reviews`), the TMS modality
 * (`testing.tms_cli`) and the Jira host (`issue_tracker.atlassian_url`). They
 * are read from there on every load, and `derived` says where each came from,
 * so a second copy never exists to go stale. The block holds only the values
 * with no other home.
 *
 * Three outcomes, never a silent default: `unconfigured` (the block or its
 * status buckets are not filled; callers skip with one line), `invalid` (every
 * error names its key path), `ok`.
 */

import type { BoardStatuses, StatusMap } from './status-map.ts';
import type { BugBucket, SourceKind, TestStatus, TicketBucket } from './types.ts';

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';

import { normalizeAtlassianUrl } from '../atlassian-instance.ts';
import { buildStatusMap } from './status-map.ts';
import { BUG_BUCKETS, SOURCE_KINDS, TEST_STATUSES, TICKET_BUCKETS } from './types.ts';

// ============================================================================
// CATALOGS (the Jira mirrors the sync scripts write)
// ============================================================================

export const PROJECT_YAML = '.agents/project.yaml';
export const WORKFLOWS_CATALOG = '.agents/jira-workflows.json';
export const FIELDS_CATALOG = '.agents/jira-fields.json';
export const LINK_TYPES_CATALOG = '.agents/jira-link-types.json';

/** `.agents/jira-workflows.json`, only the parts read here. */
export type WorkflowCatalog = Record<string, {
  jira_issue_type?: { name?: string }
  statuses?: Record<string, { name?: string }>
}>;

/** `.agents/jira-fields.json`, only the parts read here. */
export type FieldCatalog = Record<string, {
  id?: string
  name?: string
  options?: Record<string, string>
}>;

/** `.agents/jira-link-types.json`, only the parts read here. */
export type LinkTypeCatalog = Record<string, { name?: string }>;

export interface Catalogs {
  workflows: WorkflowCatalog | null
  fields: FieldCatalog | null
  /** Optional: without it the `test` link is not filtered by type (a degraded instance). */
  linkTypes?: LinkTypeCatalog | null
}

/**
 * Work types whose statuses a board ticket or bug takes (methodology slugs).
 * `tech_story` is a ticket because a coverage Tech Story is a coverable of its
 * own (discovery-driven doctrine §3).
 */
export const TICKET_WORK_TYPES = ['story', 'tech_story'] as const;
export const BUG_WORK_TYPES = ['bug', 'defect'] as const;

// ============================================================================
// RESOLVED SHAPE
// ============================================================================

export interface Person {
  name: string
  role: string | null
  /** Language for drafts written to this person (e.g. `en`). */
  language: string | null
  /** How the tracker names this person (display name), when it differs. */
  jira: string | null
}

export interface BoardConfig {
  source: SourceKind
  /** The file the block was read from; every status error names it. */
  configFile: string
  /** Repo-relative; read by the `none` source only. */
  ticketsFile: string
  jql: string | null
  ticketKeyPattern: RegExp
  projectKey: string | null
  environment: string | null
  mainline: string | null
  requiredApprovals: number | null
  jiraHost: string | null
  timezone: string | null
  statuses: BoardStatuses
  statusMap: StatusMap
  people: Person[]
  evidenceHosts: string[]
  brand: { name: string | null, logo: string | null }
  catalogs: Catalogs
}

/** A value the config did not hold but read from elsewhere, and where from. */
export interface DerivedValue {
  key: string
  value: unknown
  from: string
}

export type BoardConfigResult
  = | { state: 'unconfigured', reason: string }
    | { state: 'invalid', errors: string[] }
    | { state: 'ok', config: BoardConfig, derived: DerivedValue[], warnings: string[] };

/**
 * Shipped test status map: Xray's built-in run statuses and the jira-native
 * `test_status` option slugs (`.agents/jira-required.yaml`). An aborted Xray run
 * was not observed, so it is NOT RUN; BLOCKED means the blocking ladder is open,
 * which only the project can say. DEFERRED (the doctrine's `DEFERRED (execution)`)
 * exists in neither TMS, so it maps only what a project lists.
 */
export const DEFAULT_TEST_STATUSES: Readonly<Record<TestStatus, readonly string[]>> = {
  'PASSED': ['PASSED', 'passed'],
  'FAILED': ['FAILED', 'failed'],
  'NOT RUN': ['TODO', 'EXECUTING', 'ABORTED', 'n_r'],
  'BLOCKED': ['blocked'],
  'DEFERRED': [],
};

export const DEFAULT_TICKETS_FILE = '.context/sprint/tickets.yaml';
export const DEFAULT_EVIDENCE_HOSTS: readonly string[] = ['claude.ai'];

// ============================================================================
// HELPERS
// ============================================================================

type Mapping = Record<string, unknown>;

function isMapping(value: unknown): value is Mapping {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function at(root: Mapping, path: string): unknown {
  let node: unknown = root;
  for (const segment of path.split('.')) {
    if (!isMapping(node)) { return undefined; }
    node = node[segment];
  }
  return node;
}

function optionalString(value: unknown, path: string, errors: string[]): string | null {
  if (value === undefined || value === null) { return null; }
  if (typeof value !== 'string' || value.trim() === '') {
    errors.push(`${path}: expected a non-empty string or null`);
    return null;
  }
  return value.trim();
}

function stringList(value: unknown, path: string, errors: string[]): string[] | null {
  if (!Array.isArray(value) || value.some(v => typeof v !== 'string' || v.trim() === '')) {
    errors.push(`${path}: expected a list of non-empty strings`);
    return null;
  }
  return value.map(v => (v as string).trim());
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isTimeZone(zone: string): boolean {
  try {
    // eslint-disable-next-line no-new
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  }
  catch { return false; }
}

/** Every status slug a work type of the catalog declares. */
function slugsOf(catalog: WorkflowCatalog, workTypes: readonly string[]): Set<string> {
  const slugs = new Set<string>();
  for (const workType of workTypes) {
    for (const slug of Object.keys(catalog[workType]?.statuses ?? {})) { slugs.add(slug); }
  }
  return slugs;
}

/** `auto` follows `testing.tms_cli`: `bun xray` = jira-xray, anything else (unset, `acli`) = jira-native. */
export function modalityFromTmsCli(tmsCli: unknown): SourceKind {
  return typeof tmsCli === 'string' && tmsCli.trim().replace(/\s+/g, ' ') === 'bun xray' ? 'jira-xray' : 'jira-native';
}

/**
 * One bucketed domain. `null` buckets are "not filled yet" and are reported by
 * the caller; an unknown bucket name is a typo and fails here.
 */
function readBuckets<B extends string>(
  value: unknown,
  path: string,
  buckets: readonly B[],
  errors: string[],
): { lists: Record<B, string[]>, unset: B[] } {
  const lists = Object.fromEntries(buckets.map(b => [b, [] as string[]])) as Record<B, string[]>;
  const unset: B[] = [];
  if (!isMapping(value)) {
    if (value !== undefined && value !== null) { errors.push(`${path}: expected a mapping of bucket -> list of statuses`); }
    return { lists, unset: [...buckets] };
  }
  for (const key of Object.keys(value)) {
    if (!(buckets as readonly string[]).includes(key)) {
      errors.push(`${path}.${key}: unknown bucket (expected one of: ${buckets.join(', ')})`);
    }
  }
  for (const bucket of buckets) {
    const raw = value[bucket];
    if (raw === undefined || raw === null) { unset.push(bucket); continue; }
    const list = stringList(raw, `${path}.${bucket}`, errors);
    if (list) { lists[bucket] = list; }
  }
  return { lists, unset };
}

// ============================================================================
// RESOLVE
// ============================================================================

/** The keys each mapping of the block may hold; anything else is a typo. */
const BOARD_KEYS: Readonly<Record<string, readonly string[]>> = {
  'board': ['source', 'tickets_file', 'jql', 'ticket_key_pattern', 'timezone', 'statuses', 'people', 'evidence', 'brand'],
  'board.statuses': ['tickets', 'bugs', 'tests'],
  'board.evidence': ['allowed_hosts'],
  'board.brand': ['name', 'logo'],
};
const PERSON_KEYS = ['name', 'role', 'language', 'jira'] as const;

/**
 * Unknown keys, by path. Checked before anything else: a misspelled
 * `statuses:` would otherwise read as "not filled" and pass as unconfigured.
 */
function unknownKeys(board: Mapping): string[] {
  const errors: string[] = [];
  for (const [path, allowed] of Object.entries(BOARD_KEYS)) {
    const node = path === 'board' ? board : at(board, path.slice('board.'.length));
    if (!isMapping(node)) { continue; }
    for (const key of Object.keys(node)) {
      if (!allowed.includes(key)) { errors.push(`${path}.${key}: unknown key (expected one of: ${allowed.join(', ')})`); }
    }
  }
  if (Array.isArray(board.people)) {
    board.people.forEach((entry, i) => {
      if (!isMapping(entry)) { return; }
      for (const key of Object.keys(entry)) {
        if (!(PERSON_KEYS as readonly string[]).includes(key)) { errors.push(`board.people[${i}].${key}: unknown key (expected one of: ${PERSON_KEYS.join(', ')})`); }
      }
    });
  }
  return errors;
}

/**
 * Resolve the block from an already-parsed `project.yaml` and the catalogs. Pure.
 * `configFile` is the path the block came from, named in every status error.
 */
export function resolveBoardConfig(root: unknown, catalogs: Catalogs, configFile: string = PROJECT_YAML): BoardConfigResult {
  if (!isMapping(root)) { return { state: 'invalid', errors: [`${configFile}: expected a mapping at the top level`] }; }
  const board = root.board;
  if (board === undefined || board === null) { return { state: 'unconfigured', reason: `${configFile} has no board: block` }; }
  if (!isMapping(board)) { return { state: 'invalid', errors: ['board: expected a mapping'] }; }

  const typos = unknownKeys(board);
  if (typos.length > 0) { return { state: 'invalid', errors: typos }; }

  const errors: string[] = [];
  const warnings: string[] = [];
  const derived: DerivedValue[] = [];

  // --- statuses: decides "unconfigured" before anything else is judged.
  const statusesNode = board.statuses;
  if (statusesNode !== undefined && statusesNode !== null && !isMapping(statusesNode)) {
    return { state: 'invalid', errors: ['board.statuses: expected a mapping'] };
  }
  const statusesMap = isMapping(statusesNode) ? statusesNode : {};
  const tickets = readBuckets<TicketBucket>(statusesMap.tickets, 'board.statuses.tickets', TICKET_BUCKETS, errors);
  const bugs = readBuckets<BugBucket>(statusesMap.bugs, 'board.statuses.bugs', BUG_BUCKETS, errors);
  if (errors.length === 0 && tickets.unset.length === TICKET_BUCKETS.length && bugs.unset.length === BUG_BUCKETS.length) {
    return { state: 'unconfigured', reason: 'board.statuses.tickets and board.statuses.bugs are not filled' };
  }
  for (const bucket of tickets.unset) { errors.push(`board.statuses.tickets.${bucket}: not filled (list its statuses, or [] when none belong there)`); }
  for (const bucket of bugs.unset) { errors.push(`board.statuses.bugs.${bucket}: not filled (list its statuses, or [] when none belong there)`); }

  let tests: Record<TestStatus, string[]>;
  if (statusesMap.tests === undefined || statusesMap.tests === null) {
    tests = Object.fromEntries(TEST_STATUSES.map(s => [s, [...DEFAULT_TEST_STATUSES[s]]])) as Record<TestStatus, string[]>;
    derived.push({ key: 'board.statuses.tests', value: tests, from: 'shipped default (Xray run statuses + jira-native test_status options)' });
  }
  else {
    const read = readBuckets<TestStatus>(statusesMap.tests, 'board.statuses.tests', TEST_STATUSES, errors);
    for (const status of read.unset) { errors.push(`board.statuses.tests.${status}: not filled (list its raw values, or [])`); }
    tests = read.lists;
  }
  const statuses: BoardStatuses = { tickets: tickets.lists, bugs: bugs.lists, tests };
  const built = buildStatusMap(statuses, configFile);
  errors.push(...built.errors);

  // --- source
  let source: SourceKind;
  const sourceRaw = board.source ?? 'auto';
  if (sourceRaw === 'auto') {
    source = modalityFromTmsCli(at(root, 'testing.tms_cli'));
    derived.push({ key: 'board.source', value: source, from: 'testing.tms_cli (board.source: auto)' });
  }
  else if (typeof sourceRaw === 'string' && (SOURCE_KINDS as readonly string[]).includes(sourceRaw)) {
    source = sourceRaw as SourceKind;
  }
  else {
    errors.push(`board.source: expected auto | ${SOURCE_KINDS.join(' | ')}`);
    source = 'none';
  }

  const ticketsFile = optionalString(board.tickets_file, 'board.tickets_file', errors) ?? DEFAULT_TICKETS_FILE;
  const jql = optionalString(board.jql, 'board.jql', errors);

  // --- source-specific checks
  if (source !== 'none') {
    if (jql === null) { errors.push(`board.jql: required for the ${source} source (e.g. project = PROJ AND sprint in openSprints() AND issuetype = Story)`); }
    if (catalogs.workflows === null) {
      errors.push(`${WORKFLOWS_CATALOG} is missing: the ${source} source names statuses by its workflow slugs (run \`bun run jira:sync-workflows\`)`);
    }
    else {
      // Each domain is validated against ITS OWN work types: a bug slug in a
      // ticket bucket is a wrong mapping, not a valid one.
      const ticketSlugs = slugsOf(catalogs.workflows, TICKET_WORK_TYPES);
      const bugSlugs = slugsOf(catalogs.workflows, BUG_WORK_TYPES);
      const domains = [
        ['tickets', statuses.tickets, ticketSlugs, TICKET_WORK_TYPES],
        ['bugs', statuses.bugs, bugSlugs, BUG_WORK_TYPES],
      ] as const;
      for (const [domain, lists, own, workTypes] of domains) {
        for (const [bucket, ids] of Object.entries(lists)) {
          for (const id of ids) {
            if (!own.has(id)) { errors.push(`board.statuses.${domain}.${bucket}: "${id}" is not a status of the ${workTypes.join(' / ')} work types in ${WORKFLOWS_CATALOG}`); }
          }
        }
        const mapped = domain === 'tickets' ? built.map.tickets : built.map.bugs;
        for (const slug of own) {
          if (!mapped.has(slug)) { warnings.push(`board.statuses.${domain}: workflow status "${slug}" is in no bucket; a ${domain === 'tickets' ? 'ticket' : 'bug'} in it will fail the snapshot`); }
        }
      }
    }
  }

  // --- ticket key
  const projectKey = optionalString(at(root, 'project.project_key'), 'project.project_key', errors);
  let ticketKeyPattern = /^$/;
  const patternRaw = optionalString(board.ticket_key_pattern, 'board.ticket_key_pattern', errors);
  if (patternRaw !== null) {
    try { ticketKeyPattern = new RegExp(patternRaw); }
    catch (err) { errors.push(`board.ticket_key_pattern: not a valid regular expression (${(err as Error).message})`); }
  }
  else if (projectKey !== null) {
    ticketKeyPattern = new RegExp(`^${escapeRegExp(projectKey)}-\\d+$`);
    derived.push({ key: 'board.ticket_key_pattern', value: ticketKeyPattern.source, from: 'project.project_key' });
  }
  else {
    errors.push('board.ticket_key_pattern: null and project.project_key is unset; fill one of them');
  }

  // --- the rest of the block
  const timezone = optionalString(board.timezone, 'board.timezone', errors);
  if (timezone !== null && !isTimeZone(timezone)) { errors.push(`board.timezone: "${timezone}" is not an IANA time zone (e.g. America/New_York)`); }

  const people: Person[] = [];
  if (board.people !== undefined && board.people !== null) {
    if (!Array.isArray(board.people)) { errors.push('board.people: expected a list'); }
    else {
      const seen = new Set<string>();
      board.people.forEach((entry, i) => {
        const path = `board.people[${i}]`;
        if (!isMapping(entry)) { errors.push(`${path}: expected a mapping with at least a name`); return; }
        const name = optionalString(entry.name, `${path}.name`, errors);
        if (name === null) { errors.push(`${path}.name: required`); return; }
        if (seen.has(name)) { errors.push(`${path}.name: "${name}" is listed twice`); return; }
        seen.add(name);
        people.push({
          name,
          role: optionalString(entry.role, `${path}.role`, errors),
          language: optionalString(entry.language, `${path}.language`, errors),
          jira: optionalString(entry.jira, `${path}.jira`, errors),
        });
      });
    }
  }

  let evidenceHosts = [...DEFAULT_EVIDENCE_HOSTS];
  const hostsRaw = at(board, 'evidence.allowed_hosts');
  if (hostsRaw === undefined || hostsRaw === null) {
    derived.push({ key: 'board.evidence.allowed_hosts', value: evidenceHosts, from: 'shipped default' });
  }
  else {
    const hosts = stringList(hostsRaw, 'board.evidence.allowed_hosts', errors);
    if (hosts) {
      for (const host of hosts) {
        if (/[/:\s]/.test(host)) { errors.push(`board.evidence.allowed_hosts: "${host}" must be a bare host name (e.g. claude.ai), no scheme or path`); }
      }
      evidenceHosts = hosts;
    }
  }

  let brandName = optionalString(at(board, 'brand.name'), 'board.brand.name', errors);
  if (brandName === null) {
    brandName = optionalString(at(root, 'project.project_name'), 'project.project_name', errors);
    if (brandName !== null) { derived.push({ key: 'board.brand.name', value: brandName, from: 'project.project_name' }); }
  }
  const logo = optionalString(at(board, 'brand.logo'), 'board.brand.logo', errors);

  // --- read from their own homes, never stored in the block
  const environment = optionalString(at(root, 'testing.default_env'), 'testing.default_env', errors);
  const mainline = optionalString(at(root, 'git_strategy.branches.production'), 'git_strategy.branches.production', errors);
  const approvalsRaw = at(root, 'git_strategy.policy.require_pr_reviews');
  const requiredApprovals = typeof approvalsRaw === 'number' && Number.isInteger(approvalsRaw) && approvalsRaw >= 0 ? approvalsRaw : null;
  const jiraHost = normalizeAtlassianUrl(typeof at(root, 'issue_tracker.atlassian_url') === 'string' ? at(root, 'issue_tracker.atlassian_url') as string : null);
  derived.push(
    { key: 'environment', value: environment, from: 'testing.default_env' },
    { key: 'mainline', value: mainline, from: 'git_strategy.branches.production' },
    { key: 'requiredApprovals', value: requiredApprovals, from: 'git_strategy.policy.require_pr_reviews' },
    { key: 'jiraHost', value: jiraHost, from: 'issue_tracker.atlassian_url' },
  );
  if (source !== 'none' && jiraHost === null) { errors.push(`issue_tracker.atlassian_url: required for the ${source} source`); }

  if (errors.length > 0) { return { state: 'invalid', errors }; }

  return {
    state: 'ok',
    config: {
      source,
      configFile,
      ticketsFile,
      jql,
      ticketKeyPattern,
      projectKey,
      environment,
      mainline,
      requiredApprovals,
      jiraHost,
      timezone,
      statuses,
      statusMap: built.map,
      people,
      evidenceHosts,
      brand: { name: brandName, logo },
      catalogs,
    },
    derived,
    warnings,
  };
}

/** Read a JSON catalog; absent = `null`, unparseable = an error (a broken mirror never reads as an empty one). */
function readCatalog<T>(path: string, errors: string[]): T | null {
  if (!existsSync(path)) { return null; }
  try { return JSON.parse(readFileSync(path, 'utf8')) as T; }
  catch (err) {
    errors.push(`${path}: does not parse as JSON (${(err as Error).message})`);
    return null;
  }
}

/** Load `project.yaml` and the catalogs from a checkout, then resolve. */
export function loadBoardConfig(repoRoot: string = process.cwd()): BoardConfigResult {
  const yamlPath = join(repoRoot, PROJECT_YAML);
  if (!existsSync(yamlPath)) { return { state: 'invalid', errors: [`${PROJECT_YAML} not found under ${repoRoot}`] }; }
  let root: unknown;
  try { root = parseYaml(readFileSync(yamlPath, 'utf8')); }
  catch (err) { return { state: 'invalid', errors: [`${PROJECT_YAML}: does not parse (${(err as Error).message})`] }; }
  const errors: string[] = [];
  const catalogs: Catalogs = {
    workflows: readCatalog<WorkflowCatalog>(join(repoRoot, WORKFLOWS_CATALOG), errors),
    fields: readCatalog<FieldCatalog>(join(repoRoot, FIELDS_CATALOG), errors),
    linkTypes: readCatalog<LinkTypeCatalog>(join(repoRoot, LINK_TYPES_CATALOG), errors),
  };
  if (errors.length > 0) { return { state: 'invalid', errors }; }
  return resolveBoardConfig(root, catalogs);
}
