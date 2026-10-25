/**
 * KATA Architecture - Test Outcome Classes
 *
 * Gives every test a run knows about exactly ONE outcome class, and computes
 * the run headline from those classes instead of from Playwright's `ok()` or
 * Allure's status (ADR-0020).
 *
 * Why it exists (measured, then rule): Playwright reports a test skipped by a
 * failed `beforeAll` or a failed `describe.serial` sibling as `ok()`, and a
 * failed setup PROJECT leaves its dependents with no result at all. Allure
 * files an expected failure (`test.fail`) as passed. Either way a headline can
 * read "all passed" while known defects and setup failures hide in it.
 *
 * Measured on @playwright/test 1.60.0:
 *   - setup cascade = `status: 'skipped'` + `expectedStatus: 'passed'` + no
 *     `skip`/`fixme` annotation (beforeAll throw, serial sibling failure)
 *   - a conditional `test.skip()` in a hook or describe DOES carry a `skip`
 *     annotation, so it stays `skipped`
 *   - a failed dependency project / `--max-failures` leaves tests with ZERO
 *     results: records must come from `suite.allTests()`, never from the
 *     `onTestEnd` calls received
 *   - runtime annotations reach the reporter (the `atc` ids ride on them)
 *
 * Pure: no Playwright runtime import, no file system, no tracker call.
 * Mapping onto the doctrine's outcome vocabulary
 * (`agentic-qa-core/references/discovery-driven-doctrine.md` §5) goes through
 * the sprint source's `TestStatus`, so the board counts these records with
 * `countedOutcome` unchanged.
 */

import type { TestStatus } from '@/cli/lib/sprint-source/types';

// ============================================
// Vocabulary
// ============================================

export const OUTCOMES_SCHEMA = 'test-outcomes/1.0';
export const OUTCOMES_PATH = 'reports/test-outcomes.json';

export const OUTCOME_CLASSES = ['passed', 'failed', 'known-defect', 'unexpected-pass', 'skipped'] as const;
export type OutcomeClass = (typeof OUTCOME_CLASSES)[number];

/** Why a test landed in its class. `null` for a plain pass. */
export type OutcomeCause
  = | 'assertion'
    | 'timeout'
    | 'setup-cascade'
    | 'dependency-failed'
    | 'expected-failure'
    | 'skip-annotation'
    | 'not-run';

export type ActionItem = 'unexpected-pass' | 'known-defect-without-key';

/** Playwright's own statuses, copied so this module needs no runtime import. */
export type PlaywrightStatus = 'passed' | 'failed' | 'timedOut' | 'skipped' | 'interrupted';

/**
 * The status each class reports to the board. The two failures that were NOT
 * observed (the body never ran because setup failed) are overridden to
 * BLOCKED in `testStatusOf`: PASSED and FAILED need an observation (D21).
 */
export const TEST_STATUS_OF_CLASS = {
  'passed': 'PASSED',
  'failed': 'FAILED',
  'known-defect': 'FAILED',
  'unexpected-pass': 'PASSED',
  'skipped': 'NOT RUN',
} as const satisfies Record<OutcomeClass, TestStatus>;

/** Causes whose test body never executed although it was expected to. */
const NOT_OBSERVED_CAUSES: ReadonlySet<OutcomeCause> = new Set(['setup-cascade', 'dependency-failed']);

export function testStatusOf(outcome: OutcomeClass, cause: OutcomeCause | null): TestStatus {
  if (outcome === 'failed' && cause !== null && NOT_OBSERVED_CAUSES.has(cause)) {
    return 'BLOCKED';
  }
  return TEST_STATUS_OF_CLASS[outcome];
}

// ============================================
// Input and record shapes
// ============================================

export interface OutcomeAnnotation {
  type: string
  description?: string
}

export interface OutcomeAttempt {
  status: PlaywrightStatus
  durationMs: number
  error?: string
}

/** What the reporter extracts from one `TestCase`; plain data so it can be unit tested. */
export interface OutcomeInput {
  id: string
  title: string
  titlePath: string[]
  file: string
  line: number
  project: string
  /**
   * Identity of the parent suite (describe) INCLUDING the project, so the
   * same file matched by two projects never shares a cascade root.
   */
  parentKey: string
  expectedStatus: PlaywrightStatus
  annotations: OutcomeAnnotation[]
  tags: string[]
  /** Every attempt, in order. Empty = the test never ran. */
  attempts: OutcomeAttempt[]
}

export interface OutcomeRecord {
  id: string
  title: string
  titlePath: string[]
  file: string
  line: number
  project: string
  class: OutcomeClass
  testStatus: TestStatus
  cause: OutcomeCause | null
  /** The failed test that took this one down (setup cascade / dependency). */
  rootTestId: string | null
  attempts: number
  flaky: boolean
  durationMs: number
  atcIds: string[]
  knownDefect: string | null
  skipReason: string | null
  error: string | null
  actionItem: ActionItem | null
}

export interface OutcomeSummary {
  total: number
  passed: number
  failed: number
  knownDefect: number
  unexpectedPass: number
  skipped: number
  /** Failed tests whose body never ran (setup cascade or failed dependency). */
  setupFailures: number
  /** Skipped tests the run never reached (max-failures, interrupt). */
  notRun: number
  flaky: number
  actionItems: number
}

export interface RunInfo {
  status: string
  environment: string
  baseUrl: string
  ci: { runUrl: string, sha: string | null } | null
  playwright: string
}

export interface OutcomesDocument {
  schema: typeof OUTCOMES_SCHEMA
  generatedAt: string
  /** The run id KataReporter also stamps on reports/atc_results.json, so a reader can tell a stale pair. */
  runId?: string
  run: RunInfo
  summary: OutcomeSummary
  records: OutcomeRecord[]
}

// ============================================
// Classification
// ============================================

/** A whole marker value is a key, never a key-shaped fragment of prose (`UTF-8`, `SHA-256`). */
const DEFECT_KEY = /^[A-Z][A-Z0-9]+-\d+$/;
/** The only form of a `test.fail` description that names a key (automation-standards §"Blocked by a known bug"). */
const BLOCKED_BY = /^Blocked by ([A-Z][A-Z0-9]+-\d+)(?![\w-])/;
const FAILED_STATUSES: ReadonlySet<PlaywrightStatus> = new Set(['failed', 'timedOut']);
const MAX_ERROR_LEN = 300;

function hasAnnotation(input: OutcomeInput, ...types: string[]): boolean {
  return input.annotations.some(a => types.includes(a.type));
}

/**
 * The defect a `test.fail` names, from the first marker that holds a key:
 * a `known-defect` annotation whose whole value is a key, the
 * `@blocked:{BUG-KEY}` tag, or a `test.fail` description that starts with
 * `Blocked by {BUG-KEY}` (`test-automation/references/automation-standards.md`
 * §"Blocked by a known bug"). Free text never mints a key: a reason such as
 * "Broken UTF-8 handling" leaves the record keyless, which is an action item.
 */
export function knownDefectKey(input: Pick<OutcomeInput, 'annotations' | 'tags'>): string | null {
  const exact = [
    ...input.annotations.filter(a => a.type === 'known-defect').map(a => (a.description ?? '').trim()),
    ...input.tags.filter(t => t.startsWith('@blocked:')).map(t => t.slice('@blocked:'.length).trim()),
  ];
  const key = exact.find(candidate => DEFECT_KEY.test(candidate));
  if (key !== undefined) {
    return key;
  }
  for (const a of input.annotations) {
    const match = a.type === 'fail' ? (a.description ?? '').trim().match(BLOCKED_BY) : null;
    if (match) {
      return match[1];
    }
  }
  return null;
}

function skipReason(input: OutcomeInput): string | null {
  const annotation = input.annotations.find(a => a.type === 'skip' || a.type === 'fixme');
  if (!annotation) {
    return null;
  }
  return annotation.description ? `${annotation.type}: ${annotation.description}` : annotation.type;
}

/** First line of an error, ANSI-stripped and truncated: the record is a pointer, not the log. */
export function errorLine(message: string | undefined): string | null {
  if (message === undefined || message === '') {
    return null;
  }
  // eslint-disable-next-line no-control-regex -- stripping ANSI colour codes is the point
  const plain = message.replace(/\u001B\[[0-9;]*m/g, '').trim();
  const first = plain.split('\n')[0] ?? '';
  return first.length > MAX_ERROR_LEN ? `${first.slice(0, MAX_ERROR_LEN)}...` : first;
}

interface Classified {
  outcome: OutcomeClass
  cause: OutcomeCause | null
}

/** Class of a test from its own last attempt; zero-result tests are resolved by `buildOutcomeRecords`. */
export function classifyAttempt(input: OutcomeInput): Classified {
  const last = input.attempts.at(-1);

  if (input.expectedStatus === 'skipped' && hasAnnotation(input, 'skip', 'fixme')) {
    return { outcome: 'skipped', cause: 'skip-annotation' };
  }
  if (last === undefined || last.status === 'interrupted') {
    return { outcome: 'skipped', cause: 'not-run' };
  }
  if (input.expectedStatus === 'failed') {
    if (last.status === 'passed') {
      return { outcome: 'unexpected-pass', cause: 'expected-failure' };
    }
    // Only an observed failure reproduces the defect: a timeout falls through to failed / timeout
    if (last.status === 'failed') {
      return { outcome: 'known-defect', cause: 'expected-failure' };
    }
  }
  if (last.status === 'passed') {
    return { outcome: 'passed', cause: null };
  }
  if (last.status === 'failed') {
    return { outcome: 'failed', cause: 'assertion' };
  }
  if (last.status === 'timedOut') {
    return { outcome: 'failed', cause: 'timeout' };
  }
  // skipped
  if (hasAnnotation(input, 'skip', 'fixme')) {
    return { outcome: 'skipped', cause: 'skip-annotation' };
  }
  // Expected to run, skipped with no skip/fixme marker: a beforeAll or a
  // serial sibling failed and took it down. Never a skip.
  return { outcome: 'failed', cause: 'setup-cascade' };
}

function transitiveDependencies(project: string, dependencies: Record<string, string[]>): Set<string> {
  const seen = new Set<string>();
  const queue = [...(dependencies[project] ?? [])];
  while (queue.length > 0) {
    const next = queue.shift() as string;
    if (seen.has(next)) {
      continue;
    }
    seen.add(next);
    queue.push(...(dependencies[next] ?? []));
  }
  return seen;
}

/**
 * One record per test, in input order. `projectDependencies` maps a project
 * name to the projects it depends on (`config.projects[].dependencies`); a
 * test with no result whose dependency failed is a setup failure, not a skip.
 */
export function buildOutcomeRecords(
  inputs: readonly OutcomeInput[],
  projectDependencies: Record<string, string[]> = {},
): OutcomeRecord[] {
  const classified = inputs.map(input => ({ input, ...classifyAttempt(input) }));

  // A root is any test Playwright calls `unexpected`: a plain failure or timeout,
  // and an unexpected pass, which also stops a serial group or a setup project
  const isPlainFailure = (c: (typeof classified)[number]) =>
    (c.outcome === 'failed' && (c.cause === 'assertion' || c.cause === 'timeout')) || c.outcome === 'unexpected-pass';

  const firstFailureInSuite = new Map<string, string>();
  const firstFailureInProject = new Map<string, string>();
  for (const c of classified) {
    if (!isPlainFailure(c)) {
      continue;
    }
    if (!firstFailureInSuite.has(c.input.parentKey)) {
      firstFailureInSuite.set(c.input.parentKey, c.input.id);
    }
    if (!firstFailureInProject.has(c.input.project)) {
      firstFailureInProject.set(c.input.project, c.input.id);
    }
  }

  return classified.map(({ input, outcome, cause }) => {
    let finalOutcome = outcome;
    let finalCause = cause;
    let rootTestId: string | null = null;

    if (finalCause === 'setup-cascade') {
      rootTestId = firstFailureInSuite.get(input.parentKey) ?? null;
    }
    else if (finalCause === 'not-run' && input.attempts.length === 0) {
      for (const dependency of transitiveDependencies(input.project, projectDependencies)) {
        const root = firstFailureInProject.get(dependency);
        if (root !== undefined) {
          finalOutcome = 'failed';
          finalCause = 'dependency-failed';
          rootTestId = root;
          break;
        }
      }
    }

    const last = input.attempts.at(-1);
    // Flaky = the last attempt matched the expectation and an earlier one did not
    // (a `test.fail` that passed first and failed on retry is flaky too)
    const flaky = last?.status === input.expectedStatus
      && input.attempts.slice(0, -1).some(a => a.status !== input.expectedStatus);
    const defect = finalOutcome === 'known-defect' || finalOutcome === 'unexpected-pass'
      ? knownDefectKey(input)
      : null;

    let actionItem: ActionItem | null = null;
    if (finalOutcome === 'unexpected-pass') {
      actionItem = 'unexpected-pass';
    }
    else if (finalOutcome === 'known-defect' && defect === null) {
      actionItem = 'known-defect-without-key';
    }

    const atcIds = [...new Set(
      input.annotations
        .filter(a => a.type === 'atc' && a.description)
        .map(a => a.description as string),
    )];

    return {
      id: input.id,
      title: input.title,
      titlePath: input.titlePath,
      file: input.file,
      line: input.line,
      project: input.project,
      class: finalOutcome,
      testStatus: testStatusOf(finalOutcome, finalCause),
      cause: finalCause,
      rootTestId,
      attempts: input.attempts.length,
      flaky,
      durationMs: input.attempts.reduce((sum, a) => sum + a.durationMs, 0),
      atcIds,
      knownDefect: defect,
      skipReason: finalOutcome === 'skipped' ? skipReason(input) : null,
      error: last && FAILED_STATUSES.has(last.status) ? errorLine(last.error) : null,
      actionItem,
    };
  });
}

// ============================================
// Summary and headline
// ============================================

export function summarizeOutcomes(records: readonly OutcomeRecord[]): OutcomeSummary {
  const count = (predicate: (r: OutcomeRecord) => boolean) => records.filter(predicate).length;
  return {
    total: records.length,
    passed: count(r => r.class === 'passed'),
    failed: count(r => r.class === 'failed'),
    knownDefect: count(r => r.class === 'known-defect'),
    unexpectedPass: count(r => r.class === 'unexpected-pass'),
    skipped: count(r => r.class === 'skipped'),
    setupFailures: count(r => r.class === 'failed' && r.cause !== null && NOT_OBSERVED_CAUSES.has(r.cause)),
    notRun: count(r => r.class === 'skipped' && r.cause === 'not-run'),
    flaky: count(r => r.flaky),
    actionItems: count(r => r.actionItem !== null),
  };
}

function plural(n: number, singular: string, pluralForm = `${singular}S`): string {
  return `${n} ${n === 1 ? singular : pluralForm}`;
}

export interface Headline {
  /** Green only when nothing failed, nothing passed unexpectedly, no action item is open and every test was reached. */
  ok: boolean
  text: string
}

/** The one-line verdict of a run, from the records only. */
export function outcomeHeadline(summary: OutcomeSummary, runStatus = 'passed'): Headline {
  if (summary.total === 0) {
    return { ok: false, text: 'NO TESTS RAN' };
  }

  // Playwright's run status still counts: an error outside any test (a
  // worker crash, a throw at file load, a global setup error) fails the run
  // while every record reads clean.
  const ok = summary.failed === 0
    && summary.unexpectedPass === 0
    && summary.actionItems === 0
    && summary.notRun === 0
    && runStatus === 'passed';

  if (ok) {
    const caveats: string[] = [];
    if (summary.knownDefect > 0) {
      caveats.push(plural(summary.knownDefect, 'KNOWN DEFECT'));
    }
    if (summary.skipped > 0) {
      caveats.push(`${summary.skipped} SKIPPED`);
    }
    return { ok, text: caveats.length === 0 ? 'ALL TESTS PASSED' : `PASSED WITH ${caveats.join(', ')}` };
  }

  const parts: string[] = [];
  if (summary.failed > 0) {
    const plain = summary.failed - summary.setupFailures;
    const detail = summary.setupFailures > 0
      ? ` (${summary.setupFailures} NOT OBSERVED: SETUP FAILED, BLOCKED ON THE BOARD${plain > 0 ? `, ${plain} ASSERTION/TIMEOUT` : ''})`
      : '';
    parts.push(`${summary.failed} FAILED${detail}`);
  }
  if (summary.unexpectedPass > 0) {
    parts.push(plural(summary.unexpectedPass, 'UNEXPECTED PASS', 'UNEXPECTED PASSES'));
  }
  if (summary.notRun > 0) {
    parts.push(`${summary.notRun} NOT RUN`);
  }
  const keyless = summary.actionItems - summary.unexpectedPass;
  if (keyless > 0) {
    parts.push(`${keyless} EXPECTED FAILURE WITHOUT A DEFECT KEY`);
  }
  if (runStatus === 'interrupted' || runStatus === 'timedout') {
    parts.push(`RUN ${runStatus.toUpperCase()}`);
  }
  else if (runStatus !== 'passed' && parts.length === 0) {
    parts.push('ERROR OUTSIDE ANY TEST');
  }
  return { ok, text: `EXECUTION FAILED: ${parts.join(', ')}` };
}

/**
 * `playwright test --list` reaches the reporter's onEnd too, with no attempt
 * anywhere: nothing ran, so there is no outcome to record. The records of the
 * last real run stay where they are: a listing is not a run.
 */
export function isListOnlyRun(runStatus: string, inputs: readonly Pick<OutcomeInput, 'attempts'>[]): boolean {
  return runStatus === 'passed' && inputs.length > 0 && inputs.every(i => i.attempts.length === 0);
}

/** The banner of a listing: never "passed", since nothing ran. */
export function listedHeadline(total: number): string {
  return `LISTED ${plural(total, 'TEST')}, NONE RUN`;
}

/** One line of counts that always follows the headline. */
export function outcomeCountsLine(summary: OutcomeSummary): string {
  return [
    `${summary.total} total`,
    `${summary.passed} passed`,
    `${summary.failed} failed (${summary.setupFailures} setup)`,
    `${summary.knownDefect} known defects`,
    `${summary.unexpectedPass} unexpected passes`,
    `${summary.skipped} skipped (${summary.notRun} not run)`,
    `${summary.flaky} flaky`,
  ].join(' · ');
}

/** Human lines for every open action item and every setup root, for the banner and the step summary. */
export function actionItemLines(records: readonly OutcomeRecord[]): string[] {
  // The same file can run under two projects: name the project so two lines never look like a duplicate
  const named = (r: OutcomeRecord) => (r.project === '' ? r.title : `${r.title} [${r.project}]`);
  const lines: string[] = [];
  for (const r of records) {
    if (r.actionItem === 'unexpected-pass') {
      const defect = r.knownDefect ? ` (expected failure for ${r.knownDefect})` : '';
      lines.push(`UNEXPECTED PASS: ${named(r)}${defect}: retest the defect, then remove the expected-failure marker`);
    }
    else if (r.actionItem === 'known-defect-without-key') {
      lines.push(`EXPECTED FAILURE WITHOUT A DEFECT KEY: ${named(r)}: call knownDefect('{BUG-KEY}') (tests/utils/knownDefect.ts) or tag it @blocked:{BUG-KEY}`);
    }
  }

  const byRoot = new Map<string, number>();
  for (const r of records) {
    if (r.rootTestId !== null) {
      byRoot.set(r.rootTestId, (byRoot.get(r.rootTestId) ?? 0) + 1);
    }
  }
  for (const [rootId, count] of byRoot) {
    const root = records.find(r => r.id === rootId);
    const name = root ? named(root) : rootId;
    lines.push(`SETUP FAILED: ${name} took down ${plural(count, 'test', 'tests')} (counted FAILED here, BLOCKED on the board: not observed)`);
  }
  return lines;
}

/** Markdown block for `$GITHUB_STEP_SUMMARY`: titles and keys only, never error text. */
export function stepSummaryMarkdown(summary: OutcomeSummary, records: readonly OutcomeRecord[], runStatus = 'passed'): string {
  const headline = outcomeHeadline(summary, runStatus);
  const rows: Array<[string, number]> = [
    ['Passed', summary.passed],
    ['Failed', summary.failed],
    ['  of which setup failures (not observed, BLOCKED on the board)', summary.setupFailures],
    ['Known defects (expected failures)', summary.knownDefect],
    ['Unexpected passes', summary.unexpectedPass],
    ['Skipped', summary.skipped],
    ['  of which not run (the run stopped first)', summary.notRun],
    ['Flaky (passed on retry)', summary.flaky],
    ['Total', summary.total],
  ];
  const lines = [
    `### Test outcomes (\`${OUTCOMES_PATH}\`)`,
    '',
    `**${headline.ok ? 'OK' : 'NOT OK'}: ${headline.text}**`,
    '',
    '| Outcome | Count |',
    '|---|---:|',
    ...rows.map(([label, n]) => `| ${label} | ${n} |`),
  ];
  const items = actionItemLines(records);
  if (items.length > 0) {
    lines.push('', '**Action items**', '', ...items.map(item => `- ${item}`));
  }
  return `${lines.join('\n')}\n`;
}

export function buildOutcomesDocument(records: OutcomeRecord[], run: RunInfo, now = new Date()): OutcomesDocument {
  return {
    schema: OUTCOMES_SCHEMA,
    generatedAt: now.toISOString(),
    run,
    summary: summarizeOutcomes(records),
    records,
  };
}
