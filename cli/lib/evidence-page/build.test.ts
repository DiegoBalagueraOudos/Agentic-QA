/* eslint-disable ts/no-explicit-any -- these tests mutate valid packs into invalid shapes on purpose */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { buildEvidencePage, MB } from './build.ts';
import { demoBugPack, demoStoryPack, writeDemo } from './demo.ts';
import { crc32, decodePng, encodePng, stripJpegMetadata, stripPngMetadata } from './png.ts';
import { REDACTION_COLOR } from './raster.ts';
import { escapeHtml, scriptJson } from './render.ts';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'evidence-page-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writePack(sub: string, pack: unknown): string {
  const path = join(dir, sub, 'evidence-pack.json');
  writeFileSync(path, JSON.stringify(pack));
  return path;
}

function dataUris(html: string): string[] {
  return [...html.matchAll(/src="(data:image\/png;base64,[^"]+)"/g)].map(m => m[1]);
}

describe('buildEvidencePage', () => {
  it('builds the demo story into ONE offline page with no resource loaded from anywhere', () => {
    const { story } = writeDemo(dir);
    const result = buildEvidencePage({ packPath: story });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.pagePath).toBe(join(dir, 'story', 'evidence-page', 'index.html'));
    const html = readFileSync(result.pagePath, 'utf8');
    expect(html).toContain('<title>DEMO-101 evidence</title>');
    // Resource-loading constructs only: env.url and api urls are legitimate text
    expect(html).not.toMatch(/<link\b/i);
    expect(html).not.toMatch(/@import/i);
    expect(html).not.toMatch(/url\(/i);
    expect(html).not.toMatch(/\bsrc="(?!data:)/i);
    expect(html).not.toMatch(/<script\s[^>]*src=/i);
    expect(html).toContain('prefers-color-scheme: dark');
    expect(html).toContain(':root[data-theme="dark"]');
    expect(dataUris(html)).toHaveLength(2);
  });

  it('embeds the pack without image paths, and no markup can break out of it', () => {
    const pack = structuredClone(demoStoryPack());
    pack.summary = '</script><script>alert(1)</script>';
    const path = join(dir, 'story', 'evidence-pack.json');
    writeDemo(dir);
    writeFileSync(path, JSON.stringify(pack));
    const result = buildEvidencePage({ packPath: path });
    expect(result.ok).toBe(true);
    const html = readFileSync((result as { pagePath: string }).pagePath, 'utf8');
    expect(html).not.toContain('<script>alert(1)');
    const embedded = JSON.parse(html.match(/<script type="application\/json" id="evidence-pack">([\s\S]*?)<\/script>/)![1]);
    expect(embedded.summary).toBe(pack.summary);
    expect(JSON.stringify(embedded)).not.toContain('form-ok.png');
  });

  it('burns redactions into the pixels of the page and of the thumbnail', () => {
    const { bug } = writeDemo(dir);
    const result = buildEvidencePage({ packPath: bug, thumb: true });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const html = readFileSync(result.pagePath, 'utf8');
    const image = decodePng(Buffer.from(dataUris(html)[0].split(',')[1], 'base64'));
    const o = (350 * image.width + 300) * 4; // inside the demo redaction box (280,340 228x24)
    expect([...image.data.subarray(o, o + 4)]).toEqual([...REDACTION_COLOR]);
    expect(result.thumbPath).toBe(join(dir, 'bug', 'DEMO-120-thumbnail.png'));
    const thumb = decodePng(readFileSync(result.thumbPath!));
    const t = (350 * thumb.width + 300) * 4;
    expect([...thumb.data.subarray(t, t + 4)]).toEqual([...REDACTION_COLOR]);
  });

  it('refuses a secret and names the path, never the value', () => {
    const { story } = writeDemo(dir);
    const pack = structuredClone(demoStoryPack()) as any;
    const token = ['Bear', 'er ', 'x'.repeat(30)].join('');
    pack.cases[0].evidence[1].request = { headers: { Authorization: token } };
    writeFileSync(story, JSON.stringify(pack));
    const result = buildEvidencePage({ packPath: story });
    expect(result.ok).toBe(false);
    const errors = (result as { errors: string[] }).errors;
    expect(errors.some(e => e.startsWith('cases[0].evidence[1].request.headers.Authorization: refused'))).toBe(true);
    expect(errors.join('\n')).not.toContain('x'.repeat(30));
  });

  it('refuses images outside the pack folder, .auth files, traces and non-images', () => {
    writeDemo(dir);
    mkdirSync(join(dir, 'story', '.auth'));
    writeFileSync(join(dir, 'story', '.auth', 'shot.png'), encodePng({ width: 1, height: 1, data: new Uint8Array(4) }));
    writeFileSync(join(dir, 'outside.png'), encodePng({ width: 1, height: 1, data: new Uint8Array(4) }));
    symlinkSync(join(dir, 'outside.png'), join(dir, 'story', 'link.png'));
    writeFileSync(join(dir, 'story', 'fake.png'), 'not an image');
    const pack = structuredClone(demoStoryPack()) as any;
    pack.images = {
      a: { file: '../outside.png' },
      b: { file: '.auth/shot.png' },
      c: { file: 'session.har' },
      d: { file: 'fake.png' },
      e: { file: 'link.png' },
      form: { file: 'form-ok.png' },
      error: { file: 'form-error.png' },
    };
    const result = buildEvidencePage({ packPath: writePack('story', pack) });
    expect((result as { errors: string[] }).errors).toEqual([
      'images.a.file: resolves outside the pack folder',
      'images.b.file: points into an .auth folder; session state never goes on a page',
      'images.c.file: is a HAR, trace or state file; those never go on a page (attach a screenshot instead)',
      'images.d.file: is not a PNG or JPEG file (checked by its first bytes)',
      'images.e.file: resolves outside the pack folder',
    ]);
  });

  it('refuses a redaction on a JPEG', () => {
    writeDemo(dir);
    const jpeg = Uint8Array.from([0xFF, 0xD8, 0xFF, 0xC0, 0x00, 0x11, 0x08, 0x02, 0x58, 0x03, 0xC0, 0x03, ...Array.from<number>({ length: 9 }).fill(0), 0xFF, 0xD9]);
    writeFileSync(join(dir, 'bug', 'shot.jpg'), jpeg);
    const pack = structuredClone(demoBugPack()) as any;
    pack.images.error = { file: 'shot.jpg', redact: [{ x: 1, y: 1, w: 5, h: 5 }] };
    const result = buildEvidencePage({ packPath: writePack('bug', pack) });
    expect((result as { errors: string[] }).errors).toEqual(['images.error.redact: a JPEG cannot take a burned redaction; capture the screenshot as PNG']);
  });

  it('stops over the size limit and names the largest images', () => {
    const { story } = writeDemo(dir);
    const result = buildEvidencePage({ packPath: story, maxMb: 0.01 });
    expect(result.ok).toBe(false);
    expect((result as { errors: string[] }).errors[0]).toMatch(/over the 0\.01 MB limit\. Largest images: (form|error) \(/);
    expect(buildEvidencePage({ packPath: story, maxMb: 17 }).ok).toBe(false);
    expect(MB).toBe(1_000_000);
  });

  it('refuses an invalid pack with every error path', () => {
    const { story } = writeDemo(dir);
    writeFileSync(story, JSON.stringify({ schema: 'evidence-pack/0.9', kind: 'story' }));
    const errors = (buildEvidencePage({ packPath: story }) as { errors: string[] }).errors;
    expect(errors).toContain('schema: must be "evidence-pack/1.0" (got "evidence-pack/0.9")');
    expect(errors).toContain('ticket: is required');
  });
});

describe('render helpers', () => {
  it('escapes HTML and script-breaking JSON', () => {
    expect(escapeHtml('<a href="x">\'&')).toBe('&lt;a href=&quot;x&quot;&gt;&#39;&amp;');
    expect(scriptJson({ s: '</script>' })).toBe('{"s":"\\u003c/script>"}');
  });
});

describe('fix round: the reviewer probes (VERIFY M4, N2, N5, N6, N7)', () => {
  function burnedShare(html: string, index: number): number {
    const image = decodePng(Buffer.from(dataUris(html)[index].split(',')[1], 'base64'));
    let burned = 0;
    let total = 0;
    for (let y = 344; y < 360; y++) {
      for (let x = 284; x < 500; x++) {
        const o = (y * image.width + x) * 4;
        total++;
        if ([...image.data.subarray(o, o + 4)].join() === REDACTION_COLOR.join()) {
          burned++;
        }
      }
    }
    return burned / total;
  }

  it('M4: two image keys on one file burn the union of their redactions on every key and the thumbnail', () => {
    const { bug } = writeDemo(dir);
    const pack = structuredClone(demoBugPack()) as any;
    pack.images = {
      a: { file: 'form-error.png', redact: [{ x: 280, y: 340, w: 228, h: 24 }] },
      b: { file: './form-error.png' },
    };
    pack.bug.thumbnail = 'b';
    pack.cases[0].evidence[0].image = 'a';
    pack.cases.push({ title: 'same shot, second key', status: 'FAILED', evidence: [{ type: 'image', image: 'b' }] });
    writeFileSync(bug, JSON.stringify(pack));
    const result = buildEvidencePage({ packPath: bug, thumb: true });
    expect(result.ok).toBe(true);
    const html = readFileSync((result as { pagePath: string }).pagePath, 'utf8');
    expect(dataUris(html)).toHaveLength(2);
    expect(burnedShare(html, 0)).toBe(1);
    expect(burnedShare(html, 1)).toBe(1);
    const thumb = decodePng(readFileSync((result as { thumbPath: string }).thumbPath));
    const t = (350 * thumb.width + 300) * 4;
    expect([...thumb.data.subarray(t, t + 4)]).toEqual([...REDACTION_COLOR]);
  });

  it('N2: the local host writes a standalone document; a hosted page has no skeleton', () => {
    const { story } = writeDemo(dir);
    const local = buildEvidencePage({ packPath: story, host: 'local' });
    expect(readFileSync((local as { pagePath: string }).pagePath, 'utf8')).toStartWith('<!doctype html>');
    const hosted = buildEvidencePage({ packPath: story });
    expect(readFileSync((hosted as { pagePath: string }).pagePath, 'utf8')).toStartWith('<meta charset="utf-8">');
  });

  it('N5: a screenshot named after a trace view is accepted; trace files are not', () => {
    writeDemo(dir);
    writeFileSync(join(dir, 'story', 'contract-trace.png'), encodePng({ width: 4, height: 4, data: new Uint8Array(64) }));
    const pack = structuredClone(demoStoryPack()) as any;
    pack.images.form = { file: 'contract-trace.png' };
    pack.cases[0].evidence[0].marks = [];
    expect(buildEvidencePage({ packPath: writePack('story', pack) }).ok).toBe(true);
    pack.images.form = { file: 'trace.zip' };
    expect((buildEvidencePage({ packPath: writePack('story', pack) }) as { errors: string[] }).errors[0]).toContain('HAR, trace or state file');
  });

  it('N6: the size error weighs an image by its uses', () => {
    const { story } = writeDemo(dir);
    const pack = structuredClone(demoStoryPack()) as any;
    pack.cases[2] = { title: 'reuse', status: 'PASSED', evidence: [{ type: 'image', image: 'error' }, { type: 'image', image: 'error' }] };
    pack.ticket.verdict = 'FAILED';
    pack.bugs = undefined;
    writeFileSync(story, JSON.stringify(pack));
    const errors = (buildEvidencePage({ packPath: story, maxMb: 0.01 }) as { errors: string[] }).errors;
    expect(errors[0]).toMatch(/Largest images: error \(3 uses, /);
  });

  it('N7: PNG text chunks and JPEG EXIF / comments are stripped before inlining', () => {
    const png = encodePng({ width: 2, height: 2, data: new Uint8Array(16) });
    const text = new TextEncoder().encode('tEXtComment\0gps 40.4,-3.7');
    const chunk = new Uint8Array(12 + text.length - 4);
    new DataView(chunk.buffer).setUint32(0, text.length - 4);
    chunk.set(text, 4);
    new DataView(chunk.buffer).setUint32(8 + text.length - 4, crc32(text));
    const withText = Buffer.concat([png.subarray(0, 33), chunk, png.subarray(33)]);
    const stripped = stripPngMetadata(withText);
    expect(Buffer.from(stripped).includes('gps')).toBe(false);
    expect(decodePng(stripped).width).toBe(2);

    const exif = [0xFF, 0xE1, 0x00, 0x0A, ...new TextEncoder().encode('Exif\0\0GP')];
    const comment = [0xFF, 0xFE, 0x00, 0x06, ...new TextEncoder().encode('note')];
    const jpeg = Uint8Array.from([0xFF, 0xD8, ...exif, ...comment, 0xFF, 0xC0, 0x00, 0x11, 0x08, 0x00, 0x02, 0x00, 0x02, 0x03, ...Array.from<number>({ length: 9 }).fill(0), 0xFF, 0xDA, 0x00, 0x02, 0x11, 0x22, 0xFF, 0xD9]);
    const clean = Buffer.from(stripJpegMetadata(jpeg));
    expect(clean.includes('Exif')).toBe(false);
    expect(clean.includes('note')).toBe(false);
    expect([...clean.subarray(-8)]).toEqual([0xFF, 0xDA, 0x00, 0x02, 0x11, 0x22, 0xFF, 0xD9]);
    expect(clean.subarray(0, 2)).toEqual(Buffer.from([0xFF, 0xD8]));
    expect(clean.includes(Buffer.from([0xFF, 0xC0]))).toBe(true);
  });
});
