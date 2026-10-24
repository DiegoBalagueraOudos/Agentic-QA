#!/usr/bin/env bun
/**
 * evidence-page CLI — build, extract, record and demo the evidence page (ADR-0021, ADR-0022).
 *
 *   bun run evidence build   --pack <pack.json> [--pack <pack2.json>] [--out <index.html>] [--thumb <png>] [--case <id>]
 *                            [--repo <root>] [--bug-pack <BUG>=<pack.json>] [--max-mb N] [--host claude-artifact|local] [--json]
 *   bun run evidence extract --page <page.html> --out <pack.json>
 *   bun run evidence record  --pack <pack.json> --url <url>
 *   bun run evidence attach  --pack <bug pack.json> | --key <BUG> --png <png>  [--run <id> | --test <TC> --exec <EXEC>]
 *                            [--replace] [--source jira-xray|jira-native|none] [--dry-run] [--json]
 *   bun run evidence link    --pack <pack.json> | --key <KEY> --url <url>  [--run <id> [--case <id>] | --test <TC> --exec <EXEC>]
 *                            [--source ...] [--dry-run] [--json]
 *   bun run evidence demo    [--out <dir>]
 *
 * CONTRACT
 * --------
 *   - The builder is the `evidence-artifact` skill's `scripts/build.py` (Python 3.9+
 *     and Pillow). Every command that needs it checks both first and, when one is
 *     missing, exits 1 with ONE line naming what to install.
 *   - `build` validates the pack, refuses secrets, burns redactions and writes ONE
 *     page (or, with --thumb, the bug's thumbnail) and prints the host step: for the
 *     default `claude-artifact` host, the exact Artifact tool call the agent makes
 *     (the CLI cannot publish: that is a harness tool); for `local`, the page path
 *     the report links. It never publishes anything.
 *   - `record` stores the URL the Artifact tool returned on the pack; only a host in
 *     `board.evidence.allowed_hosts` is accepted, and a second URL for an already
 *     published pack is refused.
 *   - `attach` embeds a bug's ONE thumbnail at the end of its tracker Description
 *     (a comment when the Description cannot be edited) and `link` adds the page as
 *     a remote link (`cli/lib/evidence-page/tracker.ts`); on jira-xray a named Test
 *     Run also gets the PNG as evidence / the TC deep link in its comment; `none`
 *     writes nothing. Every write is read back before the command says done.
 *     An earlier thumbnail of the bug (same name, other bytes, so possibly
 *     unredacted) is never appended beside the new one: `attach` refuses, and
 *     `--replace` (after a person confirms) removes its image and attachment first.
 *     `--dry-run` prints every call of a first run, sends nothing and never prints a
 *     read-back as done (`--json`: `dryRun: true, sent: false`).
 *   - The ticket key pattern and the allowed hosts come from the `board:` block when
 *     it is configured, else the generic key shape and the shipped hosts. The tracker
 *     modality is `--source`, else `board.source`, else `testing.tms_cli`.
 *   - Exit codes: 0 done, 1 invalid pack / refused secret / size / URL / missing Python /
 *     tracker error or read-back mismatch, 2 usage.
 */

import type { EvidenceHost } from '../lib/evidence-page/hosts.ts';
import type { Pack } from '../lib/evidence-page/pack.ts';
import type { DryRunSeed, EvidenceTracker, RunRef, TrackerResult } from '../lib/evidence-page/tracker.ts';
import type { SourceKind } from '../lib/sprint-source/index.ts';

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { parse as parseYaml } from 'yaml';

import { DEMO_OUT, writeDemo } from '../lib/evidence-page/demo.ts';
import { describePage, EVIDENCE_HOSTS, evidenceUrlError, publishEvidence, recordPublication } from '../lib/evidence-page/hosts.ts';
import { GENERIC_TICKET_KEY } from '../lib/evidence-page/pack.ts';
import { buildError, buildWarnings, pythonPreflight, runBuildPy } from '../lib/evidence-page/python.ts';
import { createEvidenceTracker, dryRunIO, liveTrackerIO, loadMediaHelpers, xrayDocs } from '../lib/evidence-page/tracker.ts';
import { DEFAULT_EVIDENCE_HOSTS, loadBoardConfig, modalityFromTmsCli, SOURCE_KINDS } from '../lib/sprint-source/index.ts';
import { checkoutRoots } from '../lib/worktree.ts';
import { MUTATIONS, QUERIES } from '../xray/lib/graphql.ts';

const USAGE = `Usage: bun run evidence <command> [options]

  build    --pack <pack.json>   validate the pack and build its page (repeat --pack for one review page)
           [--out <index.html>] default: <pack dir>/evidence-artifact/index.html (a bug: .../evidence-artifact/<BUG>/index.html)
           [--thumb <png>]      bug pack: write its tracker thumbnail instead of the page
           [--case <id>]        with --thumb: the case to take the screenshot from
           [--repo <root>]      relative image paths resolve against it (default: the primary checkout, also from a worktree)
           [--bug-pack B=<pack>] the bug's own pack, to check a story's RETEST pill (default: beside the story pack, else the bug's PBI folder)
           [--max-mb N]         page size limit, default 14, at most 16
           [--host H]           claude-artifact (default) | local
           [--json]             one machine-readable line on stdout
  extract  --page <page.html> --out <pack.json>
                                recover the pack(s) embedded in a built or published page
  record   --pack <pack.json> --url <url>
                                store the URL the Artifact tool returned
  attach   --pack <bug pack.json> | --key <BUG> --png <png>
                                embed the bug's thumbnail in its tracker Description, read back
           [--run <id> | --test <TC> --exec <EXEC>]  jira-xray: also the Test Run's evidence
           [--replace]          an earlier thumbnail of this bug (same name, other bytes) is removed first;
                                a person confirms before: deleting a tracker attachment cannot be undone
  link     --pack <pack.json> | --key <KEY> --url <url>
                                link the published page from the issue (remote link), read back
           [--run <id> [--case <id>] | --test <TC> --exec <EXEC>]  jira-xray: the TC deep link in the run comment
           (attach, link) [--source jira-xray|jira-native|none] [--dry-run] print the calls, send nothing
  demo     [--out <dir>]        build synthetic story, bug and review pages (default ${DEMO_OUT})

build, extract, record and demo need Python 3.9+ and Pillow (python3 -m pip install pillow).`;

interface ProjectEvidenceConfig {
  ticketKeyPattern: RegExp
  allowedHosts: readonly string[]
  /** The tracker `attach` / `link` write to: `board.source`, else `testing.tms_cli`. */
  source: SourceKind
  note: string | null
}

/** `testing.tms_cli` read straight from the yaml: the board block may be unconfigured. */
function tmsModality(): SourceKind {
  try {
    const root = parseYaml(readFileSync(join(process.cwd(), '.agents', 'project.yaml'), 'utf8')) as { testing?: { tms_cli?: unknown } } | null;
    return modalityFromTmsCli(root?.testing?.tms_cli);
  }
  catch {
    return modalityFromTmsCli(undefined);
  }
}

function projectConfig(): ProjectEvidenceConfig {
  const result = loadBoardConfig(process.cwd());
  if (result.state === 'ok') {
    return { ticketKeyPattern: result.config.ticketKeyPattern, allowedHosts: result.config.evidenceHosts, source: result.config.source, note: null };
  }
  const note = result.state === 'invalid'
    ? `the board: block is invalid (run bun run board:check); using the generic key shape and ${DEFAULT_EVIDENCE_HOSTS.join(', ')}`
    : null;
  return { ticketKeyPattern: GENERIC_TICKET_KEY, allowedHosts: DEFAULT_EVIDENCE_HOSTS, source: tmsModality(), note };
}

function usage(message: string): never {
  console.error(`${message}\n\n${USAGE}`);
  process.exit(2);
}

function display(path: string): string {
  const rel = relative(process.cwd(), path);
  return rel.startsWith('..') ? path : rel;
}

/**
 * Relative image paths resolve against the PRIMARY checkout: a fleet worker runs in a worktree, the evidence lives in
 * the primary's `.context/PBI/` (`checkoutRoots`, `.agents/README.md` "Checkout roots"). build.py also accepts an
 * absolute path inside the worktree it runs from.
 */
function defaultRepo(): string {
  return checkoutRoots()?.primaryRoot ?? process.cwd();
}

/** The pack as JSON, unvalidated: build.py validates. `null` when it cannot be read. */
function readPack(packPath: string): Pack | null {
  try {
    const raw = JSON.parse(readFileSync(packPath, 'utf8'));
    return typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? raw as Pack : null;
  }
  catch {
    return null;
  }
}

/** `<pack dir>/evidence-artifact/index.html`; a bug pack: `<pack dir>/evidence-artifact/<BUG>/index.html`. */
export function defaultPagePath(packPath: string, pack: Pick<Pack, 'kind' | 'ticket'>): string {
  const base = join(dirname(resolve(packPath)), 'evidence-artifact');
  return pack.kind === 'bug' ? join(base, pack.ticket.id, 'index.html') : join(base, 'index.html');
}

// A demo pack carries synthetic DEMO- keys: build and record it with the shape `demo` built it with
function keyPatternFor(packPath: string | undefined, projectPattern: RegExp): RegExp {
  return packPath !== undefined && resolve(packPath).startsWith(resolve(DEMO_OUT) + sep) ? GENERIC_TICKET_KEY : projectPattern;
}

function preflightOrExit(json: boolean): void {
  const missing = pythonPreflight();
  if (missing !== null) {
    if (json) {
      console.log(JSON.stringify({ ok: false, errors: [missing], warnings: [] }));
    }
    else {
      console.error(`✗ ${missing}`);
    }
    process.exit(1);
  }
}

function fail(json: boolean, label: string, error: string, warnings: string[]): number {
  if (json) {
    console.log(JSON.stringify({ ok: false, errors: [error], warnings }));
  }
  else {
    console.error(`✗ ${label}: not built`);
    console.error(`  ✗ ${error}`);
    warnings.forEach(w => console.error(`  ⚠ ${w}`));
  }
  return 1;
}

function runBuild(values: Record<string, string | string[] | boolean | undefined>, config: ProjectEvidenceConfig, json: boolean): number {
  const packPaths = (values.pack as string[] | undefined) ?? [];
  if (packPaths.length === 0) {
    usage('build needs --pack <pack.json>');
  }
  const host = (values.host as string | undefined) ?? 'claude-artifact';
  if (!(EVIDENCE_HOSTS as readonly string[]).includes(host)) {
    usage(`--host must be one of ${EVIDENCE_HOSTS.join(' | ')}`);
  }
  if (values['max-mb'] !== undefined && !Number.isFinite(Number(values['max-mb']))) {
    usage('--max-mb must be a number');
  }
  const thumb = values.thumb as string | undefined;
  if (thumb !== undefined && packPaths.length !== 1) {
    usage('--thumb takes exactly one --pack');
  }
  if (packPaths.length > 1 && values.out === undefined) {
    usage('several packs build ONE review page: give --out <index.html>');
  }
  preflightOrExit(json);

  const first = readPack(packPaths[0]);
  if (first === null) {
    return fail(json, display(packPaths[0]), `${packPaths[0]}: cannot read the pack (not one JSON object)`, []);
  }
  const keyPattern = keyPatternFor(packPaths[0], config.ticketKeyPattern);
  const common = [
    '--key-pattern',
    keyPattern.source,
    '--repo',
    (values.repo as string | undefined) ?? defaultRepo(),
    ...((values['bug-pack'] as string[] | undefined) ?? []).flatMap(b => ['--bug-pack', b]),
  ];

  if (thumb !== undefined) {
    const result = runBuildPy(['--pack', packPaths[0], '--thumb', thumb, ...(values.case === undefined ? [] : ['--case', values.case as string]), ...common]);
    if (result.code !== 0) {
      return fail(json, display(packPaths[0]), buildError(result), buildWarnings(result));
    }
    if (json) {
      console.log(JSON.stringify({ ok: true, thumbnail: resolve(thumb), warnings: buildWarnings(result) }));
    }
    else {
      console.log(`✓ thumbnail: ${result.stdout.trim()}`);
      buildWarnings(result).forEach(w => console.log(`  ⚠ ${w}`));
    }
    return 0;
  }

  const out = resolve((values.out as string | undefined) ?? defaultPagePath(packPaths[0], first));
  const args = [...packPaths.flatMap(p => ['--pack', p]), '--out', out, ...common];
  if (values['max-mb'] !== undefined) {
    args.push('--max-mb', String(values['max-mb']));
  }
  if (host === 'local') {
    args.push('--standalone');
  }
  const result = runBuildPy(args);
  const warnings = buildWarnings(result);
  if (result.code !== 0) {
    return fail(json, display(packPaths[0]), buildError(result), warnings);
  }

  const description = describePage(first);
  const publish = packPaths.length === 1
    ? publishEvidence(out, first.artifact?.url, host as EvidenceHost, { packPath: display(packPaths[0]), kind: first.kind, description })
    : publishEvidence(out, undefined, host as EvidenceHost, { packPath: display(packPaths[0]), kind: 'story' });
  if (json) {
    console.log(JSON.stringify({ ok: true, page: out, line: result.stdout.trim(), warnings, ref: publish.ref, agentStep: publish.agentStep ?? null }));
    return 0;
  }
  console.log(`✓ page: ${display(result.stdout.trim())}`);
  warnings.forEach(w => console.log(`  ⚠ ${w}`));
  if (publish.agentStep === undefined) {
    console.log(`→ local host: link ${publish.ref.location} in the report`);
  }
  else if (packPaths.length > 1) {
    console.log('→ a review page of several packs is for reading locally; publish each pack\'s own page');
  }
  else {
    console.log('→ agent step (the CLI does not publish):');
    publish.agentStep.instructions.forEach(line => console.log(`  - ${line}`));
  }
  return 0;
}

function runExtract(values: Record<string, string | string[] | boolean | undefined>): number {
  const page = values.page as string | undefined;
  const out = values.out as string | undefined;
  if (page === undefined || out === undefined) {
    usage('extract needs --page <page.html> and --out <pack.json>');
  }
  preflightOrExit(false);
  const result = runBuildPy(['--extract', page, '--out', out]);
  if (result.code !== 0) {
    console.error(`✗ ${buildError(result)}`);
    return 1;
  }
  console.log(`✓ ${result.stdout.trim()}`);
  return 0;
}

function runRecord(values: Record<string, string | string[] | boolean | undefined>, config: ProjectEvidenceConfig): number {
  const packPath = (values.pack as string[] | undefined)?.[0];
  const url = values.url as string | undefined;
  if (packPath === undefined || url === undefined) {
    usage('record needs --pack <pack.json> and --url <url>');
  }
  preflightOrExit(false);
  const pack = readPack(packPath);
  if (pack === null) {
    console.error(`✗ ${packPath}: cannot read the pack (not one JSON object)`);
    return 1;
  }
  const check = runBuildPy(['--check', '--pack', packPath, '--key-pattern', keyPatternFor(packPath, config.ticketKeyPattern).source]);
  if (check.code !== 0) {
    console.error(`✗ ${display(packPath)}: invalid pack`);
    console.error(`  ✗ ${buildError(check)}`);
    return 1;
  }
  const recorded = recordPublication(pack, url, { allowedHosts: config.allowedHosts, pagePath: display(defaultPagePath(packPath, pack)) });
  if (!recorded.ok) {
    console.error(`✗ ${recorded.error}`);
    return 1;
  }
  writeFileSync(packPath, `${JSON.stringify(recorded.pack satisfies Pack, null, 2)}\n`);
  console.log(`✓ recorded ${url} on ${display(packPath)}; the next build republishes to it`);
  return 0;
}

// ---------------------------------------------------------------------------
// attach / link: the tracker side (cli/lib/evidence-page/tracker.ts)
// ---------------------------------------------------------------------------

/** The bug's tracker thumbnail, where `build --thumb` writes it by default. */
export function defaultThumbPath(packPath: string, pack: Pick<Pack, 'kind' | 'ticket'>): string {
  return join(dirname(defaultPagePath(packPath, pack)), `${pack.ticket.id}-thumbnail.png`);
}

interface TrackerTarget { key: string, pack: Pack | null, packPath?: string }

function trackerTarget(values: Record<string, string | string[] | boolean | undefined>, command: string): TrackerTarget {
  const packPaths = (values.pack as string[] | undefined) ?? [];
  if (packPaths.length > 1) {
    usage(`${command} takes one --pack`);
  }
  const key = values.key as string | undefined;
  if (packPaths.length === 1) {
    const pack = readPack(packPaths[0]);
    if (pack === null || typeof pack.ticket?.id !== 'string') {
      usage(`${packPaths[0]}: cannot read the pack's ticket.id`);
    }
    if (key !== undefined && key !== pack.ticket.id) {
      usage(`--key ${key} is not the pack's ticket ${pack.ticket.id}`);
    }
    return { key: pack.ticket.id, pack, packPath: packPaths[0] };
  }
  if (key === undefined) {
    usage(`${command} needs --pack <pack.json> or --key <KEY>`);
  }
  return { key, pack: null };
}

function runRef(values: Record<string, string | string[] | boolean | undefined>, source: SourceKind): RunRef | undefined {
  const run = values.run as string | undefined;
  const test = values.test as string | undefined;
  const exec = values.exec as string | undefined;
  if (run === undefined && test === undefined && exec === undefined) {
    return undefined;
  }
  if (source !== 'jira-xray') {
    usage(`--run / --test / --exec name an Xray Test Run; the ${source} source has none`);
  }
  if (run !== undefined) {
    if (test !== undefined || exec !== undefined) {
      usage('give --run <id> OR --test <TC> --exec <EXEC>, not both');
    }
    return { runId: run };
  }
  if (test === undefined || exec === undefined) {
    usage('--test and --exec go together');
  }
  return { test, execution: exec };
}

function trackerSource(values: Record<string, string | string[] | boolean | undefined>, config: ProjectEvidenceConfig): SourceKind {
  const flag = values.source as string | undefined;
  if (flag === undefined) {
    return config.source;
  }
  if (!(SOURCE_KINDS as readonly string[]).includes(flag)) {
    usage(`--source must be one of ${SOURCE_KINDS.join(' | ')}`);
  }
  return flag as SourceKind;
}

interface TrackerRun { operation: 'attach' | 'link', source: SourceKind, dryRun: boolean, run: RunRef | undefined, seed?: DryRunSeed }

/** The tracker for one command; a missing credential is a result (exit 1, one line or one JSON line), never an unhandled throw. */
async function tracker(spec: TrackerRun): Promise<{ tracker: EvidenceTracker, calls: string[] | null } | { error: string }> {
  if (spec.dryRun || spec.source === 'none') {
    const io = dryRunIO(spec.run, spec.seed);
    return { tracker: createEvidenceTracker(spec.source, io, xrayDocs(QUERIES, MUTATIONS), loadMediaHelpers, { dryRun: spec.dryRun }), calls: io.calls };
  }
  try {
    const live = await liveTrackerIO(spec.operation);
    return { tracker: createEvidenceTracker(spec.source, live.io, live.docs, loadMediaHelpers), calls: null };
  }
  catch (err) {
    return { error: (err as Error).message };
  }
}

function report(result: TrackerResult, json: boolean, dryRun: boolean, calls: string[] | null, done: string[]): number {
  if (json) {
    // A dry run is never reported as a real write: `dryRun` and `sent: false` travel with `ok`
    console.log(JSON.stringify({ ok: result.ok, dryRun, sent: !dryRun, lines: result.lines, ...(result.error === undefined ? {} : { error: result.error }), ...(dryRun && calls !== null ? { calls } : {}), ...(result.ok && !dryRun ? { next: done } : {}) }));
    return result.ok ? 0 : 1;
  }
  if (dryRun && calls !== null) {
    console.log('DRY RUN: nothing sent, nothing read back. The calls of a first run (a live run reads first and may skip some):');
    calls.forEach((call, i) => console.log(`  ${i + 1}. ${call}`));
  }
  result.lines.forEach(line => console.log(`${result.ok || line !== result.lines.at(-1) ? '✓' : '·'} ${line}`));
  if (!result.ok) {
    console.error(`✗ ${result.error}`);
    return 1;
  }
  if (!dryRun) {
    done.forEach(line => console.log(`→ ${line}`));
  }
  return 0;
}

async function runAttach(values: Record<string, string | string[] | boolean | undefined>, config: ProjectEvidenceConfig, json: boolean): Promise<number> {
  const target = trackerTarget(values, 'attach');
  const png = (values.png as string | undefined) ?? (target.pack !== null && target.packPath !== undefined ? defaultThumbPath(target.packPath, target.pack) : undefined);
  if (png === undefined) {
    usage('attach needs --png <png> with --key (or a --pack, whose thumbnail path build --thumb writes)');
  }
  if (target.pack !== null && target.pack.kind !== 'bug') {
    usage(`attach takes a bug's pack: ${target.key} is a ${target.pack.kind} pack (its page is linked with link)`);
  }
  if (!keyPatternFor(target.packPath, config.ticketKeyPattern).test(target.key)) {
    usage(`${target.key} does not match the ticket key pattern ${config.ticketKeyPattern.source}`);
  }
  if (!existsSync(png)) {
    console.error(`✗ ${png}: no thumbnail yet; build it with bun run evidence build --pack <bug pack> --thumb ${png}`);
    return 1;
  }
  const source = trackerSource(values, config);
  const run = runRef(values, source);
  const dryRun = values['dry-run'] === true;
  const replace = values.replace === true;
  const made = await tracker({ operation: 'attach', source, dryRun, run, seed: replace ? { earlier: { bugKey: target.key, filename: basename(png) } } : undefined });
  if ('error' in made) {
    return report({ ok: false, lines: [], error: made.error }, json, dryRun, null, []);
  }
  const { tracker: t, calls } = made;
  const result = await t.attachThumbnail(target.key, resolve(png), run, { replace });
  const ticket = target.pack?.ticket;
  const board = `bun run board bug ${ticket?.parent ?? '<ticket>'} ${target.key} --title ${JSON.stringify(ticket?.title ?? '<title>')} --severity ${ticket?.severity ?? '<Critical|High|Medium|Low>'} --evidence-embedded --by worker`;
  const next = source === 'none' || !result.embedded
    ? []
    : result.fellBack
      ? [`the image is in ${target.key}'s "Evidence" comment, not its Description (the edit screen does not expose it): say so in the report, then: ${board}`]
      : [`write "(image embedded below)" in ${target.key}'s report only now, then: ${board}`];
  return report(result, json, dryRun, calls, next);
}

async function runLink(values: Record<string, string | string[] | boolean | undefined>, config: ProjectEvidenceConfig, json: boolean): Promise<number> {
  const target = trackerTarget(values, 'link');
  const url = (values.url as string | undefined) ?? target.pack?.artifact?.url;
  if (url === undefined) {
    usage(target.pack === null ? 'link needs --url <url> with --key' : `${target.key}'s pack has no artifact.url yet: publish, then bun run evidence record`);
  }
  if (!keyPatternFor(target.packPath, config.ticketKeyPattern).test(target.key)) {
    usage(`${target.key} does not match the ticket key pattern ${config.ticketKeyPattern.source}`);
  }
  const urlError = evidenceUrlError(url, config.allowedHosts);
  if (urlError !== null) {
    console.error(`✗ ${urlError}`);
    return 1;
  }
  const source = trackerSource(values, config);
  const run = runRef(values, source);
  // The deep link names the case by the run's test key unless --case gives the pack's case id;
  // with a pack, the id must be one of its cases, or the link would open nothing
  const caseId = values.case as string | undefined;
  if (run !== undefined && target.pack === null && caseId === undefined) {
    usage('a run deep link needs the case id the page uses: pass --pack <pack.json> or --case <id>');
  }
  if (run !== undefined && target.pack !== null) {
    const wanted = caseId ?? ('test' in run ? run.test : undefined);
    if (wanted === undefined) {
      usage('with --pack and --run, name the case with --case <id> (one of the pack\'s tcs ids)');
    }
    const ids = [...(target.pack.tcs ?? []), ...(target.pack.bugs ?? [])].map(c => c.id);
    if (!ids.includes(wanted)) {
      usage(`case ${wanted} is not in ${target.key}'s pack (${ids.join(', ') || 'no cases'}); pass --case <id>`);
    }
  }
  const dryRun = values['dry-run'] === true;
  const made = await tracker({ operation: 'link', source, dryRun, run });
  if ('error' in made) {
    return report({ ok: false, lines: [], error: made.error }, json, dryRun, null, []);
  }
  const { tracker: t, calls } = made;
  const result = await t.linkEvidence(target.key, { url }, run === undefined ? undefined : { ...run, caseId });
  return report(result, json, dryRun, calls, []);
}

function runDemo(values: Record<string, string | string[] | boolean | undefined>): number {
  preflightOrExit(false);
  const out = resolve((values.out as string | undefined) ?? DEMO_OUT);
  // The demo folder is its own root: image paths are relative to it, wherever --out points
  const root = out;
  const { story, bug } = writeDemo(out, root);
  // Synthetic DEMO- keys: validated with the generic shape, never the project's own pattern. Opened from disk: standalone documents
  const common = ['--key-pattern', GENERIC_TICKET_KEY.source, '--repo', root];
  const bugPack = readPack(bug) as Pack;
  const steps: Array<[string, string[]]> = [
    ['story page', ['--pack', story, '--out', defaultPagePath(story, readPack(story) as Pack), '--standalone', ...common]],
    ['bug page', ['--pack', bug, '--out', defaultPagePath(bug, bugPack), '--standalone', ...common]],
    ['bug thumbnail', ['--pack', bug, '--thumb', join(dirname(defaultPagePath(bug, bugPack)), `${bugPack.ticket.id}-thumbnail.png`), ...common]],
    ['review page', ['--pack', story, bug, '--out', join(out, 'review', 'index.html'), '--standalone', ...common]],
  ];
  let failed = 0;
  for (const [label, args] of steps) {
    const result = runBuildPy(args);
    if (result.code === 0) {
      console.log(`✓ ${label}: ${display(result.stdout.trim())}`);
    }
    else {
      failed++;
      console.error(`✗ ${label}: ${buildError(result)}`);
    }
  }
  console.log(`Open the pages from disk; nothing was published. Packs: ${display(story)}, ${display(bug)}`);
  return failed === 0 ? 0 : 1;
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (command === undefined || command === '--help' || command === '-h') {
    console.log(USAGE);
    return command === undefined ? 2 : 0;
  }
  let values: Record<string, string | string[] | boolean | undefined>;
  try {
    ({ values } = parseArgs({
      args: rest,
      options: {
        'pack': { type: 'string', multiple: true },
        'out': { type: 'string' },
        'thumb': { type: 'string' },
        'case': { type: 'string' },
        'repo': { type: 'string' },
        'bug-pack': { type: 'string', multiple: true },
        'page': { type: 'string' },
        'max-mb': { type: 'string' },
        'host': { type: 'string' },
        'json': { type: 'boolean' },
        'url': { type: 'string' },
        'key': { type: 'string' },
        'png': { type: 'string' },
        'run': { type: 'string' },
        'test': { type: 'string' },
        'exec': { type: 'string' },
        'source': { type: 'string' },
        'dry-run': { type: 'boolean' },
        'replace': { type: 'boolean' },
      },
      strict: true,
      allowPositionals: false,
    }));
  }
  catch (err) {
    usage((err as Error).message);
  }

  const config = projectConfig();
  if (config.note !== null && values.json !== true) {
    console.error(`⚠ ${config.note}`);
  }
  switch (command) {
    case 'build':
      return runBuild(values, config, values.json === true);
    case 'extract':
      return runExtract(values);
    case 'record':
      return runRecord(values, config);
    case 'attach':
      return runAttach(values, config, values.json === true);
    case 'link':
      return runLink(values, config, values.json === true);
    case 'demo':
      return runDemo(values);
    default:
      usage(`unknown command ${JSON.stringify(command)}`);
  }
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
