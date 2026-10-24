/** Hand-drawn SVG, one scale per chart, colors from theme tokens only. */
import { esc } from './util.ts';

const COLOR: Record<string, string> = {
  'l-pass': 'var(--pass)',
  'l-fail': 'var(--fail)',
  'l-needs': 'var(--needs)',
  'l-run': 'var(--run)',
  'l-held': 'var(--held)',
  'l-next': 'var(--held-t)',
};

/** One horizontal bar split by segment, with a legend that names every value. */
export function stackBar(segs: { label: string, value: number, cls: string }[]): string {
  const total = segs.reduce((s, x) => s + x.value, 0);
  if (!total) { return '<p class="hint">—</p>'; }
  let x = 0;
  const rects = segs.filter(s => s.value).map((s) => {
    const w = (s.value / total) * 100;
    const r = `<rect x="${x}%" y="0" width="${w}%" height="14" fill="${COLOR[s.cls]}" stroke="var(--card)" stroke-width="1"><title>${esc(s.label)}: ${s.value}</title></rect>`;
    x += w;
    return r;
  }).join('');
  const legend = segs.filter(s => s.value).map(s => `<span style="display:inline-flex;gap:5px;align-items:center;margin-right:10px;font-size:12px"><i style="width:9px;height:9px;border-radius:2px;background:${COLOR[s.cls]};display:inline-block;border:1px solid var(--rule)"></i>${esc(s.label)} <b class="mono">${s.value}</b></span>`).join('');
  return `<svg width="100%" height="14" role="img" aria-label="${esc(segs.map(s => `${s.label} ${s.value}`).join(', '))}">${rects}</svg><div>${legend}</div>`;
}

export function burnupChart(points: { day: string, done: number, scope: number }[]): string {
  if (points.length < 2) { return '<p class="hint">—</p>'; }
  const W = 320; const H = 130; const L = 28; const B = 22; const T = 8; const R = 22;
  const max = Math.max(1, ...points.map(p => Math.max(p.done, p.scope)));
  const xs = (i: number) => L + (i / (points.length - 1)) * (W - L - R);
  const ys = (v: number) => T + (1 - v / max) * (H - T - B);
  const line = points.map((p, i) => `${i ? 'L' : 'M'}${xs(i).toFixed(1)},${ys(p.done).toFixed(1)}`).join('');
  const area = `${line}L${xs(points.length - 1).toFixed(1)},${ys(0)}L${xs(0)},${ys(0)}Z`;
  const scope = points.map((p, i) => `${i ? 'L' : 'M'}${xs(i).toFixed(1)},${ys(p.scope).toFixed(1)}`).join('');
  const last = points.at(-1)!;
  const ticks = [0, Math.round(max / 2), max];
  const every = Math.max(1, Math.ceil(points.length / 5));
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="burn-up: ${last.done} of ${last.scope} on ${esc(last.day)}">
    ${ticks.map(t => `<line class="axis" x1="${L}" x2="${W - R}" y1="${ys(t)}" y2="${ys(t)}" stroke-dasharray="2 3"/><text x="${L - 4}" y="${ys(t) + 4}" text-anchor="end">${t}</text>`).join('')}
    <path d="${area}" fill="var(--pass-t)"/>
    <path d="${scope}" fill="none" stroke="var(--held)" stroke-width="1.5" stroke-dasharray="4 3"/>
    <path d="${line}" fill="none" stroke="var(--pass)" stroke-width="2"/>
    <circle cx="${xs(points.length - 1)}" cy="${ys(last.done)}" r="4" fill="var(--pass)"/>
    ${points.map((p, i) => (i % every === 0 || i === points.length - 1 ? `<text x="${xs(i)}" y="${H - 6}" text-anchor="middle">${esc(p.day.slice(5))}</text>` : '')).join('')}
  </svg>`;
}

/** Horizontal bars; `a` is the main value, `b` an optional second (e.g. closed). */
export function barChart(rows: { label: string, a: number, b: number }[], keys: string[], amberAbove?: number): string {
  if (!rows.length) { return '<p class="hint">—</p>'; }
  const max = Math.max(1, ...rows.map(r => r.a + r.b));
  const rowH = 22; const L = 104; const W = 340;
  const H = rows.length * rowH + 4;
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="${esc(rows.map(r => `${r.label} ${r.a}`).join(', '))}">
    ${rows.map((r, i) => {
      const y = i * rowH + 3;
      const wa = (r.a / max) * (W - L - 92);
      const wb = (r.b / max) * (W - L - 92);
      const fill = amberAbove !== undefined ? (r.a > amberAbove ? 'var(--needs)' : 'var(--run)') : 'var(--fail)';
      return `<text x="${L - 6}" y="${y + 13}" text-anchor="end">${esc(r.label.slice(0, 14))}</text>
        <rect x="${L}" y="${y}" width="${Math.max(wa, r.a ? 2 : 0)}" height="15" rx="2" fill="${fill}"/>
        ${r.b ? `<rect x="${L + wa}" y="${y}" width="${wb}" height="15" rx="2" fill="var(--held-t)" stroke="var(--rule)"/>` : ''}
        <text x="${L + wa + wb + 5}" y="${y + 12}">${r.a}${r.b ? ` + ${r.b} ${esc(keys[1] ?? '')}` : keys[0] === 'hours' ? 'h' : ''}</text>`;
    }).join('')}
  </svg>`;
}

export function dotStrip(items: { label: string, value: number }[]): string {
  if (!items.length) { return ''; }
  const W = 320; const H = 34; const L = 6; const R = 30;
  const max = Math.max(24, ...items.map(i => i.value));
  const x = (v: number) => L + (v / max) * (W - L - R);
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="open questions by age">
    <line class="axis" x1="${L}" x2="${W - R}" y1="14" y2="14"/>
    <line x1="${x(24)}" x2="${x(24)}" y1="6" y2="22" stroke="var(--needs)" stroke-dasharray="2 2"/><text x="${x(24)}" y="32" text-anchor="middle">24h</text>
    ${items.map(i => `<circle cx="${x(i.value)}" cy="14" r="5" fill="var(--needs)" fill-opacity=".75"><title>${esc(i.label)}: ${i.value}h</title></circle>`).join('')}
    ${max > 24 ? `<text x="${W - R + 4}" y="18">${max}h</text>` : ''}
  </svg>`;
}
