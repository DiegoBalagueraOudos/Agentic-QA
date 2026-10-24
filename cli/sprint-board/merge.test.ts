import type { MergePr, MergeRaw } from './merge.ts';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { mergeNeeds, prDrawer, viewMerge } from './app/merge-view.ts';
import { routeView } from './app/views.ts';
import { readMergeLine } from './merge-read.ts';
import { freshnessOf, laneOf, mergeView, suggestOrder } from './merge.ts';

const NOW = Date.parse('2026-10-22T18:00:00Z');

function pr(n: number, over: Partial<MergePr> = {}, gates: Partial<MergePr['gates']> = {}): MergePr {
  return {
    n,
    state: 'open',
    draft: false,
    title: `PR ${n}`,
    url: '',
    author: 'qa-owner',
    authorIsBot: false,
    base: 'main',
    head: `feat/x-${n}`,
    headSha: 'abc',
    feeder: false,
    trunkPr: null,
    openedAt: '2026-10-20T12:00:00Z',
    updatedAt: '2026-10-22T12:00:00Z',
    size: { files: 5, add: 10, del: 2 },
    behindMain: 0,
    mergePrediction: 'clean',
    gates: {
      checks: { lamp: 'go', code: 'green', total: 2, failing: [], pending: 0 },
      review: { lamp: 'go', code: 'clean', open: 0 },
      approval: { lamp: 'go', code: 'approved', requested: [], approvedBy: ['reviewer-two'], changesBy: [] },
      ...gates,
    },
    cleared: 3,
    lamp: 'go',
    tickets: [],
    owner: { basis: 'checkout', worktree: { path: '/w', name: 'wt' }, terminals: [], since: '2026-10-22T12:00:00Z' },
    ...over,
  };
}

const raw = (prs: MergePr[], over: Partial<MergeRaw> = {}): MergeRaw => ({
  state: { checkedAt: '2026-10-22T17:59:00Z', mainSha: '14293db', viewer: 'qa-owner' },
  alerts: [],
  pairs: [],
  branches: [],
  remoteOnly: 0,
  prs,
  notes: {},
  collector: { everySec: 90, running: false, lastEndAt: '2026-10-22T17:59:30Z', lastLine: 'COLLECT ok', ok: true },
  ...over,
});

describe('laneOf', () => {
  test('failing checks block, even when the owner was asked', () => {
    const p = pr(1, {}, {
      checks: { lamp: 'st', code: 'failing', total: 2, failing: ['E2E Tests'], pending: 0 },
      approval: { lamp: 'ca', code: 'requested', requested: [{ login: 'qa-owner', since: '2026-10-21T00:00:00Z' }], approvedBy: [], changesBy: [] },
    });
    const r = laneOf(p, [], 'qa-owner', NOW);
    expect(r.lane).toBe('Blocked');
    expect(r.why.en).toContain('E2E Tests');
  });
  test('a review requested from the owner needs the owner', () => {
    const p = pr(2, { lamp: 'ca', cleared: 2 }, { approval: { lamp: 'ca', code: 'requested', requested: [{ login: 'qa-owner', since: '2026-10-21T00:00:00Z' }], approvedBy: [], changesBy: [] } });
    expect(laneOf(p, [], 'qa-owner', NOW).lane).toBe('Needs you');
  });
  test('nobody asked to review a PR into main needs the owner; a feeder does not', () => {
    const g = { approval: { lamp: 'off' as const, code: 'nobody' as const, requested: [], approvedBy: [], changesBy: [] } };
    expect(laneOf(pr(3, { lamp: 'ca', cleared: 2 }, g), [], 'qa-owner', NOW).lane).toBe('Needs you');
    expect(laneOf(pr(3, { lamp: 'go', feeder: true, base: 'integration/x' }, { approval: { lamp: 'go', code: 'self_merge', requested: [], approvedBy: [], changesBy: [] } }), [], 'qa-owner', NOW).lane).toBe('Ready');
  });
  test('a reviewer asked days ago is a wait, and says how long', () => {
    const p = pr(4, { lamp: 'ca', cleared: 2 }, { approval: { lamp: 'ca', code: 'requested', requested: [{ login: 'reviewer-two', since: '2026-10-15T18:00:00Z' }], approvedBy: [], changesBy: [] } });
    const r = laneOf(p, [], 'qa-owner', NOW);
    expect(r.lane).toBe('Waiting');
    expect(r.why.en).toBe('reviewer-two asked 7 days ago');
  });
  test('a clear PR is ready, and names a conflict with another open PR', () => {
    expect(laneOf(pr(5), [], 'qa-owner', NOW)).toEqual({ lane: 'Ready', why: { en: 'Ready to merge', es: 'Listo para mergear' } });
    expect(laneOf(pr(5), [7], 'qa-owner', NOW).why.en).toBe('Ready, but conflicts with #7');
  });
});

describe('order and freshness', () => {
  test('ready first, blocked last, feeders left out', () => {
    const v = mergeView(raw([
      pr(10, { lamp: 'st', cleared: 0 }, { checks: { lamp: 'st', code: 'failing', total: 1, failing: ['x'], pending: 0 } }),
      pr(11),
      pr(12, { feeder: true, base: 'integration/y' }, { approval: { lamp: 'go', code: 'self_merge', requested: [], approvedBy: [], changesBy: [] } }),
    ]), { now: NOW });
    expect(suggestOrder(v.cards)).toEqual([11, 10]);
  });
  test('live, late, stopped and never', () => {
    expect(freshnessOf(raw([]), NOW).state).toBe('live');
    expect(freshnessOf(raw([], { state: { checkedAt: '2026-10-22T17:55:00Z' } }), NOW).state).toBe('late');
    expect(freshnessOf(raw([], { state: { checkedAt: '2026-10-22T12:00:00Z' } }), NOW).state).toBe('stopped');
    expect(freshnessOf(raw([], { collector: { everySec: 90, running: false, lastLine: 'COLLECT fail gh-accounts', ok: false } }), NOW)).toMatchObject({ state: 'stopped', reason: 'COLLECT fail gh-accounts' });
    expect(freshnessOf(raw([], { state: {} }), NOW).state).toBe('never');
    expect(freshnessOf(raw([], { collector: undefined }), NOW)).toMatchObject({ state: 'stopped', reason: 'no collector loop' });
  });
});

describe('the view', () => {
  test('escapes titles, counts lanes, opens the drawer for a known PR only', () => {
    const r = raw([pr(20, { title: '<img src=x onerror=alert(1)>' }), pr(21, { lamp: 'ca', cleared: 2 }, { approval: { lamp: 'off', code: 'nobody', requested: [], approvedBy: [], changesBy: [] } })]);
    const html = viewMerge(r, { live: true, now: NOW });
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img');
    expect(mergeNeeds(r)).toBe(1);
    expect(prDrawer(r, 20, NOW)).toContain('#20');
    expect(prDrawer(r, 99, NOW)).toBeNull();
  });
  test('with no repository known and no PR url, links render as plain text, never an empty href', () => {
    const r = raw([pr(22)], { day: { merged: [{ n: 19, title: 'Merged', base: 'main', mergedAt: '2026-10-22T10:00:00Z', mergeSha: 'abc1234', overnight: false }] } });
    expect(viewMerge(r, { live: true, now: NOW })).not.toContain('href=""');
    expect(prDrawer(r, 22, NOW)).not.toContain('href=""');
    const withRepo = raw([pr(22)], { state: { checkedAt: '2026-10-22T17:59:00Z', repo: 'acme/shop' }, day: r.day });
    expect(viewMerge(withRepo, { live: true, now: NOW })).toContain('href="https://github.com/acme/shop/pull/19"');
  });
  test('a frozen copy says Merge Line is live only', () => {
    expect(viewMerge(null, { live: false })).toContain('live only');
  });
  test('the team copy and the report never route to Merge Line', () => {
    expect(routeView('merge', 'share')).toBe('now');
    expect(routeView('merge', 'report')).toBe('report');
    expect(routeView('merge', 'live')).toBe('merge');
  });
  test('the stopped note says why and what to run', () => {
    const html = viewMerge(raw([], { state: { checkedAt: '2026-10-22T12:00:00Z' } }), { live: true, now: NOW });
    expect(html).toContain('bun run board:up');
  });
});

describe('readMergeLine', () => {
  test('reads the collector documents and tolerates what is missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ml-'));
    expect(readMergeLine(dir)).toMatchObject({ prs: [], alerts: [], pairs: [], notes: {} });
    mkdirSync(join(dir, 'docs', 'prs'), { recursive: true });
    mkdirSync(join(dir, 'docs', 'meta'), { recursive: true });
    mkdirSync(join(dir, 'notes'));
    writeFileSync(join(dir, 'docs', 'prs', '7.json'), JSON.stringify(pr(7)));
    writeFileSync(join(dir, 'docs', 'prs', 'junk.json'), '{');
    writeFileSync(join(dir, 'docs', 'meta', 'alerts.json'), JSON.stringify({ items: [{ code: 'no_owner', subject: '#7', severity: 'caution', params: {}, since: '' }] }));
    writeFileSync(join(dir, 'notes', '7.json'), JSON.stringify({ held: { en: 'waiting on X' } }));
    const r = readMergeLine(dir);
    expect(r.prs.map(p => p.n)).toEqual([7]);
    expect(r.alerts).toHaveLength(1);
    expect(r.notes['7'].held?.en).toBe('waiting on X');
  });
});
