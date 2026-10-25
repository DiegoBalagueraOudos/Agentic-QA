/**
 * Xray CLI - Import guard: an import never creates or rewrites a Test
 *
 * Xray creates Tests from imported results in two cases (Xray Cloud docs):
 *   - JUnit: a testcase with no `test_key` / `test_id` property inside its
 *     `<properties>` is matched by its Generic Test Definition (classname +
 *     name) and CREATED when no Test has that definition.
 *   - Xray JSON: an entry that carries `testInfo` is created when no Test
 *     matches it (and `testInfo` next to a `testKey` rewrites that Test).
 * A keyed JUnit testcase can still rewrite the Test through `test_summary`,
 * `test_description` or `tags`. In this repo a Test is created and specified
 * by /test-documentation behind a signed ROI verdict, never by an import, so
 * all of these are refused before the upload, and so are shapes the guard
 * cannot read (it fails closed). Cucumber results imports need no guard: they
 * map only to existing Tests through scenario tags and never create one
 * (Xray Cloud docs, BDD "Common problems").
 */

export interface GuardProblem {
  /** `suite > testcase` for JUnit, `tests[i]` for Xray JSON. */
  where: string
  reason: string
}

const KEY_PROPERTIES = new Set(['test_key', 'test_id']);

function decodeEntities(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, '\'')
    .replace(/&amp;/g, '&');
}

function attributesOf(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const m of raw.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    attrs[m[1]] = decodeEntities(m[2] ?? m[3] ?? '');
  }
  return attrs;
}

/** A Jira issue key: project key, dash, number. */
const ISSUE_KEY = /^[A-Z][A-Z0-9_]+-\d+$/;

/** Testcase properties that UPDATE the matched Test's specification (Xray JUnit docs). */
const SPEC_PROPERTIES = new Set(['test_summary', 'test_description', 'tags']);

/** Elements whose body is output, never Xray metadata: their markup is not read. */
const BODY_ELEMENTS = 'system-out|system-err|failure|error|skipped|flakyFailure|flakyError|rerunFailure|rerunError';

/** A tag's attribute run, quoted values allowed to hold `>` (and its capturing form). */
const ATTR_RUN = '(?:[^>"\']|"[^"]*"|\'[^\']*\')*?';
const ATTRS = `(${ATTR_RUN})`;

/**
 * One problem per JUnit testcase that Xray could turn into a NEW Test or use
 * to rewrite one. A key counts only as a `<property>` inside the testcase's
 * own `<properties>` (where Xray reads it): no key, more than one value for
 * the same key property, a `test_key` that is not a Jira key, or a property
 * that rewrites the Test is a problem. Suite-level properties are ignored.
 */
export function findJunitCreations(xml: string): GuardProblem[] {
  // CDATA, comments and output bodies may hold raw markup that is not part of the document.
  const doc = xml
    .replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(new RegExp(`<(${BODY_ELEMENTS})\\b${ATTR_RUN}(?:\\/>|>[\\s\\S]*?<\\/\\1\\s*>)`, 'g'), '');
  const problems: GuardProblem[] = [];

  let suite = '';
  let inProperties = false;
  let current: { where: string, keys: Map<string, string[]>, extra: string[] } | null = null;

  const close = () => {
    if (current === null) {
      return;
    }
    const values = [...current.keys.values()];
    if (values.length === 0) {
      problems.push({ where: current.where, reason: 'no test_key or test_id property' });
    }
    else if (values.some(v => v.length > 1)) {
      problems.push({ where: current.where, reason: `more than one key (${values.flat().join(', ')})` });
    }
    else if (current.keys.has('test_key') && !ISSUE_KEY.test(current.keys.get('test_key')![0])) {
      problems.push({ where: current.where, reason: `test_key is not a Test key (${current.keys.get('test_key')![0]})` });
    }
    for (const name of current.extra) {
      problems.push({ where: current.where, reason: `${name} would rewrite the Test` });
    }
    current = null;
    inProperties = false;
  };

  const tags = new RegExp(`<(testsuite|testcase|properties|property)\\b${ATTRS}(\\/?)>|<\\/(testcase|properties)\\s*>`, 'g');
  for (const m of doc.matchAll(tags)) {
    if (m[1] === undefined) {
      if (m[4] === 'testcase') {
        close();
      }
      else {
        inProperties = false;
      }
      continue;
    }
    const attrs = attributesOf(m[2]);
    if (m[1] === 'testsuite') {
      close();
      suite = attrs.name ?? '';
    }
    else if (m[1] === 'testcase') {
      close();
      current = { where: suite ? `${suite} > ${attrs.name ?? ''}` : (attrs.name ?? ''), keys: new Map(), extra: [] };
      if (m[3] === '/') {
        close();
      }
    }
    else if (m[1] === 'properties') {
      inProperties = current !== null && m[3] !== '/';
    }
    else if (current !== null && inProperties) {
      const name = attrs.name ?? '';
      const value = (attrs.value ?? '').trim();
      if (KEY_PROPERTIES.has(name) && value !== '') {
        current.keys.set(name, [...(current.keys.get(name) ?? []), value]);
      }
      else if (SPEC_PROPERTIES.has(name) && !current.extra.includes(name)) {
        current.extra.push(name);
      }
    }
  }
  close();

  return problems;
}

/**
 * One problem per Xray JSON entry that could create or rewrite a Test, or that
 * names no valid Test: `testInfo` present, `testKey` missing, not a Jira key,
 * or repeated. A body the guard cannot read fails closed (`tests` not an array).
 */
export function findXrayJsonCreations(payload: unknown): GuardProblem[] {
  const tests = (payload !== null && typeof payload === 'object' && !Array.isArray(payload))
    ? (payload as { tests?: unknown }).tests
    : undefined;
  if (!Array.isArray(tests)) {
    return [{ where: 'tests', reason: 'not an array of results' }];
  }

  const problems: GuardProblem[] = [];
  const seen = new Set<string>();
  tests.forEach((entry: unknown, i) => {
    const test = (entry !== null && typeof entry === 'object' ? entry : {}) as { testKey?: unknown, testInfo?: unknown };
    const key = typeof test.testKey === 'string' ? test.testKey.trim() : '';
    if ('testInfo' in test) {
      problems.push({ where: `tests[${i}]`, reason: 'carries testInfo' });
    }
    else if (key === '') {
      problems.push({ where: `tests[${i}]`, reason: 'no testKey' });
    }
    else if (!ISSUE_KEY.test(test.testKey as string)) {
      problems.push({ where: `tests[${i}]`, reason: `testKey is not a Test key (${String(test.testKey)})` });
    }
    else if (seen.has(key)) {
      problems.push({ where: `tests[${i}]`, reason: `duplicate testKey (${key})` });
    }
    seen.add(key);
  });
  return problems;
}

/** The single line the CLI fails with. */
export function guardMessage(file: string, problems: GuardProblem[]): string {
  const list = problems.map(p => `${p.where} (${p.reason})`).join('; ');
  return `Refusing to import ${file}: ${problems.length} result(s) could create or rewrite a Test in Xray, or name no valid Test key: ${list}. `
    + 'Every result must name one existing Test key and nothing else about the Test; a missing Test is created by /test-documentation, never by an import.';
}
