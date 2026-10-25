/**
 * Xray CLI - Import guard: an import never creates a Test
 *
 * Xray creates Tests from imported results in two cases (Xray Cloud docs):
 *   - JUnit: a testcase with no `test_key` / `test_id` property is matched by
 *     its Generic Test Definition (classname + name) and CREATED when no Test
 *     has that definition.
 *   - Xray JSON: an entry that carries `testInfo` is created when no Test
 *     matches it.
 * In this repo a Test is created by /test-documentation behind a signed ROI
 * verdict, never by an import, so both shapes are refused before the upload.
 * Cucumber imports are not covered: they create Cucumber Tests from untagged
 * scenarios by design.
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

/**
 * One problem per JUnit testcase that Xray would turn into a NEW Test: no
 * `test_key` / `test_id` property, or more than one value for the same
 * property (a shape Xray does not document). Suite-level properties are ignored.
 */
export function findJunitCreations(xml: string): GuardProblem[] {
  // CDATA and comments may hold raw markup that is not part of the document.
  const doc = xml.replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '').replace(/<!--[\s\S]*?-->/g, '');
  const problems: GuardProblem[] = [];

  let suite = '';
  let current: { where: string, keys: Map<string, string[]> } | null = null;

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
    current = null;
  };

  for (const m of doc.matchAll(/<(testsuite|testcase|property)\b([^>]*?)(\/?)>|<\/testcase\s*>/g)) {
    if (m[1] === undefined) {
      close();
      continue;
    }
    const attrs = attributesOf(m[2]);
    if (m[1] === 'testsuite') {
      close();
      suite = attrs.name ?? '';
    }
    else if (m[1] === 'testcase') {
      close();
      current = { where: suite ? `${suite} > ${attrs.name ?? ''}` : (attrs.name ?? ''), keys: new Map() };
      if (m[3] === '/') {
        close();
      }
    }
    else if (current !== null && KEY_PROPERTIES.has(attrs.name ?? '') && (attrs.value ?? '').trim() !== '') {
      const name = attrs.name;
      current.keys.set(name, [...(current.keys.get(name) ?? []), attrs.value.trim()]);
    }
  }
  close();

  return problems;
}

/** One problem per Xray JSON entry that could create a Test: `testInfo` present or `testKey` missing. */
export function findXrayJsonCreations(payload: unknown): GuardProblem[] {
  const tests = (payload as { tests?: unknown })?.tests;
  if (!Array.isArray(tests)) {
    return [];
  }

  const problems: GuardProblem[] = [];
  tests.forEach((entry: unknown, i) => {
    const test = (entry ?? {}) as { testKey?: unknown, testInfo?: unknown };
    if (test.testInfo !== undefined) {
      problems.push({ where: `tests[${i}]`, reason: 'carries testInfo' });
    }
    else if (typeof test.testKey !== 'string' || test.testKey.trim() === '') {
      problems.push({ where: `tests[${i}]`, reason: 'no testKey' });
    }
  });
  return problems;
}

/** The single line the CLI fails with. */
export function guardMessage(file: string, problems: GuardProblem[]): string {
  const list = problems.map(p => `${p.where} (${p.reason})`).join('; ');
  return `Refusing to import ${file}: ${problems.length} result(s) would create a new Test in Xray: ${list}. `
    + 'Every result must name an existing Test key; a missing Test is created by /test-documentation, never by an import.';
}
