import type { BoardConfig } from './config.ts';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';
import { parse as parseYaml } from 'yaml';

import { resolveBoardConfig } from './config.ts';
import { createNoneSource, TicketsFileError } from './none.ts';
import { UnknownStatusError } from './status-map.ts';

/** Awaits a promise expected to reject and hands `toThrow` a function rethrowing its reason. */
async function rejection(promise: Promise<unknown>): Promise<() => never> {
  const reason = await promise.then(() => new Error('expected a rejection, the promise resolved'), (err: unknown) => err);
  return () => { throw reason; };
}

const REPO_ROOT = join(import.meta.dir, '..', '..', '..');
const DEMO = join(import.meta.dir, 'fixtures', 'demo');
const DEMO_NOW = new Date('2026-01-14T16:00:00Z');

function demoConfig(): BoardConfig {
  const result = resolveBoardConfig(parseYaml(readFileSync(join(DEMO, 'project.yaml'), 'utf8')), { workflows: null, fields: null });
  if (result.state !== 'ok') { throw new Error(`demo config: ${JSON.stringify(result)}`); }
  return result.config;
}

const demoTickets = readFileSync(join(DEMO, 'tickets.yaml'), 'utf8');

describe('none source', () => {
  test('the demo sprint matches the committed demo snapshot', async () => {
    const snapshot = await createNoneSource(demoConfig(), { repoRoot: REPO_ROOT }).snapshot({ now: DEMO_NOW });
    const golden = JSON.parse(readFileSync(join(DEMO, 'snapshot.json'), 'utf8'));
    expect(snapshot).toEqual(golden);
  });

  test('denominators are always printed, buckets and test outcomes are mapped', async () => {
    const snapshot = await createNoneSource(demoConfig(), { repoRoot: REPO_ROOT }).snapshot({ now: DEMO_NOW });
    expect(snapshot.searched).toEqual({ tickets: 5, tests: 8, bugs: 2 });
    expect(snapshot.tickets['DEMO-101'].bucket).toBe('in_test');
    expect(snapshot.tickets['DEMO-104'].tests.map(t => t.status)).toEqual(['BLOCKED', 'DEFERRED']);
    expect(snapshot.tickets['DEMO-105'].tests).toEqual([]);
    expect(snapshot.bugs['DEMO-201'].tickets).toEqual(['DEMO-101']);
    expect(snapshot.bugs['DEMO-202'].tickets).toEqual([]);
    expect(snapshot.tickets['DEMO-101'].sprint).toBe('Sprint 7');
  });

  test('a status the config does not know fails the snapshot instead of being counted', async () => {
    const edited = demoTickets.replace('status: In Test', 'status: In QA');
    const source = createNoneSource(demoConfig(), { repoRoot: REPO_ROOT, readFile: () => edited });
    expect(await rejection(source.snapshot({ now: DEMO_NOW }))).toThrow(UnknownStatusError);
    expect(await rejection(source.snapshot({ now: DEMO_NOW }))).toThrow(/DEMO-101: status "In QA"/);
  });

  test('an unknown test status fails too', async () => {
    const edited = demoTickets.replace('status: FAILED', 'status: FLAKY');
    const source = createNoneSource(demoConfig(), { repoRoot: REPO_ROOT, readFile: () => edited });
    expect(await rejection(source.snapshot({ now: DEMO_NOW }))).toThrow(/DEMO-101-T2: status "FLAKY" is in no bucket of board\.statuses\.tests/);
  });

  test('a ticket id outside the key pattern and a dangling bug link are file errors', async () => {
    const badKey = createNoneSource(demoConfig(), { readFile: () => 'tickets:\n  SHOP-1: { title: x, status: To Do }\n' });
    expect(await rejection(badKey.snapshot())).toThrow(TicketsFileError);
    const dangling = createNoneSource(demoConfig(), { readFile: () => 'tickets:\n  DEMO-1: { title: x, status: To Do, bugs: [DEMO-9] }\n' });
    expect(await rejection(dangling.snapshot())).toThrow(/"DEMO-9" is not under bugs:/);
  });

  test('a test row with no status, or a misspelled key, is a file error, never a silent NOT RUN', async () => {
    const missing = createNoneSource(demoConfig(), { readFile: () => 'tickets:\n  DEMO-1:\n    title: x\n    status: To Do\n    tests:\n      - id: T1\n' });
    expect(await rejection(missing.snapshot())).toThrow(/tickets\.DEMO-1\.tests\[0\]\.status: required/);
    const misspelled = createNoneSource(demoConfig(), { readFile: () => 'tickets:\n  DEMO-1:\n    title: x\n    status: To Do\n    tests:\n      - id: T1\n        stauts: FAILED\n' });
    expect(await rejection(misspelled.snapshot())).toThrow(/tickets\.DEMO-1\.tests\[0\]: unknown key\(s\) stauts/);
    const ticketTypo = createNoneSource(demoConfig(), { readFile: () => 'tickets:\n  DEMO-1:\n    title: x\n    status: To Do\n    devloper: Avery Dev\n' });
    expect(await rejection(ticketTypo.snapshot())).toThrow(/tickets\.DEMO-1: unknown key\(s\) devloper/);
  });

  test('a test or bug listed twice under one ticket is a file error', async () => {
    const twiceTest = createNoneSource(demoConfig(), { readFile: () => 'tickets:\n  DEMO-1:\n    title: x\n    status: To Do\n    tests:\n      - { id: T1, status: PASSED }\n      - { id: T1, status: FAILED }\n' });
    expect(await rejection(twiceTest.snapshot())).toThrow(/test "T1" is listed twice/);
    const twiceBug = createNoneSource(demoConfig(), { readFile: () => 'tickets:\n  DEMO-1:\n    title: x\n    status: To Do\n    bugs: [DEMO-9, DEMO-9]\nbugs:\n  DEMO-9: { title: y, status: Open }\n' });
    expect(await rejection(twiceBug.snapshot())).toThrow(/"DEMO-9" is listed twice/);
  });

  test('a test shared by two tickets counts once in the denominator', async () => {
    const shared = createNoneSource(demoConfig(), { readFile: () => 'tickets:\n  DEMO-1:\n    title: x\n    status: To Do\n    tests: [{ id: T1, status: PASSED }]\n  DEMO-2:\n    title: y\n    status: To Do\n    tests: [{ id: T1, status: PASSED }]\n' });
    expect((await shared.snapshot()).searched).toEqual({ tickets: 2, tests: 1, bugs: 0 });
  });

  test('keys narrow the board, discover lists the rest of the sprint', async () => {
    const snapshot = await createNoneSource(demoConfig(), { repoRoot: REPO_ROOT }).snapshot({ now: DEMO_NOW, keys: ['DEMO-101', 'DEMO-102'], discover: true });
    expect(Object.keys(snapshot.tickets)).toEqual(['DEMO-101', 'DEMO-102']);
    expect(Object.keys(snapshot.bugs)).toEqual(['DEMO-201']);
    expect(snapshot.discover?.sprintRows).toBe(5);
    expect(snapshot.discover?.untracked.map(r => r.id)).toEqual(['DEMO-103', 'DEMO-104', 'DEMO-105']);
  });
});
