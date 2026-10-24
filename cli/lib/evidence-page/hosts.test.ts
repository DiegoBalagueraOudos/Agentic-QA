import { join } from 'node:path';
import { describe, expect, it } from 'bun:test';

import { demoStoryPack } from './demo.ts';
import { evidenceUrlError, publishEvidence, recordPublication } from './hosts.ts';

const HOSTS = ['claude.ai'];
const URL_A = 'https://claude.ai/artifact/abc123';
const URL_CODE = 'https://claude.ai/code/artifact/0f0e0d0c-0b0a-4908-8706-050403020100';

describe('publishEvidence', () => {
  it('local: returns the repo-relative path, already published', () => {
    const result = publishEvidence('/repo/.context/PBI/x/evidence/evidence-page/index.html', null, 'local', { packPath: 'p', repoRoot: '/repo' });
    expect(result).toEqual({ ref: { host: 'local', location: '.context/PBI/x/evidence/evidence-page/index.html', state: 'published' } });
  });

  it('claude-artifact, first publish: the agent publishes the file with an icon, then records the URL', () => {
    const page = join('/tmp', 'evidence-page', 'index.html');
    const { ref, agentStep } = publishEvidence(page, undefined, 'claude-artifact', { packPath: 'pack.json' });
    expect(ref).toEqual({ host: 'claude-artifact', location: page, state: 'agent-action' });
    expect(agentStep?.publish).toEqual({ file_path: page, icon: 'evidence' });
    expect(agentStep?.readFirst).toBeNull();
    expect(agentStep?.record).toContain('bun run evidence record --pack pack.json --url');
  });

  it('claude-artifact, republish: read the existing URL first and publish to the SAME url', () => {
    const { ref, agentStep } = publishEvidence('/tmp/index.html', URL_A, 'claude-artifact', { packPath: 'pack.json' });
    expect(ref.location).toBe(URL_A);
    expect(agentStep?.readFirst).toBe(URL_A);
    expect(agentStep?.publish).toEqual({ file_path: '/tmp/index.html', url: URL_A });
    expect(agentStep?.instructions.join(' ')).toContain('Never omit url');
  });
});

describe('evidenceUrlError', () => {
  it('accepts both claude.ai artifact forms', () => {
    expect(evidenceUrlError(URL_A, HOSTS)).toBeNull();
    expect(evidenceUrlError(URL_CODE, HOSTS)).toBeNull();
  });

  it('refuses other hosts, plain http, other claude.ai paths and query strings', () => {
    expect(evidenceUrlError('https://imgbox.example/abc', HOSTS)).toContain('not in board.evidence.allowed_hosts');
    expect(evidenceUrlError('http://claude.ai/artifact/abc', HOSTS)).toBe('an evidence link must be https');
    expect(evidenceUrlError('https://claude.ai/chat/abc', HOSTS)).toContain('must be https://claude.ai/artifact/<id>');
    expect(evidenceUrlError(`${URL_A}?share=1`, HOSTS)).toBe('an evidence link carries no query string or fragment');
    expect(evidenceUrlError('not a url', HOSTS)).toContain('is not a URL');
    // N8: userinfo in an evidence link
    expect(evidenceUrlError('https://u:p@claude.ai/artifact/x', HOSTS)).toBe('an evidence link carries no user name or password');
  });
});

describe('recordPublication', () => {
  const now = new Date('2026-10-24T12:00:00Z');

  it('stores the URL and appends the publication', () => {
    const first = recordPublication(demoStoryPack(), URL_A, { allowedHosts: HOSTS, now });
    expect(first.ok).toBe(true);
    if (!first.ok) {
      return;
    }
    expect(first.pack.artifact).toEqual({ host: 'claude-artifact', ref: URL_A, published: [{ ref: URL_A, at: now.toISOString() }] });
    const again = recordPublication(first.pack, URL_A, { allowedHosts: HOSTS, now });
    expect(again.ok && again.pack.artifact?.published).toHaveLength(2);
  });

  it('refuses a second URL for a published pack', () => {
    const first = recordPublication(demoStoryPack(), URL_A, { allowedHosts: HOSTS, now });
    const second = first.ok ? recordPublication(first.pack, URL_CODE, { allowedHosts: HOSTS, now }) : first;
    expect(second).toEqual({ ok: false, error: `this pack is already published at ${URL_A}; republish to that url instead of minting a second page` });
  });
});
