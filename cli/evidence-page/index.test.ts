import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'bun:test';

import { loadBoardConfig } from '../lib/sprint-source/index.ts';

const ROOT = join(import.meta.dir, '..', '..');
const PNG = join(ROOT, 'cli', 'lib', 'evidence-page', 'fixtures', 'demo', 'checkout-error.png');

/** Every temp dir a test made, removed after the suite whatever its outcome. */
const TEMP: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'evidence-cli-'));
  TEMP.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of TEMP) { rmSync(dir, { recursive: true, force: true }); }
});

/**
 * The CLI runs in its own checkout with its own `.agents/project.yaml`, never this repo's: the key
 * pattern and the allowed hosts come from this fixture, so the tests pass in any project.
 */
const CWD = tempDir();
mkdirSync(join(CWD, '.agents'));
writeFileSync(join(CWD, '.agents', 'project.yaml'), [
  'project: { project_name: Fixture Shop, project_key: SHOP }',
  'testing: { default_env: staging, tms_cli: acli }',
  'board:',
  '  source: none',
  '  statuses:',
  '    tickets: { not_ready: [To Do], in_test: [In Test], tested: [Done], blocked: [], dropped: [] }',
  '    bugs: { open: [Open], fixed: [], resolved: [Closed], discarded: [] }',
  '  evidence: { allowed_hosts: [claude.ai] }',
  '',
].join('\n'));
const CONFIG = loadBoardConfig(CWD);
if (CONFIG.state !== 'ok') { throw new Error(`fixture project.yaml: ${JSON.stringify(CONFIG)}`); }
/** A key of the fixture's own shape: `SHOP-<n>`, read from the resolved pattern, not written by hand. */
const KEY_PREFIX = /^\^([A-Z][A-Z0-9]*)-/.exec(CONFIG.config.ticketKeyPattern.source)![1];
const key = (n: number): string => `${KEY_PREFIX}-${n}`;

function evidence(...args: string[]): { code: number, out: string, err: string } {
  const run = Bun.spawnSync(['bun', join(ROOT, 'cli', 'evidence-page', 'index.ts'), ...args], { cwd: CWD, stdout: 'pipe', stderr: 'pipe' });
  return { code: run.exitCode, out: run.stdout.toString(), err: run.stderr.toString() };
}

/** A pack with the bug's thumbnail where `build --thumb` writes it. */
function pack(id: string, kind: 'bug' | 'story' = 'bug', tcs: string[] = []): string {
  const dir = tempDir();
  const path = join(dir, 'evidence-pack.json');
  writeFileSync(path, JSON.stringify({ schema: 'evidence-pack/2.0', kind, ticket: { id, title: 'Total ignores the discount', verdict: 'FAILED', parent: key(7001) }, env: {}, summary: '', tcs: tcs.map(t => ({ id: t })), artifact: { url: 'https://claude.ai/artifact/0000aaaa-7101' } }));
  const thumbDir = join(dir, 'evidence-artifact', id);
  mkdirSync(thumbDir, { recursive: true });
  copyFileSync(PNG, join(thumbDir, `${id}-thumbnail.png`));
  return path;
}

describe('bun run evidence attach / link', () => {
  it('attach --pack --dry-run prints the calls of a first run, never a read-back as done', () => {
    const r = evidence('attach', '--pack', pack(key(7101)), '--source', 'jira-native', '--dry-run');
    expect(r.code).toBe(0);
    expect(r.out).toContain('DRY RUN: nothing sent, nothing read back');
    expect(r.out).toContain(`POST /rest/api/3/issue/${key(7101)}/attachments multipart file=${key(7101)}-thumbnail.png`);
    expect(r.out).toContain(`PUT /rest/api/3/issue/${key(7101)} {"fields":{"description"`);
    expect(r.out).toContain('DRY RUN: read-back not performed');
    expect(r.out).not.toContain('read-back OK');
    // the board step is printed only after a live read-back
    expect(r.out).not.toContain('--evidence-embedded');
  });

  it('attach --json --dry-run returns the calls as data, marked as not sent', () => {
    const r = evidence('attach', '--pack', pack(key(7102)), '--source', 'jira-native', '--dry-run', '--json');
    const line = JSON.parse(r.out.trim()) as { ok: boolean, dryRun: boolean, sent: boolean, calls: string[], lines: string[] };
    expect(line).toMatchObject({ ok: true, dryRun: true, sent: false });
    expect(line.calls[0]).toBe(`GET /rest/api/3/issue/${key(7102)}?fields=attachment,description,comment`);
    expect(line.lines.join('\n')).not.toContain('read-back OK');
  });

  it('attach --replace --dry-run prints the removal of an earlier thumbnail', () => {
    const r = evidence('attach', '--pack', pack(key(7105)), '--source', 'jira-native', '--replace', '--dry-run');
    expect(r.code).toBe(0);
    expect(r.out).toContain('DELETE /rest/api/3/attachment/<earlier attachment id>');
  });

  it('attach refuses a story pack and a key outside the project\'s pattern', () => {
    const story = evidence('attach', '--pack', pack(key(7001), 'story'), '--dry-run');
    expect(story.code).toBe(2);
    expect(story.err).toContain('attach takes a bug\'s pack');
    const other = evidence('attach', '--key', 'OTHER-7101', '--png', PNG, '--dry-run');
    expect(other.code).toBe(2);
    expect(other.err).toContain(`does not match the ticket key pattern ${CONFIG.config.ticketKeyPattern.source}`);
  });

  it('link reads the url from the pack and refuses a run on jira-native', () => {
    const path = pack(key(7103));
    expect(evidence('link', '--pack', path, '--source', 'jira-native', '--dry-run').out).toContain(`POST /rest/api/3/issue/${key(7103)}/remotelink`);
    const r = evidence('link', '--pack', path, '--source', 'jira-native', '--run', 'run-7111', '--dry-run');
    expect(r.code).toBe(2);
    expect(r.err).toContain('the jira-native source has none');
  });

  it('link refuses a deep link to a case the pack does not hold, and a run without a pack or --case', () => {
    const r = evidence('link', '--pack', pack(key(7104), 'story', [key(7112)]), '--source', 'jira-xray', '--test', key(7111), '--exec', key(7141), '--dry-run');
    expect(r.code).toBe(2);
    expect(r.err).toContain(`case ${key(7111)} is not in ${key(7104)}'s pack (${key(7112)})`);
    const bare = evidence('link', '--key', key(7001), '--url', 'https://claude.ai/artifact/0000aaaa-7001', '--source', 'jira-xray', '--run', 'run-7111', '--dry-run');
    expect(bare.code).toBe(2);
    expect(bare.err).toContain('pass --pack <pack.json> or --case <id>');
  });

  it('link refuses a host outside board.evidence.allowed_hosts before any call', () => {
    const r = evidence('link', '--key', key(7001), '--url', 'https://images.example/page', '--dry-run');
    expect(r.code).toBe(1);
    expect(r.err).toContain('is not in board.evidence.allowed_hosts');
  });

  it('none writes nothing and says where the link lives', () => {
    const r = evidence('link', '--key', key(7001), '--url', 'https://claude.ai/artifact/0000aaaa-7001', '--source', 'none');
    expect(r.code).toBe(0);
    expect(r.out).toContain('no tracker (board.source none)');
  });
});
