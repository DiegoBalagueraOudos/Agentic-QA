import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';

import { exitCodeOf, plainMsg, preflightJson, runUpPreflight, verdictOf } from './preflight.ts';

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), 'preflight-'));
  spawnSync('git', ['init', '-q', root]);
  spawnSync('git', ['-C', root, '-c', 'user.email=t@t.invalid', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init']);
  return root;
}

/** A local template source: no gh session and no network probe (preflight.md §3). */
const LOCAL = '/tmp/some-local-boilerplate-clone';

describe('verdict', () => {
  test('any block blocks, else any warn warns, else clear; exit codes 2 / 1 / 0', () => {
    expect(verdictOf([{ label: 'a', state: 'ok' }, { label: 'b', state: 'info' }])).toBe('clear');
    expect(verdictOf([{ label: 'a', state: 'warn' }, { label: 'b', state: 'ok' }])).toBe('warn');
    expect(verdictOf([{ label: 'a', state: 'warn' }, { label: 'b', state: 'block' }])).toBe('block');
    expect([exitCodeOf('clear'), exitCodeOf('warn'), exitCodeOf('block')]).toEqual([0, 1, 2]);
  });
});

describe('checks for bun run up', () => {
  test('a healthy checkout with a local source is clear, and gh is not needed', async () => {
    const r = await runUpPreflight({ cwd: repo(), templateRepo: LOCAL, lockFile: '.template/boilerplate.lock.json', lang: 'en', minFreeBytes: 1 });
    const ids = r.checks.map(c => c.id);
    expect(ids).toEqual(['bun', 'node', 'git-version', 'gh-auth', 'worktree', 'lock', 'disk']);
    expect(r.checks.find(c => c.id === 'gh-auth')).toMatchObject({ state: 'info' });
    expect(r.checks.find(c => c.id === 'lock')).toMatchObject({ state: 'info', value: 'first update' });
    expect(r.checks.some(c => c.id === 'net-github')).toBe(false);
    expect(['clear', 'warn']).toContain(r.verdict);
  });

  test('a damaged lock blocks with the restore command; an old schema only informs', async () => {
    const root = repo();
    mkdirSync(join(root, '.template'));
    writeFileSync(join(root, '.template', 'boilerplate.lock.json'), '{ not json');
    const bad = await runUpPreflight({ cwd: root, templateRepo: LOCAL, lockFile: '.template/boilerplate.lock.json', lang: 'es', minFreeBytes: 1 });
    expect(bad.verdict).toBe('block');
    expect(bad.checks.find(c => c.id === 'lock')).toMatchObject({ state: 'block', fix: 'git checkout -- .template/boilerplate.lock.json' });

    writeFileSync(join(root, '.template', 'boilerplate.lock.json'), JSON.stringify({ schemaVersion: 6 }));
    const old = await runUpPreflight({ cwd: root, templateRepo: LOCAL, lockFile: '.template/boilerplate.lock.json', lang: 'es', minFreeBytes: 1 });
    expect(old.checks.find(c => c.id === 'lock')).toMatchObject({ state: 'info', value: 'v6' });
  });

  test('a linked worktree blocks and names the main checkout', async () => {
    const root = repo();
    const wt = join(mkdtempSync(join(tmpdir(), 'preflight-wt-')), 'wt');
    spawnSync('git', ['-C', root, 'worktree', 'add', '-q', '-b', 'probe', wt]);
    const r = await runUpPreflight({ cwd: wt, templateRepo: LOCAL, lockFile: '.template/boilerplate.lock.json', lang: 'en', minFreeBytes: 1 });
    const row = r.checks.find(c => c.id === 'worktree')!;
    expect(row.state).toBe('block');
    expect(plainMsg(row.msg!)).toContain('main checkout');
  });

  test('low disk warns; the caller\'s extra rows join the checklist', async () => {
    const r = await runUpPreflight({ cwd: repo(), templateRepo: LOCAL, lockFile: 'x.json', lang: 'es', minFreeBytes: Number.MAX_SAFE_INTEGER, extra: [{ id: 'harness-migration', label: 'Migración', state: 'info', neededBy: 'fetch' }] });
    expect(r.checks.find(c => c.id === 'disk')).toMatchObject({ state: 'warn' });
    expect(r.checks[r.checks.length - 1].id).toBe('harness-migration');
  });
});

describe('--json', () => {
  test('one object per row with id, verdict, needed_by and the fix; names, never values', async () => {
    const r = await runUpPreflight({ cwd: repo(), templateRepo: LOCAL, lockFile: 'x.json', lang: 'en', minFreeBytes: 1 });
    const j = preflightJson(r);
    expect(j.verdict).toBe(r.verdict);
    expect(j.checks[0]).toEqual({ id: 'bun', group: 'Tools', verdict: 'ok', observed: process.versions.bun, needed_by: 'fetch', fix: null, message: null });
  });

  test('the CLI prints the JSON and exits with the verdict code', () => {
    const r = spawnSync(process.execPath, [join(import.meta.dir, 'preflight.ts'), '--for', 'up', '--json'], { cwd: repo(), encoding: 'utf8', env: { ...process.env, UPEX_TEMPLATE_REPO: LOCAL } });
    const parsed = JSON.parse(r.stdout) as { verdict: string };
    expect(r.status).toBe(exitCodeOf(parsed.verdict as 'clear'));
  });
});
