/**
 * Redact the request secrets that Playwright prints in the "Call log" of a failed API call (timeout, reset): header values of
 * `Authorization`, `Proxy-Authorization`, `Cookie`, `Set-Cookie`, `X-CSRF-Token`, `X-Session-Id` and `X-Timestamp`, and any
 * `Bearer <token>`. The header NAME stays, so the text still says which header was sent; only its value is replaced.
 *
 * Pure and idempotent: used by `ScrubReporter`, which cleans the error objects before every other reporter sees them.
 */

const REDACTED = '[redacted]';

/** `Name: value` lines of a call log and `"Name": "value"` pairs of a JSON-like dump (also with escaped quotes). */
const HEADER_VALUE = /\b(authorization|proxy-authorization|cookie|set-cookie|x-csrf-token|x-session-id|x-timestamp)(\\*["']?\s*:\s*\\*["']?)[^\r\n"'\\]+/gi;

/** A bearer token wherever it appears, including free text. */
const BEARER_TOKEN = /\bbearer\s+[\w.~+/=-]{8,}/gi;

export function scrubSecrets(text: string): string {
  return text
    .replace(HEADER_VALUE, (_match, name: string, separator: string) => `${name}${separator}${REDACTED}`)
    .replace(BEARER_TOKEN, `Bearer ${REDACTED}`);
}
