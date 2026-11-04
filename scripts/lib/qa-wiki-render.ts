/**
 * qa-wiki-render.ts — a small Markdown renderer for the local QA wiki preview
 * (`bun run qa:wiki:serve`). It is NOT a CommonMark engine: it handles the subset
 * the generated pages use (headings, paragraphs, lists, GFM tables, fenced code,
 * blockquotes, rules, inline code/bold/italic/links/images) and nothing else.
 *
 * Safety by construction:
 *   - Every piece of text is HTML-escaped. Raw HTML in a page is shown as text,
 *     never rendered, so a bug report cannot inject markup or script.
 *   - Link targets are limited to http, https, mailto, in-page anchors and
 *     relative paths that stay inside the wiki; images only to relative paths.
 *     Anything else (`javascript:`, `data:`, `//host`, `../` escapes) loses its
 *     link and keeps its text.
 *   - ` ```mermaid ` `pie` blocks are drawn as inline SVG here, offline. Other
 *     Mermaid types are shown as source with a note: Azure DevOps draws those.
 * The published Markdown never passes through this file; it only feeds the preview.
 */

import { posix } from 'node:path';

export interface RenderOptions {
  /** Wiki-relative path of the page being rendered (for example `Bugs/X.md`); relative targets resolve against its folder. */
  page: string
}

export interface PieData { title: string, slices: [string, number][] }

const PALETTE = ['#2563eb', '#16a34a', '#d97706', '#dc2626', '#7c3aed', '#0891b2', '#db2777', '#65a30d'];
const SAFE_SCHEME = /^(?:https?|mailto):/i;
const ANY_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' })[ch] ?? ch);
}

// ============================================
// Link and image targets
// ============================================

/** Preview route for a link/image target, or null when it must not become a link. */
function resolveTarget(raw: string, page: string, allowExternal: boolean): string | null {
  const target = raw.trim();
  if (target === '' || target.includes('\0')) { return null; }
  if (ANY_SCHEME.test(target)) { return allowExternal && SAFE_SCHEME.test(target) ? target : null; }
  if (target.startsWith('//') || target.startsWith('\\')) { return null; }
  if (target.startsWith('#')) { return allowExternal ? target : null; }
  const cut = target.search(/[?#]/);
  const path = cut < 0 ? target : target.slice(0, cut);
  const tail = cut < 0 ? '' : target.slice(cut);
  let decoded: string;
  try { decoded = decodeURIComponent(path); }
  catch { return null; }
  const joined = posix.normalize(decoded.startsWith('/') ? decoded.slice(1) : posix.join(posix.dirname(page), decoded));
  if (joined === '.' || joined === '..' || joined.startsWith('../')) { return null; }
  return `/${joined.split('/').map(encodeURIComponent).join('/')}${tail}`;
}

// ============================================
// Inline
// ============================================

const INLINE_SOURCE = String.raw`\x60([^\x60\n]+)\x60|!\[([^\]\n]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)|\[([^\]\n]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)|\*\*([^\n]+?)\*\*|__([^\n]+?)__|\*([^\s*][^\n]*?)\*|\b_([^\s_][^\n]*?)_\b`;

function inline(text: string, opts: RenderOptions): string {
  const re = new RegExp(INLINE_SOURCE, 'g');
  let html = '';
  let last = 0;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    html += escapeHtml(text.slice(last, m.index));
    last = m.index + m[0].length;
    if (m[1] !== undefined) { html += `<code>${escapeHtml(m[1])}</code>`; }
    else if (m[3] !== undefined) {
      const src = resolveTarget(m[3], opts.page, false);
      html += src === null ? `<span class="img-missing">[imagen: ${escapeHtml(m[2])}]</span>` : `<img src="${escapeHtml(src)}" alt="${escapeHtml(m[2])}">`;
    }
    else if (m[5] !== undefined) {
      const href = resolveTarget(m[5], opts.page, true);
      html += href === null ? inline(m[4], opts) : `<a href="${escapeHtml(href)}">${inline(m[4], opts)}</a>`;
    }
    else if (m[6] !== undefined || m[7] !== undefined) { html += `<strong>${inline(m[6] ?? m[7], opts)}</strong>`; }
    else { html += `<em>${inline(m[8] ?? m[9], opts)}</em>`; }
  }
  return html + escapeHtml(text.slice(last));
}

// ============================================
// Mermaid pie as SVG
// ============================================

/** Parse a Mermaid `pie` source; null when it is not a pie or holds no valid slice. */
export function parsePie(source: string): PieData | null {
  const lines = source.split(/\r?\n/).map(line => line.trim()).filter(line => line !== '' && !line.startsWith('%%'));
  const first = lines[0] ?? '';
  if (!/^pie(?:\s|$)/i.test(first)) { return null; }
  const titleAt = first.search(/\btitle\b/i);
  const title = titleAt < 0 ? '' : first.slice(titleAt + 'title'.length).trim();
  const slices: [string, number][] = [];
  for (const line of lines.slice(1)) {
    const colon = line.lastIndexOf(':');
    const amount = line.slice(colon + 1).trim();
    if (colon > 0 && /^\d+(?:\.\d+)?$/.test(amount) && Number(amount) > 0) { slices.push([line.slice(0, colon).trim().replace(/^"|"$/g, ''), Number(amount)]); }
  }
  return slices.length > 0 ? { title, slices } : null;
}

const fix = (n: number): string => n.toFixed(2);

/** Inline SVG pie chart with a legend. Deterministic: same input, same bytes. */
export function renderPieSvg(title: string, slices: [string, number][]): string {
  const total = slices.reduce((sum, [, n]) => sum + n, 0);
  const cx = 100;
  const cy = 110;
  const r = 80;
  const height = Math.max(220, 50 + slices.length * 22);
  const parts: string[] = [];
  let angle = -Math.PI / 2;
  slices.forEach(([label, n], index) => {
    const fill = PALETTE[index % PALETTE.length];
    const tip = `<title>${escapeHtml(label)}: ${n}</title>`;
    if (n === total) { parts.push(`<circle cx="${cx}" cy="${cy}" r="${r}" fill="${fill}">${tip}</circle>`); }
    else {
      const next = angle + (n / total) * 2 * Math.PI;
      const large = next - angle > Math.PI ? 1 : 0;
      const d = `M${cx} ${cy} L${fix(cx + r * Math.cos(angle))} ${fix(cy + r * Math.sin(angle))} A${r} ${r} 0 ${large} 1 ${fix(cx + r * Math.cos(next))} ${fix(cy + r * Math.sin(next))} Z`;
      parts.push(`<path d="${d}" fill="${fill}">${tip}</path>`);
      angle = next;
    }
  });
  slices.forEach(([label, n], index) => {
    const y = 56 + index * 22;
    parts.push(`<rect x="210" y="${y - 11}" width="12" height="12" fill="${PALETTE[index % PALETTE.length]}"/>`);
    parts.push(`<text x="230" y="${y}" font-size="13" fill="currentColor">${escapeHtml(label)} (${n}, ${Math.round((n / total) * 100)}%)</text>`);
  });
  return [
    `<svg class="pie" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 520 ${height}" width="520" height="${height}" role="img" aria-label="${escapeHtml(title)}">`,
    `<text x="10" y="22" font-size="15" font-weight="bold" fill="currentColor">${escapeHtml(title)}</text>`,
    ...parts,
    '</svg>',
  ].join('');
}

function fenced(lang: string, code: string): string {
  if (lang.toLowerCase() === 'mermaid') {
    const pie = parsePie(code);
    if (pie !== null) { return `<figure class="chart">${renderPieSvg(pie.title, pie.slices)}</figure>`; }
    return `<pre><code class="language-mermaid">${escapeHtml(code)}</code></pre>\n<p class="note">Diagrama Mermaid: la vista previa local solo dibuja gráficos de torta; Azure DevOps lo dibuja al publicar.</p>`;
  }
  const cls = /^[\w-]+$/.test(lang) ? ` class="language-${lang}"` : '';
  return `<pre><code${cls}>${escapeHtml(code)}</code></pre>`;
}

// ============================================
// Blocks
// ============================================

const QUOTE = /^ {0,3}> ?(.*)$/;
const ITEM = /^( *)([-*+]|\d{1,9}[.)]) (.*)$/;

/** Opening code fence: its mark (three or more backticks or tildes) and language word, or null. */
function fenceOf(line: string): { mark: string, lang: string } | null {
  const text = line.trimStart();
  if (line.length - text.length > 3 || (text[0] !== '`' && text[0] !== '~')) { return null; }
  let length = 0;
  while (text[length] === text[0]) { length++; }
  const rest = text.slice(length);
  if (length < 3 || (text[0] === '`' && rest.includes('`'))) { return null; }
  return { mark: text.slice(0, length), lang: rest.trim().split(/\s/)[0] };
}

function headingOf(line: string): { level: number, text: string } | null {
  const m = /^ {0,3}(#{1,6})(?:[ \t](.*))?$/.exec(line);
  return m === null ? null : { level: m[1].length, text: (m[2] ?? '').trim().replace(/ #+$/, '') };
}

const isRule = (line: string): boolean => /^(?:-{3,}|\*{3,}|_{3,})$/.test(line.trim().replace(/[ \t]/g, '')) && line.length - line.trimStart().length <= 3;

/** Table delimiter row, for example `| --- | :-: |`. */
function isTableSep(line: string): boolean {
  if (!line.includes('|') || !line.includes('-')) { return false; }
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').every(cell => /^:?-+:?$/.test(cell.trim()));
}

const splitRow = (line: string): string[] => (
  line.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '').split(/(?<!\\)\|/).map(c => c.trim().replace(/\\\|/g, '|'))
);

const startsBlock = (line: string, next: string | undefined): boolean => (
  fenceOf(line) !== null || headingOf(line) !== null || isRule(line) || QUOTE.test(line) || ITEM.test(line)
  || (line.includes('|') && next !== undefined && isTableSep(next))
);

function renderTable(lines: string[], opts: RenderOptions): string {
  const head = splitRow(lines[0]);
  const rows = lines.slice(2).map(splitRow);
  const th = head.map(c => `<th>${inline(c, opts)}</th>`).join('');
  const body = rows.map(row => `<tr>${head.map((_, i) => `<td>${inline(row[i] ?? '', opts)}</td>`).join('')}</tr>`).join('');
  return `<table><thead><tr>${th}</tr></thead><tbody>${body}</tbody></table>`;
}

function renderList(lines: string[], opts: RenderOptions): string {
  const first = ITEM.exec(lines[0]) as RegExpExecArray;
  const indent = first[1].length;
  const ordered = /\d/.test(first[2]);
  const items: string[][] = [];
  for (const line of lines) {
    const m = ITEM.exec(line);
    if (m !== null && m[1].length === indent && /\d/.test(m[2]) === ordered) { items.push([m[3].trim()]); }
    else { items[items.length - 1].push(line.slice(Math.min(line.length - line.trimStart().length, indent + 2))); }
  }
  const tag = ordered ? 'ol' : 'ul';
  const lis = items.map((item) => {
    const html = blocks(item, opts);
    return `<li>${html.replace(/^<p>((?:(?!<\/p>)[\s\S])*)<\/p>(?=\n|$)/, '$1')}</li>`;
  });
  return `<${tag}>${lis.join('')}</${tag}>`;
}

function blocks(lines: string[], opts: RenderOptions): string {
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '') { i++; continue; }
    const fence = fenceOf(line);
    if (fence !== null) {
      const mark = fence.mark;
      const code: string[] = [];
      for (i++; i < lines.length && !(lines[i].trim().startsWith(mark) && lines[i].trim().replace(new RegExp(`^${mark[0]}+`), '') === ''); i++) { code.push(lines[i]); }
      i++;
      out.push(fenced(fence.lang, code.join('\n')));
      continue;
    }
    const heading = headingOf(line);
    if (heading !== null) { out.push(`<h${heading.level}>${inline(heading.text, opts)}</h${heading.level}>`); i++; continue; }
    if (isRule(line)) { out.push('<hr>'); i++; continue; }
    if (QUOTE.test(line)) {
      const quoted: string[] = [];
      for (; i < lines.length && QUOTE.test(lines[i]); i++) { quoted.push((QUOTE.exec(lines[i]) as RegExpExecArray)[1]); }
      out.push(`<blockquote>${blocks(quoted, opts)}</blockquote>`);
      continue;
    }
    if (line.includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const start = i;
      for (i += 2; i < lines.length && lines[i].trim() !== '' && lines[i].includes('|'); i++) { /* collect rows */ }
      out.push(renderTable(lines.slice(start, i), opts));
      continue;
    }
    if (ITEM.test(line)) {
      const start = i;
      const head = ITEM.exec(line) as RegExpExecArray;
      const indent = head[1].length;
      const ordered = /\d/.test(head[2]);
      // A line stays in the list when it is a sibling of the same kind or is indented deeper.
      const continues = (text: string): boolean => {
        const m = ITEM.exec(text);
        if (m === null) { return text.startsWith(' '.repeat(indent + 1)); }
        return m[1].length > indent || (m[1].length === indent && /\d/.test(m[2]) === ordered);
      };
      for (i++; i < lines.length; i++) {
        const cur = lines[i];
        if (cur.trim() === '') {
          const after = lines.slice(i + 1).find(l => l.trim() !== '');
          if (after === undefined || !continues(after)) { break; }
          continue;
        }
        if (!continues(cur)) { break; }
      }
      out.push(renderList(lines.slice(start, i).filter(l => l.trim() !== ''), opts));
      continue;
    }
    const para: string[] = [line.trim()];
    for (i++; i < lines.length && lines[i].trim() !== '' && !startsBlock(lines[i], lines[i + 1]); i++) { para.push(lines[i].trim()); }
    out.push(`<p>${inline(para.join(' '), opts)}</p>`);
  }
  return out.join('\n');
}

/** Render a page body to an HTML fragment. All text is escaped; see the file header. */
export function renderMarkdown(markdown: string, opts: RenderOptions): string {
  return blocks(markdown.replace(/\r\n?/g, '\n').split('\n'), opts);
}
