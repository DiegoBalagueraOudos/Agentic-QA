#!/usr/bin/env bun
/**
 * evidence-page CLI — build, extract, record and demo the evidence page (ADR-0021, ADR-0022).
 *
 *   bun run evidence build   --pack <pack.json> [--pack <pack2.json>] [--out <index.html>] [--thumb <png>] [--case <id>]
 *                            [--repo <root>] [--bug-pack <BUG>=<pack.json>] [--max-mb N] [--host claude-artifact|local] [--json]
 *   bun run evidence extract --page <page.html> --out <pack.json>
 *   bun run evidence record  --pack <pack.json> --url <url>
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
 *   - The ticket key pattern and the allowed hosts come from the `board:` block when
 *     it is configured, else the generic key shape and the shipped hosts.
 *   - Exit codes: 0 done, 1 invalid pack / refused secret / size / URL / missing Python, 2 usage.
 */

import type { EvidenceHost } from '../lib/evidence-page/hosts.ts';
import type { Pack } from '../lib/evidence-page/pack.ts';

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';

import { DEMO_OUT, writeDemo } from '../lib/evidence-page/demo.ts';
import { describePage, EVIDENCE_HOSTS, publishEvidence, recordPublication } from '../lib/evidence-page/hosts.ts';
import { GENERIC_TICKET_KEY } from '../lib/evidence-page/pack.ts';
import { buildError, buildWarnings, pythonPreflight, runBuildPy } from '../lib/evidence-page/python.ts';
import { DEFAULT_EVIDENCE_HOSTS, loadBoardConfig } from '../lib/sprint-source/index.ts';
import { checkoutRoots } from '../lib/worktree.ts';

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
  demo     [--out <dir>]        build synthetic story, bug and review pages (default ${DEMO_OUT})

Needs Python 3.9+ and Pillow (python3 -m pip install pillow).`;

interface ProjectEvidenceConfig {
  ticketKeyPattern: RegExp
  allowedHosts: readonly string[]
  note: string | null
}

function projectConfig(): ProjectEvidenceConfig {
  const result = loadBoardConfig(process.cwd());
  if (result.state === 'ok') {
    return { ticketKeyPattern: result.config.ticketKeyPattern, allowedHosts: result.config.evidenceHosts, note: null };
  }
  const note = result.state === 'invalid'
    ? `the board: block is invalid (run bun run board:check); using the generic key shape and ${DEFAULT_EVIDENCE_HOSTS.join(', ')}`
    : null;
  return { ticketKeyPattern: GENERIC_TICKET_KEY, allowedHosts: DEFAULT_EVIDENCE_HOSTS, note };
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

function main(argv: string[]): number {
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
    case 'demo':
      return runDemo(values);
    default:
      usage(`unknown command ${JSON.stringify(command)}`);
  }
}

if (import.meta.main) {
  process.exit(main(process.argv.slice(2)));
}
