/**
 * @fileoverview Pixel operations on an RGBA buffer, in plain TypeScript.
 *
 * `fillRect` burns a redaction into the pixels (a mark is drawn over the image
 * on the page and can be removed by anyone who opens the HTML; a redaction
 * cannot). `downscale` and the stroke helpers build the bug thumbnail, the one
 * place where marks become pixels.
 */

import type { RgbaImage } from './png.ts';

export type Rgba = readonly [number, number, number, number];

export const REDACTION_COLOR: Rgba = [17, 17, 17, 255];

/** Opaque fill, clamped to the image. Every channel is overwritten, alpha included. */
export function fillRect(image: RgbaImage, x: number, y: number, w: number, h: number, color: Rgba = REDACTION_COLOR): void {
  const x0 = Math.max(0, Math.floor(x));
  const y0 = Math.max(0, Math.floor(y));
  const x1 = Math.min(image.width, Math.ceil(x + w));
  const y1 = Math.min(image.height, Math.ceil(y + h));
  for (let row = y0; row < y1; row++) {
    for (let col = x0; col < x1; col++) {
      const o = (row * image.width + col) * 4;
      image.data[o] = color[0];
      image.data[o + 1] = color[1];
      image.data[o + 2] = color[2];
      image.data[o + 3] = color[3];
    }
  }
}

/** Area-average downscale to at most `maxWidth` pixels wide; a narrower image is copied unchanged. */
export function downscale(image: RgbaImage, maxWidth: number): RgbaImage {
  if (image.width <= maxWidth) {
    return { width: image.width, height: image.height, data: image.data.slice() };
  }
  const scale = image.width / maxWidth;
  const width = maxWidth;
  const height = Math.max(1, Math.round(image.height / scale));
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const sy0 = Math.floor(y * scale);
    const sy1 = Math.min(image.height, Math.max(sy0 + 1, Math.floor((y + 1) * scale)));
    for (let x = 0; x < width; x++) {
      const sx0 = Math.floor(x * scale);
      const sx1 = Math.min(image.width, Math.max(sx0 + 1, Math.floor((x + 1) * scale)));
      const sum = [0, 0, 0, 0];
      let n = 0;
      for (let sy = sy0; sy < sy1; sy++) {
        for (let sx = sx0; sx < sx1; sx++) {
          const o = (sy * image.width + sx) * 4;
          sum[0] += image.data[o];
          sum[1] += image.data[o + 1];
          sum[2] += image.data[o + 2];
          sum[3] += image.data[o + 3];
          n++;
        }
      }
      const o = (y * width + x) * 4;
      for (let c = 0; c < 4; c++) {
        data[o + c] = Math.round(sum[c] / n);
      }
    }
  }
  return { width, height, data };
}

function blend(image: RgbaImage, x: number, y: number, color: Rgba): void {
  if (x < 0 || y < 0 || x >= image.width || y >= image.height) {
    return;
  }
  const o = (y * image.width + x) * 4;
  const a = color[3] / 255;
  image.data[o] = Math.round(color[0] * a + image.data[o] * (1 - a));
  image.data[o + 1] = Math.round(color[1] * a + image.data[o + 1] * (1 - a));
  image.data[o + 2] = Math.round(color[2] * a + image.data[o + 2] * (1 - a));
  image.data[o + 3] = Math.max(image.data[o + 3], color[3]);
}

/** A thick segment: every pixel within `thickness / 2` of it. */
export function drawLine(image: RgbaImage, ax: number, ay: number, bx: number, by: number, color: Rgba, thickness = 3): void {
  const r = thickness / 2;
  const minX = Math.floor(Math.min(ax, bx) - r);
  const maxX = Math.ceil(Math.max(ax, bx) + r);
  const minY = Math.floor(Math.min(ay, by) - r);
  const maxY = Math.ceil(Math.max(ay, by) + r);
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSq = dx * dx + dy * dy;
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const t = lengthSq === 0 ? 0 : Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / lengthSq));
      const px = ax + t * dx - x;
      const py = ay + t * dy - y;
      if (px * px + py * py <= r * r) {
        blend(image, x, y, color);
      }
    }
  }
}

export function drawPolyline(image: RgbaImage, points: ReadonlyArray<readonly [number, number]>, color: Rgba, thickness = 3): void {
  for (let i = 1; i < points.length; i++) {
    drawLine(image, points[i - 1][0], points[i - 1][1], points[i][0], points[i][1], color, thickness);
  }
}

export function strokeRect(image: RgbaImage, x: number, y: number, w: number, h: number, color: Rgba, thickness = 3): void {
  drawPolyline(image, [[x, y], [x + w, y], [x + w, y + h], [x, y + h], [x, y]], color, thickness);
}

export function strokeEllipse(image: RgbaImage, x: number, y: number, w: number, h: number, color: Rgba, thickness = 3): void {
  const cx = x + w / 2;
  const cy = y + h / 2;
  const points: Array<[number, number]> = [];
  for (let i = 0; i <= 72; i++) {
    const angle = (i / 72) * Math.PI * 2;
    points.push([cx + (w / 2) * Math.cos(angle), cy + (h / 2) * Math.sin(angle)]);
  }
  drawPolyline(image, points, color, thickness);
}

export function drawArrow(image: RgbaImage, from: readonly [number, number], to: readonly [number, number], color: Rgba, thickness = 3): void {
  drawLine(image, from[0], from[1], to[0], to[1], color, thickness);
  const angle = Math.atan2(to[1] - from[1], to[0] - from[0]);
  const head = Math.max(10, thickness * 4);
  for (const side of [-1, 1]) {
    const a = angle + Math.PI - side * (Math.PI / 7);
    drawLine(image, to[0], to[1], to[0] + head * Math.cos(a), to[1] + head * Math.sin(a), color, thickness);
  }
}
