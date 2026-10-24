import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'bun:test';

const ROOT = join(import.meta.dir, '..', '..');
const PNG = join(ROOT, 'cli', 'lib', 'evidence-page', 'fixtures', 'demo', 'checkout-error.png');

/** `bun run evidence` from the repo root, so the project's board: block and key pattern apply. */
function evidence(...args: string[]): { code: number, out: string, err: string } {
  const run = Bun.spawnSync(['bun', join(ROOT, 'cli', 'evidence-page', 'index.ts'), ...args], { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' });
  return { code: run.exitCode, out: run.stdout.toString(), err: run.stderr.toString() };
}

/** A bug pack with its thumbnail where `build --thumb` writes it; the key follows the project's own pattern. */
function bugPack(key: string, kind: 'bug' | 'story' = 'bug'): string {
  const dir = mkdtempSync(join(tmpdir(), 'evidence-cli-'));
  const pack = join(dir, 'evidence-pack.json');
  writeFileSync(pack, JSON.stringify({ schema: 'evidence-pack/2.0', kind, ticket: { id: key, title: 'Total ignores the discount', verdict: 'FAILED', parent: 'BK-7001' }, env: {}, summary: '', tcs: [], artifact: { url: 'https://claude.ai/artifact/0000aaaa-7101' } }));
  const thumbDir = join(dir, 'evidence-artifact', key);
  mkdirSync(thumbDir, { recursive: true });
  copyFileSync(PNG, join(thumbDir, `${key}-thumbnail.png`));
  return pack;
}

describe('bun run evidence attach / link', () => {
  it('attach --pack --dry-run prints the calls of a first run and the thumbnail it found', () => {
    const r = evidence('attach', '--pack', bugPack('BK-7101'), '--source', 'jira-native', '--dry-run');
    expect(r.code).toBe(0);
    expect(r.out).toContain('dry run: nothing sent');
    expect(r.out).toContain('POST /rest/api/3/issue/BK-7101/attachments multipart file=BK-7101-thumbnail.png');
    expect(r.out).toContain('PUT /rest/api/3/issue/BK-7101 {"fields":{"description"');
    // the board step is printed only after a live read-back
    expect(r.out).not.toContain('--evidence-embedded');
  });

  it('attach --json --dry-run returns the calls as data', () => {
    const r = evidence('attach', '--pack', bugPack('BK-7102'), '--source', 'jira-native', '--dry-run', '--json');
    const line = JSON.parse(r.out.trim()) as { ok: boolean, dryRun: boolean, calls: string[] };
    expect(line).toMatchObject({ ok: true, dryRun: true });
    expect(line.calls[0]).toBe('GET /rest/api/3/issue/BK-7102?fields=attachment,description');
  });

  it('attach refuses a story pack', () => {
    const r = evidence('attach', '--pack', bugPack('BK-7001', 'story'), '--dry-run');
    expect(r.code).toBe(2);
    expect(r.err).toContain('attach takes a bug\'s pack');
  });

  it('link reads the url from the pack and refuses a run on jira-native', () => {
    const pack = bugPack('BK-7103');
    expect(evidence('link', '--pack', pack, '--source', 'jira-native', '--dry-run').out).toContain('POST /rest/api/3/issue/BK-7103/remotelink');
    const r = evidence('link', '--pack', pack, '--source', 'jira-native', '--run', 'run-7111', '--dry-run');
    expect(r.code).toBe(2);
    expect(r.err).toContain('the jira-native source has none');
  });

  it('link refuses a deep link to a case the pack does not hold', () => {
    const r = evidence('link', '--pack', bugPack('BK-7104'), '--source', 'jira-xray', '--test', 'BK-7111', '--exec', 'BK-7141', '--dry-run');
    expect(r.code).toBe(2);
    expect(r.err).toContain('case BK-7111 is not in BK-7104\'s pack');
  });

  it('link refuses a host outside board.evidence.allowed_hosts before any call', () => {
    const r = evidence('link', '--key', 'BK-7001', '--url', 'https://images.example/page', '--dry-run');
    expect(r.code).toBe(1);
    expect(r.err).toContain('is not in board.evidence.allowed_hosts');
  });

  it('none writes nothing and says where the link lives', () => {
    const r = evidence('link', '--key', 'BK-7001', '--url', 'https://claude.ai/artifact/0000aaaa-7001', '--source', 'none');
    expect(r.code).toBe(0);
    expect(r.out).toContain('no tracker (board.source none)');
  });
});
