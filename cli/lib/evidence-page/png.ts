/**
 * @fileoverview Zero-dependency PNG codec on `node:zlib` (ADR-0021).
 *
 * Why not a package: `bun sync` appends upstream scripts and devDependencies to
 * a consumer project but never installs them, so a synced `cli/` module that
 * imported a new package would break downstream until someone ran `bun
 * install`. Screenshots from Chromium (playwright-cli, Playwright) are 8-bit,
 * non-interlaced PNGs, which is what this decodes; anything else fails with a
 * named error instead of a wrong image.
 *
 * JPEG is never decoded: its size is read from the SOF marker and the bytes
 * are inlined as they are, so a JPEG cannot take a burned redaction.
 */

import { deflateSync, inflateSync } from 'node:zlib';

export interface RgbaImage {
  width: number
  height: number
  /** RGBA, 4 bytes per pixel, row-major. */
  data: Uint8Array
}

export type ImageType = 'png' | 'jpeg';

export class ImageFormatError extends Error {}

const PNG_SIGNATURE = Uint8Array.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

export function sniffImageType(bytes: Uint8Array): ImageType | null {
  if (bytes.length >= 8 && PNG_SIGNATURE.every((b, i) => bytes[i] === b)) {
    return 'png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) {
    return 'jpeg';
  }
  return null;
}

// ============================================================================
// CRC32 (PNG chunk checksum). A table, not `zlib.crc32`, which older runtimes lack.
// ============================================================================

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xFFFFFFFF;
  for (const byte of bytes) {
    c = CRC_TABLE[(c ^ byte) & 0xFF] ^ (c >>> 8);
  }
  return (c ^ 0xFFFFFFFF) >>> 0;
}

// ============================================================================
// SIZE READERS
// ============================================================================

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

export function pngSize(bytes: Uint8Array): { width: number, height: number } {
  if (sniffImageType(bytes) !== 'png' || bytes.length < 24) {
    throw new ImageFormatError('not a PNG file');
  }
  const dv = view(bytes);
  return { width: dv.getUint32(16), height: dv.getUint32(20) };
}

/** Width and height from the first SOF marker (baseline, progressive, lossless). */
export function jpegSize(bytes: Uint8Array): { width: number, height: number } {
  if (sniffImageType(bytes) !== 'jpeg') {
    throw new ImageFormatError('not a JPEG file');
  }
  const dv = view(bytes);
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xFF) {
      offset++;
      continue;
    }
    const marker = bytes[offset + 1];
    if (marker === 0xFF) {
      offset++;
      continue;
    }
    // Standalone markers carry no length
    if (marker === 0xD8 || marker === 0x01 || (marker >= 0xD0 && marker <= 0xD7)) {
      offset += 2;
      continue;
    }
    const length = dv.getUint16(offset + 2);
    const isSof = marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC;
    if (isSof) {
      return { height: dv.getUint16(offset + 5), width: dv.getUint16(offset + 7) };
    }
    offset += 2 + length;
  }
  throw new ImageFormatError('JPEG has no SOF marker');
}

export function imageSize(bytes: Uint8Array): { type: ImageType, width: number, height: number } {
  const type = sniffImageType(bytes);
  if (type === 'png') {
    return { type, ...pngSize(bytes) };
  }
  if (type === 'jpeg') {
    return { type, ...jpegSize(bytes) };
  }
  throw new ImageFormatError('not a PNG or JPEG file (checked by its first bytes)');
}

// ============================================================================
// DECODE
// ============================================================================

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) {
    return a;
  }
  return pb <= pc ? b : c;
}

const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

export function decodePng(bytes: Uint8Array): RgbaImage {
  if (sniffImageType(bytes) !== 'png') {
    throw new ImageFormatError('not a PNG file');
  }
  const dv = view(bytes);
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = -1;
  let interlace = 0;
  let palette: Uint8Array | null = null;
  let transparency: Uint8Array | null = null;
  const idat: Uint8Array[] = [];

  while (offset + 8 <= bytes.length) {
    const length = dv.getUint32(offset);
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    const body = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = dv.getUint32(offset + 8);
      height = dv.getUint32(offset + 12);
      bitDepth = body[8];
      colorType = body[9];
      interlace = body[12];
    }
    else if (type === 'PLTE') {
      palette = body;
    }
    else if (type === 'tRNS') {
      transparency = body;
    }
    else if (type === 'IDAT') {
      // Chromium splits the image data across several IDAT chunks: they form one stream
      idat.push(body);
    }
    else if (type === 'IEND') {
      break;
    }
    offset += 12 + length;
  }

  if (width === 0 || height === 0) {
    throw new ImageFormatError('PNG has no IHDR');
  }
  if (bitDepth !== 8) {
    throw new ImageFormatError(`PNG bit depth ${bitDepth} is not supported (8-bit only; capture the screenshot again with Chromium)`);
  }
  if (interlace !== 0) {
    throw new ImageFormatError('interlaced PNG is not supported (capture the screenshot again with Chromium)');
  }
  const channels = CHANNELS[colorType];
  if (channels === undefined) {
    throw new ImageFormatError(`PNG colour type ${colorType} is not supported`);
  }
  if (colorType === 3 && palette === null) {
    throw new ImageFormatError('palette PNG has no PLTE chunk');
  }

  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  if (raw.length < (stride + 1) * height) {
    throw new ImageFormatError('PNG image data is truncated');
  }

  const pixels = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    for (let x = 0; x < stride; x++) {
      const value = raw[src + x];
      const left = x >= channels ? pixels[dst + x - channels] : 0;
      const up = y > 0 ? pixels[dst - stride + x] : 0;
      const upLeft = y > 0 && x >= channels ? pixels[dst - stride + x - channels] : 0;
      let out: number;
      switch (filter) {
        case 0: out = value; break;
        case 1: out = value + left; break;
        case 2: out = value + up; break;
        case 3: out = value + ((left + up) >> 1); break;
        case 4: out = value + paeth(left, up, upLeft); break;
        default: throw new ImageFormatError(`PNG row ${y} has an unknown filter type ${filter}`);
      }
      pixels[dst + x] = out & 0xFF;
    }
  }

  const data = new Uint8Array(width * height * 4);
  for (let i = 0, p = 0; i < width * height; i++, p += channels) {
    const o = i * 4;
    switch (colorType) {
      case 0:
        data[o] = data[o + 1] = data[o + 2] = pixels[p];
        data[o + 3] = 255;
        break;
      case 2:
        data[o] = pixels[p];
        data[o + 1] = pixels[p + 1];
        data[o + 2] = pixels[p + 2];
        data[o + 3] = 255;
        break;
      case 3: {
        const index = pixels[p];
        const pal = palette as Uint8Array;
        data[o] = pal[index * 3];
        data[o + 1] = pal[index * 3 + 1];
        data[o + 2] = pal[index * 3 + 2];
        data[o + 3] = transparency !== null && index < transparency.length ? transparency[index] : 255;
        break;
      }
      case 4:
        data[o] = data[o + 1] = data[o + 2] = pixels[p];
        data[o + 3] = pixels[p + 1];
        break;
      default:
        data[o] = pixels[p];
        data[o + 1] = pixels[p + 1];
        data[o + 2] = pixels[p + 2];
        data[o + 3] = pixels[p + 3];
    }
  }
  return { width, height, data };
}

// ============================================================================
// ENCODE (RGBA 8-bit, adaptive per-row filter)
// ============================================================================

function chunk(type: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + body.length);
  const dv = view(out);
  dv.setUint32(0, body.length);
  for (let i = 0; i < 4; i++) {
    out[4 + i] = type.charCodeAt(i);
  }
  out.set(body, 8);
  dv.setUint32(8 + body.length, crc32(out.subarray(4, 8 + body.length)));
  return out;
}

export function encodePng(image: RgbaImage): Uint8Array {
  const { width, height, data } = image;
  if (data.length !== width * height * 4) {
    throw new ImageFormatError(`RGBA buffer is ${data.length} bytes, expected ${width * height * 4}`);
  }
  const stride = width * 4;
  const raw = new Uint8Array((stride + 1) * height);
  const candidate = new Uint8Array(stride);
  const best = new Uint8Array(stride);

  for (let y = 0; y < height; y++) {
    const row = y * stride;
    let bestScore = Infinity;
    let bestFilter = 0;
    for (let filter = 0; filter <= 4; filter++) {
      let score = 0;
      for (let x = 0; x < stride; x++) {
        const value = data[row + x];
        const left = x >= 4 ? data[row + x - 4] : 0;
        const up = y > 0 ? data[row - stride + x] : 0;
        const upLeft = y > 0 && x >= 4 ? data[row - stride + x - 4] : 0;
        let predicted = 0;
        if (filter === 1) {
          predicted = left;
        }
        else if (filter === 2) {
          predicted = up;
        }
        else if (filter === 3) {
          predicted = (left + up) >> 1;
        }
        else if (filter === 4) {
          predicted = paeth(left, up, upLeft);
        }
        const out = (value - predicted) & 0xFF;
        candidate[x] = out;
        score += out < 128 ? out : 256 - out;
      }
      if (score < bestScore) {
        bestScore = score;
        bestFilter = filter;
        best.set(candidate);
      }
    }
    raw[y * (stride + 1)] = bestFilter;
    raw.set(best, y * (stride + 1) + 1);
  }

  const header = new Uint8Array(13);
  const hv = view(header);
  hv.setUint32(0, width);
  hv.setUint32(4, height);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', new Uint8Array(0)),
  ]);
}
