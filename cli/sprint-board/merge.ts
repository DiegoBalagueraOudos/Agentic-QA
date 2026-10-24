/**
 * Merge Line: every pull request headed for main (or a trunk), as the board reads it.
 *
 *   .session/gitflow-master/docs/meta/*.json, docs/prs/<n>.json   written by merge-collect.ts
 *   .session/gitflow-master/notes/<n>.json                        optional, a session writes it on request
 *   .session/gitflow-master/collector.json                        the server's collector loop status
 *
 * The collector (`merge-collect.ts`, doctrine in the git-flow-master skill) owns the facts; this file only reads them and derives what
 * the page shows: lanes, the one-line why, the suggested order and how fresh the reading is.
 * Pure (no fs): the page bundles it, and readMergeLine() lives in merge-read.ts.
 */

export type Lamp = 'go' | 'ca' | 'st' | 'off';

export interface MergePr {
  n: number
  state: 'open' | 'merged' | 'closed'
  draft: boolean
  title: string
  url: string
  author: string
  authorIsBot: boolean
  base: string
  head: string
  headSha: string
  feeder: boolean
  trunkPr: number | null
  openedAt: string
  updatedAt: string
  mergedAt?: string | null
  size: { files: number, add: number, del: number }
  behindMain: number | null
  mergePrediction: 'clean' | 'conflict' | 'unknown'
  gates: {
    checks: { lamp: Lamp, code: 'green' | 'pending' | 'failing' | 'none', total: number, failing: string[], pending: number }
    review: { lamp: Lamp, code: 'clean' | 'answered' | 'open' | 'running' | 'none', open: number }
    approval: { lamp: Lamp, code: 'approved' | 'changes' | 'requested' | 'nobody' | 'self_merge', requested: { login: string, since: string }[], approvedBy: string[], changesBy: string[] }
  }
  cleared: number
  lamp: Exclude<Lamp, 'off'>
  tickets: { tk: string, status: string | null, expected: string | null, ok: boolean | null, mentioned?: boolean }[]
  owner: { basis: 'checkout' | 'title' | 'sticky' | 'bot' | 'none', worktree: { path: string, name: string } | null, terminals: { title: string, handle: string }[], since: string }
}

export interface MergeAlert { code: string, subject: string, severity: 'stop' | 'caution', params: Record<string, unknown>, since: string }
export interface MergePair { a: number, b: number | 'main', count: number, files: string[], conflict: boolean }
export interface MergeBranch { name: string, local: boolean, remote: boolean, upstreamGone: boolean, behindMain: number | null, aheadMain: number | null, worktree: { path: string, name: string } | null, lastCommitAt: string | null, pr: number | null }
export interface MergedPr { n: number, title: string, base: string, mergedAt: string, mergeSha: string, overnight: boolean }
export interface MergeNote { held?: { en: string, es?: string }, deadline?: { date: string, by: string, url: string, quote: string } | null, at?: string, basisSnapshot?: string }

export interface CollectorStatus {
  everySec: number
  running: boolean
  lastStartAt?: string
  lastEndAt?: string
  /** The collector's last line: `COLLECT ok`, `COLLECT degraded <source>` or `COLLECT fail <why>`. */
  lastLine?: string
  ok?: boolean
}

export interface MergeRaw {
  state?: { checkedAt?: string, mainSha?: string, viewer?: string | null, repo?: string, health?: { code: string, source: string | null, since: string | null }, denominators?: Record<string, number> }
  day?: { merged?: MergedPr[] }
  alerts: MergeAlert[]
  pairs: MergePair[]
  branches: MergeBranch[]
  remoteOnly: number
  prs: MergePr[]
  notes: Record<string, MergeNote>
  collector?: CollectorStatus
}

export const MERGE_LANES = ['Needs you', 'Waiting', 'Blocked', 'Ready'] as const;
export type MergeLane = (typeof MERGE_LANES)[number];

export interface MergeCard {
  pr: MergePr
  lane: MergeLane
  /** The one reason this PR sits in its lane, most important first. */
  why: { en: string, es: string }
  alerts: MergeAlert[]
  conflictsWith: number[]
  sharesWith: number[]
  /** Terminals worth naming: those whose title names the PR, else the first two. */
  sessions: { title: string, handle: string }[]
  note?: MergeNote
}

export type Freshness = 'live' | 'late' | 'stopped' | 'never';

export interface MergeView {
  cards: MergeCard[]
  lanes: Record<MergeLane, MergeCard[]>
  order: number[]
  mergedToMain: MergedPr[]
  mergedToTrunks: number
  pairs: MergePair[]
  orphans: MergeBranch[]
  branchesWithoutPr: number
  remoteOnly: number
  freshness: { state: Freshness, checkedAt?: string, ageSec?: number, reason?: string }
  mainSha?: string
  /** `owner/name` of the GitHub repository the reading came from. */
  repo?: string
  denominators?: Record<string, number>
}

// ---------------------------------------------------------------------------
// Deriving
// ---------------------------------------------------------------------------

const ownerAsked = (p: MergePr, owner: string) => p.gates.approval.requested.some(r => r.login === owner);
const days = (from: string, nowMs: number) => Math.max(0, Math.floor((nowMs - Date.parse(from)) / 86_400_000));
const plural = (n: number, en: string, es: string) => ({ en: `${n} ${en}${n === 1 ? '' : 's'}`, es: `${n} ${es}${n === 1 ? '' : 's'}` });

/** The lane and its reason. Blocked beats Needs you beats Waiting beats Ready. */
export function laneOf(p: MergePr, conflictsWith: number[], owner: string, nowMs: number): { lane: MergeLane, why: { en: string, es: string } } {
  const g = p.gates;
  if (g.checks.code === 'failing') { return { lane: 'Blocked', why: { en: `Failing: ${g.checks.failing.join(', ')}`, es: `Falla: ${g.checks.failing.join(', ')}` } }; }
  if (g.approval.code === 'changes') { return { lane: 'Blocked', why: { en: `Changes requested by ${g.approval.changesBy.join(', ')}`, es: `Cambios pedidos por ${g.approval.changesBy.join(', ')}` } }; }
  if (p.mergePrediction === 'conflict') { return { lane: 'Blocked', why: { en: `Conflicts with ${p.base}: sync it first`, es: `Choca con ${p.base}: sincronizar primero` } }; }
  if (ownerAsked(p, owner)) { return { lane: 'Needs you', why: { en: 'Your review was requested', es: 'Te pidieron el review' } }; }
  if (g.review.code === 'open') { return { lane: 'Needs you', why: { en: `${plural(g.review.open, 'review finding', 'hallazgo').en} not answered`, es: `${plural(g.review.open, 'review finding', 'hallazgo').es} sin responder` } }; }
  if (!p.feeder && g.approval.code === 'nobody') { return { lane: 'Needs you', why: { en: 'Nobody was asked to review it', es: 'No se le pidió review a nadie' } }; }
  if (p.owner.basis === 'none') { return { lane: 'Needs you', why: { en: 'No session holds it', es: 'Ninguna sesión lo tiene' } }; }
  if (g.checks.code === 'pending' || g.review.code === 'running') { return { lane: 'Waiting', why: { en: g.review.code === 'running' ? 'Review running' : `${g.checks.pending} checks running`, es: g.review.code === 'running' ? 'Review corriendo' : `${g.checks.pending} checks corriendo` } }; }
  if (g.approval.code === 'requested') {
    const r = g.approval.requested;
    const d = days(r.map(x => x.since).sort()[0], nowMs);
    const who = r.map(x => x.login).join(', ');
    return { lane: 'Waiting', why: { en: `${who} asked ${d === 0 ? 'today' : `${d} day${d === 1 ? '' : 's'} ago`}`, es: `pedido a ${who} ${d === 0 ? 'hoy' : `hace ${d} día${d === 1 ? '' : 's'}`}` } };
  }
  if (g.review.code === 'none') { return { lane: 'Waiting', why: { en: 'Not reviewed at this commit', es: 'Sin review en este commit' } }; }
  if (p.lamp === 'go') {
    if (conflictsWith.length) { return { lane: 'Ready', why: { en: `Ready, but conflicts with #${conflictsWith.join(', #')}`, es: `Listo, pero choca con #${conflictsWith.join(', #')}` } }; }
    return { lane: 'Ready', why: p.feeder ? { en: `Ready to merge into ${p.base}`, es: `Listo para mergear a ${p.base}` } : { en: 'Ready to merge', es: 'Listo para mergear' } };
  }
  return { lane: 'Waiting', why: { en: `${p.cleared} of 3 signals clear`, es: `${p.cleared} de 3 señales en verde` } };
}

const LANE_RANK: Record<MergeLane, number> = { 'Ready': 0, 'Waiting': 1, 'Needs you': 2, 'Blocked': 3 };

/** Suggested order into main: what can land first, then what waits, then what is stuck; smaller first. */
export function suggestOrder(cards: MergeCard[]): number[] {
  return cards
    .filter(c => !c.pr.feeder)
    .sort((a, b) => LANE_RANK[a.lane] - LANE_RANK[b.lane] || b.pr.cleared - a.pr.cleared || b.conflictsWith.length - a.conflictsWith.length || a.pr.size.files - b.pr.size.files)
    .map(c => c.pr.n);
}

export function freshnessOf(raw: MergeRaw, nowMs: number): MergeView['freshness'] {
  const checkedAt = raw.state?.checkedAt;
  const c = raw.collector;
  if (!checkedAt) { return { state: 'never', reason: c?.lastLine }; }
  const ageSec = Math.round((nowMs - Date.parse(checkedAt)) / 1000);
  const every = c?.everySec ?? 90;
  if (c?.lastLine && !c.ok) { return { state: 'stopped', checkedAt, ageSec, reason: c.lastLine }; }
  if (raw.state?.health?.code === 'degraded') { return { state: 'stopped', checkedAt, ageSec, reason: `${raw.state.health.source ?? 'a source'} unreachable` }; }
  if (!c || ageSec > every * 4 + 120) { return { state: 'stopped', checkedAt, ageSec, reason: c ? undefined : 'no collector loop' }; }
  if (ageSec > every * 2 + 60) { return { state: 'late', checkedAt, ageSec }; }
  return { state: 'live', checkedAt, ageSec };
}

export function mergeView(raw: MergeRaw, opts: { owner?: string, now?: number } = {}): MergeView {
  const nowMs = opts.now ?? Date.now();
  const owner = opts.owner ?? raw.state?.viewer ?? '';
  const open = raw.prs.filter(p => p.state === 'open').sort((a, b) => a.n - b.n);
  const pairsOf = (n: number, conflict: boolean) => raw.pairs
    .filter(x => x.b !== 'main' && x.conflict === conflict && (x.a === n || x.b === n))
    .map(x => (x.a === n ? x.b : x.a) as number)
    .filter(m => open.some(p => p.n === m));
  const cards: MergeCard[] = open.map((pr) => {
    const conflictsWith = pairsOf(pr.n, true);
    const { lane, why } = laneOf(pr, conflictsWith, owner, nowMs);
    const named = pr.owner.terminals.filter(t => new RegExp(`(^|[^0-9])#?${pr.n}([^0-9]|$)`).test(t.title) || t.title.includes(pr.head));
    return {
      pr,
      lane,
      why,
      conflictsWith,
      sharesWith: pairsOf(pr.n, false),
      alerts: raw.alerts.filter(a => a.subject === `#${pr.n}`),
      sessions: (named.length ? named : pr.owner.terminals).slice(0, 2),
      note: raw.notes[String(pr.n)],
    };
  });
  const lanes = Object.fromEntries(MERGE_LANES.map(l => [l, cards.filter(c => c.lane === l)])) as Record<MergeLane, MergeCard[]>;
  const merged = raw.day?.merged ?? [];
  return {
    cards,
    lanes,
    order: suggestOrder(cards),
    mergedToMain: merged.filter(m => m.base === 'main'),
    mergedToTrunks: merged.filter(m => m.base !== 'main').length,
    pairs: raw.pairs.filter(x => x.b === 'main' ? open.some(p => p.n === x.a) : open.some(p => p.n === x.a) && open.some(p => p.n === x.b)),
    orphans: raw.branches.filter(b => b.pr === null && b.name !== 'main' && (b.upstreamGone || (b.worktree !== null && b.aheadMain === 0 && (b.behindMain ?? 0) > 0))),
    branchesWithoutPr: raw.branches.filter(b => b.pr === null && b.name !== 'main').length,
    remoteOnly: raw.remoteOnly,
    freshness: freshnessOf(raw, nowMs),
    mainSha: raw.state?.mainSha,
    repo: raw.state?.repo,
    denominators: raw.state?.denominators,
  };
}
