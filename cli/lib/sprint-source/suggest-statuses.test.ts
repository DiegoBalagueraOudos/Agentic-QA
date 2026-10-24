import type { WorkflowCatalog } from './config.ts';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { parse as parseYaml } from 'yaml';

import { resolveBoardConfig } from './config.ts';
import { applyStatusSuggestions, currentBuckets, suggestStatusBuckets } from './suggest-statuses.ts';

const REPO = join(import.meta.dir, '..', '..', '..');

/** A workflow mirror shaped like `.agents/jira-workflows.json`, statuses and categories invented. */
const s = (category: string, name: string) => ({ name, category });
const CATALOG: WorkflowCatalog = {
  story: {
    jira_issue_type: { name: 'Story' },
    statuses: {
      backlog: s('new', 'Backlog'),
      ready_for_dev: s('new', 'Ready For Dev'),
      in_progress: s('indeterminate', 'In Progress'),
      shift_left_qa: s('indeterminate', 'Shift-Left QA'),
      ready_for_qa: s('new', 'Ready For QA'),
      in_test: s('indeterminate', 'In Test'),
      blocked: s('new', 'BLOCKED'),
      qa_approved: s('done', 'QA Approved'),
      deployed_to_production: s('done', 'Deployed to Production'),
      aborted: s('done', 'ABORTED'),
    },
  },
  tech_story: { jira_issue_type: { name: 'Tech Story' }, statuses: { to_do: s('new', 'To Do'), fixed: s('done', 'Fixed'), aborted: s('done', 'ABORTED') } },
  bug: {
    jira_issue_type: { name: 'Bug' },
    statuses: {
      open: s('new', 'Open'),
      in_progress: s('indeterminate', 'In Progress'),
      deferred: s('indeterminate', 'Deferred'),
      ready_for_qa: s('new', 'Ready For QA'),
      closed: s('done', 'Closed'),
      cannot_reproduce: s('done', 'Cannot Reproduce'),
      duplicated: s('done', 'Duplicated'),
      enhancement: s('done', 'Enhancement'),
    },
  },
};

const EMPTY = { tickets: {}, bugs: {} };
const bucketOf = (domain: string, slug: string) => suggestStatusBuckets(CATALOG, EMPTY).find(x => x.domain === domain && x.slug === slug)?.bucket;

describe('suggested buckets', () => {
  test('tickets: category done is tested unless cancelled; ready for / in QA is in test; shift-left is not', () => {
    expect(bucketOf('tickets', 'qa_approved')).toBe('tested');
    expect(bucketOf('tickets', 'deployed_to_production')).toBe('tested');
    expect(bucketOf('tickets', 'fixed')).toBe('tested');
    expect(bucketOf('tickets', 'aborted')).toBe('dropped');
    expect(bucketOf('tickets', 'blocked')).toBe('blocked');
    expect(bucketOf('tickets', 'ready_for_qa')).toBe('in_test');
    expect(bucketOf('tickets', 'in_test')).toBe('in_test');
    expect(bucketOf('tickets', 'shift_left_qa')).toBe('not_ready');
    expect(bucketOf('tickets', 'ready_for_dev')).toBe('not_ready');
  });

  test('bugs: done is resolved unless it reads as not a defect; ready for QA waits for its retest', () => {
    expect(bucketOf('bugs', 'closed')).toBe('resolved');
    expect(bucketOf('bugs', 'cannot_reproduce')).toBe('discarded');
    expect(bucketOf('bugs', 'duplicated')).toBe('discarded');
    expect(bucketOf('bugs', 'enhancement')).toBe('discarded');
    expect(bucketOf('bugs', 'ready_for_qa')).toBe('fixed');
    expect(bucketOf('bugs', 'deferred')).toBe('open');
  });

  test('a slug two work types share is suggested once; a listed slug is never moved', () => {
    const all = suggestStatusBuckets(CATALOG, EMPTY);
    expect(all.filter(x => x.domain === 'tickets' && x.slug === 'aborted')).toHaveLength(1);
    const some = suggestStatusBuckets(CATALOG, { tickets: { tested: ['aborted'], in_test: null }, bugs: {} });
    expect(some.find(x => x.slug === 'aborted' && x.domain === 'tickets')).toBeUndefined();
  });
});

describe('writing them into project.yaml', () => {
  test('on the shipped template (every bucket null) the result validates with no status left unbucketed', () => {
    const template = readFileSync(join(REPO, '.agents', 'project.schema.yaml'), 'utf8')
      .replace(/^ {2}project_key: null/m, '  project_key: ACME')
      .replace(/^ {2}jql: null/m, '  jql: project = ACME AND sprint in openSprints() AND issuetype = Story')
      .replace(/^ {2}atlassian_url: null/m, '  atlassian_url: https://company.atlassian.net');
    const suggestions = suggestStatusBuckets(CATALOG, currentBuckets(parseYaml(template)));
    const result = applyStatusSuggestions(template, suggestions);
    expect(result.ok).toBe(true);
    if (!result.ok) { return; }
    const before = template.split('\n');
    const after = result.text.split('\n');
    expect(after).toHaveLength(before.length);
    // only bucket lines changed, comments kept
    const changed = after.map((line, i) => [before[i], line]).filter(([a, b]) => a !== b);
    expect(changed.every(([a, b]) => a.replace(/null/, '') === b.replace(/\[[^\]]*\]/, ''))).toBe(true);
    expect(result.text).toContain('      in_test: [ready_for_qa, in_test] # in the test environment, QA\'s turn');
    const resolved = resolveBoardConfig(parseYaml(result.text), { workflows: CATALOG, fields: null });
    expect(resolved.state === 'invalid' ? resolved.errors : []).toEqual([]);
    if (resolved.state === 'ok') { expect(resolved.warnings.filter(w => w.includes('is in no bucket'))).toEqual([]); }
  });

  test('appends to a filled list without touching what is there', () => {
    const yaml = 'board:\n  statuses:\n    tickets:\n      tested: [qa_approved] # past the gate\n      dropped: [] # cancelled\n    bugs:\n      open: [open]\n';
    const result = applyStatusSuggestions(yaml, [
      { domain: 'tickets', slug: 'fixed', name: 'Fixed', category: 'done', bucket: 'tested' },
      { domain: 'tickets', slug: 'aborted', name: 'ABORTED', category: 'done', bucket: 'dropped' },
    ]);
    expect(result).toEqual({ ok: true, applied: 2, text: 'board:\n  statuses:\n    tickets:\n      tested: [qa_approved, fixed] # past the gate\n      dropped: [aborted] # cancelled\n    bugs:\n      open: [open]\n' });
  });

  test('refuses a block list or a missing bucket key instead of guessing', () => {
    const block = 'board:\n  statuses:\n    tickets:\n      tested:\n        - qa_approved\n';
    expect(applyStatusSuggestions(block, [{ domain: 'tickets', slug: 'fixed', name: 'Fixed', category: 'done', bucket: 'tested' }])).toMatchObject({ ok: false, error: expect.stringContaining('a block list') });
    const missing = 'board:\n  statuses:\n    tickets:\n      tested: []\n';
    expect(applyStatusSuggestions(missing, [{ domain: 'tickets', slug: 'aborted', name: 'ABORTED', category: 'done', bucket: 'dropped' }])).toMatchObject({ ok: false, error: expect.stringContaining('board.statuses.tickets.dropped: not found') });
  });
});
