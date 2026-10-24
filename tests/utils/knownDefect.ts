/**
 * KATA Architecture - Expected Failure Helper
 *
 * Marks the running test as blocked by a known product defect in ONE call,
 * so the expected-failure flag and the defect key never drift apart:
 *
 * ```typescript
 * test('BK-101: rejects an invalid email @blocked:BK-999', async ({ api }) => {
 *   knownDefect('BK-999');  // server-side validation missing
 *   await api.users.signupWithInvalidEmail(payload);
 * });
 * ```
 *
 * KataReporter classifies the test as `known-defect` while it fails and as
 * `unexpected-pass` (an action item) once it passes (ADR-0020). A bare
 * `test.fail()` with no key is still `known-defect`, plus the action item
 * `known-defect-without-key`.
 */

import { test } from '@playwright/test';

export function knownDefect(defectKey: string, reason?: string): void {
  test.info().annotations.push({ type: 'known-defect', description: defectKey });
  test.fail(true, reason === undefined ? `Blocked by ${defectKey}` : `Blocked by ${defectKey}: ${reason}`);
}
