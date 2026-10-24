import type { CollectResult, InventoryTest, JudgedBehaviour, Judgments } from './types.ts';

import { describe, expect, test } from 'bun:test';

import { bucketFor, classify, compareGaps, diffRuns, JudgmentError, mtpFlow, NOT_VERIFIED, runIdFor, validateJudgments } from './classify.ts';

const NOW = new Date('2026-01-14T16:00:00Z');
const MTP = '| 1 | Checkout and payment | CRITICAL |\n| 2 | Catalog browsing | HIGH |';

function testRow(key: string, over: Partial<InventoryTest> = {}): InventoryTest {
  return {
    key,
    title: key,
    kind: 'manual',
    in_manifest: false,
    in_tms: true,
    status: 'ready',
    deprecated: false,
    in_design: false,
    in_regression: true,
    components: [],
    coverables: [],
    atc: null,
    fingerprint: `fp-${key}`,
    ...over,
  };
}

function collectResult(over: Partial<CollectResult> = {}): CollectResult {
  return {
    schema_version: 1,
    collected_at: NOW.toISOString(),
    sources: {
      maps: [
        { map: 'e2e', skill: 'business-e2e-context', state: 'generated', sections: ['feature-billing', 'feature-catalog'] },
        { map: 'api', skill: 'business-api-context', state: 'no-skill', sections: [] },
        { map: 'data', skill: 'business-data-context', state: 'placeholder', sections: [] },
      ],
      tms: { modality: 'jira-xray', state: 'read', reason: null },
      manifest: { state: 'read', ref: 'main@abc', production: 'main', warning: null },
      mtp: { state: 'present', path: '.context/PBI/qa-artifacts/master-test-plan.md' },
    },
    seed: [
      { id: 'e2e#feature-billing', title: 'Billing', hash: 'h-billing' },
      { id: 'e2e#feature-billing/BR-001', title: 'Total', hash: 'h-br1' },
      { id: 'e2e#feature-billing/BR-002', title: 'Coupon', hash: 'h-br2' },
      { id: 'e2e#feature-catalog/BR-003', title: 'Stock', hash: 'h-br3' },
    ],
    tests: [
      testRow('T-1', { kind: 'automated', in_manifest: true }),
      testRow('T-2'),
      testRow('T-3', { in_regression: false }),
      testRow('T-4', { deprecated: true, status: 'deprecated' }),
      testRow('T-5', { in_design: true, status: 'in_design' }),
    ],
    anchors: [],
    warnings: [],
    ...over,
  };
}

function behaviour(id: string, over: Partial<JudgedBehaviour> = {}): JudgedBehaviour {
  return { id, title: id, module: 'Billing', risk: null, covered_by: [], ...over };
}

const judgments = (behaviours: JudgedBehaviour[]): Judgments => ({ schema_version: 1, behaviours });
const ev = (test: string, verdict: 'exercises' | 'weak' = 'exercises', extra: Record<string, string> = {}) => ({ test, verdict, evidence: `asserts ${test}`, ...extra });

describe('bucket precedence', () => {
  test('no counted row is uncovered, only weak rows is weak, an exercising ATC wins over manual', () => {
    expect(bucketFor([])).toBe('uncovered');
    expect(bucketFor([{ counted: false, verdict: 'exercises', kind: 'automated' }])).toBe('uncovered');
    expect(bucketFor([{ counted: true, verdict: 'weak', kind: 'automated' }])).toBe('weak');
    expect(bucketFor([{ counted: true, verdict: 'exercises', kind: 'manual' }, { counted: true, verdict: 'weak', kind: 'automated' }])).toBe('manual-only');
    expect(bucketFor([{ counted: true, verdict: 'exercises', kind: 'manual' }, { counted: true, verdict: 'exercises', kind: 'automated' }])).toBe('automated');
  });
});

describe('validation fails closed', () => {
  test('a valid judgment set has no errors', () => {
    expect(validateJudgments(collectResult(), judgments([behaviour('e2e#feature-billing/BR-001', { covered_by: [ev('T-1')] })]))).toEqual([]);
  });

  test('unknown test, unknown section, unseeded rule id, bad level, empty module, duplicate id are errors', () => {
    const errors = validateJudgments(collectResult(), judgments([
      behaviour('e2e#feature-billing/BR-001', { covered_by: [ev('T-9')] }),
      behaviour('e2e#feature-shipping'),
      behaviour('e2e#feature-billing/BR-099'),
      behaviour('e2e#feature-catalog/BR-003', { risk: { level: 'SEVERE' as never, flow: 'x' } }),
      behaviour('e2e#feature-billing/BR-002', { module: ' ' }),
      behaviour('e2e#feature-billing/BR-002'),
    ]));
    expect(errors.some(e => e.includes('T-9 is not in the test inventory'))).toBe(true);
    expect(errors.some(e => e.includes('no section `feature-shipping`'))).toBe(true);
    expect(errors.some(e => e.includes('BR-099 is not in section'))).toBe(true);
    expect(errors.some(e => e.includes('risk level SEVERE'))).toBe(true);
    expect(errors.some(e => e.includes('module is empty'))).toBe(true);
    expect(errors.some(e => e.includes('duplicate id'))).toBe(true);
  });

  test('a behaviour on a map that is not generated is an error', () => {
    expect(validateJudgments(collectResult(), judgments([behaviour('data#entity-order')]))[0]).toContain('which is placeholder');
  });

  test('a free kebab local id on a known section is accepted', () => {
    expect(validateJudgments(collectResult(), judgments([behaviour('e2e#feature-billing/refund-window')]))).toEqual([]);
  });

  test('without the TMS a key nobody can verify does not count: the behaviour stays a gap, the total is an upper bound', () => {
    const collect = collectResult({
      sources: { ...collectResult().sources, tms: { modality: 'none', state: 'unavailable', reason: '--tms none' } },
      tests: [testRow('T-1', { kind: 'automated', in_manifest: true, in_tms: false })],
    });
    const list = classify({ collect, judgments: judgments([behaviour('e2e#feature-billing/BR-001', { covered_by: [ev('T-9')] })]), mtpText: MTP, previous: null, now: NOW });
    expect(list.behaviours[0].covered_by[0]).toMatchObject({ test: 'T-9', verified: false, kind: 'manual', counted: false, reason: NOT_VERIFIED });
    expect(list.behaviours[0].bucket).toBe('uncovered');
    expect(list.gaps).toEqual(['e2e#feature-billing/BR-001']);
    expect(list.denominators.gaps_upper_bound).toBe(true);
    expect(list.tests).toEqual([]);
  });

  test('a Test still in design does not count, like a deprecated one', () => {
    const list = classify({ collect: collectResult(), judgments: judgments([behaviour('e2e#feature-billing/BR-001', { covered_by: [ev('T-5')] })]), mtpText: MTP, previous: null, now: NOW });
    expect(list.behaviours[0].covered_by[0]).toMatchObject({ counted: false, reason: 'the Test is still in design (status `in_design`), not an approved Test' });
    expect(list.behaviours[0].bucket).toBe('uncovered');
    expect(list.denominators.gaps_upper_bound).toBe(false);
  });

  test('classify throws JudgmentError listing every error', () => {
    expect(() => classify({ collect: collectResult(), judgments: judgments([behaviour('nope')]), mtpText: MTP, previous: null, now: NOW })).toThrow(JudgmentError);
  });
});

describe('classify', () => {
  const set = judgments([
    behaviour('e2e#feature-billing/BR-001', { risk: { level: 'CRITICAL', flow: 'Checkout and payment' }, covered_by: [ev('T-1'), ev('T-2')] }),
    behaviour('e2e#feature-billing/BR-002', { risk: { level: 'CRITICAL', flow: 'Checkout and payment' }, covered_by: [ev('T-3', 'weak')] }),
    behaviour('e2e#feature-billing', { covered_by: [ev('T-2')] }),
    behaviour('e2e#feature-catalog/BR-003', { module: 'Catalog', risk: { level: 'HIGH', flow: 'Catalog browsing' }, covered_by: [ev('T-4'), { test: 'T-2', verdict: 'exercises', evidence: '' }] }),
  ]);

  test('one bucket each, rows that do not count are kept with the reason', () => {
    const list = classify({ collect: collectResult(), judgments: set, mtpText: MTP, previous: null, now: NOW });
    const bucket = Object.fromEntries(list.behaviours.map(b => [b.id, b.bucket]));
    expect(bucket).toEqual({
      'e2e#feature-billing': 'manual-only',
      'e2e#feature-billing/BR-001': 'automated',
      'e2e#feature-billing/BR-002': 'weak',
      'e2e#feature-catalog/BR-003': 'uncovered',
    });
    const br3 = list.behaviours.find(b => b.id === 'e2e#feature-catalog/BR-003')!;
    expect(br3.covered_by.map(r => [r.test, r.counted, r.reason])).toEqual([
      ['T-2', false, 'no evidence: a coverage claim without evidence does not count'],
      ['T-4', false, 'the Test is deprecated in the TMS'],
    ]);
    expect(list.behaviours.find(b => b.id === 'e2e#feature-billing/BR-002')!.covered_by[0].outside_regression).toBe(true);
    expect(list.denominators.buckets).toEqual({ 'automated': 1, 'manual-only': 1, 'weak': 1, 'uncovered': 1 });
    expect(list.denominators.gaps).toBe(2);
    expect(list.run_id).toBe(runIdFor(NOW));
  });

  test('gaps run by MTP risk, then uncovered before weak, then module and id', () => {
    const list = classify({ collect: collectResult(), judgments: set, mtpText: MTP, previous: null, now: NOW });
    expect(list.gaps).toEqual(['e2e#feature-billing/BR-002', 'e2e#feature-catalog/BR-003']);
    const at = (level: 'CRITICAL' | 'LOW' | null, bucket: 'weak' | 'uncovered', id: string) => ({ ...list.behaviours[0], id, bucket, risk: level ? { level, flow: 'f' } : null });
    const sorted = [at(null, 'uncovered', 'a'), at('LOW', 'weak', 'b'), at('CRITICAL', 'weak', 'c'), at('CRITICAL', 'uncovered', 'd')].sort(compareGaps).map(b => b.id);
    expect(sorted).toEqual(['d', 'c', 'b', 'a']);
  });

  test('a flow the MTP cache does not name is unranked, and a missing cache unranks everything', () => {
    const named = classify({ collect: collectResult(), judgments: judgments([behaviour('e2e#feature-billing/BR-001', { risk: { level: 'HIGH', flow: 'Invented flow' } })]), mtpText: MTP, previous: null, now: NOW });
    expect(named.behaviours[0].risk).toBeNull();
    expect(named.warnings.some(w => w.includes('"Invented flow" is not a row or heading of the MTP cache'))).toBe(true);
    const none = classify({ collect: collectResult(), judgments: set, mtpText: null, previous: null, now: NOW });
    expect(none.behaviours.every(b => b.risk === null)).toBe(true);
    expect(none.warnings.some(w => w.startsWith('MTP cache missing'))).toBe(true);
  });

  test('a judgment is stale when its map text or its test changed', () => {
    const list = classify({
      collect: collectResult(),
      judgments: judgments([
        behaviour('e2e#feature-billing/BR-001', { seed_hash: 'old', covered_by: [ev('T-1', 'exercises', { test_fingerprint: 'fp-T-1' })] }),
        behaviour('e2e#feature-billing/BR-002', { seed_hash: 'h-br2', covered_by: [ev('T-2', 'exercises', { test_fingerprint: 'older' })] }),
      ]),
      mtpText: MTP,
      previous: null,
      now: NOW,
    });
    expect(list.behaviours.map(b => [b.id, b.stale, b.covered_by[0].stale])).toEqual([
      ['e2e#feature-billing/BR-001', true, false],
      ['e2e#feature-billing/BR-002', false, true],
    ]);
  });

  test('structured seed ids no judgment names are listed as unjudged; section ids are not', () => {
    const list = classify({ collect: collectResult(), judgments: judgments([behaviour('e2e#feature-billing/BR-001')]), mtpText: MTP, previous: null, now: NOW });
    expect(list.unjudged_seed).toEqual(['e2e#feature-billing/BR-002', 'e2e#feature-catalog/BR-003']);
  });

  test('the inverse view lists only counted rows, each with its verdict, so a weak cover never reads as coverage', () => {
    const list = classify({ collect: collectResult(), judgments: set, mtpText: MTP, previous: null, now: NOW });
    expect(list.tests).toEqual([
      { key: 'T-1', kind: 'automated', covers: [{ id: 'e2e#feature-billing/BR-001', verdict: 'exercises' }] },
      { key: 'T-2', kind: 'manual', covers: [{ id: 'e2e#feature-billing', verdict: 'exercises' }, { id: 'e2e#feature-billing/BR-001', verdict: 'exercises' }] },
      { key: 'T-3', kind: 'manual', covers: [{ id: 'e2e#feature-billing/BR-002', verdict: 'weak' }] },
    ]);
  });

  test('a judgment without its fingerprints says stale detection is off for it', () => {
    const list = classify({
      collect: collectResult(),
      judgments: judgments([
        behaviour('e2e#feature-billing/BR-001', { seed_hash: 'h-br1', covered_by: [ev('T-1', 'exercises', { test_fingerprint: 'fp-T-1' })] }),
        behaviour('e2e#feature-billing/BR-002', { covered_by: [ev('T-2')] }),
      ]),
      mtpText: MTP,
      previous: null,
      now: NOW,
    });
    expect(list.warnings.filter(w => w.includes('stale detection is off'))).toEqual(['e2e#feature-billing/BR-002: no seed_hash, test_fingerprint of T-2: stale detection is off for it']);
  });

  test('no judgment yet against a seed is a stated note, never a clean slate', () => {
    const list = classify({ collect: collectResult(), judgments: judgments([]), mtpText: MTP, previous: null, now: NOW });
    expect(list.gaps).toEqual([]);
    expect(list.warnings).toContain('4 behaviours not judged yet: nothing is classified, so this list is not a clean slate');
    const partial = classify({ collect: collectResult(), judgments: judgments([behaviour('e2e#feature-billing/BR-001')]), mtpText: MTP, previous: null, now: NOW });
    expect(partial.warnings).toContain('2 behaviours not judged yet (structured rule ids): the gap list is incomplete');
  });

  test('same inputs, same gap list (recomputable)', () => {
    const a = classify({ collect: collectResult(), judgments: set, mtpText: MTP, previous: null, now: NOW });
    const b = classify({ collect: collectResult(), judgments: structuredClone(set), mtpText: MTP, previous: null, now: NOW });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe('MTP flow lookup', () => {
  const mtp = '# Plan\n\n## Silent killers: nightly price sync\n\n| Level | Flow |\n|---|---|\n| **HIGH** | Checkout and payment |\n| MEDIUM | `Saved searches` |\n\nPayment retries are mentioned here in prose.';

  test('a table row matches by a whole cell and carries its own level; a heading matches without a level; prose does not count', () => {
    expect(mtpFlow(mtp, 'checkout and payment')).toEqual({ found: 'row', level: 'HIGH' });
    expect(mtpFlow(mtp, 'Saved searches')).toEqual({ found: 'row', level: 'MEDIUM' });
    expect(mtpFlow(mtp, 'nightly price sync')).toEqual({ found: 'heading' });
    expect(mtpFlow(mtp, 'payment')).toBeNull();
    expect(mtpFlow(mtp, 'Payment retries')).toBeNull();
    expect(mtpFlow(mtp, ' ')).toBeNull();
  });

  test('a judged level that disagrees with the MTP row is replaced by the row\'s level, with a warning', () => {
    const list = classify({ collect: collectResult(), judgments: judgments([behaviour('e2e#feature-billing/BR-001', { risk: { level: 'CRITICAL', flow: 'Checkout and payment' } })]), mtpText: mtp, previous: null, now: NOW });
    expect(list.behaviours[0].risk).toEqual({ level: 'HIGH', flow: 'Checkout and payment' });
    expect(list.warnings).toContain('e2e#feature-billing/BR-001: judged CRITICAL, but the MTP row of "Checkout and payment" says HIGH: the MTP level is used');
  });
});

describe('run over run', () => {
  test('closed, regressed, added and removed against the previous run', () => {
    const first = classify({
      collect: collectResult(),
      judgments: judgments([
        behaviour('e2e#feature-billing/BR-001', { covered_by: [ev('T-3', 'weak')] }),
        behaviour('e2e#feature-billing/BR-002', { covered_by: [ev('T-1')] }),
        behaviour('e2e#feature-catalog/BR-003'),
      ]),
      mtpText: MTP,
      previous: null,
      now: NOW,
    });
    expect(first.diff.previous_run).toBeNull();
    const second = classify({
      collect: collectResult(),
      judgments: judgments([
        behaviour('e2e#feature-billing/BR-001', { covered_by: [ev('T-1')] }),
        behaviour('e2e#feature-billing/BR-002', { covered_by: [ev('T-3', 'weak')] }),
        behaviour('e2e#feature-billing'),
      ]),
      mtpText: MTP,
      previous: first,
      now: new Date('2026-01-21T16:00:00Z'),
    });
    expect(second.diff).toEqual({
      previous_run: first.run_id,
      closed: [{ id: 'e2e#feature-billing/BR-001', from: 'weak', to: 'automated' }],
      regressed: [{ id: 'e2e#feature-billing/BR-002', from: 'automated', to: 'weak' }],
      changed: [
        { id: 'e2e#feature-billing/BR-001', from: 'weak', to: 'automated' },
        { id: 'e2e#feature-billing/BR-002', from: 'automated', to: 'weak' },
      ],
      added: ['e2e#feature-billing'],
      removed: ['e2e#feature-catalog/BR-003'],
    });
  });

  test('a run that read the TMS differently from the previous one says the diff is not like for like', () => {
    const first = classify({ collect: collectResult(), judgments: judgments([]), mtpText: MTP, previous: null, now: NOW });
    const offline = collectResult({ sources: { ...collectResult().sources, tms: { modality: 'none', state: 'unavailable', reason: '--tms none' } } });
    const second = classify({ collect: offline, judgments: judgments([]), mtpText: MTP, previous: first, now: NOW });
    expect(second.warnings.some(w => w.includes('compares verified with unverified coverage'))).toBe(true);
    expect(diffRuns(null, []).previous_run).toBeNull();
  });
});
