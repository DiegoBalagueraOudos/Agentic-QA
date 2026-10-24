# ADR-0020 — Every automated test gets one outcome class, and the run headline comes from those records

- **Status:** Accepted (by the conductor of the discovery-impl fleet, on the owner's decisions D13 and D21, 2026-10-24)
- **Date:** 2026-10-24
- **Deciders:** framework owner (boilerplate maintainer), through the fleet conductor's plan approval for the `e2-outcomes-evidence` delivery
- **Tags:** reporting, test-runner, playwright, outcome-classes, sprint-board
- **Supersedes:** —
- **Superseded by:** —

---

## Context

The run headline printed by `tests/KataReporter.ts` came from Playwright's `FullResult.status`, and the reports the team reads came from Allure. Both can read "all passed" over tests that were never observed passing. The reference implementation this delivery ports measured a report that counted 12 of 91 tests as passed when they were not: Allure files a `test.fail` inversion as passed.

The same shapes were re-measured on the Playwright version this repo installs, with throwaway specs run through the real reporter:

- A test skipped because a `beforeAll` threw, or because an earlier `describe.serial` sibling failed, finishes with `status: 'skipped'`, `expectedStatus: 'passed'` and no `skip` or `fixme` annotation. Playwright's `ok()` is true for it.
- A test whose dependency project failed, or which `--max-failures` never reached, gets no `onTestEnd` call and zero results.
- A conditional `test.skip()` inside a hook or a describe carries a `skip` annotation on every affected test.
- `test.fail()` sets `expectedStatus: 'failed'` and a `fail` annotation; a passing body then reads `status: 'passed'`, `outcome: 'unexpected'`.
- Annotations pushed at runtime (`test.info().annotations`) reach the reporter.
- `playwright test --list` also runs the reporter's `onEnd`, with no result anywhere.

The future Sprint Board (E3) needs these outcomes per test case, in the vocabulary of E1's `TestStatus` (ADR-0019) and of the discovery-driven doctrine (`agentic-qa-core/references/discovery-driven-doctrine.md` §5): PASSED and FAILED only on observation, BLOCKED and DEFERRED as reasons a test is NOT RUN.

## Decision

We will classify every test the run knows about into exactly one outcome class, write the records to `reports/test-outcomes.json` (schema `test-outcomes/1.0`), and compute the console headline and the GitHub step summary from those records only. The classifier is `tests/utils/testOutcomes.ts`, pure and tracker-free; `KataReporter` builds its input in `onEnd` from `suite.allTests()`, so a test with zero results stays in the denominator.

| Last attempt | Class | Cause | `TestStatus` |
|---|---|---|---|
| passed, expected to pass | `passed` | — | PASSED |
| failed or timed out, expected to pass; or timed out under an expected failure | `failed` | `assertion` / `timeout` | FAILED |
| skipped, expected to pass, no `skip`/`fixme` annotation | `failed` | `setup-cascade` | BLOCKED |
| no result, a (transitive) dependency project had a failure | `failed` | `dependency-failed` | BLOCKED |
| no result otherwise, or interrupted | `skipped` | `not-run` | NOT RUN |
| expected failure (`test.fail`), failed (a timeout never reproduces the defect) | `known-defect` | `expected-failure` | FAILED |
| expected failure, passed | `unexpected-pass` | `expected-failure` | PASSED |
| skipped with a `skip`/`fixme` annotation | `skipped` | `skip-annotation` | NOT RUN |

1. **A setup cascade is `failed` in the headline and BLOCKED on the board.** The test was expected to pass and did not, so the run cannot read green; but its body never ran, so it was not observed and PASSED or FAILED would be a false observation (D21). BLOCKED is the doctrine's "the blocking ladder is still open" reason: someone has to fix the setup. The pairing is stated in the banner and the step summary ("NOT OBSERVED: SETUP FAILED, BLOCKED ON THE BOARD") so nobody reads BLOCKED as a softer result. Each cascaded record names its root (`rootTestId`): the first plain failure in the same describe of the same project, or in the failed dependency project.
2. **An expected failure names its defect.** `knownDefect('<KEY>')` (`tests/utils/knownDefect.ts`) pushes a `known-defect` annotation and calls `test.fail()` in one call. The repo's existing markers, the `@blocked:<KEY>` title tag and `test.fail(true, 'Blocked by <KEY>')`, are read too. A key is read only from a whole marker value or a description that starts with `Blocked by <KEY>`: free text such as "Broken UTF-8 handling" never mints a key. An expected failure that names no key is still `known-defect`, plus the action item `known-defect-without-key`.
3. **An unexpected pass is an action item, never silently green.** Its `TestStatus` is PASSED because the assertions were observed passing, but it keeps the headline red until the bug is retested and the marker removed.
4. **`skipped` never becomes DEFERRED or BLOCKED automatically.** Both need a QA decision record the reporter cannot mint (a gate that opens on a value the gated agent wrote is open by construction).
5. **The headline is green only** when no record is `failed` or `unexpected-pass`, no action item is open, no test was left not run, and Playwright's own run status is `passed` (an error outside any test fails the run while every record reads clean). A green run still names its known defects and skips (`PASSED WITH 2 KNOWN DEFECTS, 1 SKIPPED`). The reporter never changes the exit code: Playwright still owns it.
6. **Retries:** the last attempt decides the class; the record keeps the attempt count and `flaky: true` when the last attempt matched the expectation and an earlier one did not (a `test.fail` test that passed first and failed on retry is flaky too). There is no sixth class. A test Playwright calls `unexpected` (a failure, a timeout, or an unexpected pass) is the root of the setup cascade or failed dependency it causes.
7. **TC ids ride on the `@atc` decorator**, which now also pushes an `atc` annotation per ATC id; the records carry them as `atcIds`. A test whose body never ran has no ids in this version. The Xray/Jira write-back (`tests/utils/jiraSync.ts`, `reports/atc_results.json`) is unchanged.
8. **Records hold the run's environment** (`run.environment`), because a run in a lower or local environment is not an execution the board may count. Error text is the first line only, ANSI-stripped and truncated, and never reaches the step summary.

The board (E3) will load the file, refuse any other schema, use `testStatus` through `countedOutcome()` unchanged, show automated outcomes as their own lane beside the TMS status (never overwriting it), and ignore a run whose environment is not `testing.default_env`. `TEST_STATUS_OF_CLASS` is typed `satisfies Record<OutcomeClass, TestStatus>` against E1's type, so a new class or status is a compile error.

## Consequences

- **Positive:** a run with a broken setup, a hidden expected failure or a fixed bug can no longer print ALL TESTS PASSED. The board gets per-test outcomes in its own vocabulary without parsing Allure. The classifier is unit-tested on the measured shapes (`bun test tests/utils`).
- **Negative / trade-offs:** the final banner text changes for any run that is not truly all-passed, so a CI step that grepped the old failure text must read the records instead. A test that never ran carries no ATC ids until a static resolver exists. The classification depends on Playwright's skip and annotation shapes: re-measure them when `@playwright/test` moves a minor version.
- **Inherent limit:** a static or describe-level `test.fail` whose `beforeAll` throws reads `known-defect` on its first test, exactly as Playwright counts it as expected; a one-test group then reads green. Marking expected failures inside the test body (`knownDefect()`) avoids it.
- **Neutral / follow-ups:** the CI workflows do not run `bun test`, so the classifier tests gate only locally and in `repo:check` pieces a maintainer runs; wiring unit tests into CI is a separate decision. A static TC resolver for skipped tests and the board lane are E3 work.

## Alternatives considered

- **Keep Allure as the source of the headline.** Rejected: Allure's status is the measured cause of the miscount.
- **Map a setup cascade to FAILED.** Rejected: the body never ran, and PASSED/FAILED are observation-only (D21). BLOCKED keeps the board honest while the headline still counts it as a failure.
- **Build records from the `onTestEnd` calls received.** Rejected: tests behind a failed dependency project or `--max-failures` never get one, and would vanish from the denominator.
- **Read the board's `ticket_key_pattern` for defect keys.** Rejected: the reporter stays free of project configuration and tracker calls; the generic key shape is enough to find the marker.

## References

- Doctrine: `.agents/skills/agentic-qa-core/references/discovery-driven-doctrine.md` §5.
- E1 types and `countedOutcome()`: `cli/lib/sprint-source/types.ts` (ADR-0019).
- Expected-failure convention: `.agents/skills/test-automation/references/automation-standards.md` §"Blocked by a known bug".
- Results analysis: `.agents/skills/regression-testing/references/failure-classification.md`.
