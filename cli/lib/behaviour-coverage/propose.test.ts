import type { ClassifiedBehaviour, GapList } from './types.ts';

import { describe, expect, test } from 'bun:test';

import { COVERAGE_LABEL, gapIdsIn, proposeTechStories } from './propose.ts';

function gap(id: string, module: string, over: Partial<ClassifiedBehaviour> = {}): ClassifiedBehaviour {
  const [, section] = /#([^/]+)/.exec(id)!;
  return {
    id,
    title: `Title of ${id}`,
    module,
    source: { map: 'e2e', section, local_id: null },
    risk: { level: 'HIGH', flow: 'Catalog browsing' },
    bucket: 'uncovered',
    covered_by: [],
    stale: false,
    tech_story: null,
    ...over,
  };
}

const weakRow = { test: 'DEMO-13', kind: 'manual' as const, verdict: 'weak' as const, evidence: 'valid coupon only', judged_by: 'agent' as const, counted: true, reason: null, outside_regression: true, stale: false, verified: true };

function list(behaviours: ClassifiedBehaviour[]): GapList {
  return { behaviours, gaps: behaviours.map(b => b.id) } as unknown as GapList;
}

const options = { projectKey: 'DEMO', parentKey: 'DEMO-70', techStoryType: 'Tech Story', anchors: [] };

describe('coverage Tech Story proposals (dry run)', () => {
  const gaps = list([
    gap('e2e#feature-billing/BR-002', 'Billing', { bucket: 'weak', covered_by: [weakRow] }),
    gap('e2e#feature-catalog/BR-003', 'Catalog'),
    gap('e2e#feature-catalog/BR-004', 'Catalog', { risk: null }),
  ]);

  test('grain gap: one payload per gap, with parent, label, component and the gap-id lines', () => {
    const { proposals } = proposeTechStories(gaps, { ...options, grain: 'gap' });
    expect(proposals.map(p => p.summary)).toEqual([
      'Coverage: Billing: Title of e2e#feature-billing/BR-002',
      'Coverage: Catalog: Title of e2e#feature-catalog/BR-003',
      'Coverage: Catalog: Title of e2e#feature-catalog/BR-004',
    ]);
    expect(proposals[0].payload).toEqual({ projectKey: 'DEMO', type: 'Tech Story', summary: proposals[0].summary, labels: [COVERAGE_LABEL], parentIssueId: 'DEMO-70' });
    expect(proposals[0].components).toEqual(['Billing']);
    expect(proposals[0].description_md).toContain('`DEMO-13` on `e2e#feature-billing/BR-002`: valid coupon only');
    expect(proposals[0].description_md).toContain('`oracle: observed`');
    expect(gapIdsIn(proposals[2].description_md)).toEqual(['e2e#feature-catalog/BR-004']);
    expect(proposals[2].description_md).toContain('| unranked |');
  });

  test('grain module: one payload per module carrying all its gaps', () => {
    const { proposals } = proposeTechStories(gaps, { ...options, grain: 'module' });
    expect(proposals.map(p => [p.id, p.gap_ids])).toEqual([
      ['module:Billing', ['e2e#feature-billing/BR-002']],
      ['module:Catalog', ['e2e#feature-catalog/BR-003', 'e2e#feature-catalog/BR-004']],
    ]);
  });

  test('a gap an existing Tech Story already anchors is skipped, never proposed twice', () => {
    const result = proposeTechStories(gaps, { ...options, grain: 'gap', anchors: [{ key: 'DEMO-51', title: 't', gap_ids: ['e2e#feature-catalog/BR-003'] }] });
    expect(result.skipped).toEqual([{ id: 'e2e#feature-catalog/BR-003', tech_story: 'DEMO-51' }]);
    expect(result.proposals.flatMap(p => p.gap_ids)).not.toContain('e2e#feature-catalog/BR-003');
  });

  test('an unresolved parent stays null for the caller to resolve first', () => {
    const { proposals } = proposeTechStories(gaps, { ...options, parentKey: null, grain: 'gap' });
    expect(proposals.every(p => p.payload.parentIssueId === null)).toBe(true);
  });

  test('a long title is cut to the summary limit', () => {
    const { proposals } = proposeTechStories(list([gap('e2e#feature-billing/BR-009', 'Billing', { title: 'x'.repeat(400) })]), { ...options, grain: 'gap' });
    expect(proposals[0].summary.length).toBe(250);
    expect(proposals[0].summary.endsWith('...')).toBe(true);
  });
});
