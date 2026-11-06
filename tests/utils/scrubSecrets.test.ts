import { scrubSecrets } from '@utils/scrubSecrets';

import { describe, expect, it } from 'bun:test';

describe('scrubSecrets', () => {
  it('redacts header values of a Playwright call log and keeps the names', () => {
    const log = [
      'apiRequestContext.get: Request timed out',
      'Call log:',
      '  - GET http://localhost/api/x',
      '  -   Authorization: Bearer abcdef1234567890',
      '  -   X-CSRF-Token: csrf-value-123456',
      '  -   X-Session-Id: 0f8fad5b-d9cb-469f-a165-70867728950e',
      '  -   cookie: access_token=aaa.bbb.ccc; refresh_token=zzz',
    ].join('\n');
    const clean = scrubSecrets(log);
    expect(clean).not.toMatch(/abcdef1234567890|csrf-value-123456|0f8fad5b|aaa\.bbb|refresh_token=zzz/);
    for (const name of ['Authorization', 'X-CSRF-Token', 'X-Session-Id', 'cookie']) {
      expect(clean).toContain(`${name}: [redacted]`);
    }
    expect(clean).toContain('GET http://localhost/api/x');
  });

  it('redacts JSON-like header dumps, with plain and escaped quotes', () => {
    expect(scrubSecrets('{"Authorization": "Bearer abcdef1234567890", "X-Timestamp": "1793890000"}')).not.toMatch(/abcdef1234567890|1793890000/);
    expect(scrubSecrets('{\\"x-session-id\\":\\"sess-1234567890\\"}')).not.toContain('sess-1234567890');
  });

  it('redacts a bearer token in free text', () => {
    expect(scrubSecrets('sent Bearer eyJhbGciOi.payload.sig to the server')).toBe('sent Bearer [redacted] to the server');
  });

  it('leaves a text without secrets untouched', () => {
    const text = 'expect(received).toBe(expected)\nExpected: 200\nReceived: 500';
    expect(scrubSecrets(text)).toBe(text);
  });

  it('is idempotent', () => {
    const once = scrubSecrets('Authorization: Bearer abcdef1234567890\ncookie: a=b');
    expect(scrubSecrets(once)).toBe(once);
  });
});
