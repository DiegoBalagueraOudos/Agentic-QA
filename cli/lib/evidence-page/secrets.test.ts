import { describe, expect, it } from 'bun:test';

import { describeRefusal, isMasked, scanSecrets } from './secrets.ts';

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
    expect(rules({ raw: `Cookie: sid=${seg(10)}` })).toContain('raw cookie-header');
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

describe('fix round: the reviewer probes (VERIFY M3, S3)', () => {
  const tok = seg(28);
  const refused = (value: unknown) => scanSecrets(value).refusals.length > 0;

  it('M3: secret words anywhere in a key, in an object or a JSON body kept as a string', () => {
    expect(rules({ request: { newPassword: secretValue } })).toEqual(['request.newPassword secret-key']);
    expect(refused({ body: JSON.stringify({ currentPassword: secretValue }) })).toBe(true);
    for (const key of ['user_password', 'X-Auth-Token', 'x-access-token', 'api_token', 'service_role_key']) {
      expect(rules({ [key]: tok }).length).toBeGreaterThan(0);
    }
  });

  it('M3: SQL cells under a secret column are refused, other columns pass', () => {
    const sql = { type: 'sql', query: 'select', columns: ['email', 'reset_token'], rows: [['qa@test.com', tok]] };
    expect(rules({ sql })).toEqual(['sql.rows[0][1] secret-column']);
    const hash = ['$2b$10$', seg(30)].join('');
    expect(rules({ sql: { columns: ['password'], rows: [[hash]] } })).toEqual(['sql.rows[0][0] secret-column']);
    expect(rules({ sql: { columns: ['password'], rows: [['[REDACTED]']] } })).toEqual([]);
  });

  it('M3: any Authorization scheme and a Cookie header anywhere in a line', () => {
    expect(rules({ raw: `Authorization: Basic ${seg(16)}` })).toContain('raw authorization-header');
    expect(rules({ raw: `Authorization: Token ${tok}` })).toContain('raw authorization-header');
    expect(rules({ raw: `curl -H 'Cookie: connect.sid=${seg(20)}' https://app.test` })).toContain('raw cookie-header');
    expect(rules({ raw: 'Authorization: [REDACTED]' })).toEqual([]);
  });

  it('M3: token query parameters', () => {
    expect(rules({ url: `https://app.test/x?token=${tok}` })).toEqual(['url secret-assignment']);
    expect(rules({ url: `https://app.test/x?access_token=${tok}&page=2` })).toEqual(['url secret-assignment']);
    expect(rules({ url: 'https://app.test/x?page=2&sort=name' })).toEqual([]);
  });

  it('M3: a real value ending in *** is not a mask; at most a few clear characters are', () => {
    expect(rules({ password: 'RealSecretValue***' })).toEqual(['password secret-key']);
    expect(isMasked('RealSecretValue***')).toBe(false);
    for (const mask of ['***', '[REDACTED]', '<redacted>', 'ab****', '****1234', 'xxxxxx', '']) {
      expect(isMasked(mask)).toBe(true);
    }
  });

  it('S3: common vendor token shapes', () => {
    const shapes = [
      ['gh', 'p_', seg(36)].join(''),
      ['github', '_pat_', seg(30)].join(''),
      ['sk', '_live_', seg(24)].join(''),
      ['xo', 'xb-', seg(20)].join(''),
      ['gl', 'pat-', seg(20)].join(''),
    ];
    for (const shape of shapes) {
      expect(refused({ note: `leaked ${shape} here` })).toBe(true);
    }
  });

  it('keeps ordinary API data and prose passing', () => {
    expect(rules({ response: { orderId: 'demo-order-9', total: 42.5, monkey: 'banana', primaryKey: 'id' } })).toEqual([]);
    expect(rules({ caption: 'The session cookie expires after logout' })).toEqual([]);
  });
});
