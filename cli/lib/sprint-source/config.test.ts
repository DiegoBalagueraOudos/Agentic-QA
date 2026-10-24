import type { BoardConfigResult, Catalogs, FieldCatalog, WorkflowCatalog } from './config.ts';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';
import { parse as parseYaml } from 'yaml';

import { DEFAULT_TEST_STATUSES, loadBoardConfig, modalityFromTmsCli, resolveBoardConfig } from './config.ts';

const RECORDED = join(import.meta.dir, 'fixtures', 'recorded');
const catalogs: Catalogs = {
  workflows: JSON.parse(readFileSync(join(RECORDED, 'workflows.json'), 'utf8')) as WorkflowCatalog,
  fields: JSON.parse(readFileSync(join(RECORDED, 'fields.json'), 'utf8')) as FieldCatalog,
};

/** A filled jira project yaml; `board` overrides merge into the board block. */
function project(board: Record<string, unknown> | null = {}, rest: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    project: { project_name: 'Acme Store', project_key: 'ACME' },
    issue_tracker: { atlassian_url: 'https://company.atlassian.net/' },
    testing: { default_env: 'staging', tms_cli: 'bun xray' },
    git_strategy: { branches: { production: 'main' }, policy: { require_pr_reviews: 2 } },
    ...rest,
    board: board === null
      ? null
      : {
          source: 'auto',
          jql: 'project = ACME AND sprint in openSprints()',
          statuses: {
            tickets: { not_ready: ['to_do'], in_test: ['in_test'], tested: ['qa_approved'], blocked: ['blocked'], dropped: ['aborted'] },
            bugs: { open: ['open'], fixed: ['ready_for_qa'], resolved: ['closed'], discarded: ['rejected'] },
          },
          ...board,
        },
  };
}

function ok(result: BoardConfigResult): Extract<BoardConfigResult, { state: 'ok' }> {
  if (result.state !== 'ok') { throw new Error(`expected ok, got ${result.state}: ${JSON.stringify(result)}`); }
  return result;
}

function invalid(result: BoardConfigResult): string[] {
  if (result.state !== 'invalid') { throw new Error(`expected invalid, got ${result.state}`); }
  return result.errors;
}

describe('board config: derived values come from their existing homes', () => {
  test('key pattern, env, mainline, approvals, host and source are read, never stored', () => {
    const { config, derived } = ok(resolveBoardConfig(project(), catalogs));
    expect(config.ticketKeyPattern.source).toBe('^ACME-\\d+$');
    expect(config.environment).toBe('staging');
    expect(config.mainline).toBe('main');
    expect(config.requiredApprovals).toBe(2);
    expect(config.jiraHost).toBe('https://company.atlassian.net');
    expect(config.source).toBe('jira-xray');
    expect(config.brand.name).toBe('Acme Store');
    expect(config.evidenceHosts).toEqual(['claude.ai']);
    expect(config.statuses.tests).toEqual(Object.fromEntries(Object.entries(DEFAULT_TEST_STATUSES).map(([k, v]) => [k, [...v]])) as typeof config.statuses.tests);
    const from = Object.fromEntries(derived.map(d => [d.key, d.from]));
    expect(from['board.source']).toBe('testing.tms_cli (board.source: auto)');
    expect(from['board.ticket_key_pattern']).toBe('project.project_key');
    expect(from.mainline).toBe('git_strategy.branches.production');
    expect(from.requiredApprovals).toBe('git_strategy.policy.require_pr_reviews');
  });

  test('auto follows tms_cli: bun xray = jira-xray, anything else = jira-native', () => {
    expect(modalityFromTmsCli('bun xray')).toBe('jira-xray');
    expect(modalityFromTmsCli('bun  xray ')).toBe('jira-xray');
    expect(modalityFromTmsCli('acli')).toBe('jira-native');
    expect(modalityFromTmsCli(null)).toBe('jira-native');
  });

  test('an explicit pattern overrides the derived one', () => {
    const { config } = ok(resolveBoardConfig(project({ ticket_key_pattern: '^(ACME|OPS)-\\d+$' }), catalogs));
    expect(config.ticketKeyPattern.test('OPS-4')).toBe(true);
  });
});

describe('board config: unconfigured is a state, not an error', () => {
  test('no block', () => {
    expect(resolveBoardConfig(project(null), catalogs).state).toBe('unconfigured');
  });

  test('the shipped template (every bucket null)', () => {
    const template = project({
      statuses: {
        tickets: { not_ready: null, in_test: null, tested: null, blocked: null, dropped: null },
        bugs: { open: null, fixed: null, resolved: null, discarded: null },
      },
    });
    expect(resolveBoardConfig(template, catalogs).state).toBe('unconfigured');
  });

  test('the real template of this repo resolves as unconfigured', () => {
    const schema = parseYaml(readFileSync(join(import.meta.dir, '..', '..', '..', '.agents', 'project.schema.yaml'), 'utf8')) as Record<string, unknown>;
    expect(resolveBoardConfig(schema, catalogs).state).toBe('unconfigured');
  });
});

describe('board config: every error names its key path', () => {
  test('a half-filled status map', () => {
    const errors = invalid(resolveBoardConfig(project({ statuses: { tickets: { not_ready: ['to_do'] }, bugs: { open: ['open'] } } }), catalogs));
    expect(errors).toContain('board.statuses.tickets.tested: not filled (list its statuses, or [] when none belong there)');
    expect(errors).toContain('board.statuses.bugs.resolved: not filled (list its statuses, or [] when none belong there)');
  });

  test('a slug the workflow catalog does not know', () => {
    const errors = invalid(resolveBoardConfig(project({
      statuses: {
        tickets: { not_ready: ['to_do'], in_test: ['in_qa_env'], tested: ['qa_approved'], blocked: [], dropped: [] },
        bugs: { open: ['open'], fixed: [], resolved: ['closed'], discarded: [] },
      },
    }), catalogs));
    expect(errors).toEqual(['board.statuses.tickets.in_test: "in_qa_env" is not a status of the story / tech_story work types in .agents/jira-workflows.json']);
  });

  test('a bug slug in a ticket bucket is rejected: each domain is checked against its own work types', () => {
    const errors = invalid(resolveBoardConfig(project({
      statuses: {
        tickets: { not_ready: ['to_do'], in_test: ['in_test', 'ready_for_qa'], tested: ['qa_approved', 'closed'], blocked: [], dropped: [] },
        bugs: { open: ['open'], fixed: [], resolved: ['closed'], discarded: ['in_test'] },
      },
    }), catalogs));
    expect(errors).toEqual([
      'board.statuses.tickets.in_test: "ready_for_qa" is not a status of the story / tech_story work types in .agents/jira-workflows.json',
      'board.statuses.tickets.tested: "closed" is not a status of the story / tech_story work types in .agents/jira-workflows.json',
      'board.statuses.bugs.discarded: "in_test" is not a status of the bug / defect work types in .agents/jira-workflows.json',
    ]);
  });

  test('a Tech Story status is a valid ticket slug', () => {
    const { config } = ok(resolveBoardConfig(project({
      statuses: {
        tickets: { not_ready: ['to_do'], in_test: ['in_test'], tested: ['qa_approved', 'completed'], blocked: ['blocked'], dropped: ['aborted'] },
        bugs: { open: ['open'], fixed: ['ready_for_qa'], resolved: ['closed'], discarded: ['rejected'] },
      },
    }), catalogs));
    expect(config.statusMap.tickets.get('completed')).toBe('tested');
  });

  test('a misspelled key is an error, never "unconfigured"', () => {
    const typo = project(null);
    typo.board = { source: 'auto', statuse: { tickets: { in_test: ['in_test'] } } };
    expect(invalid(resolveBoardConfig(typo, catalogs))).toEqual(['board.statuse: unknown key (expected one of: source, tickets_file, jql, ticket_key_pattern, timezone, statuses, people, evidence, brand)']);
    const nested = invalid(resolveBoardConfig(project({ evidence: { allowed_host: ['claude.ai'] }, brand: { logo: null, colour: 'red' }, people: [{ name: 'Rowan QA', langauge: 'en' }] }), catalogs));
    expect(nested).toEqual([
      'board.evidence.allowed_host: unknown key (expected one of: allowed_hosts)',
      'board.brand.colour: unknown key (expected one of: name, logo)',
      'board.people[0].langauge: unknown key (expected one of: name, role, language, jira)',
    ]);
    const statusTypo = project({ statuses: { tickets: {}, bugs: {}, test: {} } });
    expect(invalid(resolveBoardConfig(statusTypo, catalogs))).toEqual(['board.statuses.test: unknown key (expected one of: tickets, bugs, tests)']);
  });

  test('a typo in a bucket name', () => {
    const errors = invalid(resolveBoardConfig(project({
      statuses: {
        tickets: { not_ready: ['to_do'], in_tests: [], in_test: ['in_test'], tested: ['qa_approved'], blocked: [], dropped: [] },
        bugs: { open: ['open'], fixed: [], resolved: ['closed'], discarded: [] },
      },
    }), catalogs));
    expect(errors[0]).toMatch(/^board\.statuses\.tickets\.in_tests: unknown bucket/);
  });

  test('a jira source with no query, no catalog, no host', () => {
    const errors = invalid(resolveBoardConfig(project({ jql: null }, { issue_tracker: { atlassian_url: null } }), { workflows: null, fields: null }));
    expect(errors.some(e => e.startsWith('board.jql: required for the jira-xray source'))).toBe(true);
    expect(errors.some(e => e.startsWith('.agents/jira-workflows.json is missing'))).toBe(true);
    expect(errors).toContain('issue_tracker.atlassian_url: required for the jira-xray source');
  });

  test('bad timezone, evidence host with a scheme, duplicate person, unknown source', () => {
    const errors = invalid(resolveBoardConfig(project({
      source: 'linear',
      timezone: 'Mars/Olympus',
      evidence: { allowed_hosts: ['https://claude.ai'] },
      people: [{ name: 'Rowan QA' }, { name: 'Rowan QA' }],
    }), catalogs));
    expect(errors).toContain('board.source: expected auto | jira-xray | jira-native | none');
    expect(errors).toContain('board.timezone: "Mars/Olympus" is not an IANA time zone (e.g. America/New_York)');
    expect(errors.some(e => e.includes('must be a bare host name'))).toBe(true);
    expect(errors).toContain('board.people[1].name: "Rowan QA" is listed twice');
  });

  test('no project key and no pattern', () => {
    const errors = invalid(resolveBoardConfig(project({}, { project: { project_name: 'Acme', project_key: null } }), catalogs));
    expect(errors).toContain('board.ticket_key_pattern: null and project.project_key is unset; fill one of them');
  });
});

describe('board config: coverage warnings', () => {
  test('a workflow status in no bucket is a warning before it is a snapshot failure', () => {
    const { warnings } = ok(resolveBoardConfig(project({
      statuses: {
        tickets: { not_ready: ['to_do'], in_test: ['in_test'], tested: ['qa_approved'], blocked: [], dropped: [] },
        bugs: { open: ['open'], fixed: ['ready_for_qa'], resolved: ['closed'], discarded: ['rejected'] },
      },
    }), catalogs));
    expect(warnings).toEqual([
      'board.statuses.tickets: workflow status "blocked" is in no bucket; a ticket in it will fail the snapshot',
      'board.statuses.tickets: workflow status "aborted" is in no bucket; a ticket in it will fail the snapshot',
      'board.statuses.tickets: workflow status "completed" is in no bucket; a ticket in it will fail the snapshot',
    ]);
  });
});

describe('board config: loading from a checkout', () => {
  test('the maintainer copy of this repo resolves without errors', () => {
    const result = loadBoardConfig(join(import.meta.dir, '..', '..', '..'));
    expect(result.state === 'invalid' ? result.errors : []).toEqual([]);
  });
});
