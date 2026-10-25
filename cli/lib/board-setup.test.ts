import type { Catalogs, WorkflowCatalog } from './sprint-source/config.ts';

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { parse as parseYaml } from 'yaml';

import { boardStatusPlan, defaultBoardJql, fillBoardBlock, fillBoardIfValid, readSyncedCatalog } from './board-setup.ts';
import { resolveBoardConfig } from './sprint-source/config.ts';

const REPO = join(import.meta.dir, '..', '..');
/** What a new project starts from: the blank template, every bucket null. */
const TEMPLATE = await Bun.file(join(REPO, '.agents', 'project.schema.yaml')).text();
/** The template with the two values a valid board derives from: the ticket key and the Atlassian host. */
const IDENTIFIED = TEMPLATE
  .replace(/^ {2}project_key: null.*$/m, '  project_key: DEMO')
  .replace(/^ {2}atlassian_url: null.*$/m, '  atlassian_url: https://demo.atlassian.net');

/** Invented statuses; this workflow has no blocked or cancelled status at all. */
const s = (category: string, name: string): { name: string, category: string } => ({ name, category });
const WORKFLOWS: WorkflowCatalog = {
  story: { jira_issue_type: { name: 'Story' }, statuses: { to_do: s('new', 'To Do'), ready_for_qa: s('new', 'Ready For QA'), in_test: s('indeterminate', 'In Test'), done: s('done', 'Done') } },
  bug: { jira_issue_type: { name: 'Bug' }, statuses: { open: s('new', 'Open'), closed: s('done', 'Closed') } },
};
const CATALOGS: Catalogs = { workflows: WORKFLOWS, fields: null, linkTypes: null };

describe('readSyncedCatalog', () => {
  test('a missing file, a broken one and the {} placeholder are all "not synced"', () => {
    const dir = mkdtempSync(join(tmpdir(), 'board-setup-'));
    try {
      writeFileSync(join(dir, 'empty.json'), '{}\n');
      writeFileSync(join(dir, 'broken.json'), '{');
      writeFileSync(join(dir, 'real.json'), JSON.stringify(WORKFLOWS));
      expect(readSyncedCatalog(join(dir, 'missing.json'))).toBeNull();
      expect(readSyncedCatalog(join(dir, 'broken.json'))).toBeNull();
      expect(readSyncedCatalog(join(dir, 'empty.json'))).toBeNull();
      expect(readSyncedCatalog<WorkflowCatalog>(join(dir, 'real.json'))).toEqual(WORKFLOWS);
    }
    finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('defaultBoardJql', () => {
  test('the sprint stories of the project key, and nothing without a key', () => {
    expect(defaultBoardJql('DEMO')).toBe('project = DEMO AND sprint in openSprints() AND issuetype = Story');
    expect(defaultBoardJql(null)).toBeNull();
    expect(defaultBoardJql('  ')).toBeNull();
  });
});

describe('boardStatusPlan', () => {
  test('suggests every workflow status and says a jql is still needed', () => {
    const plan = boardStatusPlan(TEMPLATE, WORKFLOWS);
    expect(plan.note).toBeNull();
    expect(plan.needsJql).toBe(true);
    expect(plan.suggestions.map(x => `${x.domain}.${x.slug}->${x.bucket}`)).toEqual([
      'tickets.to_do->not_ready',
      'tickets.ready_for_qa->in_test',
      'tickets.in_test->in_test',
      'tickets.done->tested',
      'bugs.open->open',
      'bugs.closed->resolved',
    ]);
  });

  test('an unsynced catalog gets the one line, not silence', () => {
    const plan = boardStatusPlan(TEMPLATE, null);
    expect(plan.suggestions).toEqual([]);
    expect(plan.note).toContain('not synced yet');
    expect(plan.note).toContain('bun run jira:sync-workflows');
  });

  test('a yaml with no board: block names the block and how to get it', () => {
    const plan = boardStatusPlan('project:\n  project_key: DEMO\n', WORKFLOWS);
    expect(plan.suggestions).toEqual([]);
    expect(plan.note).toContain('has no board: block');
    expect(plan.note).toContain('bun sync');
    expect(plan.note).toContain('.agents/project.schema.yaml');
  });
});

describe('fillBoardBlock', () => {
  test('writes the suggestions, [] in every bucket left null, the jql; every other line stays', () => {
    const plan = boardStatusPlan(IDENTIFIED, WORKFLOWS);
    const r = fillBoardBlock(IDENTIFIED, { suggestions: plan.suggestions, jql: defaultBoardJql('DEMO') });
    expect(r.ok).toBe(true);
    if (!r.ok) { return; }
    const board = (parseYaml(r.text) as { board: { jql: string, statuses: Record<string, Record<string, string[]>> } }).board;
    expect(board.jql).toBe('project = DEMO AND sprint in openSprints() AND issuetype = Story');
    expect(board.statuses.tickets).toEqual({ not_ready: ['to_do'], in_test: ['ready_for_qa', 'in_test'], tested: ['done'], blocked: [], dropped: [] });
    expect(board.statuses.bugs).toEqual({ open: ['open'], fixed: [], resolved: ['closed'], discarded: [] });
    // Only the board lines changed, each keeping its comment.
    const before = IDENTIFIED.split('\n');
    const after = r.text.split('\n');
    expect(after).toHaveLength(before.length);
    const changed = after.filter((line, i) => line !== before[i]);
    expect(changed).toHaveLength(10);
    expect(changed.every(line => line.includes(' # '))).toBe(true);
  });
});

describe('fillBoardIfValid: setup never turns board:check red', () => {
  test('with a key and a host the filled block resolves ok', () => {
    const plan = boardStatusPlan(IDENTIFIED, WORKFLOWS);
    const r = fillBoardIfValid(IDENTIFIED, { suggestions: plan.suggestions, jql: defaultBoardJql('DEMO') }, CATALOGS);
    expect(r.ok).toBe(true);
    if (!r.ok) { return; }
    expect(resolveBoardConfig(parseYaml(r.text), CATALOGS).state).toBe('ok');
  });

  test('without the key and the host nothing is written, and the errors say what to fill', () => {
    const plan = boardStatusPlan(TEMPLATE, WORKFLOWS);
    const r = fillBoardIfValid(TEMPLATE, { suggestions: plan.suggestions, jql: null }, CATALOGS);
    expect(r.ok).toBe(false);
    if (r.ok) { return; }
    expect(r.errors.join('\n')).toContain('board.jql');
    expect(r.errors.join('\n')).toContain('atlassian_url');
  });
});
