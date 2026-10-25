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
 * Status per ATC: FAILED when any execution failed, PASSED when the rest
 * passed, and LEFT OUT when every execution was a runtime skip (NOT RUN,
 * ADR-0020). The sibling `test-outcomes.json` of each report fills one gap: an
 * ATC whose test failed before the decorator could record it (a timeout on a
 * non-Playwright await never reaches its catch) is sent as FAILED. Both files
 * carry the run id KataReporter stamped; a report from another run is refused.
 *
 * CLI (the CI step, through `bun run xray:payload`):
 *   bun tests/utils/xrayResults.ts --execution <KEY> --out <file> <report...>
 * exits 1 with one line naming every unreadable or stale report, or every id
 * that is not shaped like a Test key, and writes nothing when no ATC result is
 * left (Xray's schema needs at least one entry). Whether the key EXISTS is
 * Xray's call: Xray returns an error for an unknown key.
 */

import type { AtcResult } from '@utils/decorators';
import type { OutcomesDocument } from '@utils/testOutcomes';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

// ============================================
// Types
// ============================================

/**
 * One ATC execution as this module reads it. `bun sync` delivers this file
 * while `decorators.ts` stays the project's own copy, which may predate
 * `playwrightTestId`: declaring the field here keeps this file compiling
 * against either copy.
 */
export type AtcRun = AtcResult & { playwrightTestId?: string };

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
  runId?: string
  results?: Record<string, AtcRun[]>
}

/** What `readRunReport` returns: the results, or the reasons the report cannot be used. */
export interface RunReport {
  results: Record<string, AtcRun[]>
  problems: string[]
}

/** A Jira issue key: project key, dash, number. */
const ISSUE_KEY = /^[A-Z][A-Z0-9_]+-\d+$/;

/** The method name a synthetic record carries for an ATC that never finished. */
export const UNFINISHED_METHOD = '(did not finish)';

// ============================================
// Builders
// ============================================

/** Merge the `results` of several reports: executions of one ATC are concatenated. */
export function mergeAtcReports(reports: AtcReport[]): Record<string, AtcRun[]> {
  const merged: Record<string, AtcRun[]> = {};
  for (const report of reports) {
    for (const [testId, executions] of Object.entries(report.results ?? {})) {
      merged[testId] = [...(merged[testId] ?? []), ...executions];
    }
  }
  return merged;
}

/**
 * Add a FAIL record for every ATC a FAILED test started but never recorded:
 * the `atc` annotation is pushed when the ATC starts, the record only when it
 * ends, so a test that timed out inside it has the first and not the second.
 */
export function addUnfinishedAtcs(
  results: Record<string, AtcRun[]>,
  outcomes: Pick<OutcomesDocument, 'generatedAt' | 'records'>,
): Record<string, AtcRun[]> {
  const merged: Record<string, AtcRun[]> = { ...results };

  for (const record of outcomes.records) {
    if (record.testStatus !== 'FAILED') {
      continue;
    }
    for (const atcId of record.atcIds) {
      const executions = merged[atcId] ?? [];
      // A record written before the decorator stamped the test id cannot be
      // tied to one test: any execution of the ATC counts as finished.
      const finished = executions.some(e => e.playwrightTestId === undefined || e.playwrightTestId === record.id);
      if (finished) {
        continue;
      }
      merged[atcId] = [...executions, {
        testId: atcId,
        methodName: UNFINISHED_METHOD,
        className: '',
        status: 'FAIL',
        error: `ATC did not finish: the test "${record.title}" failed (${record.cause ?? 'failed'}) before the ATC recorded a result.`
          + `${record.error ? ` ${record.error}` : ''}`,
        executedAt: outcomes.generatedAt,
        duration: record.durationMs,
        softFail: false,
        playwrightTestId: record.id,
      }];
    }
  }

  return merged;
}

/**
 * One Xray entry per ATC. FAILED when any execution failed, PASSED otherwise;
 * an ATC whose every execution was a runtime skip is left out (NOT RUN). Never
 * carries `testInfo`, so Xray cannot create a Test.
 */
export function buildXrayTests(results: Record<string, AtcRun[]>): XrayTestEntry[] {
  const tests: XrayTestEntry[] = [];

  for (const [testId, executions] of Object.entries(results)) {
    const ran = executions.filter(e => e.status !== 'SKIP');
    if (ran.length === 0) {
      continue;
    }
    const finalStatus = ran.some(e => e.status === 'FAIL') ? 'FAILED' : 'PASSED';
    const lastExecution = ran[ran.length - 1];

    tests.push({
      testKey: testId,
      status: finalStatus,
      comment:
        `KATA ATC: ${lastExecution.methodName}\n`
        + `Executions: ${ran.length}\n`
        + `Duration: ${lastExecution.duration}ms\n`
        + `Last run: ${lastExecution.executedAt}\n${
          lastExecution.error !== null ? `\nError:\n${lastExecution.error}` : ''
        }`,
    });
  }

  return tests;
}

/** The import body: always an EXISTING Test Execution, never `info`. */
export function buildXrayPayload(executionKey: string, results: Record<string, AtcRun[]>): XrayExecutionPayload {
  return { testExecutionKey: executionKey, tests: buildXrayTests(results) };
}

/** One `<id> (<Class.method>)` per ATC id that is not a Jira issue key. */
export function findKeyProblems(results: Record<string, AtcRun[]>): string[] {
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
// Reading one run's reports
// ============================================

function readJson<T>(path: string, problems: string[]): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as T;
  }
  catch (error) {
    problems.push(`unreadable report ${path} (${error instanceof Error ? error.message : String(error)})`);
    return null;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isResultsReport(value: unknown): value is AtcReport {
  return isPlainObject(value)
    && (value.results === undefined || (isPlainObject(value.results) && Object.values(value.results).every(Array.isArray)));
}

/**
 * Read one `atc_results.json` (absent = no ATC recorded) with its sibling
 * `test-outcomes.json` (absent = nothing to add, nothing to compare). A report
 * whose run id differs from the outcomes' run id is from another run: stale.
 */
export function readRunReport(reportPath: string): RunReport {
  const problems: string[] = [];
  const outcomesPath = join(dirname(reportPath), 'test-outcomes.json');

  const report = existsSync(reportPath) ? readJson<AtcReport>(reportPath, problems) : null;
  const outcomes = existsSync(outcomesPath) ? readJson<OutcomesDocument>(outcomesPath, problems) : null;

  if (report !== null && !isResultsReport(report)) {
    problems.push(`unreadable report ${reportPath} (no results map)`);
  }
  if (outcomes !== null && !(isPlainObject(outcomes) && Array.isArray(outcomes.records))) {
    problems.push(`unreadable report ${outcomesPath} (no records list)`);
  }
  if (report !== null && outcomes?.runId !== undefined && report.runId !== outcomes.runId) {
    problems.push(`stale report ${reportPath} (run ${report.runId ?? 'unknown'}, but ${outcomesPath} is run ${outcomes.runId})`);
  }
  if (problems.length > 0) {
    return { results: {}, problems };
  }

  const results = mergeAtcReports(report ? [report] : []);
  return { results: outcomes ? addUnfinishedAtcs(results, outcomes) : results, problems };
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

  if (out === '') {
    console.error('Usage: bun tests/utils/xrayResults.ts --execution <TEST-EXECUTION-KEY> --out <file> <atc_results.json...>');
    return 2;
  }
  if (!ISSUE_KEY.test(execution)) {
    console.log(`::error title=Xray import blocked::The execution key "${execution}" is not a Test Execution key (PROJECT-123 shape), nothing was sent to Xray.`);
    return 2;
  }

  const runs = reports.map(readRunReport);
  const readProblems = runs.flatMap(r => r.problems);
  if (readProblems.length > 0) {
    console.log(`::error title=Xray import blocked::Nothing was sent to Xray: ${readProblems.join('; ')}.`);
    return 1;
  }

  const results = mergeAtcReports(runs.map(r => ({ results: r.results })));

  const problems = findKeyProblems(results);
  if (problems.length > 0) {
    console.log(`::error title=Xray import blocked::${keyProblemLine(problems)}`);
    return 1;
  }

  const payload = buildXrayPayload(execution, results);
  if (payload.tests.length === 0) {
    console.log(`::notice title=Xray import skipped::No ATC result to import in this run (${reports.length} report path(s) read).`);
    return 0;
  }

  writeFileSync(out, `${JSON.stringify(payload, null, 2)}\n`);
  console.log(`Wrote ${payload.tests.length} result(s) for existing Tests into ${out} (target ${execution}).`);
  return 0;
}

if (import.meta.main) {
  process.exit(runCli(process.argv.slice(2)));
}
