/**
 * @fileoverview The `jira-native` source: Jira without Xray.
 *
 * A test case is an issue of the catalogued test work type (`test_case` in
 * `.agents/jira-workflows.json`) reached through the coverage cascade
 * (`jira-common.ts`), and its outcome is the `test_status` field
 * (`test-documentation/references/jira-setup.md` §3). The option id is turned
 * back into its slug through `.agents/jira-fields.json`, so the raw value the
 * config maps is `passed` / `failed` / `n_r` / `blocked` or whatever options the
 * project added; an empty field is a test nobody ran. There is no Test Plan
 * membership to read: in this modality a Plan's tests are its ATS links.
 */

import type { BoardConfig } from './config.ts';
import type { TestReader } from './jira-common.ts';
import type { Transport } from './transport.ts';
import type { Source, TestCase } from './types.ts';

import { createJiraSource, fieldId, issuesByKey } from './jira-common.ts';
import { classifyTest } from './status-map.ts';

/** The `test_status` value -> its option slug; an option the catalog lacks keeps its display value. */
function rawTestStatus(config: BoardConfig, value: unknown): string | null {
  if (value === null || value === undefined) { return null; }
  const option = value as { id?: string, value?: string };
  const options = config.catalogs.fields?.test_status?.options ?? {};
  const slug = Object.entries(options).find(([, id]) => id === option.id)?.[0];
  return slug ?? option.value ?? null;
}

export function createJiraNativeSource(config: BoardConfig, transport: Transport): Source {
  const statusField = fieldId(config, 'test_status');
  const readTests: TestReader = async (requests) => {
    const out = new Map<string, TestCase[]>();
    const keys = [...new Set(requests.flatMap(r => r.tests.map(t => t.key)))];
    if (keys.length > 0 && !statusField) {
      throw new Error('jira-native: the test_status field is not in .agents/jira-fields.json (run `bun run jira:sync-fields`)');
    }
    const byKey = new Map<string, TestCase>();
    for (const issue of await issuesByKey(transport, keys, ['summary', 'updated', statusField as string])) {
      const raw = rawTestStatus(config, issue.fields[statusField as string]);
      byKey.set(issue.key, {
        id: issue.key,
        name: issue.fields.summary ?? issue.key,
        status: classifyTest(config.statusMap, issue.key, raw),
        rawStatus: raw,
        updatedAt: issue.fields.updated ?? null,
      });
    }
    for (const request of requests) {
      out.set(request.ticket, request.tests.map(t => byKey.get(t.key)).filter((t): t is TestCase => t !== undefined));
    }
    return out;
  };
  return createJiraSource({ kind: 'jira-native', config, transport, readTests });
}
