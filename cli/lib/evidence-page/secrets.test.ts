import { describe, expect, it } from 'bun:test';

import { describeRefusal, scanSecrets } from './secrets.ts';

// Token-shaped values are built at runtime: the repo's leak scanner reads test sources
const seg = (n: number) => 'a1B2c3D4e5'.repeat(4).slice(0, n);
const jwt = ['ey', `J${seg(20)}`, '.', seg(24), '.', seg(30)].join('');
const bearer = ['Bear', 'er ', seg(32)].join('');
const awsKey = ['AK', 'IA', 'ABCDEFGHIJKLMNOP'].join('');
const pem = ['-----BEGIN ', 'RSA PRIVATE', ' KEY-----\nxyz'].join('');
const secretValue = `hunter${seg(6)}`;

function rules(value: unknown): string[] {
  return scanSecrets(value).refusals.map(f => `${f.path} ${f.rule}`);
}

describe('scanSecrets', () => {
  it('refuses bearer tokens, JWTs, private keys and cloud keys anywhere, by path', () => {
    expect(rules({ cases: [{ evidence: [{ request: { headers: { 'x-trace': bearer } } }] }] }))
      .toEqual(['cases[0].evidence[0].request.headers["x-trace"] bearer-token']);
    expect(rules({ note: `token was ${jwt}` })).toEqual(['note jwt']);
    expect(rules({ sql: { rows: [[pem]] } })).toEqual(['sql.rows[0][0] private-key']);
    expect(rules({ caption: awsKey })).toEqual(['caption aws-access-key']);
  });

  it('refuses a value under a key that names a secret, unless it is masked', () => {
    expect(rules({ headers: { Authorization: 'Basic abcdef' } })).toEqual(['headers.Authorization secret-key']);
    expect(rules({ body: { password: secretValue } })).toEqual(['body.password secret-key']);
    expect(rules({ headers: { Cookie: 'sid=1' } })).toEqual(['headers.Cookie secret-key']);
    expect(rules({ body: { password: '[REDACTED]', token: '***', apiKey: '' } })).toEqual([]);
  });

  it('reads the header-list shapes and JSON bodies kept as strings', () => {
    expect(rules({ h: [{ name: 'Set-Cookie', value: 'session=abc123' }] })).toContain('h[0].value secret-key');
    expect(rules({ h: [['authorization', 'Basic zzz']] })).toEqual(['h[0] secret-key']);
    expect(rules({ response: JSON.stringify({ user: { refresh_token: secretValue } }) })).toContain('response.user.refresh_token secret-key');
  });

  it('refuses secret assignments and cookie headers inside raw text', () => {
    expect(rules({ log: `login ok password=${secretValue}` })).toEqual(['log secret-assignment']);
    expect(rules({ raw: `Cookie: sid=${seg(10)}` })).toEqual(['raw cookie-header']);
  });

  it('only warns on emails', () => {
    const scan = scanSecrets({ actual: 'Shown to qa.user@example.test' });
    expect(scan.refusals).toEqual([]);
    expect(scan.warnings).toEqual([{ path: 'actual', rule: 'email' }]);
  });

  it('passes the ordinary fields of a pack', () => {
    expect(rules({ ticket: { id: 'BK-1', title: 'Login rejects a wrong password' }, env: { name: 'staging' }, cases: [{ status: 'PASSED' }] })).toEqual([]);
  });

  it('never prints the value it refused', () => {
    const [finding] = scanSecrets({ body: { password: secretValue } }).refusals;
    expect(describeRefusal(finding)).not.toContain(secretValue);
  });
});
