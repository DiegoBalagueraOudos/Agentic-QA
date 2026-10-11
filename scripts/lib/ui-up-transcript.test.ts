/**
 * Golden journal (plan §12): the recorded `bun run up --dry-run` transcript
 * (`cli/lib/fixtures/ui-up-dry-run.transcript.json`, a real run against a consumer
 * project) must translate to exactly the committed journal the page replays. A
 * diff here shows which event changed.
 */

import type { JournalEntry } from '../../cli/lib/ui/events.ts';

import { readFileSync } from 'node:fs';

import { describe, expect, test } from 'bun:test';

import { glossary } from '../../cli/lib/ui/strings.ts';
import { stripAnsi, translateUpTranscript } from './ui-up-transcript.ts';

const fixture = (name: string): string => readFileSync(new URL(`../../cli/lib/fixtures/${name}`, import.meta.url), 'utf8');
const transcript = JSON.parse(fixture('ui-up-dry-run.transcript.json')) as { repo: string, args: string[], exit: number, lines: { ms: number, text: string }[] };
const golden = JSON.parse(fixture('ui-up-dry-run.journal.json')) as JournalEntry[];

describe('golden journal: up --dry-run', () => {
  const journal = translateUpTranscript(transcript.lines, { repo: transcript.repo, args: transcript.args });

  test('re-translating the recorded transcript gives the committed journal', () => {
    expect(journal).toEqual(golden);
  });

  test('the event sequence of a real run', () => {
    const shape = golden.filter(e => e.t !== 'step.start' && e.t !== 'step.end').map(e => `${e.t}${'id' in e && e.t.startsWith('phase') ? `:${e.id}` : ''}`);
    expect(shape).toEqual([
      'run.start',
      'notice',
      'notice',
      'phase.start:fetch',
      'phase.end:fetch',
      'phase.start:self',
      'notice',
      'restart',
      'phase.end:self',
      'phase.start:detect',
      'phase.end:detect',
      'phase.start:scope',
      'phase.end:scope',
      'phase.start:apply',
      'phase.end:apply',
      'phase.start:report',
      'notice',
      'notice',
      'notice',
      'report',
      'phase.end:report',
      'run.end',
    ]);
  });

  test('every step that starts ends, sequence and time never go back', () => {
    const open = new Set<string>();
    let prev = { seq: 0, ts: 0 };
    for (const e of golden) {
      expect(e.seq).toBe(prev.seq + 1);
      expect(e.ts).toBeGreaterThanOrEqual(prev.ts);
      prev = e;
      if (e.t === 'step.start') { open.add(e.id); }
      if (e.t === 'step.end') { expect(open.delete(e.id)).toBe(true); }
    }
    expect(open.size).toBe(0);
  });

  test('the report carries the real parity table, findings and totals', () => {
    const report = golden.find(e => e.t === 'report');
    expect(report?.t).toBe('report');
    if (report?.t !== 'report') { return; }
    expect(report.surfaces?.map(s => s.label)).toEqual(['Instrucciones y config', 'Skills', 'Hooks', 'MCP', 'Env', 'Componentes', 'package.json', 'Git', 'Verificación']);
    expect(report.findings?.map(f => [f.n, f.file, f.blocking])).toEqual([[1, '.codex/config.toml', false], [2, '.claude/settings.json', false], [3, '.claude/skills', true]]);
    expect(report.tiles.find(t => t.label === 'aplicados')?.n).toBe('18');
    expect(report.prompt).toContain('Parity review after `bun run up --dry-run`');
  });

  test('the run is read-only and ends like the updater did (exit 0)', () => {
    expect(golden[0]).toMatchObject({ t: 'run.start', cmd: 'up', mode: 'readonly', args: ['--dry-run'], repo: 'bunkai-qa-engineering' });
    expect(golden[golden.length - 1]).toMatchObject({ t: 'run.end', status: 'done', exit: transcript.exit });
  });

  test('every glossary term the translator links exists', () => {
    const used = [...JSON.stringify(golden).matchAll(/\[\[([a-z0-9-]+)\|/g)].map(m => m[1]);
    expect(used.length).toBeGreaterThan(0);
    for (const k of used) { expect(glossary('es')[k], k).toBeDefined(); }
  });
});

describe('translator edge cases', () => {
  test('a transcript cut before the closing line ends the run as failed', () => {
    const lines = ['── PHASE 1 — FETCH ───────────────', '│', '●  HEAD upstream: abc'].map((text, i) => ({ ms: i * 10, text }));
    const j = translateUpTranscript(lines, { repo: 'x', args: [] });
    expect(j.at(-2)).toMatchObject({ t: 'phase.end', id: 'fetch', status: 'failed' });
    expect(j.at(-1)).toMatchObject({ t: 'run.end', status: 'failed', exit: 1 });
  });

  test('ANSI colour codes are stripped', () => {
    expect(stripAnsi('\u001B[36m── PHASE 1\u001B[39m')).toBe('── PHASE 1');
  });

  test('an error line becomes an error notice and the phase ends with a warning', () => {
    const lines = ['── PHASE 2 — DETECT ──────', '│', '■  git failed', '└  Abortado.'].map((text, i) => ({ ms: i, text }));
    const j = translateUpTranscript(lines, { repo: 'x', args: [] });
    expect(j.find(e => e.t === 'notice' && e.level === 'error')).toMatchObject({ text: 'git failed', phase: 'detect' });
  });
});
