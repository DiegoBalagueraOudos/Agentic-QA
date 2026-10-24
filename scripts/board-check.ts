#!/usr/bin/env bun
/**
 * board-check.ts — validate the `board:` block of `.agents/project.yaml`
 * against the Jira catalogs, and optionally take a snapshot (ADR-0019).
 *
 *   bun run board:check               validate only; no network (part of repo:check)
 *   bun run board:check --snapshot    run the configured source, print the snapshot JSON
 *   bun run board:check --demo        run the `none` source on the committed demo sprint
 *
 * CONTRACT
 * --------
 *   - An unconfigured block (absent, or every status bucket null, which is how the
 *     template ships) prints one INFO line and exits 0: a project that has not
 *     adopted the board is not failing anything.
 *   - An invalid block prints every error with its key path and exits 1.
 *   - A valid block prints the resolved values, each derived one with the key it
 *     was read from, and every workflow status no bucket lists yet as a WARN.
 *   - `--snapshot` / `--demo` print the snapshot JSON on stdout and nothing else;
 *     an unmapped status there exits 1 with the item and the key to fill.
 *   - Validation never touches the network; `--snapshot` on a Jira source does,
 *     reading credentials by name only.
 */

import type { BoardConfigResult } from '../cli/lib/sprint-source/index.ts';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';

import { createSource, loadBoardConfig, resolveBoardConfig } from '../cli/lib/sprint-source/index.ts';

const DEMO_PROJECT = 'cli/lib/sprint-source/fixtures/demo/project.yaml';

const USAGE = `Usage: bun run board:check [--snapshot | --demo] [--discover]

  (default)    validate the board: block of .agents/project.yaml (no network)
  --snapshot   take a snapshot with the configured source and print it as JSON
  --demo       snapshot the committed demo sprint (none source, ${DEMO_PROJECT})
  --discover   with --snapshot/--demo: also list sprint rows the board does not track
  --help       this text`;

/** Whether git ignores a repo-relative path (the `none` source's system of record must be versioned). */
function gitIgnores(repoRoot: string, path: string): boolean {
  const probe = Bun.spawnSync(['git', 'check-ignore', '-q', '--no-index', path], { cwd: repoRoot, stdout: 'ignore', stderr: 'ignore' });
  return probe.exitCode === 0;
}

function report(result: BoardConfigResult, repoRoot: string): number {
  if (result.state === 'unconfigured') {
    console.log(`board:check INFO: board not configured (${result.reason}); nothing to check.`);
    return 0;
  }
  if (result.state === 'invalid') {
    console.error(`board:check: ${result.errors.length} error(s) in the board: block`);
    for (const error of result.errors) { console.error(`  ERROR ${error}`); }
    return 1;
  }
  const { config, derived, warnings } = result;
  console.log(`board:check OK: source ${config.source}, ticket key ${config.ticketKeyPattern.source}`);
  for (const value of derived) { console.log(`  derived ${value.key} = ${JSON.stringify(value.value)}  <- ${value.from}`); }
  for (const warning of warnings) { console.log(`  WARN ${warning}`); }
  if (config.source === 'none' && gitIgnores(repoRoot, config.ticketsFile)) {
    console.log(`  WARN board.tickets_file ${config.ticketsFile} is ignored by git, so the none source's system of record would never be committed: add a re-include line for its folder to .gitignore (e.g. !.context/sprint/ after .context/*)`);
  }
  return 0;
}

async function main(): Promise<number> {
  const argv = new Set(process.argv.slice(2));
  if (argv.has('--help')) { console.log(USAGE); return 0; }
  const unknown = [...argv].filter(a => !['--snapshot', '--demo', '--discover'].includes(a));
  if (unknown.length > 0) { console.error(`board:check: unknown option(s) ${unknown.join(' ')}\n\n${USAGE}`); return 1; }
  const snapshotMode = argv.has('--snapshot') || argv.has('--demo');
  if (argv.has('--discover') && !snapshotMode) { console.error(`board:check: --discover only applies with --snapshot or --demo\n\n${USAGE}`); return 1; }

  const repoRoot = process.cwd();
  const demo = argv.has('--demo');
  const result = demo
    ? resolveBoardConfig(parseYaml(readFileSync(join(repoRoot, DEMO_PROJECT), 'utf8')), { workflows: null, fields: null }, DEMO_PROJECT)
    : loadBoardConfig(repoRoot);

  if (!snapshotMode) { return report(result, repoRoot); }
  if (result.state === 'unconfigured') {
    console.error(`board:check: --snapshot needs a configured board: block (${result.reason})`);
    return 1;
  }
  if (result.state === 'invalid') { return report(result, repoRoot); }

  try {
    const snapshot = await createSource(result.config, { repoRoot }).snapshot({ discover: argv.has('--discover') });
    console.log(JSON.stringify(snapshot, null, 2));
    return 0;
  }
  catch (err) {
    console.error(`board:check: snapshot failed: ${(err as Error).message}`);
    return 1;
  }
}

process.exit(await main());
