import type { Lamp, MergeCard, MergeLane, MergePair, MergePr, MergeRaw, MergeView } from '../merge.ts';
/**
 * The Merge Line view: every pull request headed for main (or a trunk), in the board's own
 * patterns. A bottom line that answers "what needs me", four tiles, the lanes of cards, the
 * interlocking strip, and a rail with the order, the interference and what passed today.
 * Pure: MergeRaw in, HTML out.
 */
import { MERGE_LANES, mergeView } from '../merge.ts';
import { localHhmm } from '../model.ts';
import { getLang, tr } from './i18n.ts';
import { ago, esc } from './util.ts';

const LANE_CLASS: Record<MergeLane, string> = { 'Needs you': 'l-needs', 'Waiting': 'l-run', 'Blocked': 'l-fail', 'Ready': 'l-pass' };
const LANE_GLYPH: Record<MergeLane, string> = { 'Needs you': '◆', 'Waiting': '◷', 'Blocked': '✕', 'Ready': '✓' };
const LANE_ES: Record<MergeLane, string> = { 'Needs you': 'Te necesita', 'Waiting': 'Esperando', 'Blocked': 'Bloqueado', 'Ready': 'Listo' };
const laneName = (l: MergeLane) => tr(l, LANE_ES[l]);
const say = (o: { en: string, es: string }) => (getLang() === 'es' ? o.es : o.en);
/** A PR link from the reading's own repository; no repository known = no link. */
const ghPr = (n: number, repo?: string) => (repo ? `https://github.com/${repo}/pull/${n}` : '');
/** An anchor when there is a URL, the plain label otherwise (an empty href would reload the page). */
const linkOr = (href: string, label: string) => (href ? `<a href="${esc(href)}" target="_blank" rel="noopener">${label}</a>` : label);

// ---------------------------------------------------------------------------
// Gates
// ---------------------------------------------------------------------------

type Gate = 'checks' | 'review' | 'approval';
const GATES: Gate[] = ['checks', 'review', 'approval'];
const gateName = (g: Gate, feeder: boolean) => ({
  checks: tr('Checks', 'Checks'),
  review: tr('Review', 'Review'),
  approval: feeder ? tr('Self-merge', 'Auto-merge') : tr('Approval', 'Aprobación'),
})[g];

function gateText(pr: MergePr, g: Gate, nowMs: number): string {
  const x = pr.gates;
  if (g === 'checks') {
    return ({
      green: tr(`${x.checks.total} green`, `${x.checks.total} en verde`),
      pending: tr(`${x.checks.pending} of ${x.checks.total} running`, `${x.checks.pending} de ${x.checks.total} corriendo`),
      failing: tr(`failing: ${x.checks.failing.join(', ')}`, `fallan: ${x.checks.failing.join(', ')}`),
      none: tr('no checks on this commit', 'sin checks en este commit'),
    })[x.checks.code];
  }
  if (g === 'review') {
    return ({
      clean: tr('clean, no findings', 'limpio, sin hallazgos'),
      answered: tr('findings answered', 'hallazgos respondidos'),
      open: tr(`${x.review.open} findings open`, `${x.review.open} hallazgos abiertos`),
      running: tr('running', 'corriendo'),
      none: tr('not reviewed at this commit', 'sin review en este commit'),
    })[x.review.code];
  }
  const a = x.approval;
  return ({
    approved: tr(`approved by ${a.approvedBy.join(', ')}`, `aprobado por ${a.approvedBy.join(', ')}`),
    changes: tr(`changes requested by ${a.changesBy.join(', ')}`, `cambios pedidos por ${a.changesBy.join(', ')}`),
    requested: a.requested.map(r => tr(`${r.login}, asked ${ago(r.since, nowMs)} ago`, `${r.login}, pedido hace ${ago(r.since, nowMs)}`)).join(' · '),
    nobody: tr('nobody asked', 'no se pidió a nadie'),
    self_merge: tr('we merge it ourselves once the rest is green', 'lo mergeamos nosotros cuando lo demás esté en verde'),
  })[a.code];
}

const dot = (l: Lamp, title: string) => `<i class="gd g-${l}" title="${esc(title)}"></i>`;
const dots = (pr: MergePr, nowMs: number) =>
  `<span class="gates" aria-label="${esc(GATES.map(g => `${gateName(g, pr.feeder)}: ${gateText(pr, g, nowMs)}`).join('; '))}">${GATES.map(g => dot(pr.gates[g].lamp, `${gateName(g, pr.feeder)}: ${gateText(pr, g, nowMs)}`)).join('')}</span>`;

function sessionLabel(c: MergeCard): string {
  const o = c.pr.owner;
  if (o.basis === 'bot') { return tr('bot', 'bot'); }
  if (!o.worktree) { return `<span class="warn">${tr('no session', 'sin sesión')}</span>`; }
  return `${esc(o.worktree.name)}${o.basis === 'sticky' ? ` <span class="hint">(${tr('last seen', 'visto')} ${ago(o.since)})</span>` : ''}`;
}

// ---------------------------------------------------------------------------
// Cards and lanes
// ---------------------------------------------------------------------------

function prCard(c: MergeCard, nowMs: number): string {
  const p = c.pr;
  return `<button type="button" class="card ${LANE_CLASS[c.lane]}" data-open-pr="${p.n}" data-card="pr-${p.n}">
    <div class="row"><span class="id">#${p.n}</span>${p.feeder ? `<span class="flag">${tr('into', 'hacia')} ${esc(p.base)}</span>` : ''}${p.draft ? `<span class="flag">${tr('draft', 'borrador')}</span>` : ''}${dots(p, nowMs)}</div>
    <div class="title">${esc(p.title)}</div>
    <div class="meta"><span>${sessionLabel(c)}</span><span>${p.size.files} ${tr('files', 'archivos')}</span><span>${tr('open', 'abierto')} ${ago(p.openedAt, nowMs)}</span>${c.conflictsWith.length ? `<span class="flag drift">${tr('conflicts with', 'choca con')} #${c.conflictsWith.join(', #')}</span>` : ''}</div>
    <div class="say">${LANE_GLYPH[c.lane]} ${esc(say(c.why))}</div>
  </button>`;
}

function lanes(v: MergeView, nowMs: number): string {
  return `<div class="board">${MERGE_LANES.map(l => `<section class="lane ${LANE_CLASS[l]}" data-lane="${esc(l)}">
      <div class="lane-head"><span class="glyph" aria-hidden="true">${LANE_GLYPH[l]}</span><span class="lbl" style="color:var(--ink)">${laneName(l)}</span><span class="n">${v.lanes[l].length}</span></div>
      ${v.lanes[l].length ? v.lanes[l].map(c => prCard(c, nowMs)).join('') : `<div class="none">${l === 'Needs you' ? tr('Nothing waiting on you.', 'Nada te espera.') : tr('Empty', 'Vacío')}</div>`}
    </section>`).join('')}</div>`;
}

// ---------------------------------------------------------------------------
// The interlocking strip: each PR on its track, three signals, MAIN on the right
// ---------------------------------------------------------------------------

function interlocking(v: MergeView): string {
  const rows = [...v.cards].sort((a, b) => (v.order.indexOf(a.pr.n) + 1 || 99) - (v.order.indexOf(b.pr.n) + 1 || 99));
  if (!rows.length) { return ''; }
  const H = 34;
  const h = rows.length * H + 26;
  const X0 = 64; const SIG = [250, 420, 590]; const TOK = [150, 335, 505, 680]; const X1 = 760; const JX = 800;
  const sig = (l: Lamp) => ({ go: 'var(--pass)', ca: 'var(--needs)', st: 'var(--fail)', off: 'var(--rule)' })[l];
  const lines = rows.map((c, i) => {
    const y = 26 + i * H; const p = c.pr; const x = TOK[Math.min(p.cleared, 3)];
    return `<g>
      <text x="8" y="${y + 4}" class="ml-n">#${p.n}</text>
      <path d="M ${X0} ${y} H ${X1} C ${X1 + 20} ${y}, ${JX} ${y + 10}, ${JX} ${Math.min(y + 24, h - 10)}" class="ml-trk"/>
      ${GATES.map((g, k) => `<circle cx="${SIG[k]}" cy="${y}" r="5" fill="${sig(p.gates[g].lamp)}"><title>${esc(`${gateName(g, p.feeder)}: ${p.gates[g].code}`)}</title></circle>`).join('')}
      <rect x="${x - 20}" y="${y - 9}" width="40" height="18" rx="4" class="ml-tok ${LANE_CLASS[c.lane]}" data-open-pr="${p.n}"/>
      <text x="${x}" y="${y + 4}" class="ml-tokt" data-open-pr="${p.n}">${p.n}</text>
    </g>`;
  }).join('');
  return `<section class="panel ml-strip" aria-label="${esc(tr('Interlocking diagram', 'Diagrama de enclavamiento'))}">
    <svg viewBox="0 0 920 ${h}" role="img">
      ${SIG.map((x, k) => `<text x="${x}" y="11" class="ml-sig" text-anchor="middle">${esc(gateName(GATES[k], false).toUpperCase())}</text>`).join('')}
      ${lines}
      <path d="M ${JX} 26 V ${h - 10} H 900" class="ml-main"/>
      <text x="${JX + 12}" y="${h - 16}" class="ml-mainl">MAIN${v.mainSha ? ` ${esc(v.mainSha)}` : ''}</text>
    </svg>
  </section>`;
}

// ---------------------------------------------------------------------------
// Header pieces
// ---------------------------------------------------------------------------

function freshness(v: MergeView, nowMs: number): string {
  const f = v.freshness;
  const at = f.checkedAt ? localHhmm(f.checkedAt) : '';
  // Not the server's own "Live" pill: this one says how old the GitHub reading is.
  const title = tr('When the collector last read GitHub, git, Orca and the tracker', 'Cuándo el colector leyó por última vez GitHub, git, Orca y el tracker');
  if (f.state === 'live') { return `<span class="ml-fresh live" title="${esc(title)}"><i></i>${tr('GitHub read', 'GitHub leído hace')} ${ago(f.checkedAt, nowMs)}${tr(' ago', '')}</span>`; }
  if (f.state === 'late') { return `<span class="ml-fresh late" title="${esc(title)}"><i></i>${tr('GitHub read late', 'Lectura atrasada')} · ${at}</span>`; }
  if (f.state === 'never') { return `<span class="ml-fresh stopped"><i></i>${tr('No reading yet', 'Todavía sin lectura')}</span>`; }
  return `<span class="ml-fresh stopped"><i></i>${tr('Not updating', 'Sin actualizar')} · ${tr('last reading', 'última lectura')} ${at}</span>`;
}

/** Only when the reading is not live: one line saying why, and what fixes it. */
function stoppedNote(v: MergeView): string {
  const f = v.freshness;
  if (f.state === 'live' || f.state === 'late') { return ''; }
  const fix = tr('The board server runs the collector every 90 s. Start it with', 'El servidor del tablero corre el colector cada 90 s. Arrancalo con');
  const why = f.reason ? `<code>${esc(f.reason)}</code>. ` : '';
  return `<div class="stale">${why}${fix} <code>bun run board:up</code>.</div>`;
}

function bottomLine(v: MergeView): string {
  const toMain = v.cards.filter(c => !c.pr.feeder).length;
  const feeders = v.cards.length - toMain;
  const parts = [
    `<span><b class="n">${toMain}</b> ${tr(toMain === 1 ? 'PR to main' : 'PRs to main', toMain === 1 ? 'PR hacia main' : 'PR hacia main')}${feeders ? ` · ${feeders} ${tr('into trunks', 'hacia troncos')}` : ''}</span>`,
    `<span><b class="n">${v.lanes['Needs you'].length}</b> ${tr('need you', 'te necesitan')}</span>`,
    `<span><b class="n">${v.lanes.Ready.length}</b> ${tr('ready', 'listos')}</span>`,
  ];
  if (v.lanes.Blocked.length) { parts.push(`<span class="warn"><b class="n">${v.lanes.Blocked.length}</b> ${tr('blocked', 'bloqueados')}</span>`); }
  return `<div class="bottomline">${parts.join('<span class="sep">·</span>')}</div>`;
}

function kpis(v: MergeView, nowMs: number): string {
  const oldestWait = v.lanes.Waiting.flatMap(c => c.pr.gates.approval.requested.map(r => r.since)).sort()[0];
  const tile = (cls: string, lbl: string, n: number, sub: string) => `<div class="kpi ${cls}"><span class="lbl">${lbl}</span><b>${n}</b><small>${sub}</small></div>`;
  return `<div class="kpis">
    ${tile('k-needs', tr('Needs you', 'Te necesita'), v.lanes['Needs you'].length, v.lanes['Needs you'][0] ? esc(say(v.lanes['Needs you'][0].why)) : tr('nothing waiting on you', 'nada te espera'))}
    ${tile('k-run', tr('Waiting on others', 'Esperando a otros'), v.lanes.Waiting.length, oldestWait ? tr(`oldest ask ${ago(oldestWait, nowMs)} ago`, `pedido más viejo hace ${ago(oldestWait, nowMs)}`) : tr('no one is being waited on', 'no se espera a nadie'))}
    ${tile('k-fail', tr('Blocked', 'Bloqueado'), v.lanes.Blocked.length, v.lanes.Blocked[0] ? esc(say(v.lanes.Blocked[0].why)) : tr('nothing stuck', 'nada trabado'))}
    ${tile('k-pass', tr('Ready to merge', 'Listo para mergear'), v.lanes.Ready.length, v.mergedToMain.length ? tr(`${v.mergedToMain.length} merged into main today`, `${v.mergedToMain.length} mergeados a main hoy`) : tr('none merged into main today', 'ninguno mergeado a main hoy'))}
  </div>`;
}

// ---------------------------------------------------------------------------
// The rail: order, interference, what passed, branches
// ---------------------------------------------------------------------------

function pairLine(x: MergePair): string {
  const other = x.b === 'main' ? 'main' : `#${x.b}`;
  return `<details class="acc ml-pair"><summary><span class="chev" aria-hidden="true">›</span><span class="acc-title">#${x.a} ↔ ${esc(other)}</span><span class="hint">${x.count} ${tr(x.count === 1 ? 'file' : 'files', x.count === 1 ? 'archivo' : 'archivos')}</span>${x.conflict ? `<span class="flag">${tr('textual conflict', 'conflicto textual')}</span>` : ''}</summary>
    <ul class="ml-files">${x.files.map(f => `<li class="mono">${esc(f)}</li>`).join('')}${x.count > x.files.length ? `<li class="hint">+${x.count - x.files.length}</li>` : ''}</ul></details>`;
}

function rail(v: MergeView): string {
  const byN = new Map(v.cards.map(c => [c.pr.n, c]));
  const order = v.order.length
    ? `<ol>${v.order.map(n => byN.get(n)!).map(c => `<li><button type="button" class="linkish" data-open-pr="${c.pr.n}">#${c.pr.n}</button> ${esc(say(c.why))}</li>`).join('')}</ol>`
    : `<p class="empty">${tr('Nothing to order.', 'Nada que ordenar.')}</p>`;
  const conflicts = v.pairs.filter(x => x.conflict);
  const shared = v.pairs.filter(x => !x.conflict);
  return `<aside class="rail ml-rail">
    <span class="lbl">${tr('Suggested order into main', 'Orden sugerido hacia main')}</span>${order}
    <span class="lbl">${tr('Interference', 'Interferencia')} · ${conflicts.length} ${tr('conflicts', 'conflictos')}, ${shared.length} ${tr('shared only', 'solo compartidos')}</span>
    ${v.pairs.length ? v.pairs.map(pairLine).join('') : `<p class="empty">${tr('No two open PRs touch the same files.', 'Ningún par de PR abiertos toca los mismos archivos.')}</p>`}
    <span class="lbl">${tr('Passed today', 'Pasaron hoy')}</span>
    ${v.mergedToMain.length ? `<ul class="ml-passed">${v.mergedToMain.map(m => `<li>${linkOr(ghPr(m.n, v.repo), `#${m.n}`)} <span class="mono">${localHhmm(m.mergedAt)} · ${esc(m.mergeSha)}</span>${m.overnight ? ` <span class="flag">${tr('overnight', 'de noche')}</span>` : ''}<br><span class="hint">${esc(m.title)}</span></li>`).join('')}</ul>` : `<p class="hint">${tr('Nothing merged into main yet today.', 'Todavía nada mergeado a main hoy.')}</p>`}
    ${v.mergedToTrunks ? `<p class="hint">${v.mergedToTrunks} ${tr('more merged into trunks', 'más mergeados a troncos')}</p>` : ''}
    <details class="acc"><summary><span class="chev" aria-hidden="true">›</span><span class="acc-title">${tr('Branches with no PR', 'Ramas sin PR')}</span><span class="hint">${v.branchesWithoutPr} ${tr('local', 'locales')} · ${v.remoteOnly} ${tr('remote only', 'solo remotas')}</span></summary>
      ${v.orphans.length ? `<p class="hint">${v.orphans.length} ${tr('look stale: upstream gone, or a worktree whose work already merged.', 'parecen viejas: sin upstream, o un worktree cuyo trabajo ya se mergeó.')} ${tr('Clean them with the orphan audit (<code>bun run worktree:audit</code>).', 'Se limpian con la auditoría de huérfanos (<code>bun run worktree:audit</code>).')}</p><ul class="ml-files">${v.orphans.map(b => `<li class="mono">${esc(b.name)}${b.worktree ? ` <span class="hint">· ${esc(b.worktree.name)}</span>` : ''}</li>`).join('')}</ul>` : `<p class="hint">${tr('None look stale.', 'Ninguna parece vieja.')}</p>`}
    </details>
  </aside>`;
}

// ---------------------------------------------------------------------------
// The view and the drawer
// ---------------------------------------------------------------------------

/** `raw` null: the page has no server to ask (a frozen copy) or the first fetch has not landed. */
export function viewMerge(raw: MergeRaw | null, opts: { live: boolean, now?: number }): string {
  if (!opts.live) { return `<section class="panel"><h2>Merge Line</h2><p class="hint">${tr('Merge Line is live only: it reads the Git Flow Master collector through the local server.', 'Merge Line es solo en vivo: lee el colector del Git Flow Master a través del servidor local.')}</p></section>`; }
  if (!raw) { return `<section class="panel"><h2>Merge Line</h2><p class="hint">${tr('Reading…', 'Leyendo…')}</p></section>`; }
  const nowMs = opts.now ?? Date.now();
  const v = mergeView(raw, { now: nowMs });
  const den = v.denominators;
  return `<div class="ml-head">${bottomLine(v)}${freshness(v, nowMs)}</div>
  ${stoppedNote(v)}
  <div class="now-grid">
    <div style="display:grid;gap:12px;min-width:0">${kpis(v, nowMs)}${interlocking(v)}${v.cards.length ? lanes(v, nowMs) : `<section class="panel"><h2>${tr('Line clear', 'Vía libre')}</h2><p class="hint">${tr('No pull request is open.', 'No hay ningún PR abierto.')}</p></section>`}</div>
    ${rail(v)}
  </div>
  ${den ? `<p class="hint ml-den">${tr('Read', 'Leído')} ${den.prs} PRs, ${den.branches} ${tr('branches', 'ramas')}, ${den.worktrees} worktrees, ${den.terminals} ${tr('terminals', 'terminales')}, ${den.tickets} ${tr('tickets', 'tickets')}. ${tr('The Git Flow Master observes only: it never merges, approves, comments or closes.', 'El Git Flow Master solo observa: nunca mergea, aprueba, comenta ni cierra.')}</p>` : ''}`;
}

/** Badge for the nav entry: how many PRs need the owner. */
export function mergeNeeds(raw: MergeRaw | null): number {
  return raw ? mergeView(raw).lanes['Needs you'].length : 0;
}

export function prDrawer(raw: MergeRaw, n: number, now?: number): string | null {
  const nowMs = now ?? Date.now();
  const v = mergeView(raw, { now: nowMs });
  const c = v.cards.find(x => x.pr.n === n);
  if (!c) { return null; }
  const p = c.pr;
  const named = p.tickets.filter(t => !t.mentioned);
  const mentioned = p.tickets.filter(t => t.mentioned);
  const mism = named.filter(t => t.ok === false);
  const pairs = v.pairs.filter(x => x.a === n || x.b === n);
  const note = c.note;
  return `<button class="btn ghost close" type="button" data-close>Esc ✕</button>
  <div><div class="row" style="display:flex;gap:6px;align-items:center;flex-wrap:wrap"><span class="id">#${p.n}</span><span class="pill ${LANE_CLASS[c.lane]}">${laneName(c.lane)}</span>${p.feeder ? `<span class="flag">${tr('into', 'hacia')} ${esc(p.base)}</span>` : ''}</div>
  <h2 style="margin-top:6px">${esc(p.title)}</h2>
  <p class="hint"><span class="mono">${esc(p.head)} → ${esc(p.base)}</span> · ${esc(p.author)} · ${linkOr(p.url || ghPr(p.n, raw.state?.repo), tr('open on GitHub', 'abrir en GitHub'))}</p></div>
  <div class="need-box ${LANE_CLASS[c.lane]}"><b>${LANE_GLYPH[c.lane]} ${esc(say(c.why))}</b>${note?.held ? `<span class="hint">${esc(getLang() === 'es' ? (note.held.es ?? note.held.en) : note.held.en)}</span>` : ''}${note?.deadline ? `<span class="hint">${tr('Deadline', 'Plazo')} ${esc(note.deadline.date)} · ${esc(note.deadline.by)}: "${esc(note.deadline.quote)}"</span>` : ''}</div>
  <section><span class="lbl">${tr('Signals', 'Señales')}</span><table class="grid">${GATES.map(g => `<tr><td>${dot(p.gates[g].lamp, '')}</td><td>${gateName(g, p.feeder)}</td><td>${esc(gateText(p, g, nowMs))}</td></tr>`).join('')}</table></section>
  <section><span class="lbl">${tr('Session', 'Sesión')}</span><div>${sessionLabel(c)}${p.owner.basis === 'checkout' ? ` <span class="hint">${tr('has the branch checked out', 'tiene la rama')}</span>` : p.owner.basis === 'title' ? ` <span class="hint">${tr('named in a terminal title', 'nombrado en el título de una terminal')}</span>` : ''}</div>
    ${c.sessions.map(t => `<div class="progress-line">${esc(t.title)} <span class="mono hint">${esc(t.handle.slice(0, 13))}</span></div>`).join('')}</section>
  <section><span class="lbl">${tr('Tracker', 'Tracker')}${mism.length ? ` · ${mism.length} ${tr('out of step', 'desfasados')}` : ''}</span>
    ${named.length ? `<table class="grid">${named.map(t => `<tr><td class="id">${esc(t.tk)}</td><td><span class="pill source">${esc(t.status ?? '?')}</span></td><td>${t.ok === false ? `<span class="warn">${tr('should read', 'debería decir')} ${esc(t.expected ?? '')}</span>` : t.ok ? tr('matches', 'coincide') : `<span class="hint">${tr('no expectation', 'sin expectativa')}</span>`}</td></tr>`).join('')}</table>` : `<p class="hint">${tr('No ticket named in the branch or title.', 'Ningún ticket en la rama o el título.')}</p>`}
    ${mentioned.length ? `<details class="acc"><summary><span class="chev" aria-hidden="true">›</span><span class="acc-title">${tr('Mentioned in the description', 'Mencionados en la descripción')}</span><span class="hint">${mentioned.length}</span></summary><ul class="ml-files">${mentioned.map(t => `<li><span class="mono">${esc(t.tk)}</span> <span class="hint">${esc(t.status ?? '?')}</span></li>`).join('')}</ul></details>` : ''}</section>
  ${pairs.length ? `<section><span class="lbl">${tr('Interference', 'Interferencia')}</span>${pairs.map(pairLine).join('')}</section>` : ''}
  <section><span class="lbl">${tr('Numbers', 'Números')}</span><div class="hint">${p.size.files} ${tr('files', 'archivos')} · +${p.size.add} / −${p.size.del}${p.behindMain ? ` · ${p.behindMain} ${tr('behind main', 'detrás de main')}` : ''} · ${tr('open', 'abierto')} ${ago(p.openedAt, nowMs)} · ${tr('updated', 'actualizado')} ${ago(p.updatedAt, nowMs)} ${tr('ago', 'atrás')}</div></section>`;
}

export type { MergeLane };
