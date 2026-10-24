#!/usr/bin/env bun
/**
 * context-coverage.ts — the deterministic half of `project-context` mode
 * `coverage` (`.agents/skills/project-context/references/coverage.md`).
 *
 * `collect` reads the three business maps (behaviour seed), the KATA manifest
 * at the production branch and the TMS test repository into `collect.json`.
 * The agent then writes `judgments.json` (which test covers which behaviour,
 * and whether its assertions exercise it). `classify` buckets, orders by MTP
 * risk and diffs against the previous run. `propose` builds the coverage Tech
 * Story payloads as a DRY RUN: nothing here ever writes to a tracker.
 *
 * Files live in `<<PRIMARY_ROOT>>/.session/project-context/coverage/`, so a run
 * from a linked worktree lands where the next run finds it.
 *
 * USAGE
 *   bun run context:coverage collect  [--tms none] [--root <dir>] [--out-dir <dir>]
 *   bun run context:coverage classify [--root <dir>] [--out-dir <dir>]
 *   bun run context:coverage propose  --grain gap|module [--root <dir>] [--out-dir <dir>]
 *
 * EXIT CODES
 *   0  done
 *   1  bad arguments, invalid judgments, or an unreadable input
 *   2  no behaviour source: every business map is a placeholder (a stated note, never an empty list)
 */

import type { CollectResult, GapList, InventoryTest, Judgments, ManifestSource, MapKey, MapSource, SeedBehaviour, TmsSource } from '../cli/lib/behaviour-coverage/types.ts';
import type { WorkflowCatalog } from '../cli/lib/sprint-source/config.ts';
import type { Transport } from '../cli/lib/sprint-source/transport.ts';

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';

import { classify, JudgmentError } from '../cli/lib/behaviour-coverage/classify.ts';
import { proposeTechStories } from '../cli/lib/behaviour-coverage/propose.ts';
import { gapsCell, pendingNote, renderGapList } from '../cli/lib/behaviour-coverage/render.ts';
import { DEPRECATED_SLUG, designStatusSlugs, readTmsInventory } from '../cli/lib/behaviour-coverage/tms.ts';
import { BEHAVIOUR_MAPS, compareIds, SCHEMA_VERSION } from '../cli/lib/behaviour-coverage/types.ts';
import { contextMapStatuses } from '../cli/lib/context-maps.ts';
import { LINK_TYPES_CATALOG, modalityFromTmsCli, WORKFLOWS_CATALOG } from '../cli/lib/sprint-source/config.ts';
import { liveTransport } from '../cli/lib/sprint-source/transport.ts';
import { checkoutRoots } from '../cli/lib/worktree.ts';
import { parseMap } from './context-map.ts';

export const SESSION_DIR = '.session/project-context/coverage';
export const MTP_CACHE = '.context/PBI/qa-artifacts/master-test-plan.md';
export const MANIFEST = 'kata-manifest.json';
export const DISCOVERY_GAPS_SECTION = 'discovery-gaps';
export const NO_BEHAVIOUR_SOURCE = 'no behaviour source: every business map is a placeholder or missing. Run `project-context e2e` (and `data`, `api`), then collect again.';

export interface Io { out: (s: string) => void, err: (s: string) => void }
const STDIO: Io = { out: (s) => { process.stdout.write(s); }, err: (s) => { process.stderr.write(s); } };

export interface Deps {
  now?: () => Date
  /** Jira sources only; defaults to the live transport. */
  transport?: Transport
  /** `git` in the repo root; tests replace it. Returns null when the command fails. */
  git?: (root: string, args: string[]) => string | null
}

interface Args { command: string | null, root: string | null, outDir: string | null, tms: string | null, grain: string | null, help: boolean, unknown: string[] }

export function parseArgs(argv: string[]): Args {
  const args: Args = { command: null, root: null, outDir: null, tms: null, grain: null, help: false, unknown: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h' || a === 'help') { args.help = true; }
    else if (a === '--root' || a === '--out-dir' || a === '--tms' || a === '--grain') {
      const value = argv[++i] ?? '';
      if (a === '--root') { args.root = value; }
      else if (a === '--out-dir') { args.outDir = value; }
      else if (a === '--tms') { args.tms = value; }
      else { args.grain = value; }
    }
    else if (args.command === null && !a.startsWith('-')) { args.command = a; }
    else { args.unknown.push(a); }
  }
  return args;
}

const defaultGit = (root: string, args: string[]): string | null => {
  try { return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); }
  catch { return null; }
};

const sha = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 16);

function readJson<T>(path: string): T | null {
  if (!existsSync(path)) { return null; }
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * Where session files and the PBI cache live: the primary checkout when `root`
 * is a checkout's own root (a worktree's `.session/` dies with it), else `root`
 * itself (a fixture tree inside the repo).
 */
export function stateRoot(root: string): string {
  const roots = checkoutRoots(root);
  return roots && roots.repoRoot === realpathSync(root) ? roots.primaryRoot : root;
}

// ============================================================================
// collect
// ============================================================================

/** Every section of a generated map, plus its `BR-NNN` rule rows and `FEAT-NNN` features. */
export function seedFromMap(map: MapKey, html: string): { sections: string[], seed: SeedBehaviour[] } {
  const parsed = parseMap(html);
  const seed: SeedBehaviour[] = [];
  for (const s of parsed.sections) {
    // The map's own `discovery-gaps` section lists what was not verified: it is not a behaviour.
    if (s.id === DISCOVERY_GAPS_SECTION) { continue; }
    seed.push({ id: `${map}#${s.id}`, title: s.title, hash: sha(s.text) });
    // A feature block runs from its `#### Feature:` heading to the next heading; its hash covers the whole block.
    const blocks: Array<{ heading: string | null, lines: string[] }> = [{ heading: null, lines: [] }];
    for (const raw of s.text.split('\n')) {
      const line = raw.trim();
      const heading = /^#{3,6} (?:Feature: ?)?(\S.*)$/.exec(line);
      if (heading) { blocks.push({ heading: heading[1].trim(), lines: [line] }); }
      else { blocks[blocks.length - 1].lines.push(line); }
    }
    for (const block of blocks) {
      for (const line of block.lines) {
        const cells = line.startsWith('|') ? line.replace(/^\||\|$/g, '').split(' | ').map(c => c.trim()) : [];
        if (/^BR-\d+$/.test(cells[0] ?? '')) {
          seed.push({ id: `${map}#${s.id}/${cells[0]}`, title: cells[2] || cells[0], hash: sha(line) });
        }
        else if (cells[0]?.replace(/\*/g, '') === 'ID' && /^FEAT-\d+$/.test(cells[1] ?? '')) {
          seed.push({ id: `${map}#${s.id}/${cells[1]}`, title: block.heading ?? cells[1], hash: sha(block.lines.join('\n')) });
        }
      }
    }
  }
  const unique = new Map(seed.map(b => [b.id, b]));
  return { sections: parsed.sections.map(s => s.id).sort(compareIds), seed: [...unique.values()].sort((a, b) => compareIds(a.id, b.id)) };
}

interface ManifestFile { components?: Record<string, Array<{ relativePath?: string, atcs?: Array<{ id?: string, method?: string, line?: number }> }>> }

/**
 * The manifest at the production branch (doctrine §6), else the working tree's
 * copy with a warning. The branch is read only when `root` is a checkout's own
 * root: `git show <branch>:<path>` resolves from the repository root, so a
 * `--root` inside a repository would read that repository's manifest instead.
 */
export function readManifest(root: string, production: string | null, git: NonNullable<Deps['git']>): { source: ManifestSource, atcs: Map<string, { file: string, line: number, method: string }> } {
  let text: string | null = null;
  let ref: string | null = null;
  let warning: string | null = null;
  const top = git(root, ['rev-parse', '--show-toplevel'])?.trim() ?? '';
  const isCheckoutRoot = top !== '' && existsSync(top) && realpathSync(top) === realpathSync(root);
  for (const branch of production && isCheckoutRoot ? [`origin/${production}`, production] : []) {
    const commit = git(root, ['rev-parse', '--verify', '--quiet', `${branch}^{commit}`])?.trim();
    if (!commit) { continue; }
    const shown = git(root, ['show', `${branch}:${MANIFEST}`]);
    if (shown !== null) { text = shown; ref = `${branch}@${commit.slice(0, 12)}`; break; }
  }
  if (text === null && existsSync(join(root, MANIFEST))) {
    text = readFileSync(join(root, MANIFEST), 'utf8');
    ref = 'working-tree';
    warning = production
      ? `read from the working tree, not \`${production}\`: an ATC that is not merged yet reads as automated (discovery-driven doctrine §6)`
      : 'git_strategy.branches.production is not set: read from the working tree';
  }
  const atcs = new Map<string, { file: string, line: number, method: string }>();
  if (text === null) { return { source: { state: 'missing', ref: null, production, warning: null }, atcs }; }
  const manifest = JSON.parse(text) as ManifestFile;
  for (const list of Object.values(manifest.components ?? {})) {
    for (const component of list) {
      for (const atc of component.atcs ?? []) {
        if (atc.id) { atcs.set(atc.id, { file: component.relativePath ?? '', line: atc.line ?? 0, method: atc.method ?? '' }); }
      }
    }
  }
  return { source: { state: 'read', ref, production, warning }, atcs };
}

interface ProjectYaml {
  project?: { project_key?: string | null }
  testing?: { tms_cli?: string | null }
  git_strategy?: { branches?: { production?: string | null } }
  qa?: { qa_epics?: { test_repository_epic?: { key?: string | null } } }
}

function readProjectYaml(root: string): ProjectYaml {
  const path = join(root, '.agents', 'project.yaml');
  return existsSync(path) ? (parseYaml(readFileSync(path, 'utf8')) as ProjectYaml) ?? {} : {};
}

/**
 * What changes when the test changes. An ATC: its `file:line:method`, the same
 * with or without the TMS. A manual Test: the TMS `updated` stamp, which also
 * moves on a comment or a new link, so expect some stale noise there, never a
 * wrong bucket.
 */
function fingerprint(atc: { file: string, line: number, method: string } | null, updated: string | null): string {
  return sha(atc ? `atc:${atc.file}:${atc.line}:${atc.method}` : `tms:${updated ?? ''}`);
}

export async function collect(root: string, opts: { tms: string | null }, deps: Deps = {}): Promise<CollectResult> {
  const now = deps.now?.() ?? new Date();
  const git = deps.git ?? defaultGit;
  const project = readProjectYaml(root);
  const base = stateRoot(root);
  const warnings: string[] = [];

  // --- behaviours: the three business maps
  const maps: MapSource[] = [];
  const seed: SeedBehaviour[] = [];
  const statuses = contextMapStatuses(root);
  for (const [key, slug] of Object.entries(BEHAVIOUR_MAPS) as Array<[MapKey, string]>) {
    const status = statuses.find(s => s.skill.slug === slug);
    const state = status?.state ?? 'no-skill';
    if (state !== 'generated' || !status) { maps.push({ map: key, skill: slug, state, sections: [] }); continue; }
    const html = readFileSync(join(root, '.agents', 'skills', slug, 'references', status.skill.map), 'utf8');
    const read = seedFromMap(key, html);
    maps.push({ map: key, skill: slug, state, sections: read.sections });
    seed.push(...read.seed);
  }

  // --- tests: the manifest at production, then the TMS (skipped when there is nothing to cross it with)
  const manifest = readManifest(root, project.git_strategy?.branches?.production ?? null, git);
  const projectKey = project.project?.project_key ?? null;
  const modality = opts.tms === 'none' ? 'none' : modalityFromTmsCli(project.testing?.tms_cli);
  const workflows = readJson<WorkflowCatalog>(join(root, WORKFLOWS_CATALOG));
  const design = designStatusSlugs(workflows);
  let tms: TmsSource = { modality, state: 'unavailable', reason: null };
  let tmsTests: Awaited<ReturnType<typeof readTmsInventory>> | null = null;
  if (modality === 'none') { tms.reason = '--tms none: manifest only'; }
  else if (!maps.some(m => m.state === 'generated')) { tms.reason = 'not read: no business map is generated, so there is nothing to cross the tests with'; }
  else if (!projectKey) { tms.reason = 'project.project_key is not set in .agents/project.yaml'; }
  else {
    try {
      const linkTypes = readJson<Record<string, { name?: string }>>(join(root, LINK_TYPES_CATALOG));
      tmsTests = await readTmsInventory({ transport: deps.transport ?? liveTransport(), projectKey, modality, workflows, testLink: linkTypes?.test?.name ?? null });
      tms = { modality, state: 'read', reason: null };
      warnings.push(...tmsTests.warnings);
    }
    catch (err) { tms.reason = (err as Error).message; }
  }

  const byKey = new Map<string, InventoryTest>();
  for (const t of tmsTests?.tests ?? []) {
    const atc = manifest.atcs.get(t.key) ?? null;
    byKey.set(t.key, {
      key: t.key,
      title: t.title,
      kind: atc ? 'automated' : 'manual',
      in_manifest: atc !== null,
      in_tms: true,
      status: t.status,
      deprecated: t.status === DEPRECATED_SLUG,
      in_design: t.status !== null && design.has(t.status),
      in_regression: t.in_regression,
      components: t.components,
      coverables: t.coverables,
      atc,
      fingerprint: fingerprint(atc, t.updated),
    });
    if (!atc && t.status === 'automated') { warnings.push(`${t.key}: TMS status is automated but no ATC with this id is in the manifest${manifest.source.ref ? ` at ${manifest.source.ref}` : ''}: counted as manual`); }
  }
  for (const [id, atc] of manifest.atcs) {
    if (byKey.has(id)) { continue; }
    if (tms.state === 'read') { warnings.push(`ATC ${id} (${atc.file}) has no Test in the TMS`); }
    byKey.set(id, {
      key: id,
      title: atc.method,
      kind: 'automated',
      in_manifest: true,
      in_tms: false,
      status: null,
      deprecated: false,
      in_design: false,
      in_regression: null,
      components: [],
      coverables: [],
      atc,
      fingerprint: fingerprint(atc, null),
    });
  }

  return {
    schema_version: SCHEMA_VERSION,
    collected_at: now.toISOString(),
    sources: {
      maps,
      tms,
      manifest: manifest.source,
      mtp: { state: existsSync(join(base, MTP_CACHE)) ? 'present' : 'missing', path: MTP_CACHE },
    },
    seed: seed.sort((a, b) => compareIds(a.id, b.id)),
    tests: [...byKey.values()].sort((a, b) => compareIds(a.key, b.key)),
    anchors: tmsTests?.anchors ?? [],
    warnings,
  };
}

const hasBehaviourSource = (c: CollectResult): boolean => c.sources.maps.some(m => m.state === 'generated');

// ============================================================================
// classify + propose
// ============================================================================

/** The most recent run file, by its sortable id. */
function previousRun(outDir: string): GapList | null {
  const dir = join(outDir, 'runs');
  if (!existsSync(dir)) { return null; }
  const last = readdirSync(dir).filter(f => f.endsWith('.json')).sort(compareIds).pop();
  return last ? readJson<GapList>(join(dir, last)) : null;
}

function techStoryTypeName(root: string): string {
  return readJson<WorkflowCatalog>(join(root, WORKFLOWS_CATALOG))?.tech_story?.jira_issue_type?.name ?? 'Tech Story';
}

// ============================================================================
// CLI
// ============================================================================

const USAGE = 'usage: bun run context:coverage <collect [--tms none] | classify | propose --grain gap|module> [--root <dir>] [--out-dir <dir>]\n';

export async function run(argv: string[], cwd: string, io: Io = STDIO, deps: Deps = {}): Promise<number> {
  const args = parseArgs(argv);
  if (args.help || args.command === null) { io.out(USAGE); return args.help ? 0 : 1; }
  const bad = [...args.unknown];
  if (!['collect', 'classify', 'propose'].includes(args.command)) { bad.push(`unknown command \`${args.command}\``); }
  if (args.tms !== null && args.tms !== 'none') { bad.push('--tms only takes `none`'); }
  if (args.command === 'propose' && args.grain !== 'gap' && args.grain !== 'module') { bad.push('propose needs --grain gap or --grain module (the person picks it when approving the gap list)'); }
  if (bad.length > 0) { io.err(`context:coverage: bad arguments: ${bad.join('; ')}\n${USAGE}`); return 1; }

  const root = resolve(cwd, args.root ?? '.');
  const outDir = args.outDir ? resolve(cwd, args.outDir) : join(stateRoot(root), SESSION_DIR);
  mkdirSync(outDir, { recursive: true });

  if (args.command === 'collect') {
    const result = await collect(root, { tms: args.tms }, deps);
    writeJson(join(outDir, 'collect.json'), result);
    const s = result.sources;
    io.out([
      `collect -> ${join(outDir, 'collect.json')}`,
      ...s.maps.map(m => `  map ${m.skill}: ${m.state}`),
      `  TMS (${s.tms.modality}): ${s.tms.state}${s.tms.reason ? `: ${s.tms.reason}` : ''}`,
      `  manifest: ${s.manifest.state}${s.manifest.ref ? ` at ${s.manifest.ref}` : ''}${s.manifest.warning ? ` (warning: ${s.manifest.warning})` : ''}`,
      `  MTP cache: ${s.mtp.state}`,
      `  seed: ${result.seed.length} candidate behaviours · tests: ${result.tests.length} · coverage Tech Stories: ${result.anchors.length} · warnings: ${result.warnings.length}`,
      '',
    ].join('\n'));
    if (!hasBehaviourSource(result)) { io.err(`context:coverage: ${NO_BEHAVIOUR_SOURCE}\n`); return 2; }
    return 0;
  }

  const collected = readJson<CollectResult>(join(outDir, 'collect.json'));
  if (!collected) { io.err(`context:coverage: no collect.json in ${outDir}: run \`bun run context:coverage collect\` first\n`); return 1; }
  if (!hasBehaviourSource(collected)) { io.err(`context:coverage: ${NO_BEHAVIOUR_SOURCE}\n`); return 2; }

  if (args.command === 'classify') {
    const judgments = readJson<Judgments>(join(outDir, 'judgments.json'));
    if (!judgments) { io.err(`context:coverage: no judgments.json in ${outDir}: the agent writes it from collect.json (schema: project-context/references/coverage.md)\n`); return 1; }
    const mtpPath = join(stateRoot(root), collected.sources.mtp.path);
    let list: GapList;
    try {
      list = classify({ collect: collected, judgments, mtpText: existsSync(mtpPath) ? readFileSync(mtpPath, 'utf8') : null, previous: previousRun(outDir), now: deps.now?.() ?? new Date() });
    }
    catch (err) {
      if (err instanceof JudgmentError) { io.err(`context:coverage: ${err.message}\n`); return 1; }
      throw err;
    }
    mkdirSync(join(outDir, 'runs'), { recursive: true });
    writeJson(join(outDir, 'gap-list.json'), list);
    writeJson(join(outDir, 'runs', `${list.run_id}.json`), list);
    writeFileSync(join(outDir, 'gap-list.md'), renderGapList(list));
    const b = list.denominators.buckets;
    io.out(`classify -> ${join(outDir, 'gap-list.md')}\n  ${list.denominators.behaviours} behaviours: automated ${b.automated} · manual-only ${b['manual-only']} · weak ${b.weak} · uncovered ${b.uncovered} · gaps ${gapsCell(list)}${list.diff.previous_run ? ` · vs ${list.diff.previous_run}: ${list.diff.closed.length} closed, ${list.diff.regressed.length} regressed` : ''}\n`);
    return 0;
  }

  // propose
  const list = readJson<GapList>(join(outDir, 'gap-list.json'));
  if (!list) { io.err(`context:coverage: no gap-list.json in ${outDir}: run classify first\n`); return 1; }
  const project = readProjectYaml(root);
  const result = proposeTechStories(list, {
    grain: args.grain as 'gap' | 'module',
    projectKey: project.project?.project_key ?? null,
    parentKey: project.qa?.qa_epics?.test_repository_epic?.key ?? null,
    techStoryType: techStoryTypeName(root),
    anchors: collected.anchors,
  });
  const dir = join(outDir, 'proposals');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  result.proposals.forEach((p, i) => {
    const name = `${String(i + 1).padStart(2, '0')}-${p.id.replace(/[^\w-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').toLowerCase()}`;
    writeJson(join(dir, `${name}.json`), p);
    writeFileSync(join(dir, `${name}.md`), p.description_md);
  });
  const pending = pendingNote(list);
  io.out(`${[
    `propose (DRY RUN, nothing was created) -> ${dir}`,
    list.denominators.gaps_upper_bound ? '  the TMS was not read: these gaps are an upper bound, manual coverage was not verified' : '',
    pending ? `  ${pending.replace(/\*/g, '')}` : '',
    ...result.proposals.map(p => `  ${p.summary}  [${p.gap_ids.length} gap(s), parent ${p.payload.parentIssueId ?? 'UNRESOLVED'}, component ${p.module}]`),
    ...result.skipped.map(s => `  skipped ${s.id}: already anchored by ${s.tech_story}`),
    result.proposals.some(p => p.payload.parentIssueId === null) ? '  parent unresolved: qa.qa_epics.test_repository_epic.key is not set (resolve or create the QA Test Repository epic first)' : '',
    '',
  ].filter(line => line !== '').join('\n')}\n`);
  return 0;
}

if (import.meta.main) {
  process.exit(await run(process.argv.slice(2), process.cwd()));
}
