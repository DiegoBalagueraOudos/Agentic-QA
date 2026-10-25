/**
 * Unit tests for the Xray result payload. Run with `bun test tests/utils`.
 *
 * Playwright never collects this file: every project in playwright.config.ts
 * has its own `testMatch`.
 */

import type { AtcResult } from '@utils/decorators';
import type { AtcReport } from '@utils/xrayResults';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildXrayPayload,
  buildXrayTests,
  findKeyProblems,
  keyProblemLine,
  mergeAtcReports,
  runCli,
} from '@utils/xrayResults';

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';

function run(testId: string, overrides: Partial<AtcResult> = {}): AtcResult {
  return {
    testId,
    methodName: 'loginSuccessfully',
    className: 'LoginPage',
    status: 'PASS',
    error: null,
    executedAt: '2026-01-01T00:00:00.000Z',
    duration: 12,
    softFail: false,
    ...overrides,
  };
}

describe('mergeAtcReports', () => {
  it('concatenates the executions of one ATC across reports', () => {
    const integration: AtcReport = { results: { 'DEMO-7101': [run('DEMO-7101')] } };
    const e2e: AtcReport = { results: { 'DEMO-7101': [run('DEMO-7101', { status: 'FAIL', error: 'boom' })], 'DEMO-7102': [run('DEMO-7102')] } };

    const merged = mergeAtcReports([integration, e2e, {}]);

    expect(Object.keys(merged)).toEqual(['DEMO-7101', 'DEMO-7102']);
    expect(merged['DEMO-7101']).toHaveLength(2);
  });
});

describe('buildXrayTests / buildXrayPayload', () => {
  it('writes one entry per ATC, keyed by the @atc id, FAILED when any execution failed', () => {
    const tests = buildXrayTests({
      'DEMO-7101': [run('DEMO-7101'), run('DEMO-7101', { status: 'FAIL', error: 'Timeout' })],
      'DEMO-7102': [run('DEMO-7102'), run('DEMO-7102')],
    });

    expect(tests.map(t => [t.testKey, t.status])).toEqual([['DEMO-7101', 'FAILED'], ['DEMO-7102', 'PASSED']]);
    expect(tests[0].comment).toContain('Executions: 2');
    expect(tests[0].comment).toContain('Error:\nTimeout');
  });

  it('never carries testInfo or info, so Xray cannot create a Test or an Execution', () => {
    const payload = buildXrayPayload('DEMO-7150', { 'DEMO-7101': [run('DEMO-7101')] });

    expect(Object.keys(payload).sort()).toEqual(['testExecutionKey', 'tests']);
    expect(payload.testExecutionKey).toBe('DEMO-7150');
    for (const entry of payload.tests) {
      expect(Object.keys(entry).sort()).toEqual(['comment', 'status', 'testKey']);
    }
  });
});

describe('findKeyProblems', () => {
  it('names every id that is not a Jira issue key, with its method', () => {
    const problems = findKeyProblems({
      'DEMO-7101': [run('DEMO-7101')],
      'login-01': [run('login-01', { className: 'LoginPage', methodName: 'loginWithSso' })],
      'demo-7102': [run('demo-7102')],
    });

    expect(problems).toEqual(['login-01 (LoginPage.loginWithSso)', 'demo-7102 (LoginPage.loginSuccessfully)']);
    expect(keyProblemLine(problems)).toContain('nothing was sent to Xray: login-01 (LoginPage.loginWithSso), demo-7102');
  });

  it('accepts real keys', () => {
    expect(findKeyProblems({ 'DEMO-7101': [run('DEMO-7101')], 'QA_X2-7103': [run('QA_X2-7103')] })).toEqual([]);
  });
});

describe('runCli (the CI step)', () => {
  let dir: string;
  let lines: string[];
  let logSpy: ReturnType<typeof spyOn>;
  let errSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'xray-results-'));
    lines = [];
    logSpy = spyOn(console, 'log').mockImplementation((...a: unknown[]) => void lines.push(a.join(' ')));
    errSpy = spyOn(console, 'error').mockImplementation((...a: unknown[]) => void lines.push(a.join(' ')));
  });

  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
  });

  function report(name: string, results: Record<string, AtcResult[]>): string {
    const path = join(dir, name);
    writeFileSync(path, JSON.stringify({ results }));
    return path;
  }

  it('writes the payload when every id is a Test key, skipping a report that is absent', () => {
    const out = join(dir, 'xray-results.json');
    const code = runCli(['--execution', 'DEMO-7150', '--out', out, report('a.json', { 'DEMO-7101': [run('DEMO-7101')] }), join(dir, 'missing.json')]);

    expect(code).toBe(0);
    const payload = JSON.parse(readFileSync(out, 'utf-8'));
    expect(payload.testExecutionKey).toBe('DEMO-7150');
    expect(payload.tests).toHaveLength(1);
  });

  it('fails with ONE line naming each bad id and writes nothing', () => {
    const out = join(dir, 'xray-results.json');
    const code = runCli(['--execution', 'DEMO-7150', '--out', out, report('a.json', { 'DEMO-7101': [run('DEMO-7101')], 'smoke-login': [run('smoke-login')] })]);

    expect(code).toBe(1);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toStartWith('::error title=Xray import blocked::');
    expect(lines[0]).toContain('smoke-login (LoginPage.loginSuccessfully)');
    expect(() => readFileSync(out)).toThrow();
  });

  it('writes nothing and exits 0 when no ATC ran', () => {
    const out = join(dir, 'xray-results.json');
    expect(runCli(['--execution', 'DEMO-7150', '--out', out, report('a.json', {})])).toBe(0);
    expect(lines[0]).toContain('No ATC ran');
    expect(() => readFileSync(out)).toThrow();
  });

  it('refuses a missing or malformed execution key', () => {
    expect(runCli(['--out', join(dir, 'x.json')])).toBe(2);
    expect(runCli(['--execution', 'not a key', '--out', join(dir, 'x.json')])).toBe(2);
  });
});
