/**
 * @fileoverview The evidence page builder (ADR-0021).
 *
 * Order matters, each gate is fail-closed:
 *   1. parse + validate the pack (every error names its JSON path)
 *   2. refuse secrets anywhere in it (path + rule, never the value)
 *   3. resolve every image INSIDE the pack's folder; refuse `.auth`, HAR,
 *      trace, state files, and anything that is not PNG/JPEG by its bytes
 *   4. check every redaction and mark lies inside its image
 *   5. burn redactions into the pixels (PNG only; a JPEG redaction is refused)
 *   6. render ONE self-contained page and check its byte size against the limit
 *   7. optionally write the bug thumbnail (redactions burned, marks drawn)
 */

import type { Mark, Pack, Point, Size } from './pack.ts';
import type { RgbaImage } from './png.ts';
import type { Rgba } from './raster.ts';
import type { InlineImage } from './render.ts';

import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { checkGeometry, pointToFraction, toFraction, validatePack } from './pack.ts';
import { decodePng, encodePng, ImageFormatError, imageSize, sniffImageType } from './png.ts';
import { downscale, drawArrow, drawPolyline, fillRect, strokeEllipse, strokeRect } from './raster.ts';
import { renderPage } from './render.ts';
import { describeRefusal, describeWarning, scanSecrets } from './secrets.ts';

export const MB = 1024 * 1024;
export const DEFAULT_MAX_MB = 14;
/** The hosted-artifact page limit; `--max-mb` cannot exceed it. */
export const HARD_MAX_MB = 16;
export const THUMB_MAX_WIDTH = 1200;

export interface BuildOptions {
  packPath: string
  /** Default: `<pack dir>/evidence-page/` (story) or `<pack dir>/evidence-page/<BUG>/` (bug). */
  outDir?: string
  thumb?: boolean
  maxMb?: number
  ticketKeyPattern?: RegExp
  now?: Date
}

export type BuildResult
  = | { ok: true, pack: Pack, pagePath: string, thumbPath: string | null, bytes: number, warnings: string[] }
    | { ok: false, errors: string[], warnings: string[] };

const ALLOWED_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg']);

export function defaultOutDir(packPath: string, pack: Pick<Pack, 'kind' | 'ticket'>): string {
  const base = join(dirname(resolve(packPath)), 'evidence-page');
  return pack.kind === 'bug' ? join(base, pack.ticket.id) : base;
}

export function defaultThumbPath(packPath: string, pack: Pick<Pack, 'ticket'>): string {
  return join(dirname(resolve(packPath)), `${pack.ticket.id}-thumbnail.png`);
}

/** The image file, resolved and confined to the pack's folder, or the reason it is refused. */
export function resolveImagePath(packDir: string, file: string): { path: string } | { error: string } {
  if (isAbsolute(file)) {
    return { error: 'must be a path relative to the pack folder' };
  }
  const segments = file.split(/[\\/]/);
  if (segments.some(s => s === '.auth' || s.startsWith('.auth'))) {
    return { error: 'points into an .auth folder; session state never goes on a page' };
  }
  const ext = extname(file).toLowerCase();
  if (ext === '.har' || ext === '.zip' || ext === '.json' || ext === '.trace' || file.toLowerCase().includes('trace')) {
    return { error: 'is a HAR, trace or state file; those never go on a page (attach a screenshot instead)' };
  }
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    return { error: 'must be a .png, .jpg or .jpeg screenshot' };
  }
  const joined = resolve(packDir, file);
  if (!existsSync(joined)) {
    return { error: `file not found (${relative(process.cwd(), joined) || joined})` };
  }
  const real = realpathSync(joined);
  const root = realpathSync(packDir);
  if (real !== root && !real.startsWith(root + sep)) {
    return { error: 'resolves outside the pack folder' };
  }
  return { path: real };
}

const TONE_RGBA: Record<string, Rgba> = {
  defect: [229, 72, 77, 255],
  ok: [48, 164, 108, 255],
  note: [62, 99, 221, 255],
};

function drawMark(image: RgbaImage, mark: Mark, size: Size, scale: number): void {
  const color = TONE_RGBA[mark.tone ?? 'defect'];
  const thickness = 4;
  const px = (p: Point): Point => {
    const f = pointToFraction(p, mark.coords, size);
    return [f[0] * size.width * scale, f[1] * size.height * scale];
  };
  if (mark.shape === 'arrow') {
    drawArrow(image, px(mark.from as Point), px(mark.to as Point), color, thickness);
    return;
  }
  if (mark.shape === 'path') {
    drawPolyline(image, (mark.points as Point[]).map(px), color, thickness);
    return;
  }
  const f = toFraction({ x: mark.x as number, y: mark.y as number, w: mark.w as number, h: mark.h as number, coords: mark.coords }, size);
  const [x, y, w, h] = [f.x * image.width, f.y * image.height, f.w * image.width, f.h * image.height];
  if (mark.shape === 'ellipse') {
    strokeEllipse(image, x, y, w, h, color, thickness);
  }
  else {
    strokeRect(image, x, y, w, h, color, thickness);
  }
}

interface LoadedImage extends Size {
  type: 'png' | 'jpeg'
  bytes: Uint8Array
  /** Decoded with redactions burned; PNG only. */
  pixels: RgbaImage | null
}

/** The image a bug thumbnail shows: `bug.thumbnail`, else the first image of the first FAILED case. */
function thumbnailSource(pack: Pack): { key: string, marks: Mark[] } | null {
  const failed = pack.cases.find(c => c.status === 'FAILED') ?? pack.cases[0];
  const items = pack.cases.flatMap(c => c.evidence ?? []).filter(i => i.type === 'image');
  if (pack.bug?.thumbnail !== undefined) {
    const item = items.find(i => i.type === 'image' && i.image === pack.bug?.thumbnail);
    return { key: pack.bug.thumbnail, marks: item?.type === 'image' ? item.marks ?? [] : [] };
  }
  const first = (failed?.evidence ?? []).find(i => i.type === 'image');
  return first?.type === 'image' ? { key: first.image, marks: first.marks ?? [] } : null;
}

export function buildEvidencePage(options: BuildOptions): BuildResult {
  const warnings: string[] = [];
  const maxMb = options.maxMb ?? DEFAULT_MAX_MB;
  if (!(maxMb > 0 && maxMb <= HARD_MAX_MB)) {
    return { ok: false, errors: [`--max-mb must be between 0 and ${HARD_MAX_MB} (the hosted page limit)`], warnings };
  }

  // 1. parse + validate
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(options.packPath, 'utf8'));
  }
  catch (err) {
    return { ok: false, errors: [`${options.packPath}: cannot read the pack (${(err as Error).message})`], warnings };
  }
  const validation = validatePack(raw, { ticketKeyPattern: options.ticketKeyPattern });
  warnings.push(...validation.warnings);
  if (!validation.ok) {
    return { ok: false, errors: validation.errors, warnings };
  }
  const pack = validation.pack;

  // 2. secrets
  const scan = scanSecrets(pack);
  warnings.push(...scan.warnings.map(describeWarning));
  if (scan.refusals.length > 0) {
    return { ok: false, errors: scan.refusals.map(describeRefusal), warnings };
  }

  // 3. images
  const packDir = dirname(resolve(options.packPath));
  const errors: string[] = [];
  const loaded: Record<string, LoadedImage> = {};
  for (const [key, decl] of Object.entries(pack.images ?? {})) {
    const resolved = resolveImagePath(packDir, decl.file);
    if ('error' in resolved) {
      errors.push(`images.${key}.file: ${resolved.error}`);
      continue;
    }
    const bytes = new Uint8Array(readFileSync(resolved.path));
    const type = sniffImageType(bytes);
    if (type === null) {
      errors.push(`images.${key}.file: is not a PNG or JPEG file (checked by its first bytes)`);
      continue;
    }
    try {
      const size = imageSize(bytes);
      loaded[key] = { type, bytes, width: size.width, height: size.height, pixels: null };
    }
    catch (err) {
      errors.push(`images.${key}.file: ${(err as Error).message}`);
    }
  }
  if (errors.length > 0) {
    return { ok: false, errors, warnings };
  }

  // 4. geometry
  const geometry = checkGeometry(pack, loaded);
  if (geometry.length > 0) {
    return { ok: false, errors: geometry, warnings };
  }

  // 5. burn redactions
  const inline: Record<string, InlineImage> = {};
  for (const [key, image] of Object.entries(loaded)) {
    const redactions = pack.images?.[key]?.redact ?? [];
    const needsPixels = redactions.length > 0 || (options.thumb === true && pack.kind === 'bug');
    if (image.type === 'jpeg') {
      if (redactions.length > 0) {
        errors.push(`images.${key}.redact: a JPEG cannot take a burned redaction; capture the screenshot as PNG`);
        continue;
      }
      inline[key] = { width: image.width, height: image.height, dataUri: `data:image/jpeg;base64,${Buffer.from(image.bytes).toString('base64')}` };
      continue;
    }
    let bytes = image.bytes;
    if (needsPixels) {
      try {
        const pixels = decodePng(image.bytes);
        for (const box of redactions) {
          const f = toFraction(box, image);
          fillRect(pixels, f.x * image.width, f.y * image.height, f.w * image.width, f.h * image.height);
        }
        image.pixels = pixels;
        if (redactions.length > 0) {
          bytes = encodePng(pixels);
        }
      }
      catch (err) {
        if (err instanceof ImageFormatError) {
          errors.push(`images.${key}.file: ${err.message}`);
          continue;
        }
        throw err;
      }
    }
    inline[key] = { width: image.width, height: image.height, dataUri: `data:image/png;base64,${Buffer.from(bytes).toString('base64')}` };
  }
  if (errors.length > 0) {
    return { ok: false, errors, warnings };
  }

  // 6. render + size guard
  const html = renderPage(pack, inline, { generatedAt: (options.now ?? new Date()).toISOString() });
  const bytes = Buffer.byteLength(html, 'utf8');
  if (bytes > maxMb * MB) {
    const largest = Object.entries(inline)
      .sort((a, b) => b[1].dataUri.length - a[1].dataUri.length)
      .slice(0, 3)
      .map(([key, img]) => `${key} (${(img.dataUri.length / MB).toFixed(1)} MB inlined)`);
    return {
      ok: false,
      errors: [`the page is ${(bytes / MB).toFixed(1)} MB, over the ${maxMb} MB limit. Largest images: ${largest.join(', ')}. Crop them to the element that proves the case, or split the pack`],
      warnings,
    };
  }

  const outDir = options.outDir ?? defaultOutDir(options.packPath, pack);
  mkdirSync(outDir, { recursive: true });
  const pagePath = join(outDir, 'index.html');
  writeFileSync(pagePath, html);

  // 7. thumbnail (bug only)
  let thumbPath: string | null = null;
  if (options.thumb === true) {
    if (pack.kind !== 'bug') {
      warnings.push('--thumb applies to a bug pack only; no thumbnail written');
    }
    else {
      const source = thumbnailSource(pack);
      const image = source ? loaded[source.key] : undefined;
      if (source === null || image === undefined) {
        warnings.push('no image to make a thumbnail from (set bug.thumbnail or add an image to the FAILED case)');
      }
      else if (image.pixels === null) {
        warnings.push(`images.${source.key} is a JPEG; a thumbnail needs a PNG, none written`);
      }
      else {
        const small = downscale(image.pixels, THUMB_MAX_WIDTH);
        const scale = small.width / image.width;
        for (const mark of source.marks) {
          drawMark(small, mark, image, scale);
        }
        thumbPath = defaultThumbPath(options.packPath, pack);
        writeFileSync(thumbPath, encodePng(small));
      }
    }
  }

  return { ok: true, pack, pagePath, thumbPath, bytes, warnings };
}
