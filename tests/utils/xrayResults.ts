/**
 * KATA Architecture - Xray result payload (one entry per ATC, explicit keys)
 *
 * Builds the Xray JSON body for `POST /api/v2/import/execution` from one or
 * more `reports/atc_results.json` files. Shared by the local write-back
 * (`tests/utils/jiraSync.ts`) and the CI one (the XrayImport job of
 * `.github/workflows/regression.yml`), so both legs follow one rule.
 *
 * WHY Xray JSON and not the JUnit report. Xray creates a NEW Generic Test for
 * every JUnit testcase that carries no `test_key` property, and a Playwright
 * testcase calls zero, one or several ATCs (the setup and teardown projects
 * land in the same file with none). Xray JSON creates a Test only when an entry
 * carries `testInfo`; this module never writes one, so an import built here can
 * write runs onto existing Tests and nothing else. The `@atc` id IS the Test
 * key (one ATC = one TMS ticket), so every entry is `testKey: <atc id>`.
 *
 * CLI (the CI step, through `bun run xray:payload`):
 *   bun tests/utils/xrayResults.ts --execution <KEY> --out <file> <report...>
 * exits 1 with one line naming every id that is not shaped like a Test key,
 * and writes nothing when no ATC ran (Xray's schema needs at least one entry).
 * Whether the key EXISTS is Xray's call: an unknown key fails the import.
 */

import type { AtcResult } from '@utils/decorators';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

// ============================================
// Types
// ============================================

export interface XrayTestEntry {
  testKey: string
  status: 'PASSED' | 'FAILED'
  comment: string
}

export interface XrayExecutionPayload {
  testExecutionKey: string
  tests: XrayTestEntry[]
}

/** The shape KataReporter.onEnd() writes to reports/atc_results.json. */
export interface AtcReport {
  results?: Record<string, AtcResult[]>
}

/** A Jira issue key: project key, dash, number. */
const ISSUE_KEY = /^[A-Z][A-Z0-9_]+-\d+$/;

// ============================================
// Builders
// ============================================

/** Merge the `results` of several reports: executions of one ATC are concatenated. */
export function mergeAtcReports(reports: AtcReport[]): Record<string, AtcResult[]> {
  const merged: Record<string, AtcResult[]> = {};
  for (const report of reports) {
    for (const [testId, executions] of Object.entries(report.results ?? {})) {
      merged[testId] = [...(merged[testId] ?? []), ...executions];
    }
  }
  return merged;
}

/**
 * One Xray entry per ATC. Conservative status: PASSED only when every
 * execution passed. Never carries `testInfo`, so Xray cannot create a Test.
 */
export function buildXrayTests(results: Record<string, AtcResult[]>): XrayTestEntry[] {
  const tests: XrayTestEntry[] = [];

  for (const [testId, executions] of Object.entries(results)) {
    const finalStatus = executions.every(e => e.status === 'PASS') ? 'PASSED' : 'FAILED';
    const lastExecution = executions[executions.length - 1];

    tests.push({
      testKey: testId,
      status: finalStatus,
      comment:
        `KATA ATC: ${lastExecution.methodName}\n`
        + `Executions: ${executions.length}\n`
        + `Duration: ${lastExecution.duration}ms\n`
        + `Last run: ${lastExecution.executedAt}\n${
          lastExecution.error !== null ? `\nError:\n${lastExecution.error}` : ''
        }`,
    });
  }

  return tests;
}

/** The import body: always an EXISTING Test Execution, never `info`. */
export function buildXrayPayload(executionKey: string, results: Record<string, AtcResult[]>): XrayExecutionPayload {
  return { testExecutionKey: executionKey, tests: buildXrayTests(results) };
}

/** One `<id> (<Class.method>)` per ATC id that is not a Jira issue key. */
export function findKeyProblems(results: Record<string, AtcResult[]>): string[] {
  return Object.entries(results)
    .filter(([testId]) => !ISSUE_KEY.test(testId))
    .map(([testId, executions]) => {
      const first = executions[0];
      return first ? `${testId} (${first.className}.${first.methodName})` : testId;
    });
}

/** The single line a blocked import prints. */
export function keyProblemLine(problems: string[]): string {
  return `Not a Test key (PROJECT-123 shape), nothing was sent to Xray: ${problems.join(', ')}. `
    + 'Every @atc id must be the key of a Test that already exists in the TMS; '
    + 'a missing Test is created by /test-documentation, never by an import.';
}

// ============================================
// CLI
// ============================================

interface CliArgs {
  execution: string
  out: string
  reports: string[]
}

export function parseCliArgs(argv: string[]): CliArgs {
  const args: CliArgs = { execution: '', out: '', reports: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--execution') {
      args.execution = argv[++i] ?? '';
    }
    else if (arg === '--out') {
      args.out = argv[++i] ?? '';
    }
    else {
      args.reports.push(arg);
    }
  }
  return args;
}

/** Returns the exit code. Prints GitHub annotations, which read as plain lines locally. */
export function runCli(argv: string[]): number {
  const { execution, out, reports } = parseCliArgs(argv);

  if (!ISSUE_KEY.test(execution) || out === '') {
    console.error('Usage: bun tests/utils/xrayResults.ts --execution <TEST-EXECUTION-KEY> --out <file> <atc_results.json...>');
    return 2;
  }

  const found = reports.filter(path => existsSync(path));
  const results = mergeAtcReports(
    found.map(path => JSON.parse(readFileSync(path, 'utf-8')) as AtcReport),
  );

  const problems = findKeyProblems(results);
  if (problems.length > 0) {
    console.log(`::error title=Xray import blocked::${keyProblemLine(problems)}`);
    return 1;
  }

  const payload = buildXrayPayload(execution, results);
  if (payload.tests.length === 0) {
    console.log(`::notice title=Xray import skipped::No ATC ran in this run (${found.length} report(s) read), so there is no result to import.`);
    return 0;
  }

  writeFileSync(out, `${JSON.stringify(payload, null, 2)}\n`);
  console.log(`Wrote ${payload.tests.length} result(s) for existing Tests into ${out} (target ${execution}).`);
  return 0;
}

if (import.meta.main) {
  process.exit(runCli(process.argv.slice(2)));
}
