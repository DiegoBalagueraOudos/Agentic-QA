import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'bun:test';

import { DEMO_REDACT, writeDemo } from './demo.ts';
import { BUILD_PY, buildError, buildWarnings, PILLOW_INSTALL, pillowInstall, pythonCandidates, pythonPreflight, resolvePython, runBuildPy } from './python.ts';

const missing = pythonPreflight();
// Without Python 3.9+ and Pillow these tests cannot run the builder: skipped, and the reason is printed once
if (missing !== null) {
  console.warn(`evidence builder tests skipped: ${missing}`);
}

describe('the build.py seam', () => {
  it('finds the copied builder beside its templates', () => {
    expect(existsSync(BUILD_PY)).toBe(true);
    expect(existsSync(join(dirname(BUILD_PY), '..', 'templates', 'evidence-artifact.html'))).toBe(true);
  });

  it('names the one thing to install when the preflight fails', () => {
    expect(missing === null || missing.includes('python3') || missing.includes(PILLOW_INSTALL)).toBe(true);
  });

  it('tries the py launcher first on Windows, python3 then python elsewhere', () => {
    expect(pythonCandidates('win32')).toEqual([['py', '-3'], ['python3'], ['python']]);
    expect(pythonCandidates('darwin')).toEqual([['python3'], ['python']]);
    expect(pythonCandidates('linux')).toEqual([['python3'], ['python']]);
  });

  // A Homebrew or distro Python refuses a bare pip install (PEP 668).
  it('names the PEP 668 way to get Pillow on each platform', () => {
    expect(pillowInstall('darwin')).toContain('brew install pillow');
    expect(pillowInstall('linux')).toContain('python3-pil');
    expect(pillowInstall('win32')).toBe('py -m pip install pillow');
  });

  it('reads the builder error line and its warnings apart', () => {
    const result = { code: 1, stdout: '', stderr: 'warning: p.json: pack.summary shows the address a@b.test.\nbuild.py: p.json: ticket{} is required\n' };
    expect(buildError(result)).toBe('p.json: ticket{} is required');
    expect(buildWarnings(result)).toEqual(['p.json: pack.summary shows the address a@b.test.']);
  });
});

describe.skipIf(missing !== null)('build.py (Python 3.9+ and Pillow present)', () => {
  it('passes its own regression suite', () => {
    const result = Bun.spawnSync([...resolvePython()!, '-m', 'unittest', 'discover', '-s', dirname(BUILD_PY)], { stdout: 'pipe', stderr: 'pipe' });
    const output = result.stderr.toString();
    expect(output).toMatch(/\nOK\b/);
    expect(result.exitCode).toBe(0);
  }, 120_000);

  it('builds the demo packs: story page, bug page with its history, the thumbnail', () => {
    const dir = mkdtempSync(join(tmpdir(), 'evidence-demo-'));
    try {
      const { story, bug } = writeDemo(dir, dir);
      const common = ['--key-pattern', '^[A-Z][A-Z0-9]+-\\d+$', '--repo', dir];
      const page = join(dir, 'story.html');
      expect(runBuildPy(['--pack', story, '--out', page, ...common]).code).toBe(0);
      const html = readFileSync(page, 'utf8');
      expect(html.startsWith('<title>DEMO-7101 Evidence</title>')).toBe(true);
      const bugPage = join(dir, 'bug.html');
      expect(runBuildPy(['--pack', bug, '--out', bugPage, '--standalone', ...common]).code).toBe(0);
      expect(readFileSync(bugPage, 'utf8')).toContain('BEFORE FIX (round 0, build 2026.10.24-3, 2026-10-24)');
      const thumb = runBuildPy(['--pack', bug, '--thumb', join(dir, 'thumb.png'), ...common]);
      expect(thumb.code).toBe(0);
      expect(thumb.stdout).toContain('960x600');
      const review = runBuildPy(['--pack', story, bug, '--out', join(dir, 'review.html'), ...common]);
      expect(review.code).toBe(0);
      expect(DEMO_REDACT).toHaveLength(4);
    }
    finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('bun run evidence demo --out builds into a folder outside the repo (VERIFY S2)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'evidence-demo-cli-'));
    try {
      const cli = join(dirname(BUILD_PY), '..', '..', '..', '..', 'cli', 'evidence-page', 'index.ts');
      const result = Bun.spawnSync(['bun', cli, 'demo', '--out', dir], { stdout: 'pipe', stderr: 'pipe' });
      expect(result.stderr.toString()).not.toContain('outside the repo root');
      expect(result.exitCode).toBe(0);
      expect(existsSync(join(dir, 'review', 'index.html'))).toBe(true);
      expect(existsSync(join(dir, 'story', 'evidence-artifact', 'DEMO-7120', 'DEMO-7120-thumbnail.png'))).toBe(true);
    }
    finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
