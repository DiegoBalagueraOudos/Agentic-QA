/**
 * The page's brand slot, filled from `board.brand` (`.agents/project.yaml`): the logo file inlined
 * (an SVG as markup so both themes can color it, a PNG as a data URI), or the brand name as text
 * when no logo is set. The page and every snapshot carry the same header. Server side only.
 */
import { existsSync, readFileSync } from 'node:fs';
import { extname, isAbsolute, join } from 'node:path';
import { boardConfig, CODE_ROOT } from './sync.ts';

export const BRAND_SLOT = '<!--BRAND_LOGO-->';
const NAME_SLOT = '__BRAND_NAME__';

const esc = (v: string) => v.replace(/[&<>"]/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[m]!);

export interface Brand { name: string, logo: string | null }

/** The configured brand; an unreadable config means the text brand "Sprint Board". */
export function brand(): Brand {
  try {
    const c = boardConfig();
    return { name: c.brand.name ?? 'Sprint Board', logo: c.brand.logo };
  }
  catch {
    return { name: 'Sprint Board', logo: null };
  }
}

/** The markup for the slot: a full logo and a rail mark, the pair the page's CSS switches between. */
export function brandMarkup(b: Brand, root = CODE_ROOT): string {
  const file = b.logo ? (isAbsolute(b.logo) ? b.logo : join(root, b.logo)) : null;
  if (file && existsSync(file)) {
    const ext = extname(file).toLowerCase();
    if (ext === '.svg') {
      const svg = readFileSync(file, 'utf8').replace(/<\?xml[\s\S]*?\?>/, '').replace(/<!--[\s\S]*?-->/g, '').trim();
      // Scripts and event handlers never reach the page, whoever wrote the file.
      const clean = svg.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/\son\w+\s*=\s*(?:"[^"]*"|'[^']*')/gi, '');
      // Its own class attribute, if any, is folded into ours: two class attributes would drop one.
      const own = /^<svg\b[^>]*?\sclass="([^"]*)"/i.exec(clean)?.[1];
      const bare = own === undefined ? clean : clean.replace(/^(<svg\b[^>]*?)\sclass="[^"]*"/i, '$1');
      return ['logo-full', 'logo-mark'].map(c => bare.replace(/^<svg\b/i, `<svg class="${own ? `${c} ${own}` : c}" focusable="false"`)).join('');
    }
    if (ext === '.png') {
      const src = `data:image/png;base64,${readFileSync(file).toString('base64')}`;
      return `<img class="logo-full logo-img" src="${src}" alt="" /><img class="logo-mark logo-img" src="${src}" alt="" />`;
    }
  }
  if (file && !existsSync(file)) { console.warn(`sprint-board: board.brand.logo ${b.logo} not found, showing the brand name`); }
  const name = b.name.trim() || 'Sprint Board';
  return `<span class="logo-full logo-text">${esc(name)}</span><span class="logo-mark logo-text">${esc(name.slice(0, 1).toUpperCase())}</span>`;
}

/** `index.html` with its brand slot and label filled. */
export function brandHtml(html: string, b: Brand = brand()): string {
  return html.replace(BRAND_SLOT, brandMarkup(b)).replaceAll(NAME_SLOT, esc(b.name));
}
