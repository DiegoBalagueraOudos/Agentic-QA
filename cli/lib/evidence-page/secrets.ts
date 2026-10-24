/**
 * @fileoverview Secret refusal for an evidence pack (ADR-0021).
 *
 * The page is meant to be shared, so a pack that carries a credential is
 * REFUSED, never sanitised quietly: bearer tokens, JWTs, cookies, private
 * keys, cloud access keys, and any value under a key that names a secret
 * (password, token, api key, authorization, session...) unless the value is an
 * obvious mask. Emails only WARN: a test account's address is often legitimate
 * evidence, but the human should look.
 *
 * Findings name the JSON path and the rule, never the value, so the refusal
 * itself cannot leak what it found.
 */

export interface SecretFinding {
  path: string
  rule: string
}

export interface SecretScan {
  refusals: SecretFinding[]
  warnings: SecretFinding[]
}

const VALUE_RULES: ReadonlyArray<{ rule: string, pattern: RegExp }> = [
  { rule: 'bearer-token', pattern: /\bBearer\s+[\w.~+/-]{8,}=*/i },
  { rule: 'jwt', pattern: /\beyJ[\w-]{5,}\.[\w-]{5,}\.[\w-]{5,}/ },
  { rule: 'private-key', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { rule: 'aws-access-key', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { rule: 'cookie-header', pattern: /^\s*(?:set-)?cookie\s*:\s*\S/im },
  // `password=...`, `"token": "..."`, `api_key: ...` written inside a string (a raw body, a log line)
  {
    rule: 'secret-assignment',
    pattern: /\b(?:password|passwd|pwd|secret|client[_-]?secret|api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|session[_-]?id)["']?\s*[:=]\s*["']?(?!\*{3}|\[REDACTED\]|<redacted>)[^\s"'&,;}]{6,}/i,
  },
];

const SECRET_KEY = /^(?:pass(?:word|wd)?|pwd|secret|client[_-]?secret|token|access[_-]?token|refresh[_-]?token|id[_-]?token|auth[_-]?token|api[_-]?key|x-api-key|authorization|proxy-authorization|cookie|set-cookie|session|session[_-]?id|sid|private[_-]?key|access[_-]?key|secret[_-]?key|credentials?)$/i;

const MASK = /^(?:\*+|•+|x{3,}|\[redacted\]|<redacted>|redacted|\[masked\]|masked|\*{3}.*|.*\*{3})$/i;

const EMAIL = /[\w.%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;

function joinPath(base: string, key: string | number): string {
  if (typeof key === 'number') {
    return `${base}[${key}]`;
  }
  return /^[A-Z_$][\w$]*$/i.test(key) ? (base === '' ? key : `${base}.${key}`) : `${base}[${JSON.stringify(key)}]`;
}

function isMasked(value: unknown): boolean {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') {
    return true;
  }
  return typeof value === 'string' && MASK.test(value.trim());
}

function scanString(value: string, path: string, scan: SecretScan): void {
  for (const { rule, pattern } of VALUE_RULES) {
    if (pattern.test(value)) {
      scan.refusals.push({ path, rule });
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

function walk(value: unknown, path: string, scan: SecretScan): void {
  if (typeof value === 'string') {
    scanString(value, path, scan);
    return;
  }
  if (Array.isArray(value)) {
    // A header list kept as [name, value] pairs
    if (value.length === 2 && typeof value[0] === 'string' && SECRET_KEY.test(value[0]) && !isMasked(value[1])) {
      scan.refusals.push({ path, rule: 'secret-key' });
    }
    value.forEach((item, i) => walk(item, joinPath(path, i), scan));
    return;
  }
  if (typeof value === 'object' && value !== null) {
    const obj = value as Record<string, unknown>;
    // `{ "name": "Authorization", "value": "..." }`, the HAR / fetch header shape
    if (typeof obj.name === 'string' && SECRET_KEY.test(obj.name) && 'value' in obj && !isMasked(obj.value)) {
      scan.refusals.push({ path: joinPath(path, 'value'), rule: 'secret-key' });
    }
    for (const [key, child] of Object.entries(obj)) {
      const childPath = joinPath(path, key);
      if (SECRET_KEY.test(key) && !isMasked(child)) {
        scan.refusals.push({ path: childPath, rule: 'secret-key' });
      }
      walk(child, childPath, scan);
    }
  }
}

/** Every string in the value, recursively, and every key that names a secret. */
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
