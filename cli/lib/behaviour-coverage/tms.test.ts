import type { WorkflowCatalog } from '../sprint-source/config.ts';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';

import { FIXTURES, replayTransport } from './fixtures/mini-repo.ts';
import { adfText, designStatusSlugs, readTmsInventory } from './tms.ts';

const workflows = JSON.parse(readFileSync(join(FIXTURES, 'workflows.json'), 'utf8')) as WorkflowCatalog;

describe('TMS inventory (jira-xray)', () => {
  test('reads every Test with its slug, the cascade coverables, RTP membership and existing anchors', async () => {
    const transport = replayTransport();
    const inv = await readTmsInventory({ transport, projectKey: 'DEMO', modality: 'jira-xray', workflows, testLink: 'Test' });
    expect(inv.tests.map(t => [t.key, t.status, t.coverables, t.in_regression])).toEqual([
      ['DEMO-11', 'automated', ['DEMO-1'], true],
      ['DEMO-12', 'manual', ['DEMO-2'], true],
      ['DEMO-13', 'ready', ['DEMO-2'], false],
      ['DEMO-14', 'deprecated', [], true],
      ['DEMO-16', 'automated', [], false],
      ['DEMO-17', 'in_design', [], false],
    ]);
    expect(inv.anchors).toEqual([{ key: 'DEMO-51', title: 'Coverage: Catalog: Search results hide products that are out of stock', gap_ids: ['e2e#feature-catalog/BR-003'] }]);
    expect(inv.warnings).toEqual([]);
    // The RTP and the ATP that links a coverable are asked for their members; the FTP that links none is not.
    expect(transport.calls.filter(c => c.startsWith('xray'))).toEqual([
      'xray {"issueId":"2041","limit":100,"start":0}',
      'xray {"issueId":"2042","limit":100,"start":0}',
    ]);
  });

  test('jira-native reads regression membership from labels only, never from Xray', async () => {
    const transport = replayTransport();
    const inv = await readTmsInventory({ transport, projectKey: 'DEMO', modality: 'jira-native', workflows, testLink: 'Test' });
    expect(inv.tests.find(t => t.key === 'DEMO-12')!.in_regression).toBe(false);
    expect(inv.tests.find(t => t.key === 'DEMO-11')!.in_regression).toBe(true);
    expect(inv.tests.find(t => t.key === 'DEMO-13')!.coverables).toEqual([]);
    expect(transport.calls.some(c => c.startsWith('xray') || c.includes('Test Plan'))).toBe(false);
  });

  test('an Xray failure keeps the Jira inventory and leaves membership unknown, never outside regression', async () => {
    const transport = replayTransport();
    transport.xray = async () => { throw new Error('Authentication failed: 403'); };
    const inv = await readTmsInventory({ transport, projectKey: 'DEMO', modality: 'jira-xray', workflows, testLink: 'Test' });
    expect(inv.tests.map(t => [t.key, t.in_regression])).toEqual([['DEMO-11', true], ['DEMO-12', null], ['DEMO-13', null], ['DEMO-14', true], ['DEMO-16', null], ['DEMO-17', null]]);
    expect(inv.warnings).toEqual(['Test Plan membership not read (Xray: Authentication failed: 403): a Test without a regression label reads as unknown, not outside regression, and the Test Plan leg of the cascade is skipped']);
    expect(inv.anchors).toHaveLength(1);
  });

  test('a status the catalog does not hold is a warning, never a guessed slug', async () => {
    const inv = await readTmsInventory({ transport: replayTransport(), projectKey: 'DEMO', modality: 'jira-native', workflows: { ...workflows, test_case: { jira_issue_type: { name: 'Test' }, statuses: {} } }, testLink: 'Test' });
    expect(inv.tests.every(t => t.status === null)).toBe(true);
    expect(inv.warnings[0]).toContain('is not in .agents/jira-workflows.json');
  });

  test('the design statuses come from the catalog transitions, never from a hardcoded slug', () => {
    expect([...designStatusSlugs(workflows)]).toEqual(['draft', 'in_design']);
    const renamed = { test_case: { transitions: { create: { to_canonical: 'new_tc' }, start_design: { to_canonical: 'authoring' } } } } as unknown as WorkflowCatalog;
    expect([...designStatusSlugs(renamed)]).toEqual(['new_tc', 'authoring']);
    expect(designStatusSlugs(null).size).toBe(0);
  });

  test('ADF descriptions flatten to text for the gap-id lines', () => {
    expect(adfText({ content: [{ content: [{ text: 'a' }] }, { text: 'b' }] })).toBe('a\nb');
    expect(adfText('plain')).toBe('plain');
    expect(adfText(null)).toBe('');
  });
});
