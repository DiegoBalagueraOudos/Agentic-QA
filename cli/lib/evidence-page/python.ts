/**
 * @fileoverview The seam to the evidence builder, the `evidence-artifact` skill's `scripts/build.py` (ADR-0022).
 *
 * The page, the thumbnail and the pack validator are the reference builder
 * itself (Python 3.9+ and Pillow), so the output is the reference's by
 * construction. This module checks that the interpreter and Pillow are there,
 * naming the one thing to install when they are not, and runs the script.
 */

import { resolve } from 'node:path';

/** The copied builder, resolved from this module so the CLI runs from any working directory. */
export const BUILD_PY = resolve(import.meta.dir, '..', '..', '..', '.agents', 'skills', 'evidence-artifact', 'scripts', 'build.py');

export const PYTHON = 'python3';
export const PILLOW_INSTALL = 'python3 -m pip install pillow';

export interface PythonRun { code: number, stdout: string, stderr: string }

function run(args: string[], cwd?: string): PythonRun {
  try {
    const result = Bun.spawnSync([PYTHON, ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
    return { code: result.exitCode ?? 1, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
  }
  catch (err) {
    return { code: 127, stdout: '', stderr: (err as Error).message };
  }
}

/** `null` when Python 3.9+ and Pillow are installed, else ONE line naming what to install. */
export function pythonPreflight(): string | null {
  const probe = run(['-c', 'import sys; print("%d.%d" % sys.version_info[:2]); import PIL']);
  const version = probe.stdout.trim().split('\n')[0] ?? '';
  if (probe.code === 127 || !/^\d+\.\d+$/.test(version)) {
    return `the evidence builder needs Python 3.9+ as ${PYTHON} on the PATH, then Pillow: ${PILLOW_INSTALL}`;
  }
  const [major, minor] = version.split('.').map(Number);
  if (major < 3 || (major === 3 && minor < 9)) {
    return `the evidence builder needs Python 3.9+ (${PYTHON} is ${version})`;
  }
  if (probe.code !== 0) {
    return `the evidence builder needs Pillow: ${PILLOW_INSTALL}`;
  }
  return null;
}

/** Run `build.py` with these arguments. */
export function runBuildPy(args: string[], cwd?: string): PythonRun {
  return run([BUILD_PY, ...args], cwd);
}

/** The builder's own error line, without its `build.py: ` prefix. */
export function buildError(result: PythonRun): string {
  const lines = result.stderr.trim().split('\n').filter(l => !l.startsWith('warning: '));
  return (lines.at(-1) ?? `build.py exited ${result.code}`).replace(/^build\.py: /, '');
}

/** The builder's warnings (emails shown, a DEFERRED case under a PASSED verdict). */
export function buildWarnings(result: PythonRun): string[] {
  return result.stderr.split('\n').filter(l => l.startsWith('warning: ')).map(l => l.slice('warning: '.length));
}
