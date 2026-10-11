#!/usr/bin/env bun
/**
 * @fileoverview Records a real `bun sync` run as a page journal.
 *
 *   bun scripts/ui-record-up.ts --repo <consumer checkout> [--name <project>] [--out <journal.json>] [--transcript <lines.json>] [-- <updater args>]
 *
 * Runs `bun cli/update-boilerplate.ts <args>` (default `--dry-run`) INSIDE `--repo`
 * with stdin closed and stdout piped, stamps every printed line with the time it
 * arrived, and translates the transcript into journal entries
 * (`scripts/lib/ui-up-transcript.ts`). `--repo` must be a plain checkout of a
 * consumer project, not a linked worktree: the updater refuses to run in one.
 * `--name` is the project name the page shows (default: the folder name), for a
 * recording made in a scratch clone.
 *
 * Transitional: delivery 2 records through the updater's own sink.
 */

import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';

import { translateUpTranscript } from './lib/ui-up-transcript.ts';

const DEFAULT_OUT = 'cli/lib/fixtures/ui-up-dry-run.journal.json';
const DEFAULT_TRANSCRIPT = 'cli/lib/fixtures/ui-up-dry-run.transcript.json';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const repo = arg('--repo');
  if (!repo) {
    process.stderr.write('usage: bun scripts/ui-record-up.ts --repo <consumer checkout> [--out file] [--transcript file] [-- updater args]\n');
    process.exit(2);
  }
  const dash = process.argv.indexOf('--');
  const updaterArgs = dash > 0 ? process.argv.slice(dash + 1) : ['--dry-run'];
  const out = resolve(arg('--out') ?? DEFAULT_OUT);
  const transcriptOut = resolve(arg('--transcript') ?? DEFAULT_TRANSCRIPT);

  const t0 = Date.now();
  const lines: { ms: number, text: string }[] = [];
  const child = spawn('bun', ['cli/update-boilerplate.ts', ...updaterArgs], { cwd: resolve(repo), stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NO_COLOR: '1' } });
  let buf = '';
  const take = (chunk: Buffer): void => {
    buf += chunk.toString('utf8');
    const parts = buf.split('\n');
    buf = parts.pop() ?? '';
    for (const text of parts) { lines.push({ ms: Date.now() - t0, text }); }
  };
  child.stdout.on('data', take);
  child.stderr.on('data', take);
  const exit = await new Promise<number>(r => child.on('close', code => r(code ?? 1)));
  if (buf) { lines.push({ ms: Date.now() - t0, text: buf }); }

  const name = arg('--name') ?? basename(resolve(repo));
  const journal = translateUpTranscript(lines, { repo: name, args: updaterArgs });
  writeFileSync(transcriptOut, `${JSON.stringify({ repo: name, args: updaterArgs, exit, lines }, null, 2)}\n`);
  writeFileSync(out, `${JSON.stringify(journal, null, 2)}\n`);
  process.stdout.write(`updater exit ${exit} · ${lines.length} lines · ${journal.length} events\n  journal:    ${out}\n  transcript: ${transcriptOut}\n`);
}

await main();
