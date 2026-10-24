import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'bun:test';

import { crc32, decodePng, encodePng, ImageFormatError, imageSize, jpegSize, sniffImageType } from './png.ts';
import { downscale, fillRect, REDACTION_COLOR, strokeRect } from './raster.ts';

const FIXTURES = join(import.meta.dir, 'fixtures');

function pixel(image: { width: number, data: Uint8Array }, x: number, y: number): number[] {
  const o = (y * image.width + x) * 4;
  return [...image.data.subarray(o, o + 4)];
}

function gradient(width: number, height: number) {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      data.set([x % 256, y % 256, (x * y) % 256, 255 - (x % 7)], o);
    }
  }
  return { width, height, data };
}

describe('crc32', () => {
  it('matches the reference value of "IEND"', () => {
    expect(crc32(new TextEncoder().encode('IEND'))).toBe(0xAE426082);
  });
});

describe('decodePng on real Chromium screenshots (synthetic content)', () => {
  it('decodes an RGB screenshot split across several IDAT chunks', () => {
    const bytes = new Uint8Array(readFileSync(join(FIXTURES, 'chromium-rgb.png')));
    const image = decodePng(bytes);
    expect(image).toMatchObject({ width: 240, height: 140 });
    // The header bar is #224466-ish dark blue, opaque
    const [r, g, b, a] = pixel(image, 5, 5);
    expect(a).toBe(255);
    expect(b).toBeGreaterThan(r);
    expect(g).toBeLessThan(128);
  });

  it('decodes an RGBA screenshot with transparency', () => {
    const image = decodePng(new Uint8Array(readFileSync(join(FIXTURES, 'chromium-alpha.png'))));
    expect(pixel(image, 1, 1)[3]).toBe(0);
    const inside = pixel(image, 60, 40);
    expect(inside[3]).toBeGreaterThan(100);
    expect(inside[0]).toBeGreaterThan(inside[2]);
  });

  it('round-trips a Chromium image through our encoder pixel for pixel', () => {
    const original = decodePng(new Uint8Array(readFileSync(join(FIXTURES, 'chromium-rgb.png'))));
    expect(decodePng(encodePng(original)).data).toEqual(original.data);
  });
});

describe('encodePng', () => {
  it('round-trips every filter path on a gradient', () => {
    const image = gradient(97, 53);
    const decoded = decodePng(encodePng(image));
    expect(decoded.width).toBe(97);
    expect(decoded.data).toEqual(image.data);
  });

  it('encodes a full-page sized buffer in reasonable time', () => {
    const image = gradient(1440, 2600);
    const start = performance.now();
    const bytes = encodePng(image);
    expect(performance.now() - start).toBeLessThan(15000);
    expect(imageSize(bytes)).toEqual({ type: 'png', width: 1440, height: 2600 });
  });
});

describe('format guards', () => {
  it('sniffs by magic bytes, not by name', () => {
    expect(sniffImageType(new TextEncoder().encode('GIF89a...'))).toBeNull();
    expect(sniffImageType(Uint8Array.from([0xFF, 0xD8, 0xFF, 0xE0]))).toBe('jpeg');
  });

  it('refuses 16-bit and interlaced PNGs with a named error', () => {
    const header = (depth: number, interlace: number) => {
      const ihdr = new Uint8Array(13);
      const dv = new DataView(ihdr.buffer);
      dv.setUint32(0, 2);
      dv.setUint32(4, 2);
      ihdr[8] = depth;
      ihdr[9] = 6;
      ihdr[12] = interlace;
      const chunk = (type: string, body: Uint8Array) => {
        const out = new Uint8Array(12 + body.length);
        const v = new DataView(out.buffer);
        v.setUint32(0, body.length);
        out.set(new TextEncoder().encode(type), 4);
        out.set(body, 8);
        v.setUint32(8 + body.length, crc32(out.subarray(4, 8 + body.length)));
        return out;
      };
      return Buffer.concat([Uint8Array.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(new Uint8Array(40))), chunk('IEND', new Uint8Array())]);
    };
    expect(() => decodePng(header(16, 0))).toThrow(ImageFormatError);
    expect(() => decodePng(header(8, 1))).toThrow(/interlaced/);
  });

  it('reads JPEG dimensions from the SOF marker', () => {
    // SOI, APP0 (len 16), SOF0 (len 17: precision, height 300, width 500, ...)
    const app0 = [0xFF, 0xE0, 0x00, 0x10, ...Array.from({ length: 14 }).fill(0)] as number[];
    const sof = [0xFF, 0xC0, 0x00, 0x11, 0x08, 0x01, 0x2C, 0x01, 0xF4, 0x03, ...Array.from({ length: 9 }).fill(0)] as number[];
    expect(jpegSize(Uint8Array.from([0xFF, 0xD8, ...app0, ...sof, 0xFF, 0xD9]))).toEqual({ width: 500, height: 300 });
  });
});

describe('raster', () => {
  it('fillRect burns an opaque box, clamped to the image, alpha included', () => {
    const image = { width: 10, height: 10, data: new Uint8Array(400) };
    fillRect(image, 8, 8, 5, 5);
    expect(pixel(image, 9, 9)).toEqual([...REDACTION_COLOR]);
    expect(pixel(image, 7, 7)).toEqual([0, 0, 0, 0]);
  });

  it('downscale keeps the aspect ratio and averages', () => {
    const image = { width: 4, height: 2, data: new Uint8Array(32) };
    fillRect(image, 0, 0, 2, 2, [200, 0, 0, 255]);
    const small = downscale(image, 2);
    expect(small).toMatchObject({ width: 2, height: 1 });
    expect(pixel(small, 0, 0)).toEqual([200, 0, 0, 255]);
    expect(pixel(small, 1, 0)).toEqual([0, 0, 0, 0]);
  });

  it('strokeRect draws the outline and leaves the inside untouched', () => {
    const image = { width: 40, height: 40, data: new Uint8Array(40 * 40 * 4) };
    strokeRect(image, 10, 10, 20, 20, [255, 0, 0, 255], 2);
    expect(pixel(image, 10, 20)[0]).toBe(255);
    expect(pixel(image, 20, 20)[0]).toBe(0);
  });
});
