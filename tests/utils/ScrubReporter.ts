/**
 * KATA Architecture - Scrubbing Reporter
 *
 * Playwright ends its own API-call step (`GET "/x"`) with an error whose "Call log" carries the request headers (Bearer token, cookies,
 * CSRF token, session id) when the call fails on transport. Every reporter receives those same error objects, in `reporter:` order, so
 * this one, listed FIRST, cleans them in place before Allure, HTML, JSON and JUnit read them. Text attachments that carry the same call log
 * (the `error-context` markdown) are rewritten in place too. It prints nothing.
 *
 * Usage in playwright.config.ts (it MUST be the first entry):
 *   reporter: [['./tests/utils/ScrubReporter.ts'], ...otherReporters]
 *
 * Any failure here is swallowed: a reporter that throws would break the whole run, and `reports:share` still scans for tokens.
 */

import type { Reporter, TestCase, TestError, TestResult, TestStep } from '@playwright/test/reporter';

import { readFileSync, statSync, writeFileSync } from 'node:fs';

import { scrubSecrets } from '@utils/scrubSecrets';

/** Text attachments worth cleaning (Playwright writes the failure text, with its call log, to an `error-context` markdown file). */
const TEXT_ATTACHMENT = /^(?:text\/|application\/json)/i;
const MAX_ATTACHMENT_BYTES = 2_000_000;

/** Clean the text fields of an error object in place. */
function scrubError(error: TestError | undefined): void {
  if (error === undefined) {
    return;
  }
  for (const key of ['message', 'stack', 'snippet'] as const) {
    const value = error[key];
    if (typeof value === 'string') {
      error[key] = scrubSecrets(value);
    }
  }
}

/** Clean a text attachment file in place, before the reporters below copy it. */
function scrubAttachment(attachment: TestResult['attachments'][number]): void {
  if (attachment.path === undefined || !TEXT_ATTACHMENT.test(attachment.contentType) || statSync(attachment.path).size > MAX_ATTACHMENT_BYTES) {
    return;
  }
  const text = readFileSync(attachment.path, 'utf8');
  const clean = scrubSecrets(text);
  if (clean !== text) {
    writeFileSync(attachment.path, clean, 'utf8');
  }
}

function scrubStep(step: TestStep): void {
  scrubError(step.error);
  for (const child of step.steps) {
    scrubStep(child);
  }
}

class ScrubReporter implements Reporter {
  onStepEnd(_test: TestCase, _result: TestResult, step: TestStep): void {
    try {
      scrubError(step.error);
    }
    catch {
      // never break the run
    }
  }

  onTestEnd(_test: TestCase, result: TestResult): void {
    try {
      for (const error of result.errors) {
        scrubError(error);
      }
      scrubError(result.error);
      for (const step of result.steps) {
        scrubStep(step);
      }
      for (const attachment of result.attachments) {
        scrubAttachment(attachment);
      }
    }
    catch {
      // never break the run
    }
  }

  printsToStdio(): boolean {
    return false;
  }
}

export default ScrubReporter;
