/**
 * Contract tests for `bun run board:check` (scripts/board-check.ts).
 *
 * What they guard: the exit codes `repo:check` relies on (unconfigured = INFO
 * and 0, invalid = 1), the option rules (`--discover` only with a snapshot, an
 * unconfigured block cannot be snapshotted), the demo snapshot, and the warning
 * when the `none` source's tickets file is ignored by git.
 *
 * No network: every case runs on the committed demo or on a temp checkout with
 * a `none` source.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'bun:test';

const SCRIPT = join(import.meta.dir, 'board-check.ts');
const REPO_ROOT = join(import.meta.dir, '..');
const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) { rmSync(roots.pop()!, { recursive: true, force: true }); }
});

function run(cwd: string, ...args: string[]): { code: number, out: string, err: string } {
  const proc = Bun.spawnSync(['bun', SCRIPT, ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  return { code: proc.exitCode ?? -1, out: proc.stdout.toString(), err: proc.stderr.toString() };
}

/** A temp git checkout holding only `.agents/project.yaml` (+ an optional `.gitignore`). */
function checkout(projectYaml: string, gitignore?: string): string {
  const root = mkdtempSync(join(tmpdir(), 'board check '));
  roots.push(root);
  mkdirSync(join(root, '.agents'), { recursive: true });
  writeFileSync(join(root, '.agents', 'project.yaml'), projectYaml);
  if (gitignore !== undefined) { writeFileSync(join(root, '.gitignore'), gitignore); }
  Bun.spawnSync(['git', 'init', '-q'], { cwd: root });
  return root;
}

const NONE_BOARD = `project:
  project_key: DEMO
board:
  source: none
  tickets_file: .context/sprint/tickets.yaml
  statuses:
    tickets: { not_ready: [To Do], in_test: [], tested: [], blocked: [], dropped: [] }
    bugs: { open: [Open], fixed: [], resolved: [], discarded: [] }
`;

describe('board:check', () => {
  test('the demo sprint snapshots to JSON with its denominators', () => {
    const { code, out } = run(REPO_ROOT, '--demo');
    expect(code).toBe(0);
    expect(JSON.parse(out).searched).toEqual({ tickets: 5, tests: 8, bugs: 2 });
  });

  test('an unconfigured block is INFO and exit 0, but cannot be snapshotted', () => {
    const root = checkout('project:\n  project_key: DEMO\n');
    expect(run(root)).toMatchObject({ code: 0 });
    expect(run(root).out).toContain('board:check INFO: board not configured');
    const snap = run(root, '--snapshot');
    expect(snap.code).toBe(1);
    expect(snap.err).toContain('--snapshot needs a configured board: block');
  });

  test('an invalid block exits 1 and names the key path', () => {
    const root = checkout('project:\n  project_key: DEMO\nboard:\n  statuse: {}\n');
    const result = run(root);
    expect(result.code).toBe(1);
    expect(result.err).toContain('ERROR board.statuse: unknown key');
  });

  test('--discover alone and unknown options are rejected', () => {
    expect(run(REPO_ROOT, '--discover').code).toBe(1);
    expect(run(REPO_ROOT, '--discover').err).toContain('--discover only applies with --snapshot or --demo');
    expect(run(REPO_ROOT, '--snapshots').code).toBe(1);
  });

  test('warns when git ignores the none source\'s tickets file, and not once it is re-included', () => {
    const ignored = run(checkout(NONE_BOARD, '.context/*\n'));
    expect(ignored.code).toBe(0);
    expect(ignored.out).toContain('WARN board.tickets_file .context/sprint/tickets.yaml is ignored by git');
    const reincluded = run(checkout(NONE_BOARD, '.context/*\n!.context/sprint/\n'));
    expect(reincluded.code).toBe(0);
    expect(reincluded.out).not.toContain('is ignored by git');
  });
});
