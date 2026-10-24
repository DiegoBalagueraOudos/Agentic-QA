#!/usr/bin/env bun
/**
 * evidence-page CLI — build, record and demo the static evidence page (ADR-0021).
 *
 *   bun run evidence build  --pack <pack.json> [--out <dir>] [--thumb] [--max-mb N] [--host claude-artifact|local] [--json]
 *   bun run evidence record --pack <pack.json> --url <url>
 *   bun run evidence demo   [--out <dir>]
 *
 * CONTRACT
 * --------
 *   - `build` validates, refuses secrets, burns redactions, writes ONE offline
 *     page (+ the bug thumbnail with --thumb) and prints the host step: for the
 *     default `claude-artifact` host, the exact Artifact tool call the agent
 *     makes (the CLI cannot publish: that is a harness tool); for `local`, the
 *     page path the report links. It never publishes anything.
 *   - `record` stores the URL the Artifact tool returned on the pack; only a
 *     host in `board.evidence.allowed_hosts` is accepted, and a second URL for
 *     an already published pack is refused.
 *   - The ticket key pattern and the allowed hosts come from the `board:` block
 *     when it is configured, else the generic key shape and the shipped hosts.
 *   - Exit codes: 0 done, 1 invalid pack / refused secret / size / URL, 2 usage.
 */

import type { EvidenceHost } from '../lib/evidence-page/hosts.ts';
import type { Pack } from '../lib/evidence-page/pack.ts';

import { readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';

import { buildEvidencePage } from '../lib/evidence-page/build.ts';
import { DEMO_OUT, writeDemo } from '../lib/evidence-page/demo.ts';
import { EVIDENCE_HOSTS, publishEvidence, recordPublication } from '../lib/evidence-page/hosts.ts';
import { GENERIC_TICKET_KEY, validatePack } from '../lib/evidence-page/pack.ts';
import { DEFAULT_EVIDENCE_HOSTS, loadBoardConfig } from '../lib/sprint-source/index.ts';

const USAGE = `Usage: bun run evidence <command> [options]

  build   --pack <pack.json>   validate the pack and build its offline page
          [--out <dir>]        default: <pack dir>/evidence-page/ (a bug: .../evidence-page/<BUG>/)
          [--thumb]            bug pack: also write <pack dir>/<BUG>-thumbnail.png
          [--max-mb N]         page size limit, default 14, at most 16
          [--host H]           claude-artifact (default) | local
          [--json]             one machine-readable line on stdout
  record  --pack <pack.json> --url <url>
                               store the URL the Artifact tool returned
  demo    [--out <dir>]        build a synthetic story page and bug page (default ${DEMO_OUT})`;

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

function runBuild(values: Record<string, string | boolean | undefined>, keyPattern: RegExp, json: boolean): number {
  const packPath = values.pack as string | undefined;
  if (packPath === undefined) {
    usage('build needs --pack <pack.json>');
  }
  const host = (values.host as string | undefined) ?? 'claude-artifact';
  if (!(EVIDENCE_HOSTS as readonly string[]).includes(host)) {
    usage(`--host must be one of ${EVIDENCE_HOSTS.join(' | ')}`);
  }
  const maxMb = values['max-mb'] === undefined ? undefined : Number(values['max-mb']);
  if (maxMb !== undefined && !Number.isFinite(maxMb)) {
    usage('--max-mb must be a number');
  }

  const result = buildEvidencePage({ packPath, outDir: values.out as string | undefined, thumb: values.thumb === true, maxMb, ticketKeyPattern: keyPattern, host: host as EvidenceHost });
  if (!result.ok) {
    if (json) {
      console.log(JSON.stringify({ ok: false, errors: result.errors, warnings: result.warnings }));
    }
    else {
      console.error(`✗ ${display(packPath)}: not built`);
      result.errors.forEach(e => console.error(`  ✗ ${e}`));
      result.warnings.forEach(w => console.error(`  ⚠ ${w}`));
    }
    return 1;
  }

  const publish = publishEvidence(result.pagePath, result.pack.artifact?.ref, host as EvidenceHost, { packPath: display(packPath) });
  if (json) {
    console.log(JSON.stringify({
      ok: true,
      page: result.pagePath,
      thumbnail: result.thumbPath,
      bytes: result.bytes,
      warnings: result.warnings,
      ref: publish.ref,
      agentStep: publish.agentStep ?? null,
    }));
    return 0;
  }
  console.log(`✓ page: ${display(result.pagePath)} (${(result.bytes / 1024 / 1024).toFixed(2)} MB, offline, self-contained)`);
  if (result.thumbPath !== null) {
    console.log(`✓ thumbnail: ${display(result.thumbPath)}`);
  }
  result.warnings.forEach(w => console.log(`  ⚠ ${w}`));
  if (publish.agentStep === undefined) {
    console.log(`→ local host: link ${publish.ref.location} in the report`);
  }
  else {
    console.log('→ agent step (the CLI does not publish):');
    publish.agentStep.instructions.forEach(line => console.log(`  - ${line}`));
  }
  return 0;
}

// A demo pack carries synthetic DEMO- keys: build and record it with the shape `demo` built it with
function keyPatternFor(packPath: string | undefined, projectPattern: RegExp): RegExp {
  return packPath !== undefined && resolve(packPath).startsWith(resolve(DEMO_OUT) + sep) ? GENERIC_TICKET_KEY : projectPattern;
}

function runRecord(values: Record<string, string | boolean | undefined>, config: ProjectEvidenceConfig): number {
  const packPath = values.pack as string | undefined;
  const url = values.url as string | undefined;
  if (packPath === undefined || url === undefined) {
    usage('record needs --pack <pack.json> and --url <url>');
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(packPath, 'utf8'));
  }
  catch (err) {
    console.error(`✗ ${packPath}: cannot read the pack (${(err as Error).message})`);
    return 1;
  }
  const validation = validatePack(raw, { ticketKeyPattern: keyPatternFor(packPath, config.ticketKeyPattern) });
  if (!validation.ok) {
    console.error(`✗ ${display(packPath)}: invalid pack`);
    validation.errors.forEach(e => console.error(`  ✗ ${e}`));
    return 1;
  }
  const recorded = recordPublication(validation.pack, url, { allowedHosts: config.allowedHosts });
  if (!recorded.ok) {
    console.error(`✗ ${recorded.error}`);
    return 1;
  }
  writeFileSync(packPath, `${JSON.stringify(recorded.pack satisfies Pack, null, 2)}\n`);
  console.log(`✓ recorded ${url} on ${display(packPath)}; the next build republishes to it`);
  return 0;
}

function runDemo(values: Record<string, string | boolean | undefined>): number {
  const out = (values.out as string | undefined) ?? DEMO_OUT;
  const packs = writeDemo(out);
  let failed = 0;
  for (const [label, packPath] of Object.entries(packs)) {
    // Synthetic DEMO- keys: validated with the generic shape, never the project's own pattern
    // Opened from disk: a standalone document
    const result = buildEvidencePage({ packPath, thumb: label === 'bug', ticketKeyPattern: GENERIC_TICKET_KEY, host: 'local' });
    if (result.ok) {
      console.log(`✓ ${label}: ${display(result.pagePath)}${result.thumbPath ? ` + ${display(result.thumbPath)}` : ''}`);
    }
    else {
      failed++;
      console.error(`✗ ${label}: ${result.errors.join('; ')}`);
    }
  }
  console.log(`Open the pages from disk; nothing was published. Packs: ${display(join(out, 'story'))}, ${display(join(out, 'bug'))}`);
  return failed === 0 ? 0 : 1;
}

function main(argv: string[]): number {
  const [command, ...rest] = argv;
  if (command === undefined || command === '--help' || command === '-h') {
    console.log(USAGE);
    return command === undefined ? 2 : 0;
  }
  let values: Record<string, string | boolean | undefined>;
  try {
    ({ values } = parseArgs({
      args: rest,
      options: {
        'pack': { type: 'string' },
        'out': { type: 'string' },
        'thumb': { type: 'boolean' },
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
      return runBuild(values, keyPatternFor(values.pack as string | undefined, config.ticketKeyPattern), values.json === true);
    case 'record':
      return runRecord(values, config);
    case 'demo':
      return runDemo(values);
    default:
      usage(`unknown command ${JSON.stringify(command)}`);
  }
}

process.exit(main(process.argv.slice(2)));
