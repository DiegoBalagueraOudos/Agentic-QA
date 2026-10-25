/**
 * The Merge Line collector in TypeScript: the pure build against a recorded reading, and the
 * collector end to end in fixture mode (no network, no git calls for the reading itself).
 */
import type { BuildParams, Reading } from './merge-build.ts';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { buildDocuments, businessDays, planOf, stableJson } from './merge-build.ts';
import { githubRepo } from './merge-collect.ts';
import { readMergeLine } from './merge-read.ts';
import { mergeView } from './merge.ts';

const FX = join(import.meta.dir, 'fixtures', 'merge-reading');
const reading = (): Reading => JSON.parse(readFileSync(join(FX, 'reading.json'), 'utf8'));
const prev = () => JSON.parse(readFileSync(join(FX, 'prev-snapshot.json'), 'utf8'));
const PARAMS: BuildParams = {
  now: '2026-01-14T12:00:00Z',
  snap: 'S1',
  reason: 'poll',
  mode: 'wake',
  degraded: '',
  todayStart: '2026-01-14T00:00:00Z',
  today: '2026-01-14',
  nextOpen: '2026-01-15T09:00:00Z',
  mainBranch: 'main',
  repo: 'acme/shop',
  timezone: 'UTC',
  winOpen: '09:00',
  winClose: '21:00',
  days: '1 2 3 4 5',
  heartbeatSec: 3000,
  requiredApprovals: 1,
  ticketKey: 'DEMO-\\d+',
  handle: '',
  mailbox: 'off',
  usage: null,
};

describe('buildDocuments (the jq port)', () => {
  test('a wake builds exactly the recorded documents', () => {
    const golden = JSON.parse(readFileSync(join(FX, 'expected-wake.json'), 'utf8'));
    expect(JSON.parse(JSON.stringify(buildDocuments(reading(), PARAMS, prev())))).toEqual(golden);
  });

  test('a check run superseded by a later run of the same check does not fail the gate', () => {
    const r = reading();
    const cancelled = { id: 1, name: 'test', status: 'completed', conclusion: 'cancelled', started_at: '2026-01-14T11:00:00Z', completed_at: '2026-01-14T11:00:30Z' };
    const success = { id: 2, name: 'test', status: 'completed', conclusion: 'success', started_at: '2026-01-14T11:00:31Z', completed_at: '2026-01-14T11:10:00Z' };
    const review = r.prs['11'].checks.check_runs.filter((c: { name: string }) => c.name !== 'test');
    for (const order of [[cancelled, success], [success, cancelled]]) {
      r.prs['11'].checks.check_runs = [...order, ...review];
      const checks = buildDocuments(r, PARAMS, prev()).docs['prs/11'].gates.checks;
      expect(checks).toMatchObject({ lamp: 'go', code: 'green', total: 1, failing: [] });
    }
    r.prs['11'].checks.check_runs = [{ ...success, conclusion: 'failure' }, cancelled, ...review];
    expect(buildDocuments(r, PARAMS, prev()).docs['prs/11'].gates.checks).toMatchObject({ code: 'failing', failing: ['test'] });
  });

  test('gates, lanes and owners read the way the view expects', () => {
    const out = buildDocuments(reading(), PARAMS, prev());
    const pr11 = out.docs['prs/11'];
    expect(pr11.gates.checks).toMatchObject({ lamp: 'go', code: 'green', total: 1 });
    expect(pr11.gates.review).toMatchObject({ lamp: 'go', code: 'clean' });
    expect(pr11.gates.approval).toMatchObject({ lamp: 'go', code: 'approved', approvedBy: ['morgan-owner'] });
    expect(pr11.owner).toMatchObject({ basis: 'checkout', worktree: { path: '/work/shop-discount', name: 'discount' } });
    const pr12 = out.docs['prs/12'];
    expect(pr12.gates.checks).toMatchObject({ lamp: 'st', code: 'failing', failing: ['test'], pending: 2 });
    expect(pr12.gates.review).toMatchObject({ code: 'open', open: 2 });
    expect(pr12.mergePrediction).toBe('conflict');
    expect(pr12.owner.basis).toBe('title');
    const pr13 = out.docs['prs/13'];
    expect(pr13).toMatchObject({ feeder: true, draft: true, gates: { approval: { code: 'self_merge' } } });
    const view = mergeView(readMergeLineLike(out.docs), { now: Date.parse(PARAMS.now) });
    expect(view.lanes.Ready.map(c => c.pr.n)).toEqual([11]);
    // no worktree or terminal holds #13: nobody owns it
    expect(view.lanes['Needs you'].map(c => c.pr.n)).toEqual([13]);
    expect(view.lanes.Blocked.map(c => c.pr.n)).toEqual([12]);
    expect(view.repo).toBe('acme/shop');
  });

  test('tracker parity: an open PR into the mainline on a ticket QA already closed is out of step', () => {
    const out = buildDocuments(reading(), PARAMS, prev());
    expect(out.docs['prs/11'].tickets).toEqual([
      { tk: 'DEMO-7101', status: 'In Test', expected: 'in review or in test', ok: true },
      { tk: 'DEMO-7105', status: 'QA Approved', expected: null, ok: null, mentioned: true },
    ]);
    expect(out.docs['prs/12'].tickets[0]).toMatchObject({ tk: 'DEMO-7102', ok: false });
    // a feeder (into a trunk) carries no expectation; a ticket the board never read is unknown, not wrong
    expect(out.docs['prs/13'].tickets).toEqual([{ tk: 'DEMO-7104', status: null, expected: null, ok: null }]);
    expect(out.docs['meta/alerts'].items.filter((a: { code: string }) => a.code === 'tracker_mismatch').map((a: { params: { tk: string } }) => a.params.tk)).toEqual(['DEMO-7102']);
  });

  test('a degraded run emits only meta/state, with the source and when it started', () => {
    const out = buildDocuments(reading(), { ...PARAMS, degraded: 'github' }, prev());
    expect(Object.keys(out.docs)).toEqual(['meta/state']);
    expect(out.docs['meta/state'].health).toEqual({ code: 'degraded', source: 'github', since: PARAMS.now });
  });

  test('boot resets the day\'s wake counters and starts the day list from the last close', () => {
    const out = buildDocuments(reading(), { ...PARAMS, mode: 'boot' }, prev());
    expect(out.docs['meta/state'].wakes).toEqual({ poll: 1 });
    expect(out.docs['meta/day'].merged.map((m: { n: number }) => m.n)).toEqual([9]);
  });

  test('business days skip weekends', () => {
    const fri = Date.parse('2026-01-16T10:00:00Z') / 1000;
    expect(businessDays(fri, fri + 3 * 86400)).toBe(1);
    expect(businessDays(null, fri)).toBe(0);
  });

  test('the plan writes changed documents, always meta/state, and deletes gone PRs on boot', () => {
    const docs = [{ key: 'meta/state', hash: 'a', file: 's' }, { key: 'prs/1', hash: 'x', file: 'p1' }, { key: 'prs/2', hash: 'y', file: 'p2' }];
    const plan = planOf({ snapshotId: 'S', mode: 'boot', ledger: { 'prs/1': { hash: 'x' }, 'prs/7': { hash: 'z' } }, docs, openPrs: ['1', '2'], closedPrs: [] });
    expect(plan.entries).toEqual([{ op: 'set', key: 'prs/2', file: 'p2', hash: 'y' }, { op: 'delete', key: 'prs/7' }, { op: 'set', key: 'meta/state', file: 's', hash: 'a' }]);
    expect(plan.unchanged).toBe(1);
    expect(stableJson({ b: 1, a: [{ d: 2, c: 3 }] })).toBe('{"a":[{"c":3,"d":2}],"b":1}');
  });

  test('the repository comes from origin, GitHub only', () => {
    expect(githubRepo('git@github.com:acme/shop.git')).toBe('acme/shop');
    expect(githubRepo('https://github.com/acme/shop')).toBe('acme/shop');
    expect(githubRepo('https://gitlab.com/acme/shop.git')).toBeNull();
  });
});

/** The documents as `readMergeLine` returns them from disk. */
function readMergeLineLike(docs: Record<string, any>): Parameters<typeof mergeView>[0] { // eslint-disable-line ts/no-explicit-any
  return {
    state: docs['meta/state'],
    day: docs['meta/day'],
    alerts: docs['meta/alerts'].items,
    pairs: docs['meta/chords'].pairs,
    branches: docs['meta/branches'].items,
    remoteOnly: docs['meta/branches'].remoteOnly,
    prs: Object.entries(docs).filter(([k]) => k.startsWith('prs/')).map(([, v]) => v),
    notes: {},
  };
}

describe('merge-collect.ts in fixture mode', () => {
  const run = (state: string, extra: Record<string, string> = {}, ...args: string[]) => {
    const r = Bun.spawnSync(['bun', join(import.meta.dir, 'merge-collect.ts'), '--reason', 'test', ...args], {
      env: { ...process.env, MERGE_FIXTURE_DIR: FX, MERGE_STATE_DIR: state, SPRINT_BOARD_DIR: join(state, 'board'), SPRINT_BOARD_PROJECT_YAML: join(import.meta.dir, 'demo', 'project.yaml'), ...extra },
      timeout: 60_000,
    });
    return { code: r.exitCode, out: r.stdout.toString() };
  };

  test('writes the documents the view reads; a degraded rerun keeps them and exits 3', () => {
    const state = mkdtempSync(join(tmpdir(), 'merge-line-'));
    try {
      const ok = run(state);
      expect(ok.out.trim().split('\n').at(-1)).toBe('COLLECT ok');
      expect(ok.code).toBe(0);
      const raw = readMergeLine(state);
      expect(raw.prs.map(p => p.n).sort()).toEqual([11, 12, 13]);
      expect(raw.state?.health?.code).toBe('ok');
      expect(existsSync(join(state, 'snapshot.json'))).toBe(true);
      expect(existsSync(join(state, 'plan.json'))).toBe(true);

      const bad = run(state, { MERGE_FIXTURE_DEGRADED: 'github' });
      expect(bad.out.trim().split('\n').at(-1)).toBe('COLLECT degraded github');
      expect(bad.code).toBe(3);
      const kept = readMergeLine(state);
      expect(kept.prs.map(p => p.n).sort()).toEqual([11, 12, 13]);
      expect(kept.state?.health).toMatchObject({ code: 'degraded', source: 'github' });
      expect(existsSync(join(state, 'snapshot.degraded.json'))).toBe(true);
    }
    finally {
      rmSync(state, { recursive: true, force: true });
    }
  });

  test('an unknown flag fails with exit 2', () => {
    const state = mkdtempSync(join(tmpdir(), 'merge-line-'));
    try {
      const r = run(state, {}, '--nope');
      expect(r.out.trim()).toBe('COLLECT fail unknown-arg:--nope');
      expect(r.code).toBe(2);
    }
    finally {
      rmSync(state, { recursive: true, force: true });
    }
  });
});
