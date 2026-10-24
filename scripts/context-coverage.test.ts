import type { CollectResult, GapList } from '../cli/lib/behaviour-coverage/types.ts';
import type { Deps } from './context-coverage.ts';

import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { buildMiniRepo, FIXTURES, noGit, replayTransport } from '../cli/lib/behaviour-coverage/fixtures/mini-repo.ts';
import { NO_BEHAVIOUR_SOURCE, readManifest, run, seedFromMap } from './context-coverage.ts';

let repo: string;
let outDir: string;
let out: string;
let err: string;
const io = { out: (s: string) => { out += s; }, err: (s: string) => { err += s; } };
const NOW = new Date('2026-01-14T16:00:00Z');
const deps = (now = NOW) => ({ transport: replayTransport(), git: noGit, now: () => now });
const read = <T>(name: string): T => JSON.parse(readFileSync(join(outDir, name), 'utf8')) as T;
const cli = async (argv: string[], d: Deps = deps()) => run([...argv, '--root', repo, '--out-dir', outDir], repo, io, d);

beforeEach(() => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), 'coverage-')));
  outDir = join(repo, 'out');
  out = '';
  err = '';
});
afterEach(() => { rmSync(repo, { recursive: true, force: true }); });

describe('collect -> classify -> propose on the fixture project', () => {
  beforeEach(() => { buildMiniRepo(repo); });

  test('collect reads the map seed, the manifest and the TMS inventory', async () => {
    expect(await cli(['collect'])).toBe(0);
    const c = read<CollectResult>('collect.json');
    expect(c.sources.maps.map(m => [m.map, m.state])).toEqual([['e2e', 'generated'], ['api', 'no-skill'], ['data', 'placeholder']]);
    expect(c.seed.map(s => s.id)).toEqual([
      'e2e#discovery-gaps',
      'e2e#feature-billing',
      'e2e#feature-billing/BR-001',
      'e2e#feature-billing/BR-002',
      'e2e#feature-billing/FEAT-001',
      'e2e#feature-catalog',
      'e2e#feature-catalog/BR-003',
      'e2e#feature-catalog/BR-004',
      'e2e#feature-catalog/FEAT-002',
    ]);
    expect(c.seed.find(s => s.id === 'e2e#feature-billing/FEAT-001')!.title).toBe('Checkout');
    expect(c.tests.map(t => [t.key, t.kind, t.in_tms, t.deprecated])).toEqual([
      ['DEMO-11', 'automated', true, false],
      ['DEMO-12', 'manual', true, false],
      ['DEMO-13', 'manual', true, false],
      ['DEMO-14', 'manual', true, true],
      ['DEMO-15', 'automated', false, false],
      ['DEMO-16', 'manual', true, false],
    ]);
    expect(c.sources.tms).toEqual({ modality: 'jira-xray', state: 'read', reason: null });
    expect(c.sources.manifest).toMatchObject({ state: 'read', ref: 'working-tree', production: 'main' });
    expect(c.warnings).toEqual([
      'DEMO-16: TMS status is automated but no ATC with this id is in the manifest at working-tree: counted as manual',
      'ATC DEMO-15 (tests/components/api/OrdersApi.ts) has no Test in the TMS',
    ]);
    expect(c.anchors.map(a => a.key)).toEqual(['DEMO-51']);
  });

  test('classify buckets the fixture judgments, orders the gaps and writes the run history', async () => {
    await cli(['collect']);
    copyFileSync(join(FIXTURES, 'judgments.json'), join(outDir, 'judgments.json'));
    expect(await cli(['classify'])).toBe(0);
    const list = read<GapList>('gap-list.json');
    expect(list.denominators.buckets).toEqual({ 'automated': 1, 'manual-only': 1, 'weak': 1, 'uncovered': 2 });
    expect(list.gaps).toEqual(['e2e#feature-billing/BR-002', 'e2e#feature-catalog/BR-003', 'e2e#feature-catalog/BR-004']);
    expect(list.unjudged_seed).toEqual(['e2e#feature-catalog/FEAT-002']);
    expect(list.behaviours.find(b => b.id === 'e2e#feature-billing/BR-002')!.covered_by[0].outside_regression).toBe(true);
    expect(readdirSync(join(outDir, 'runs'))).toEqual([`${list.run_id}.json`]);
    const md = readFileSync(join(outDir, 'gap-list.md'), 'utf8');
    expect(md).toContain('| 1 | CRITICAL (Checkout and payment) | weak | Billing |');
    expect(md).toContain('The business-data-context map is placeholder');
    expect(md).toContain('MTP flow "Saved searches" is not in the MTP cache');
    expect(out).toContain('automated 1 · manual-only 1 · weak 1 · uncovered 2 · gaps 3');
  });

  test('a second run diffs against the first', async () => {
    await cli(['collect']);
    copyFileSync(join(FIXTURES, 'judgments.json'), join(outDir, 'judgments.json'));
    await cli(['classify']);
    const judgments = read<{ behaviours: Array<{ id: string, covered_by: unknown[] }> }>('judgments.json');
    judgments.behaviours.find(b => b.id === 'e2e#feature-catalog/BR-004')!.covered_by = [{ test: 'DEMO-11', verdict: 'exercises', evidence: 'asserts the sign-in guard' }];
    writeFileSync(join(outDir, 'judgments.json'), JSON.stringify(judgments));
    expect(await cli(['classify'], deps(new Date('2026-01-21T16:00:00Z')))).toBe(0);
    const list = read<GapList>('gap-list.json');
    expect(list.diff.previous_run).toBe('20260114T160000Z');
    expect(list.diff.closed).toEqual([{ id: 'e2e#feature-catalog/BR-004', from: 'uncovered', to: 'automated' }]);
    expect(readdirSync(join(outDir, 'runs'))).toHaveLength(2);
  });

  test('propose writes dry-run payloads and skips the anchored gap', async () => {
    await cli(['collect']);
    copyFileSync(join(FIXTURES, 'judgments.json'), join(outDir, 'judgments.json'));
    await cli(['classify']);
    expect(await cli(['propose', '--grain', 'gap'])).toBe(0);
    expect(readdirSync(join(outDir, 'proposals')).sort()).toEqual([
      '01-e2e-feature-billing-br-002.json',
      '01-e2e-feature-billing-br-002.md',
      '02-e2e-feature-catalog-br-004.json',
      '02-e2e-feature-catalog-br-004.md',
    ]);
    expect(out).toContain('DRY RUN, nothing was created');
    expect(out).toContain('skipped e2e#feature-catalog/BR-003: already anchored by DEMO-51');
    const p = JSON.parse(readFileSync(join(outDir, 'proposals', '01-e2e-feature-billing-br-002.json'), 'utf8')) as { payload: Record<string, unknown> };
    expect(p.payload).toMatchObject({ projectKey: 'DEMO', type: 'Tech Story', parentIssueId: 'DEMO-70', labels: ['coverage-gap'] });
  });

  test('without the TMS, manual-only is unknown and the rows stay unverified', async () => {
    expect(await cli(['collect', '--tms', 'none'])).toBe(0);
    expect(read<CollectResult>('collect.json').sources.tms).toEqual({ modality: 'none', state: 'unavailable', reason: '--tms none: manifest only' });
    copyFileSync(join(FIXTURES, 'judgments.json'), join(outDir, 'judgments.json'));
    expect(await cli(['classify'])).toBe(0);
    const md = readFileSync(join(outDir, 'gap-list.md'), 'utf8');
    expect(md).toMatch(/\| manual-only \| unknown \(\d+ judged, unverified\) \|/);
    expect(md).toContain('`manual-only` was not measured: TMS not read (--tms none: manifest only)');
  });

  test('a TMS failure is stated as the reason, never an empty inventory', async () => {
    const failing = { ...deps(), transport: { jira: async () => { throw new Error('Jira credentials are not set'); }, xray: async () => ({}) as never } };
    expect(await cli(['collect'], failing)).toBe(0);
    expect(read<CollectResult>('collect.json').sources.tms).toEqual({ modality: 'jira-xray', state: 'unavailable', reason: 'Jira credentials are not set' });
  });

  test('an invalid judgment is rejected with every error, and nothing is written', async () => {
    await cli(['collect']);
    writeFileSync(join(outDir, 'judgments.json'), JSON.stringify({ schema_version: 1, behaviours: [{ id: 'e2e#nope', title: 't', module: 'm', risk: null, covered_by: [{ test: 'DEMO-99', verdict: 'exercises', evidence: 'x' }] }] }));
    expect(await cli(['classify'])).toBe(1);
    expect(err).toContain('no section `nope`');
    expect(err).toContain('DEMO-99 is not in the test inventory');
    expect(existsSync(join(outDir, 'gap-list.json'))).toBe(false);
  });
});

describe('degradation', () => {
  test('every map a placeholder: a stated note and exit 2, from collect and from classify', async () => {
    buildMiniRepo(repo, { e2eMap: false });
    expect(await cli(['collect'])).toBe(2);
    expect(err).toContain(NO_BEHAVIOUR_SOURCE);
    err = '';
    expect(await cli(['classify'])).toBe(2);
    expect(err).toContain(NO_BEHAVIOUR_SOURCE);
  });

  test('no project key: the TMS is not read and the header says why', async () => {
    buildMiniRepo(repo);
    writeFileSync(join(repo, '.agents', 'project.yaml'), 'testing:\n  tms_cli: bun xray\n');
    await cli(['collect']);
    expect(read<CollectResult>('collect.json').sources.tms.reason).toBe('project.project_key is not set in .agents/project.yaml');
  });

  test('no manifest, no MTP cache: automated is unknown and every row is unranked', async () => {
    buildMiniRepo(repo, { manifest: false, mtp: false });
    await cli(['collect']);
    copyFileSync(join(FIXTURES, 'judgments.json'), join(outDir, 'judgments.json'));
    // DEMO-11 is no longer an ATC, so it is a manual TMS Test: still a valid key.
    expect(await cli(['classify'])).toBe(0);
    const list = read<GapList>('gap-list.json');
    expect(list.sources.manifest.state).toBe('missing');
    expect(list.behaviours.every(b => b.risk === null)).toBe(true);
    expect(readFileSync(join(outDir, 'gap-list.md'), 'utf8')).toContain('`automated` was not measured: no KATA manifest');
  });
});

describe('the manifest at production', () => {
  test('read from the branch when the root is the checkout root', () => {
    buildMiniRepo(repo);
    const calls: string[][] = [];
    const git = (_root: string, args: string[]): string | null => {
      calls.push(args);
      if (args[1] === '--show-toplevel') { return `${repo}\n`; }
      if (args[0] === 'rev-parse') { return args[3] === 'origin/main^{commit}' ? 'abcdef0123456789\n' : null; }
      return JSON.stringify({ components: { api: [{ relativePath: 'x.ts', atcs: [{ id: 'DEMO-90', method: 'm', line: 1 }] }] } });
    };
    const { source, atcs } = readManifest(repo, 'main', git);
    expect(source).toEqual({ state: 'read', ref: 'origin/main@abcdef012345', production: 'main', warning: null });
    expect([...atcs.keys()]).toEqual(['DEMO-90']);
    expect(calls.at(-1)).toEqual(['show', 'origin/main:kata-manifest.json']);
  });

  test('a root inside a repository reads its own working-tree copy, never the repository\'s branch', () => {
    buildMiniRepo(repo);
    const parent = join(repo, '..');
    const git = (_root: string, args: string[]): string | null => (args[1] === '--show-toplevel' ? parent : 'should not be read');
    const { source, atcs } = readManifest(repo, 'main', git);
    expect(source.ref).toBe('working-tree');
    expect(source.warning).toContain('not `main`');
    expect([...atcs.keys()].sort()).toEqual(['DEMO-11', 'DEMO-15']);
  });
});

describe('arguments', () => {
  test('propose needs a grain, an unknown command or flag is rejected', async () => {
    mkdirSync(outDir, { recursive: true });
    expect(await cli(['propose'])).toBe(1);
    expect(err).toContain('propose needs --grain gap or --grain module');
    expect(await cli(['scan'])).toBe(1);
    expect(await cli(['collect', '--tms', 'xray'])).toBe(1);
    expect(await run(['--help'], repo, io)).toBe(0);
  });
});

describe('map seed', () => {
  test('a feature\'s hash follows its whole block, a rule\'s hash its own row', () => {
    const html = readFileSync(join(FIXTURES, 'e2e-map.html'), 'utf8');
    const before = seedFromMap('e2e', html).seed;
    const after = seedFromMap('e2e', html.replace('<td>Stable</td>', '<td>Beta</td>')).seed;
    const hash = (seed: typeof before, id: string) => seed.find(s => s.id === id)!.hash;
    expect(hash(after, 'e2e#feature-billing/FEAT-001')).not.toBe(hash(before, 'e2e#feature-billing/FEAT-001'));
    expect(hash(after, 'e2e#feature-billing/BR-001')).toBe(hash(before, 'e2e#feature-billing/BR-001'));
    expect(before.find(s => s.id === 'e2e#feature-billing/BR-002')!.title).toBe('A coupon code is rejected once it has expired');
  });
});
