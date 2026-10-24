/**
 * @fileoverview Secret refusal for an evidence pack (ADR-0021).
 *
 * The page is meant to be shared, so a pack that carries a credential is
 * REFUSED, never sanitised quietly:
 *   - credential SHAPES anywhere in any string: bearer tokens, any
 *     `Authorization:` header, a `Cookie:` header, JWTs, private keys, cloud
 *     and common vendor tokens, `secret=value` assignments (query strings too);
 *   - any value under a KEY whose normalized name contains a secret word
 *     (`newPassword`, `X-Auth-Token`, `service_role_key`...), in objects, in
 *     header lists, in JSON bodies kept as strings;
 *   - any cell of an SQL result whose COLUMN is such a name.
 * A value counts as masked only when at most a few clear characters remain
 * (`[REDACTED]`, `***`, `ab****`), so `RealValue***` is still refused. Emails
 * only WARN: a test account's address is often legitimate evidence.
 *
 * Findings name the JSON path and the rule, never the value. Prose that states
 * a secret in plain words ("the password is ...") is not detectable: masking it
 * stays the tester's job (`agentic-qa-core/references/evidence-page.md` §4).
 */

export interface SecretFinding {
  path: string
  rule: string
}

export interface SecretScan {
  refusals: SecretFinding[]
  warnings: SecretFinding[]
}

/** Clear characters a masked value may keep (`ab****`, `****1234`). */
const MAX_CLEAR_CHARS = 4;
const MASK_WORDS = /^(?:\[?redacted\]?|<redacted>|\[?masked\]?|\[?hidden\]?|null|none|n\/a)$/i;

/** Secret words matched anywhere in a key, after lowercasing and dropping `-`, `_`, spaces and dots. */
const SECRET_KEY_WORDS = /password|passwd|pwd|secret|token|apikey|authorization|cookie|session|credential|signature|(?:role|private|access|service|signing|encryption|master|client|auth)key/;
const SECRET_KEY_EXACT = new Set(['sid', 'key', 'auth', 'pin', 'pass', 'otp']);

/**
 * Value rules. `value` = the capture group whose content decides; a masked
 * capture passes (`Authorization: [REDACTED]`). No capture = always refused.
 */
const VALUE_RULES: ReadonlyArray<{ rule: string, pattern: RegExp, value?: number }> = [
  { rule: 'bearer-token', pattern: /\bBearer\s+([\w.~+/-]{8,}=*)/i, value: 1 },
  { rule: 'authorization-header', pattern: /\b(?:proxy-)?authorization\s*:\s*(?:[a-z][\w-]*\s+)?([^\s,;"']+)/i, value: 1 },
  { rule: 'cookie-header', pattern: /\b(?:set-)?cookie\s*:\s*([^\s;"']+)/i, value: 1 },
  { rule: 'jwt', pattern: /\beyJ[\w-]{5,}\.[\w-]{5,}\.[\w-]{5,}/ },
  { rule: 'private-key', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { rule: 'aws-access-key', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { rule: 'github-token', pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_\w{20,})/ },
  { rule: 'gitlab-token', pattern: /\bglpat-[\w-]{20,}/ },
  { rule: 'slack-token', pattern: /\bxox[abeoprs]-[\w-]{10,}/ },
  { rule: 'stripe-key', pattern: /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{10,}/ },
  { rule: 'google-api-key', pattern: /\bAIza[\w-]{35}/ },
  { rule: 'api-secret-key', pattern: /\bsk-[\w-]{20,}/ },
  // `password=...`, `"token": "..."`, `?api_key=...`, `newPassword: ...` written inside a string
  {
    rule: 'secret-assignment',
    pattern: /(?:[\w-]*?(?:password|passwd|secret|token|apikey|api[_-]key|credential)|\b(?:[\w-]*[_-])?(?:key|sid|pwd|session[_-]?id))["']?\s*[:=]\s*["']?([^\s"'&,;}]+)/i,
    value: 1,
  },
];

const EMAIL = /[\w.%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;

export function isSecretKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[\s._-]/g, '');
  return SECRET_KEY_EXACT.has(normalized) || SECRET_KEY_WORDS.test(normalized);
}

/** Masked = empty, a mask word, or at most {@link MAX_CLEAR_CHARS} characters besides mask symbols. */
export function isMasked(value: unknown): boolean {
  if (value === null || value === undefined || typeof value === 'boolean') {
    return true;
  }
  if (typeof value !== 'string' && typeof value !== 'number') {
    return false;
  }
  const text = String(value).trim();
  if (text === '' || MASK_WORDS.test(text)) {
    return true;
  }
  const clear = text.replace(/[*•·]/g, '');
  if (/^x+$/i.test(clear) && clear.length >= 3) {
    return true;
  }
  return clear.length <= MAX_CLEAR_CHARS;
}

function joinPath(base: string, key: string | number): string {
  if (typeof key === 'number') {
    return `${base}[${key}]`;
  }
  return /^[A-Z_$][\w$]*$/i.test(key) ? (base === '' ? key : `${base}.${key}`) : `${base}[${JSON.stringify(key)}]`;
}

function scanString(value: string, path: string, scan: SecretScan): void {
  for (const { rule, pattern, value: group } of VALUE_RULES) {
    const global = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
    for (const match of value.matchAll(global)) {
      if (group === undefined || !isMasked(match[group])) {
        scan.refusals.push({ path, rule });
        break;
      }
    }
  }
  if (EMAIL.test(value)) {
    scan.warnings.push({ path, rule: 'email' });
  }
  // A JSON body kept as a string is scanned by key too
  const trimmed = value.trim();
  if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
    try {
      walk(JSON.parse(trimmed), path, scan);
    }
    catch {
      // Not JSON: the value rules above already ran
    }
  }
}

/** An SQL result: every cell under a column named like a secret is refused unless masked. */
function scanSqlColumns(obj: Record<string, unknown>, path: string, scan: SecretScan): void {
  if (!Array.isArray(obj.columns) || !Array.isArray(obj.rows)) {
    return;
  }
  const secretColumns = obj.columns
    .map((column, i) => (typeof column === 'string' && isSecretKey(column) ? i : -1))
    .filter(i => i >= 0);
  obj.rows.forEach((row, r) => {
    if (!Array.isArray(row)) {
      return;
    }
    for (const i of secretColumns) {
      if (!isMasked(row[i])) {
        scan.refusals.push({ path: `${joinPath(joinPath(path, 'rows'), r)}[${i}]`, rule: 'secret-column' });
      }
    }
  });
}

function walk(value: unknown, path: string, scan: SecretScan): void {
  if (typeof value === 'string') {
    scanString(value, path, scan);
    return;
  }
  if (Array.isArray(value)) {
    // A header list kept as [name, value] pairs
    if (value.length === 2 && typeof value[0] === 'string' && isSecretKey(value[0]) && !isMasked(value[1])) {
      scan.refusals.push({ path, rule: 'secret-key' });
    }
    value.forEach((item, i) => walk(item, joinPath(path, i), scan));
    return;
  }
  if (typeof value === 'object' && value !== null) {
    const obj = value as Record<string, unknown>;
    // `{ "name": "Authorization", "value": "..." }`, the HAR / fetch header shape
    if (typeof obj.name === 'string' && isSecretKey(obj.name) && 'value' in obj && !isMasked(obj.value)) {
      scan.refusals.push({ path: joinPath(path, 'value'), rule: 'secret-key' });
    }
    scanSqlColumns(obj, path, scan);
    for (const [key, child] of Object.entries(obj)) {
      const childPath = joinPath(path, key);
      if (isSecretKey(key) && (typeof child === 'string' || typeof child === 'number') && !isMasked(child)) {
        scan.refusals.push({ path: childPath, rule: 'secret-key' });
      }
      walk(child, childPath, scan);
    }
  }
}

/** Every string in the value, recursively, every key that names a secret, every SQL column that does. */
export function scanSecrets(value: unknown, path = ''): SecretScan {
  const scan: SecretScan = { refusals: [], warnings: [] };
  walk(value, path, scan);
  const dedupe = (list: SecretFinding[]) => list.filter((f, i) => list.findIndex(g => g.path === f.path && g.rule === f.rule) === i);
  return { refusals: dedupe(scan.refusals), warnings: dedupe(scan.warnings) };
}

export function describeRefusal(finding: SecretFinding): string {
  return `${finding.path || 'pack'}: refused (${finding.rule}). Remove the value or replace it with "[REDACTED]"; a page never carries a credential`;
}

export function describeWarning(finding: SecretFinding): string {
  return `${finding.path || 'pack'}: holds an email address; mask it unless it is a test account the page may show`;
}
