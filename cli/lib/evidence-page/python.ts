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

/**
 * The interpreters tried, in order. Windows usually exposes the `py` launcher
 * (or `python`) and no `python3`; elsewhere `python3` is the name, `python` the
 * fallback. Each entry is the argv prefix that starts it.
 */
export function pythonCandidates(platform: string = process.platform): string[][] {
  const unix = [['python3'], ['python']];
  return platform === 'win32' ? [['py', '-3'], ...unix] : unix;
}

/**
 * How to install Pillow, per platform. A Homebrew or distro Python refuses
 * `pip install` outside a virtual environment (PEP 668, `externally-managed-environment`),
 * so the plain pip line alone failed exactly where most people have Python.
 */
export function pillowInstall(platform: string = process.platform): string {
  if (platform === 'win32') { return 'py -m pip install pillow'; }
  if (platform === 'darwin') { return 'python3 -m pip install pillow (Homebrew Python: brew install pillow, or a venv)'; }
  return 'python3 -m pip install pillow (a distro Python: your package manager\'s python3-pil, or a venv)';
}

export const PILLOW_INSTALL = pillowInstall();

export interface PythonRun { code: number, stdout: string, stderr: string }

function spawn(argv: string[], cwd?: string): PythonRun {
  try {
    const result = Bun.spawnSync(argv, { cwd, stdout: 'pipe', stderr: 'pipe' });
    return { code: result.exitCode ?? 1, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
  }
  catch (err) {
    return { code: 127, stdout: '', stderr: (err as Error).message };
  }
}

let resolved: string[] | null | undefined;

/** The first candidate that starts and reports its version, cached; null when none does. */
export function resolvePython(): string[] | null {
  if (resolved === undefined) {
    resolved = pythonCandidates().find(argv => spawn([...argv, '-c', 'import sys; print(sys.version_info[0])']).code === 0) ?? null;
  }
  return resolved;
}

function run(args: string[], cwd?: string): PythonRun {
  const python = resolvePython();
  if (python === null) { return { code: 127, stdout: '', stderr: 'no Python interpreter on the PATH' }; }
  return spawn([...python, ...args], cwd);
}

/** `null` when Python 3.9+ and Pillow are installed, else ONE line naming what to install. */
export function pythonPreflight(): string | null {
  const names = pythonCandidates().map(argv => argv.join(' ')).join(' or ');
  const probe = run(['-c', 'import sys; print("%d.%d" % sys.version_info[:2]); import PIL']);
  const version = probe.stdout.trim().split('\n')[0] ?? '';
  if (probe.code === 127 || !/^\d+\.\d+$/.test(version)) {
    return `the evidence builder needs Python 3.9+ on the PATH (${names}), then Pillow: ${PILLOW_INSTALL}`;
  }
  const [major, minor] = version.split('.').map(Number);
  if (major < 3 || (major === 3 && minor < 9)) {
    return `the evidence builder needs Python 3.9+ (${resolvePython()!.join(' ')} is ${version})`;
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
