/**
 * @fileoverview Renders a validated pack into ONE self-contained HTML page (ADR-0021).
 *
 * The page needs nothing at view time: inline CSS, a small inline script,
 * images as data URIs, a system font stack (no web fonts), no network. It
 * follows the hosted-artifact page contract (no document skeleton of its own,
 * a short `<title>`, colour tokens with both dark-mode guards, a 16 px side
 * gutter), so the same file is published unchanged or opened from disk.
 *
 * Marks are DATA drawn as an SVG overlay in the image's natural pixel space;
 * redactions were already burned into the pixels by the builder. The pack,
 * minus image bytes, is embedded as JSON so a later reader (the board) gets
 * the verdict without parsing markup.
 */

import type { Case, EvidenceItem, Mark, Pack, Point, Size } from './pack.ts';
import type { EvidenceStatus } from './statuses.ts';

import { pointToFraction, toFraction } from './pack.ts';
import { TONE_OF } from './statuses.ts';

export interface InlineImage extends Size {
  dataUri: string
}

export interface RenderMeta {
  generatedAt: string
  /**
   * A full document of its own (doctype, `<html>`, viewport): the `local` host
   * opens the file straight from disk, where a missing doctype means quirks
   * mode. A hosted page leaves it out because its host wraps the page.
   */
  standalone?: boolean
}

export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** JSON safe inside a `<script>` element: no `<`, so no `</script>` can close it early. */
export function scriptJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replaceAll(String.fromCharCode(0x2028), '\\u2028')
    .replaceAll(String.fromCharCode(0x2029), '\\u2029');
}

/** Only finite numbers ever reach an SVG attribute. */
function n(value: number): string {
  return Number.isFinite(value) ? String(Math.round(value * 100) / 100) : '0';
}

function pill(status: EvidenceStatus, large = false): string {
  return `<span class="pill tone-${TONE_OF[status]}${large ? ' pill-lg' : ''}">${escapeHtml(status)}</span>`;
}

function anchorOf(index: number): string {
  return `case-${index + 1}`;
}

// ============================================================================
// EVIDENCE ITEMS
// ============================================================================

function markSvg(mark: Mark, size: Size): string {
  const tone = mark.tone ?? 'defect';
  const cls = `mark mark-${tone}`;
  if (mark.shape === 'arrow') {
    const from = pointToFraction(mark.from as Point, mark.coords, size);
    const to = pointToFraction(mark.to as Point, mark.coords, size);
    const [ax, ay, bx, by] = [from[0] * size.width, from[1] * size.height, to[0] * size.width, to[1] * size.height];
    const angle = Math.atan2(by - ay, bx - ax);
    const head = Math.max(10, size.width * 0.018);
    const left: Point = [bx - head * Math.cos(angle - Math.PI / 7), by - head * Math.sin(angle - Math.PI / 7)];
    const right: Point = [bx - head * Math.cos(angle + Math.PI / 7), by - head * Math.sin(angle + Math.PI / 7)];
    return `<line class="${cls}" x1="${n(ax)}" y1="${n(ay)}" x2="${n(bx)}" y2="${n(by)}"/>`
      + `<polygon class="${cls} mark-head" points="${n(bx)},${n(by)} ${n(left[0])},${n(left[1])} ${n(right[0])},${n(right[1])}"/>`;
  }
  if (mark.shape === 'path') {
    const points = (mark.points as Point[])
      .map(p => pointToFraction(p, mark.coords, size))
      .map(p => `${n(p[0] * size.width)},${n(p[1] * size.height)}`)
      .join(' ');
    return `<polyline class="${cls}" points="${points}"/>`;
  }
  const f = toFraction({ x: mark.x as number, y: mark.y as number, w: mark.w as number, h: mark.h as number, coords: mark.coords }, size);
  const [x, y, w, h] = [f.x * size.width, f.y * size.height, f.w * size.width, f.h * size.height];
  if (mark.shape === 'ellipse') {
    return `<ellipse class="${cls}" cx="${n(x + w / 2)}" cy="${n(y + h / 2)}" rx="${n(w / 2)}" ry="${n(h / 2)}"/>`;
  }
  const radius = mark.shape === 'bubble' ? Math.min(w, h) / 4 : 2;
  return `<rect class="${cls}" x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}" rx="${n(radius)}"/>`;
}

/** Where a mark's text label sits, in percent of the image. */
function labelAnchor(mark: Mark, size: Size): Point {
  if (mark.shape === 'arrow') {
    return pointToFraction(mark.from as Point, mark.coords, size);
  }
  if (mark.shape === 'path') {
    return pointToFraction((mark.points as Point[])[0], mark.coords, size);
  }
  const f = toFraction({ x: mark.x as number, y: mark.y as number, w: mark.w as number, h: mark.h as number, coords: mark.coords }, size);
  return [f.x, f.y + f.h];
}

function imageItem(item: Extract<EvidenceItem, { type: 'image' }>, images: Readonly<Record<string, InlineImage>>): string {
  const image = images[item.image];
  if (image === undefined) {
    return '';
  }
  const marks = item.marks ?? [];
  const labels = marks
    .filter(m => m.text !== undefined && m.text !== '')
    .map((m) => {
      const [lx, ly] = labelAnchor(m, image);
      return `<span class="mark-label mark-label-${m.tone ?? 'defect'}" style="left:${n(Math.min(lx, 0.8) * 100)}%;top:${n(Math.min(ly, 0.94) * 100)}%">${escapeHtml(m.text)}</span>`;
    })
    .join('');
  return `<figure class="shot">
  <button type="button" class="shot-frame" data-zoom aria-label="Open ${escapeHtml(item.caption ?? item.image)} full window" style="aspect-ratio:${image.width} / ${image.height}">
    <img src="${image.dataUri}" width="${image.width}" height="${image.height}" alt="${escapeHtml(item.caption ?? item.image)}">
    <svg class="marks" viewBox="0 0 ${image.width} ${image.height}" aria-hidden="true">${marks.map(m => markSvg(m, image)).join('')}</svg>
    ${labels}
  </button>
  ${item.caption ? `<figcaption>${escapeHtml(item.caption)}</figcaption>` : ''}
</figure>`;
}

function codeOf(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}

function evidenceItem(item: EvidenceItem, images: Readonly<Record<string, InlineImage>>): string {
  switch (item.type) {
    case 'image':
      return imageItem(item, images);
    case 'api': {
      const ok = item.status !== undefined && item.status < 400;
      const status = item.status === undefined ? '' : `<span class="http ${ok ? 'http-ok' : 'http-bad'}">${n(item.status)}</span>`;
      const parts = [
        item.request === undefined ? '' : `<div class="io"><p class="io-label">Request</p><pre>${escapeHtml(codeOf(item.request))}</pre></div>`,
        item.response === undefined ? '' : `<div class="io"><p class="io-label">Response</p><pre>${escapeHtml(codeOf(item.response))}</pre></div>`,
      ].join('');
      return `<div class="item api">
  <p class="item-head"><span class="method">${escapeHtml(item.method.toUpperCase())}</span> <code class="url">${escapeHtml(item.url)}</code> ${status}</p>
  ${item.caption ? `<p class="caption">${escapeHtml(item.caption)}</p>` : ''}
  ${parts ? `<div class="io-pair">${parts}</div>` : ''}
</div>`;
    }
    case 'sql': {
      const head = (item.columns ?? []).map(c => `<th>${escapeHtml(c)}</th>`).join('');
      const rows = (item.rows ?? []).map(r => `<tr>${r.map(cell => `<td>${escapeHtml(cell === null ? 'NULL' : typeof cell === 'object' ? JSON.stringify(cell) : cell)}</td>`).join('')}</tr>`).join('');
      return `<div class="item sql">
  <pre class="query">${escapeHtml(item.query)}</pre>
  ${item.caption ? `<p class="caption">${escapeHtml(item.caption)}</p>` : ''}
  ${head || rows ? `<div class="scroll"><table>${head ? `<thead><tr>${head}</tr></thead>` : ''}<tbody>${rows}</tbody></table></div>` : ''}
</div>`;
    }
    case 'timeline':
      return `<div class="item timeline">
  ${item.caption ? `<p class="caption">${escapeHtml(item.caption)}</p>` : ''}
  <ol>${item.events.map(e => `<li><time>${escapeHtml(e.at)}</time><span class="ev-label">${escapeHtml(e.label)}</span>${e.detail ? `<span class="ev-detail">${escapeHtml(e.detail)}</span>` : ''}</li>`).join('')}</ol>
</div>`;
    case 'note':
      return `<div class="item note"><p>${escapeHtml(item.text)}</p></div>`;
  }
}

// ============================================================================
// CASES
// ============================================================================

function caseDetail(c: Case, index: number, images: Readonly<Record<string, InlineImage>>, anchor: string | null): string {
  const facts = [
    c.reason ? `<p class="fact"><span class="k">Reason</span> ${escapeHtml(c.reason)}</p>` : '',
    c.followUp ? `<p class="fact"><span class="k">Follow-up</span> <code>${escapeHtml(c.followUp)}</code></p>` : '',
  ].join('');
  const compare = c.expected || c.actual
    ? `<div class="compare">
    <div class="side side-expected"><p class="side-label">Expected</p><p>${escapeHtml(c.expected ?? '—')}</p></div>
    <div class="side side-actual tone-${TONE_OF[c.status]}"><p class="side-label">Actual</p><p>${escapeHtml(c.actual ?? '—')}</p></div>
  </div>`
    : '';
  return `<article class="case"${anchor ? ` id="${anchor}"` : ''}>
  <header class="case-head">
    <span class="case-no">${index + 1}</span>
    <h3>${escapeHtml(c.title)}</h3>
    ${c.id ? `<code class="key">${escapeHtml(c.id)}</code>` : ''}
    ${pill(c.status)}
  </header>
  ${facts}
  ${compare}
  ${(c.evidence ?? []).map(item => evidenceItem(item, images)).join('\n')}
</article>`;
}

function caseBoard(cases: readonly Case[]): string {
  const counts = new Map<string, number>();
  for (const c of cases) {
    counts.set(c.status, (counts.get(c.status) ?? 0) + 1);
  }
  const tally = [...counts].map(([status, count]) => `<span class="tally">${pill(status as EvidenceStatus)} ${count}</span>`).join('');
  const rows = cases.map((c, i) => `<li><a href="#${anchorOf(i)}"><span class="case-no">${i + 1}</span><span class="row-title">${escapeHtml(c.title)}</span>${c.id ? `<code class="key">${escapeHtml(c.id)}</code>` : ''}${pill(c.status)}</a></li>`).join('');
  return `<div class="tallies">${tally}</div><ol class="board">${rows}</ol>`;
}

// ============================================================================
// PAGE
// ============================================================================

const STYLE = `
/* Layout: one reading column; the verdict and the case board come first, every case below it */
:root {
  --bg: #f6f7f9; --surface: #ffffff; --sunken: #eef0f4; --fg: #1b2230; --muted: #5b6577; --line: #d9dde5;
  --accent: #2f5bd3;
  --ok: #1e7a46; --ok-bg: #e3f4ea; --defect: #b42318; --defect-bg: #fbe7e5;
  --pending: #8a5a00; --pending-bg: #fdf1d8; --neutral: #4b5565; --neutral-bg: #e8ebf0;
  --redact: #111111;
  --font-ui: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  --font-mono: ui-monospace, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;
}
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {
  --bg: #11151c; --surface: #181d26; --sunken: #0d1117; --fg: #e6e9ef; --muted: #9aa4b5; --line: #2a3140;
  --accent: #7d9bff;
  --ok: #5fd08f; --ok-bg: #12301f; --defect: #ff8a7f; --defect-bg: #3a1714;
  --pending: #f2bf5e; --pending-bg: #352708; --neutral: #b7c0cf; --neutral-bg: #262d39; color-scheme: dark;
} }
:root[data-theme="dark"] {
  --bg: #11151c; --surface: #181d26; --sunken: #0d1117; --fg: #e6e9ef; --muted: #9aa4b5; --line: #2a3140;
  --accent: #7d9bff;
  --ok: #5fd08f; --ok-bg: #12301f; --defect: #ff8a7f; --defect-bg: #3a1714;
  --pending: #f2bf5e; --pending-bg: #352708; --neutral: #b7c0cf; --neutral-bg: #262d39; color-scheme: dark;
}
* { box-sizing: border-box; }
[hidden] { display: none !important; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.55 var(--font-ui);
  padding-left: max(16px, env(safe-area-inset-left, 0px)); padding-right: max(16px, env(safe-area-inset-right, 0px)); padding-block: 24px 40px; }
.page { max-width: 980px; margin: 0 auto; display: flex; flex-direction: column; gap: 28px; }
h1, h2, h3 { text-wrap: balance; margin: 0; line-height: 1.25; }
h1 { font-size: 1.6rem; font-weight: 650; }
h2 { font-size: 0.78rem; text-transform: uppercase; letter-spacing: 0.08em; color: var(--muted); font-weight: 600; }
h3 { font-size: 1.02rem; font-weight: 600; flex: 1 1 16rem; min-width: 0; }
p { margin: 0; }
code, pre, .key, time { font-family: var(--font-mono); font-size: 0.85em; }
a { color: var(--accent); }
section { display: flex; flex-direction: column; gap: 12px; }
.verdict { display: flex; flex-direction: column; gap: 12px; padding-bottom: 20px; border-bottom: 1px solid var(--line); }
.eyebrow { display: flex; flex-wrap: wrap; gap: 8px 12px; align-items: center; color: var(--muted); font-size: 0.85rem; }
.eyebrow .key { color: var(--fg); font-weight: 600; font-size: 0.95rem; }
.title-row { display: flex; flex-wrap: wrap; gap: 12px 16px; align-items: center; justify-content: space-between; }
.title-row h1 { flex: 1 1 20rem; min-width: 0; }
.summary { max-width: 68ch; color: var(--fg); }
.env { display: flex; flex-wrap: wrap; gap: 6px 22px; margin: 0; padding: 10px 14px; background: var(--sunken); border-radius: 8px; font-size: 0.85rem; }
.env div { display: flex; gap: 6px; min-width: 0; }
.env dt { color: var(--muted); }
.env dd { margin: 0; font-family: var(--font-mono); overflow-wrap: anywhere; }
.pill { display: inline-flex; align-items: center; white-space: nowrap; padding: 2px 9px; border-radius: 999px; font-size: 0.72rem; font-weight: 700; letter-spacing: 0.04em; }
.pill-lg { font-size: 0.95rem; padding: 6px 16px; }
.pill.tone-ok { color: var(--ok); background: var(--ok-bg); }
.pill.tone-defect { color: var(--defect); background: var(--defect-bg); }
.pill.tone-pending { color: var(--pending); background: var(--pending-bg); }
.pill.tone-neutral { color: var(--neutral); background: var(--neutral-bg); }
.tallies { display: flex; flex-wrap: wrap; gap: 8px 16px; font-variant-numeric: tabular-nums; }
.tally { display: inline-flex; gap: 6px; align-items: center; font-weight: 600; }
.board, .bugs { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; border: 1px solid var(--line); border-radius: 10px; background: var(--surface); overflow: hidden; }
.board li + li, .bugs li + li { border-top: 1px solid var(--line); }
.board a, .bugs li { display: flex; gap: 12px; align-items: center; padding: 10px 14px; color: inherit; text-decoration: none; }
.board a:hover, .board a:focus-visible { background: var(--sunken); }
.row-title { flex: 1 1 auto; min-width: 0; }
.case-no { font-variant-numeric: tabular-nums; color: var(--muted); font-size: 0.8rem; min-width: 1.6em; }
.key { color: var(--muted); }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.bugbox { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(min(100%, 18rem), 1fr)); }
.repro { margin: 0; padding-left: 1.4em; display: flex; flex-direction: column; gap: 4px; }
.case { display: flex; flex-direction: column; gap: 14px; padding: 18px; background: var(--surface); border: 1px solid var(--line); border-radius: 12px; scroll-margin-top: 16px; min-width: 0; }
.case-head { display: flex; flex-wrap: wrap; gap: 8px 12px; align-items: center; }
.fact .k, .side-label, .io-label { color: var(--muted); font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.06em; font-weight: 600; margin-right: 6px; }
.compare { display: grid; gap: 10px; grid-template-columns: repeat(auto-fit, minmax(min(100%, 16rem), 1fr)); }
.side { padding: 12px 14px; border-radius: 8px; background: var(--sunken); display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.side-actual.tone-defect { background: var(--defect-bg); }
.side-actual.tone-ok { background: var(--ok-bg); }
.shot { margin: 0; display: flex; flex-direction: column; gap: 6px; }
.shot-frame { position: relative; display: block; width: 100%; max-width: 100%; padding: 0; border: 1px solid var(--line); border-radius: 8px; overflow: hidden; background: var(--sunken); cursor: zoom-in; }
.shot-frame img { display: block; width: 100%; height: 100%; }
.marks { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; }
.mark { fill: none; stroke-width: 3; vector-effect: non-scaling-stroke; stroke-linejoin: round; stroke-linecap: round; }
.mark-defect { stroke: #e5484d; } .mark-ok { stroke: #30a46c; } .mark-note { stroke: #3e63dd; }
.mark-head.mark-defect { fill: #e5484d; } .mark-head.mark-ok { fill: #30a46c; } .mark-head.mark-note { fill: #3e63dd; }
.mark-label { position: absolute; transform: translateY(4px); max-width: 40%; padding: 2px 7px; border-radius: 4px; font-size: 0.75rem; font-weight: 600; color: #ffffff; text-align: left; line-height: 1.35; }
.mark-label-defect { background: #c8303a; } .mark-label-ok { background: #1f7a4d; } .mark-label-note { background: #2f4fb8; }
figcaption, .caption { color: var(--muted); font-size: 0.85rem; }
.item { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.item-head { display: flex; flex-wrap: wrap; gap: 8px; align-items: baseline; }
.method { font-family: var(--font-mono); font-weight: 700; font-size: 0.8rem; }
.url { overflow-wrap: anywhere; }
.http { font-family: var(--font-mono); font-weight: 700; font-size: 0.8rem; padding: 1px 6px; border-radius: 4px; }
.http-ok { color: var(--ok); background: var(--ok-bg); } .http-bad { color: var(--defect); background: var(--defect-bg); }
.io-pair { display: grid; gap: 10px; grid-template-columns: repeat(auto-fit, minmax(min(100%, 18rem), 1fr)); }
.io { min-width: 0; display: flex; flex-direction: column; gap: 4px; }
pre { margin: 0; padding: 10px 12px; background: var(--sunken); border-radius: 8px; overflow-x: auto; white-space: pre; max-height: 22rem; }
.scroll { overflow-x: auto; border: 1px solid var(--line); border-radius: 8px; }
table { border-collapse: collapse; width: 100%; font-size: 0.85rem; font-variant-numeric: tabular-nums; }
th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid var(--line); white-space: nowrap; }
th { background: var(--sunken); font-weight: 600; }
.timeline ol { list-style: none; margin: 0; padding: 0 0 0 14px; border-left: 2px solid var(--line); display: flex; flex-direction: column; gap: 8px; }
.timeline li { display: flex; flex-wrap: wrap; gap: 4px 12px; }
.timeline time { color: var(--muted); }
.ev-label { font-weight: 600; }
.ev-detail { color: var(--muted); flex-basis: 100%; }
.note p { padding: 10px 14px; border-left: 3px solid var(--accent); background: var(--sunken); border-radius: 0 8px 8px 0; max-width: 72ch; }
.history { border: 1px solid var(--pending); border-radius: 12px; background: var(--pending-bg); }
.history > summary { cursor: pointer; padding: 12px 16px; font-weight: 600; color: var(--pending); }
.history-body { display: flex; flex-direction: column; gap: 16px; padding: 0 16px 16px; }
.round-head { color: var(--pending); font-size: 0.85rem; font-weight: 600; }
.foot { color: var(--muted); font-size: 0.8rem; border-top: 1px solid var(--line); padding-top: 14px; display: flex; flex-direction: column; gap: 4px; }
.zoom { position: fixed; inset: 0; z-index: 20; background: rgba(8, 10, 14, 0.92); display: flex; align-items: center; justify-content: center;
  padding: max(16px, env(safe-area-inset-top, 0px)) max(16px, env(safe-area-inset-right, 0px)) max(16px, env(safe-area-inset-bottom, 0px)) max(16px, env(safe-area-inset-left, 0px)); }
.zoom .shot-frame { cursor: zoom-out; width: auto; max-width: 100%; max-height: 100%; height: auto; }
.zoom-close { position: absolute; top: max(12px, env(safe-area-inset-top, 0px)); right: max(12px, env(safe-area-inset-right, 0px)); font: inherit; font-weight: 600; padding: 6px 12px; border-radius: 6px; border: 0; background: #ffffff; color: #111111; cursor: pointer; }
@media (prefers-reduced-motion: no-preference) { .board a { transition: background 120ms ease; } }
`;

const SCRIPT = `
(function () {
  var overlay = document.getElementById('zoom');
  var slot = document.getElementById('zoom-slot');
  function close() { overlay.hidden = true; slot.innerHTML = ''; }
  document.addEventListener('click', function (event) {
    var frame = event.target.closest('[data-zoom]');
    if (frame && !overlay.contains(frame)) {
      var copy = frame.cloneNode(true);
      copy.removeAttribute('data-zoom');
      copy.setAttribute('aria-label', 'Close the full-window image');
      var ratio = frame.querySelector('img').naturalWidth / frame.querySelector('img').naturalHeight || 1;
      copy.style.width = 'min(100%, calc((100vh - 64px) * ' + ratio + '))';
      slot.appendChild(copy);
      overlay.hidden = false;
      document.getElementById('zoom-close').focus();
      return;
    }
    if (!overlay.hidden && (event.target === overlay || event.target.closest('#zoom-close') || overlay.contains(event.target))) { close(); }
  });
  document.addEventListener('keydown', function (event) { if (event.key === 'Escape' && !overlay.hidden) { close(); } });
})();
`;

function envStrip(pack: Pack): string {
  const rows: Array<[string, string | undefined]> = [
    ['Environment', pack.env.name],
    ['URL', pack.env.url],
    ['Build', pack.env.build],
    ['Commit', pack.env.commit],
    ['Tested', pack.env.testedAt],
    ['Tester', pack.env.tester],
  ];
  return `<dl class="env">${rows.filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => `<div><dt>${k}</dt><dd>${escapeHtml(v)}</dd></div>`).join('')}</dl>`;
}

function bugSection(pack: Pack): string {
  const bug = pack.bug;
  if (bug === undefined) {
    return '';
  }
  const repro = (bug.repro ?? []).length > 0 ? `<ol class="repro">${(bug.repro ?? []).map(s => `<li>${escapeHtml(s)}</li>`).join('')}</ol>` : '';
  return `<section aria-labelledby="bug-h">
  <h2 id="bug-h">Defect</h2>
  <div class="eyebrow">${bug.severity ? `<span>Severity <strong>${escapeHtml(bug.severity)}</strong></span>` : ''}${bug.story ? `<span>Found on <code class="key">${escapeHtml(bug.story)}</code></span>` : ''}</div>
  <div class="compare">
    <div class="side side-expected"><p class="side-label">Expected</p><p>${escapeHtml(bug.expected ?? '—')}</p></div>
    <div class="side side-actual tone-defect"><p class="side-label">Actual</p><p>${escapeHtml(bug.actual ?? '—')}</p></div>
  </div>
  ${repro ? `<div class="item"><p class="side-label">Steps to reproduce</p>${repro}</div>` : ''}
</section>`;
}

/** The pack as embedded on the page: everything except image bytes and local file paths. */
export function embeddedPack(pack: Pack): unknown {
  const images = Object.fromEntries(Object.entries(pack.images ?? {}).map(([key, decl]) => [key, { redactions: (decl.redact ?? []).length }]));
  return { ...pack, images };
}

export function renderPage(pack: Pack, images: Readonly<Record<string, InlineImage>>, meta: RenderMeta): string {
  const headStatus: EvidenceStatus = pack.kind === 'bug' && pack.bug ? pack.bug.status : (pack.ticket.verdict ?? 'PENDING');
  const kindLabel = pack.kind === 'bug' ? 'Bug evidence' : 'Story evidence';
  const ticketKey = pack.ticket.link
    ? `<a class="key" href="${escapeHtml(pack.ticket.link)}" rel="noopener" target="_blank">${escapeHtml(pack.ticket.id)}</a>`
    : `<span class="key">${escapeHtml(pack.ticket.id)}</span>`;

  const bugs = (pack.bugs ?? []).length > 0
    ? `<section aria-labelledby="bugs-h"><h2 id="bugs-h">Bugs filed</h2><ul class="bugs">${(pack.bugs ?? []).map(b => `<li><code class="key">${b.link ? `<a href="${escapeHtml(b.link)}" rel="noopener" target="_blank">${escapeHtml(b.id)}</a>` : escapeHtml(b.id)}</code><span class="row-title">${escapeHtml(b.title)}</span>${pill(b.status)}</li>`).join('')}</ul></section>`
    : '';

  const history = (pack.history ?? []).length > 0
    ? `<details class="history">
  <summary>Before fix: ${(pack.history ?? []).length === 1 ? '1 earlier round' : `${(pack.history ?? []).length} earlier rounds`}, not counted in the verdict</summary>
  <div class="history-body">${[...(pack.history ?? [])].sort((a, b) => b.round - a.round).map(round => `<div class="round"><p class="round-head">Round ${n(round.round)}${round.build ? ` · build ${escapeHtml(round.build)}` : ''}${round.at ? ` · ${escapeHtml(round.at)}` : ''}</p>${round.cases.map((c, i) => caseDetail(c, i, images, null)).join('\n')}</div>`).join('\n')}</div>
</details>`
    : '';

  const page = `<meta charset="utf-8">
<title>${escapeHtml(pack.ticket.id)} evidence</title>
<meta name="claude:viewport-fit-sides" content="cover">
<style>${STYLE}</style>
<main class="page">
<header class="verdict">
  <p class="eyebrow">${ticketKey}<span>${kindLabel}</span></p>
  <div class="title-row"><h1>${escapeHtml(pack.ticket.title)}</h1>${pill(headStatus, true)}</div>
  ${pack.summary ? `<p class="summary">${escapeHtml(pack.summary)}</p>` : ''}
  ${envStrip(pack)}
</header>
${bugSection(pack)}
<section aria-labelledby="cases-h">
  <h2 id="cases-h">${pack.cases.length === 1 ? '1 case' : `${pack.cases.length} cases`}</h2>
  ${caseBoard(pack.cases)}
</section>
${bugs}
<section aria-labelledby="detail-h">
  <h2 id="detail-h">Evidence by case</h2>
  ${pack.cases.map((c, i) => caseDetail(c, i, images, anchorOf(i))).join('\n')}
</section>
${history}
<footer class="foot">
  <p>Private evidence. Share it from the page's own share menu; never post a public link. Redactions are burned into the images.</p>
  <p>Built ${escapeHtml(meta.generatedAt)} from <code>${escapeHtml(pack.schema)}</code>.</p>
</footer>
</main>
<div class="zoom" id="zoom" hidden><button type="button" class="zoom-close" id="zoom-close">Close</button><div id="zoom-slot"></div></div>
<script type="application/json" id="evidence-pack">${scriptJson(embeddedPack(pack))}</script>
<script>${SCRIPT}</script>
`;
  return meta.standalone === true
    ? `<!doctype html>\n<html lang="en">\n<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n${page}</html>\n`
    : page;
}
