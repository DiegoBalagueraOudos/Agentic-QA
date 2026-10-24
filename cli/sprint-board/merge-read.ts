/**
 * Reads what the Git Flow Master collector left in `.session/gitflow-master/` (see merge.ts).
 * Missing or unreadable files read as empty: the view says what it could not find.
 */
import type { MergeAlert, MergeBranch, MergeNote, MergePair, MergePr, MergeRaw } from './merge.ts';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// ---------------------------------------------------------------------------

function readJson<T>(file: string): T | undefined {
  try { return JSON.parse(readFileSync(file, 'utf8')) as T; }
  catch { return undefined; }
}

/** Everything the collector left in `dir` (`.session/gitflow-master`). Missing files read as empty. */
export function readMergeLine(dir: string): MergeRaw {
  const docs = join(dir, 'docs');
  const prsDir = join(docs, 'prs');
  const notesDir = join(dir, 'notes');
  const prs = existsSync(prsDir)
    ? readdirSync(prsDir).filter(f => /^\d+\.json$/.test(f)).map(f => readJson<MergePr>(join(prsDir, f))).filter((p): p is MergePr => Boolean(p?.n))
    : [];
  const notes: Record<string, MergeNote> = {};
  if (existsSync(notesDir)) {
    for (const f of readdirSync(notesDir)) {
      const m = /^(\d+)\.json$/.exec(f);
      const v = m && readJson<MergeNote>(join(notesDir, f));
      if (m && v) { notes[m[1]] = v; }
    }
  }
  const branches = readJson<{ items?: MergeBranch[], remoteOnly?: number }>(join(docs, 'meta', 'branches.json'));
  return {
    state: readJson(join(docs, 'meta', 'state.json')),
    day: readJson(join(docs, 'meta', 'day.json')),
    alerts: readJson<{ items?: MergeAlert[] }>(join(docs, 'meta', 'alerts.json'))?.items ?? [],
    pairs: readJson<{ pairs?: MergePair[] }>(join(docs, 'meta', 'chords.json'))?.pairs ?? [],
    branches: branches?.items ?? [],
    remoteOnly: branches?.remoteOnly ?? 0,
    prs,
    notes,
    collector: readJson(join(dir, 'collector.json')),
  };
}
