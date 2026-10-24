/** Small DOM + formatting helpers. Every value from data goes through esc(). */

export const esc = (v: unknown): string =>
  String(v ?? '').replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' })[m]!);

export const $ = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector<T>(sel);
export const $$ = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document) => Array.from(root.querySelectorAll<T>(sel));

export function ago(iso: string | undefined, now = Date.now()): string {
  if (!iso) { return ''; }
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) { return `${s}s`; }
  const m = Math.round(s / 60);
  if (m < 60) { return `${m}m`; }
  const h = Math.round(m / 6) / 10;
  if (h < 48) { return `${h}h`; }
  return `${Math.round(h / 24)}d`;
}

export const hhmm = (iso?: string) => (iso ? `${iso.slice(11, 16)}Z` : '');
export const day = (iso?: string) => (iso ? iso.slice(0, 10) : '');
export const pct = (n: number | null | undefined) => (n === null || n === undefined ? '—' : `${Math.round(n * 100)}%`);
export const firstName = (n?: string) => (n ? n.split(/\s+/)[0] : 'Unassigned');
export const initials = (n: string) => n.split(/\s+/).map(p => p[0]).slice(0, 2).join('').toUpperCase();

/** Slack-friendly copy: rich HTML (bullets, bold) plus a plain-text fallback. */
export async function copyRich(plain: string, html?: string): Promise<boolean> {
  try {
    if (html && 'ClipboardItem' in window) {
      await navigator.clipboard.write([new ClipboardItem({
        'text/html': new Blob([html], { type: 'text/html' }),
        'text/plain': new Blob([plain], { type: 'text/plain' }),
      })]);
    }
    else {
      await navigator.clipboard.writeText(plain);
    }
    return true;
  }
  catch {
    const ta = document.createElement('textarea');
    ta.value = plain;
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}

export async function copyImage(src: string): Promise<boolean> {
  try {
    const blob = await (await fetch(src)).blob();
    const png = blob.type === 'image/png' ? blob : await toPng(blob);
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
    return true;
  }
  catch {
    return false;
  }
}

async function toPng(blob: Blob): Promise<Blob> {
  const bmp = await createImageBitmap(blob);
  const c = document.createElement('canvas');
  c.width = bmp.width;
  c.height = bmp.height;
  c.getContext('2d')!.drawImage(bmp, 0, 0);
  return new Promise((res, rej) => c.toBlob(b => (b ? res(b) : rej(new Error('png'))), 'image/png'));
}

/** A draft's text as Slack sees it: lines starting with "- " become bullets, *x* bold. */
export function slackHtml(text: string): string {
  const lines = text.split('\n');
  let html = '';
  let inList = false;
  for (const raw of lines) {
    const line = esc(raw).replace(/\*([^*\n]+)\*/g, '<b>$1</b>').replace(/`([^`\n]+)`/g, '<code>$1</code>');
    if (/^\s*[-•]\s+/.test(raw)) {
      if (!inList) { html += '<ul>'; inList = true; }
      html += `<li>${line.replace(/^\s*[-•]\s+/, '')}</li>`;
    }
    else {
      if (inList) { html += '</ul>'; inList = false; }
      html += raw.trim() ? `<p>${line}</p>` : '';
    }
  }
  if (inList) { html += '</ul>'; }
  return html;
}

export function slackPlain(text: string): string {
  return text.replace(/^\s*-\s+/gm, '• ');
}

let toastTimer = 0;
export function toast(msg: string, action?: { label: string, run: () => void }): void {
  const el = $('#toast')!;
  el.innerHTML = `<span>${esc(msg)}</span>${action ? `<button type="button">${esc(action.label)}</button>` : ''}`;
  el.hidden = false;
  if (action) { el.querySelector('button')!.onclick = () => { el.hidden = true; action.run(); }; }
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (el.hidden = true), action ? 7000 : 2600);
}

export function store<T>(key: string, fallback: T): T {
  try { const v = localStorage.getItem(key); return v === null ? fallback : (JSON.parse(v) as T); }
  catch { return fallback; }
}
export function save(key: string, v: unknown): void {
  try { localStorage.setItem(key, JSON.stringify(v)); }
  catch { /* storage blocked: fine */ }
}
