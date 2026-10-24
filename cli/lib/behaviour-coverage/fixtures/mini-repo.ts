/**
 * @fileoverview A synthetic project for `project-context` mode `coverage`,
 * assembled in a directory the caller owns (a tmp dir in tests, a scratch dir
 * for a demo). The fixture files stay flat here so no gate mistakes them for
 * this repo's own `.agents/`, maps or manifest; `buildMiniRepo` lays them out.
 *
 * Every key (`DEMO-*`), id and name is invented. The graph, read through
 * `replayTransport`: `DEMO-11` is automated (an ATC in the manifest) and labelled
 * regression; `DEMO-12` is manual, reaches Story `DEMO-2` through its ATS
 * `DEMO-31` and is a member of the RTP `DEMO-41`; `DEMO-13` is manual, outside
 * the regression repository, and reaches `DEMO-2` through the ATP `DEMO-42`
 * it belongs to (the Test Plan leg); `DEMO-14` is deprecated; `DEMO-16` says
 * AUTOMATED with no ATC; `DEMO-17` is still In Design; ATC `DEMO-15` has no
 * Test. The FTP `DEMO-43` links no coverable, so its members are never read.
 * Tech Story `DEMO-51` already anchors gap `e2e#feature-catalog/BR-003`.
 */

import type { Transport } from '../../sprint-source/transport.ts';

import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { TEST_PLAN_TESTS_QUERY } from '../../sprint-source/jira-xray.ts';

export const FIXTURES = import.meta.dir;
const RECORDED = join(FIXTURES, 'recorded');

export const PROJECT_YAML = `project:
  project_key: DEMO
testing:
  tms_cli: bun xray
git_strategy:
  branches:
    production: main
qa:
  qa_epics:
    test_repository_epic:
      key: DEMO-70
`;

export const PLACEHOLDER_MAP = '<!-- placeholder: run project-context mode data to generate this map -->\n<!doctype html><html><head><title>Business data map</title></head><body></body></html>\n';

export interface MiniRepoOptions {
  /** Also write the e2e map (default true). */
  e2eMap?: boolean
  /** Also write the MTP cache (default true). */
  mtp?: boolean
  /** Also write the KATA manifest (default true). */
  manifest?: boolean
}

/** Lay the fixture project out under `dir`: a generated e2e map, a placeholder data map, no api skill. */
export function buildMiniRepo(dir: string, options: MiniRepoOptions = {}): void {
  const { e2eMap = true, mtp = true, manifest = true } = options;
  mkdirSync(join(dir, '.agents'), { recursive: true });
  writeFileSync(join(dir, '.agents', 'project.yaml'), PROJECT_YAML);
  copyFileSync(join(FIXTURES, 'workflows.json'), join(dir, '.agents', 'jira-workflows.json'));
  writeFileSync(join(dir, '.agents', 'jira-link-types.json'), '{ "test": { "name": "Test" } }\n');

  const e2e = join(dir, '.agents', 'skills', 'business-e2e-context', 'references');
  mkdirSync(e2e, { recursive: true });
  if (e2eMap) { copyFileSync(join(FIXTURES, 'e2e-map.html'), join(e2e, 'business-e2e-map.html')); }
  else { writeFileSync(join(e2e, 'business-e2e-map.html'), PLACEHOLDER_MAP.replace('mode data', 'mode e2e')); }
  const data = join(dir, '.agents', 'skills', 'business-data-context', 'references');
  mkdirSync(data, { recursive: true });
  writeFileSync(join(data, 'business-data-map.html'), PLACEHOLDER_MAP);

  if (manifest) { copyFileSync(join(FIXTURES, 'manifest.json'), join(dir, 'kata-manifest.json')); }
  if (mtp) {
    mkdirSync(join(dir, '.context', 'PBI', 'qa-artifacts'), { recursive: true });
    copyFileSync(join(FIXTURES, 'master-test-plan.md'), join(dir, '.context', 'PBI', 'qa-artifacts', 'master-test-plan.md'));
  }
}

const recorded = (name: string): unknown => JSON.parse(readFileSync(join(RECORDED, name), 'utf8'));

/** Replays the recorded TMS; a request it does not recognise fails loud. */
export function replayTransport(overrides: Record<string, unknown> = {}): Transport & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async jira<T>(path: string, body?: unknown): Promise<T> {
      const jql = (body as { jql?: string } | undefined)?.jql ?? '';
      calls.push(`jira ${jql}`);
      if (path !== '/rest/api/3/search/jql') { throw new Error(`unexpected path ${path}`); }
      if (jql in overrides) { return overrides[jql] as T; }
      if (jql === 'project = DEMO AND issuetype in ("Test") ORDER BY key') { return recorded('search-tests.json') as T; }
      if (jql === 'key in (DEMO-31) ORDER BY key') { return recorded('search-sets.json') as T; }
      if (jql === 'project = DEMO AND issuetype in ("Test Plan") ORDER BY key') { return recorded('search-plans.json') as T; }
      if (jql === 'project = DEMO AND issuetype in ("Tech Story") AND labels = "coverage-gap" ORDER BY key') { return recorded('search-anchors.json') as T; }
      throw new Error(`unexpected jql ${jql}`);
    },
    async xray<T>(query: string, variables: Record<string, unknown>): Promise<T> {
      calls.push(`xray ${JSON.stringify(variables)}`);
      if (query === TEST_PLAN_TESTS_QUERY && variables.issueId === '2041') { return recorded('xray-rtp.json') as T; }
      if (query === TEST_PLAN_TESTS_QUERY && variables.issueId === '2042') { return recorded('xray-atp.json') as T; }
      throw new Error(`unexpected xray call ${JSON.stringify(variables)}`);
    },
  };
}

/** A `git` stand-in that knows no repository: the manifest is read from the working tree. */
export const noGit = (): string | null => null;
