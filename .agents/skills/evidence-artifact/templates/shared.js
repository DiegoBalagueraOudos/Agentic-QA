/* Evidence renderer used by templates/evidence-artifact.html (born in the 2026-10-19 spike, shared by its prototypes).
   Annotation model (all coordinates are FRACTIONS of the image's natural width/height,
   so the same JSON survives any downscale):
     {n, shape:"rect", x,y,w,h} | {n, shape:"ellipse", cx,cy,rx,ry} | {n, shape:"arrow", x1,y1,x2,y2}
     {n, shape:"path", pts:[[x,y],...]} (freehand-like stroke) | {n, shape:"bubble", x,y, text} (speech bubble, tip at x,y)
   plus tone ("defect" | "ok" | "note"), layer (free label used by layer toggles), title, explain. */
const EV = (() => {
  const NS = "http://www.w3.org/2000/svg";
  const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const el = (tag, attrs = {}, html) => { const e = document.createElement(tag); for (const k in attrs) e.setAttribute(k, attrs[k]); if (html != null) e.innerHTML = html; return e; };
  const sv = (tag, attrs = {}) => { const e = document.createElementNS(NS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); return e; };

  function smooth(pts) {
    if (pts.length < 3) return "M" + pts.map(p => p.join(",")).join(" L");
    let d = `M${pts[0][0]},${pts[0][1]}`;
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || p2;
      const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
      const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
      d += ` C${c1} ${c2} ${p2}`;
    }
    return d;
  }

  function anchorOf(a, W, H) {
    switch (a.shape) {
      case "rect": return [a.x * W, a.y * H];
      case "ellipse": return [(a.cx - a.rx * .72) * W, (a.cy - a.ry * .72) * H];
      case "arrow": return [a.x1 * W, a.y1 * H];
      case "path": return [a.pts[0][0] * W, a.pts[0][1] * H];
      default: return [a.x * W, a.y * H];
    }
  }
  function centerOf(a) {
    switch (a.shape) {
      case "rect": return { x: a.x + a.w / 2, y: a.y + a.h / 2, w: a.w, h: a.h };
      case "ellipse": return { x: a.cx, y: a.cy, w: a.rx * 2, h: a.ry * 2 };
      case "arrow": return { x: (a.x1 + a.x2) / 2, y: (a.y1 + a.y2) / 2, w: Math.abs(a.x2 - a.x1), h: Math.abs(a.y2 - a.y1) };
      case "path": { const xs = a.pts.map(p => p[0]), ys = a.pts.map(p => p[1]); const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys); return { x: (x0 + x1) / 2, y: (y0 + y1) / 2, w: x1 - x0, h: y1 - y0 }; }
      default: return { x: a.x, y: a.y - .03, w: .2, h: .06 };
    }
  }

  /* Draw every non-bubble annotation into an <svg viewBox="0 0 W H">; bubbles become HTML so
     their text stays readable at any width. Returns {svg, bubbles}. */
  function drawMarks(anns, W, H) {
    const svg = sv("svg", { class: "ev-marks", viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: "none", "aria-hidden": "true" });
    const r = Math.max(12, W * .013);
    const bubbles = [];
    for (const a of anns) {
      const tone = a.tone || "defect";
      if (a.shape === "bubble") {
        const b = el("div", { class: `ev-bubble t-${tone}`, "data-ann": a.n, "data-layer": a.layer || tone }, `<b>${esc(a.n)}</b> · ${esc(a.text)}`);
        b.style.left = (a.x * 100) + "%"; b.style.top = (a.y * 100) + "%";
        bubbles.push(b); continue;
      }
      const g = sv("g", { class: "ann", "data-ann": a.n, "data-layer": a.layer || tone });
      let geo;
      if (a.shape === "rect") geo = () => sv("rect", { x: a.x * W, y: a.y * H, width: a.w * W, height: a.h * H, rx: 6 });
      else if (a.shape === "ellipse") geo = () => sv("ellipse", { cx: a.cx * W, cy: a.cy * H, rx: a.rx * W, ry: a.ry * H });
      else if (a.shape === "arrow") geo = () => sv("line", { x1: a.x1 * W, y1: a.y1 * H, x2: a.x2 * W, y2: a.y2 * H });
      else if (a.shape === "path") geo = () => sv("path", { d: smooth(a.pts.map(p => [p[0] * W, p[1] * H])) });
      if (!geo) continue;
      const halo = geo(); halo.setAttribute("class", "halo"); g.appendChild(halo);
      const s = geo(); s.setAttribute("class", `shape t-${tone}`); g.appendChild(s);
      if (a.shape === "arrow") {
        const x1 = a.x1 * W, y1 = a.y1 * H, x2 = a.x2 * W, y2 = a.y2 * H, ang = Math.atan2(y2 - y1, x2 - x1), L = r * 1.5;
        const p = [[x2, y2], [x2 - L * Math.cos(ang - .45), y2 - L * Math.sin(ang - .45)], [x2 - L * Math.cos(ang + .45), y2 - L * Math.sin(ang + .45)]];
        g.appendChild(sv("polygon", { points: p.map(q => q.join(",")).join(" "), class: `head-${tone}` }));
      }
      if (a.n != null) {
        const [bx, by] = anchorOf(a, W, H);
        const bg = sv("g", { class: "badge" });
        bg.appendChild(sv("circle", { cx: bx, cy: by, r, fill: `var(--mark-${tone})` }));
        const t = sv("text", { x: bx, y: by + 1, "font-size": r * 1.15 }); t.textContent = a.n; bg.appendChild(t);
        g.appendChild(bg);
      }
      svg.appendChild(g);
    }
    return { svg, bubbles };
  }

  /* <figure> with screenshot + overlay. item = {ref, caption, annotations} */
  function figure(pack, item) {
    const im = pack.images[item.ref];
    const fig = el("figure", { class: "ev-figure" });
    const stage = el("div", { class: "ev-stage" });
    const img = el("img", { src: im.src, alt: item.alt || item.caption || "", width: im.w, height: im.h });
    stage.appendChild(img);
    const { svg, bubbles } = drawMarks(item.annotations || [], im.w, im.h);
    stage.appendChild(svg); bubbles.forEach(b => stage.appendChild(b));
    fig.appendChild(stage);
    if (item.caption) fig.appendChild(el("figcaption", { class: "ev-cap" }, esc(item.caption)));
    return fig;
  }
  function focus(root, n) {
    root.querySelectorAll("[data-ann]").forEach(g => {
      const on = n == null || String(g.dataset.ann) === String(n);
      g.classList.toggle("dim", !on); g.classList.toggle("hot", n != null && on);
    });
  }
  function setLayer(root, layer, visible) {
    root.querySelectorAll(`g.ann[data-layer="${layer}"], .ev-bubble[data-layer="${layer}"]`).forEach(g => g.style.display = visible ? "" : "none");
  }

  function copy(text, btn) {
    const done = ok => { const t = btn.textContent; btn.textContent = ok ? "Copied" : "Select and copy"; setTimeout(() => btn.textContent = t, 1400); };
    try { navigator.clipboard.writeText(text).then(() => done(true), () => done(false)); } catch { done(false); }
  }

  /* Provenance chips ("Token redacted", "Response trimmed", "Query written for display"):
     they say what was changed or reconstructed for display, so a reader never mistakes it for raw output. */
  function flags(list) {
    return (list || []).length ? `<div class="flags">${list.map(f => `<span class="flag">${esc(f)}</span>`).join("")}</div>` : "";
  }

  /* API panel: {method, url, status, ms, note, request, response, curl, flags?} */
  function api(item) {
    const p = el("section", { class: "panel" });
    const sc = String(item.status)[0];
    p.innerHTML = `<div class="panel-head"><span class="method">${esc(item.method)}</span><span class="url">${esc(item.url)}</span>
      <span class="status s${sc}">${esc(item.status)}</span>${item.ms ? `<span class="label tabular">${esc(item.ms)}</span>` : ""}</div>
      <div class="panel-body">${flags(item.flags)}<div class="seg" role="tablist"></div><div class="api-out" style="margin-top:10px"></div>${item.note ? `<p class="api-note">${esc(item.note)}</p>` : ""}</div>`;
    const seg = p.querySelector(".seg"), out = p.querySelector(".api-out");
    const tabs = [["Response", item.response], ["Request", item.request], ["curl", item.curl]].filter(t => t[1]);
    tabs.forEach(([name, body], i) => {
      const b = el("button", { role: "tab", "aria-selected": i === 0 ? "true" : "false" }, name);
      b.onclick = () => { seg.querySelectorAll("button").forEach(x => x.setAttribute("aria-selected", "false")); b.setAttribute("aria-selected", "true"); show(name, body); };
      seg.appendChild(b);
    });
    function show(name, body) {
      out.innerHTML = "";
      const pre = el("pre", { class: "code" }); pre.textContent = body; out.appendChild(pre);
      if (name === "curl") { const c = el("button", { class: "btn", style: "margin-top:8px" }, "Copy curl"); c.onclick = () => copy(body, c); out.appendChild(c); }
    }
    if (tabs.length) show(tabs[0][0], tabs[0][1]);
    return p;
  }

  /* DB panel: {db, query, columns, rows, hl:[rowIdx], okRows:[rowIdx], note} */
  function db(item) {
    const p = el("section", { class: "panel" });
    const head = `<div class="panel-head"><span class="method">SQL</span><span class="url">${esc(item.db)}</span>${item.when ? `<span class="label">${esc(item.when)}</span>` : ""}</div>`;
    const rows = item.rows.map((r, i) => `<tr class="${(item.hl || []).includes(i) ? "hl" : (item.okRows || []).includes(i) ? "ok" : ""}">${r.map(c => `<td>${c === null ? "<i>NULL</i>" : esc(c)}</td>`).join("")}</tr>`).join("");
    p.innerHTML = `${head}<div class="panel-body">${flags(item.flags)}<pre class="code"></pre><div class="tbl-wrap" style="margin-top:10px"><table class="data"><thead><tr>${item.columns.map(c => `<th>${esc(c)}</th>`).join("")}</tr></thead><tbody>${rows}</tbody></table></div>${item.note ? `<p class="api-note">${esc(item.note)}</p>` : ""}</div>`;
    p.querySelector("pre").textContent = item.query;
    return p;
  }

  /* Timeline panel: {title, events:[{t (ms), label, rows?, state: ok|req|wait|bad}], source?} */
  function timeline(item) {
    const box = el("section", { class: "tl" });
    const max = Math.max(...item.events.map(e => e.t));
    box.innerHTML = `<h3 class="tl-h">${esc(item.title)}</h3>${flags(item.flags)}<div class="tl-track"></div><div class="tl-scale"><span>0 ms</span><span>${(max / 1000).toFixed(1)} s</span></div><ul></ul>
      ${item.source ? `<p class="api-note">Source: <code>${esc(item.source)}</code></p>` : ""}`;
    const track = box.querySelector(".tl-track"), ul = box.querySelector("ul");
    item.events.forEach(e => {
      const d = el("span", { class: `tl-dot ${e.state}`, title: e.label }); d.style.left = (e.t / max * 100) + "%"; track.appendChild(d);
      const rows = e.rows == null ? "" : `<span class="rows ${e.state === "bad" ? "bad" : e.state === "ok" ? "ok" : ""}">${e.rows} rows</span>`;
      ul.appendChild(el("li", {}, `<span class="ms tabular">${e.t.toLocaleString()} ms</span><span>${esc(e.label)}</span>${rows}`));
    });
    return box;
  }

  /* Where a reader should look first: the centre of the defect marks, else of all marks, else the top. */
  function focusOf(anns) {
    const pick = anns.filter(a => a.tone === "defect").length ? anns.filter(a => a.tone === "defect") : anns;
    if (!pick.length) return { fx: .5, fy: 0, none: true };
    const bs = pick.map(centerOf);
    const x0 = Math.min(...bs.map(b => b.x - b.w / 2)), x1 = Math.max(...bs.map(b => b.x + b.w / 2));
    const y0 = Math.min(...bs.map(b => b.y - b.h / 2)), y1 = Math.max(...bs.map(b => b.y + b.h / 2));
    return { fx: (x0 + x1) / 2, fy: (y0 + y1) / 2 };
  }

  /* Thumbnail cropped around the marks that matter (defect marks first), so a 1440x2600 page
     still shows its defect on a small card. aspect = container height / width. */
  function thumb(pack, item, aspect = .625) {
    const box = el("div", { class: "thumb" });
    if (!item) { box.appendChild(el("div", { class: "tile tile-none" }, `<span class="tile-k">No evidence attached</span>`)); return box; }
    if (item.type === "image" || item.type === "compare") {
      const ref = item.type === "image" ? item.ref : item.right.image;
      const anns = item.type === "image" ? (item.annotations || []) : (item.right.annotations || []);
      const im = pack.images[ref], A = aspect, R = im.h / im.w;
      const { fx, fy } = focusOf(anns);
      const inner = el("div", { class: "thumb-in" });
      const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
      if (R >= A) {                     /* tall: fill the width, slide vertically to the focus */
        const top = clamp(A / 2 - fy * R, A - R, 0);
        Object.assign(inner.style, { width: "100%", height: (R / A * 100) + "%", left: "0", top: (top / A * 100) + "%" });
      } else {                          /* wide: fill the height, slide horizontally */
        const iw = A / R, left = clamp(.5 - fx * iw, 1 - iw, 0);
        Object.assign(inner.style, { height: "100%", width: (iw * 100) + "%", top: "0", left: (left * 100) + "%" });
      }
      inner.appendChild(el("img", { src: im.src, alt: "", loading: "lazy", decoding: "async" }));
      inner.appendChild(drawMarks(anns.filter(a => a.shape !== "bubble"), im.w, im.h).svg);
      box.appendChild(inner);
      if (item.type === "compare") box.appendChild(el("span", { class: "thumb-cmp", "aria-hidden": "true" }));
      return box;
    }
    let html = "";
    if (item.type === "api") html = `<span class="tile-k">API</span><span class="tile-row"><span class="method">${esc(item.method)}</span><span class="status s${String(item.status)[0]}">${esc(item.status)}</span></span><span class="tile-url">${esc(item.url)}</span>`;
    else if (item.type === "sql") html = `<span class="tile-k">SQL</span><span class="tile-row"><span class="method">${item.rows.length} rows</span></span><span class="tile-url">${esc(item.db)}</span>`;
    else if (item.type === "timeline") html = `<span class="tile-k">Timeline</span><span class="tile-row"><span class="method">${item.events.length} events</span></span><span class="tile-url">${esc(item.title)}</span>`;
    else html = `<span class="tile-k">Note</span><span class="tile-url">${esc(item.title || "")}</span>`;
    box.appendChild(el("div", { class: `tile tile-${item.type}` }, html));
    return box;
  }

  /* Pan/zoom engine for one viewport. layer = the absolutely positioned W x H element that moves.
     Wheel pans, Ctrl/Cmd+wheel (and trackpad pinch) zooms, drag pans unless onDrag claims it, two-finger pinch zooms. */
  function zoomer(vp, layer, opts = {}) {
    const z = { s: 1, tx: 0, ty: 0, W: 1, H: 1 };
    z.size = (W, H) => { z.W = W; z.H = H; layer.style.width = W + "px"; layer.style.height = H + "px"; };
    z.apply = anim => {
      layer.classList.toggle("anim", !!anim);
      layer.style.transform = `translate(${z.tx}px, ${z.ty}px) scale(${z.s})`;
      opts.onApply && opts.onApply(z);
    };
    z.fit = (mode, anim) => {        /* mode "auto": a page much taller than the viewport fits its width, top first */
      const r = vp.getBoundingClientRect(); if (!r.width || !r.height) return;
      const cs = Math.min(r.width / z.W, r.height / z.H) * .96, ws = r.width * .96 / z.W;
      z.s = Math.min(2, mode === "auto" && cs < ws * .6 ? ws : cs);
      z.tx = (r.width - z.W * z.s) / 2; z.ty = Math.max(8, (r.height - z.H * z.s) / 2); z.apply(anim);
    };
    z.centerOn = (fx, fy) => {      /* keep the scale, slide a page taller or wider than the viewport to (fx, fy) */
      const r = vp.getBoundingClientRect(), w = z.W * z.s, h = z.H * z.s;
      if (h > r.height) z.ty = Math.min(8, Math.max(r.height - h - 8, r.height / 2 - fy * h));
      if (w > r.width) z.tx = Math.min(8, Math.max(r.width - w - 8, r.width / 2 - fx * w));
      z.apply(false);
    };
    z.zoomAt = (f, cx, cy) => {
      const ns = Math.min(5, Math.max(.06, z.s * f));
      z.tx = cx - (cx - z.tx) * ns / z.s; z.ty = cy - (cy - z.ty) * ns / z.s; z.s = ns; z.apply(false);
    };
    z.center = () => { const r = vp.getBoundingClientRect(); return [r.width / 2, r.height / 2]; };
    z.focusBox = b => {            /* b: {x,y,w,h} as fractions, x/y = centre */
      const r = vp.getBoundingClientRect();
      const bw = Math.max(b.w * z.W, 140), bh = Math.max(b.h * z.H, 90);
      z.s = Math.min(2.5, Math.max(.25, Math.min(r.width / (bw * 2.4), r.height / (bh * 3))));
      z.tx = r.width / 2 - b.x * z.W * z.s; z.ty = r.height / 2 - b.y * z.H * z.s; z.apply(true);
    };
    const pts = new Map(); let last = null, pinch = null;
    vp.addEventListener("pointerdown", e => {
      if (e.button !== 0 || e.target.closest("button, input, a, select")) return;
      vp.setPointerCapture(e.pointerId); pts.set(e.pointerId, [e.clientX, e.clientY]); vp.classList.add("dragging"); last = [e.clientX, e.clientY];
      if (opts.onDrag && pts.size === 1) opts.onDrag(e, z);
    });
    vp.addEventListener("pointermove", e => {
      if (!pts.has(e.pointerId)) return; pts.set(e.pointerId, [e.clientX, e.clientY]);
      const r = vp.getBoundingClientRect();
      if (pts.size === 2) { const [a, b] = [...pts.values()]; const d = Math.hypot(a[0] - b[0], a[1] - b[1]); if (pinch) z.zoomAt(d / pinch, (a[0] + b[0]) / 2 - r.left, (a[1] + b[1]) / 2 - r.top); pinch = d; return; }
      if (opts.onDrag && opts.onDrag(e, z)) return;
      z.tx += e.clientX - last[0]; z.ty += e.clientY - last[1]; last = [e.clientX, e.clientY]; z.apply(false);
    });
    const up = e => { pts.delete(e.pointerId); if (pts.size < 2) pinch = null; if (!pts.size) vp.classList.remove("dragging"); const p = [...pts.values()][0]; if (p) last = p; };
    vp.addEventListener("pointerup", up); vp.addEventListener("pointercancel", up);
    vp.addEventListener("wheel", e => {
      e.preventDefault(); const r = vp.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey) z.zoomAt(Math.exp(-e.deltaY * .01), e.clientX - r.left, e.clientY - r.top);
      else { z.tx -= e.deltaX; z.ty -= e.deltaY; z.apply(false); }
    }, { passive: false });
    return z;
  }

  return { esc, el, figure, focus, setLayer, copy, api, db, centerOf, drawMarks, flags, timeline, thumb, zoomer, focusOf };
})();

/* Theme switch: Auto follows the viewer's OS/app theme; Light and Dark pin it. The choice is remembered per viewer. */
(() => {
  const KEY = "evidence-theme";
  const root = document.documentElement;
  const icons = {
    auto: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"/><path d="M12 4v16" /></svg>',
    light: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
    dark: '<svg viewBox="0 0 24 24"><path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/></svg>'
  };
  const labels = { auto: "Auto", light: "Light", dark: "Dark" };
  function apply(mode) {
    if (mode === "light" || mode === "dark") root.setAttribute("data-theme", mode); else root.removeAttribute("data-theme");
    document.querySelectorAll(".theme-switch button").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.mode === mode)));
  }
  let saved = "auto";
  try { saved = localStorage.getItem(KEY) || "auto"; } catch { /* storage blocked: stay on Auto */ }
  apply(saved);
  function mount() {
    if (document.querySelector(".theme-switch")) return;
    const box = document.createElement("div");
    box.className = "theme-switch"; box.setAttribute("role", "group"); box.setAttribute("aria-label", "Color theme");
    box.innerHTML = ["auto", "light", "dark"].map(m => `<button type="button" data-mode="${m}" aria-pressed="false" title="${labels[m]} theme">${icons[m]}<span>${labels[m]}</span></button>`).join("");
    box.addEventListener("click", e => {
      const b = e.target.closest("button"); if (!b) return;
      apply(b.dataset.mode);
      try { localStorage.setItem(KEY, b.dataset.mode); } catch { /* not persisted, still applied */ }
    });
    document.body.appendChild(box);
    apply(saved);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount); else mount();
})();
