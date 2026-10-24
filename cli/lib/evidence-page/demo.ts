/**
 * @fileoverview A synthetic story pack and bug pack that build into two pages.
 *
 * Everything here is invented: a drawn fake UI (no real product, no real data),
 * `DEMO-` keys like the sprint source demo (`cli/lib/sprint-source/fixtures/demo/`).
 * `bun run evidence demo` writes them under a gitignored folder and builds both.
 */

import type { Pack } from './pack.ts';
import type { RgbaImage } from './png.ts';
import type { Rgba } from './raster.ts';

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { PACK_SCHEMA } from './pack.ts';
import { encodePng } from './png.ts';
import { fillRect } from './raster.ts';

export const DEMO_OUT = 'reports/evidence-demo';

const WIDTH = 960;
const HEIGHT = 600;

function canvas(color: Rgba): RgbaImage {
  const image = { width: WIDTH, height: HEIGHT, data: new Uint8Array(WIDTH * HEIGHT * 4) };
  fillRect(image, 0, 0, WIDTH, HEIGHT, color);
  return image;
}

/** A checkout form drawn in blocks: header, two fields, an email field to redact, a button, an error banner. */
export function demoScreenshot(withError: boolean): RgbaImage {
  const image = canvas([244, 246, 250, 255]);
  fillRect(image, 0, 0, WIDTH, 64, [36, 52, 86, 255]);
  fillRect(image, 24, 22, 140, 20, [210, 220, 240, 255]);
  fillRect(image, 240, 110, 480, 400, [255, 255, 255, 255]);
  for (const y of [150, 230, 310]) {
    fillRect(image, 272, y, 180, 12, [120, 130, 150, 255]);
    fillRect(image, 272, y + 22, 416, 40, [236, 239, 244, 255]);
  }
  // The "email" field content the bug pack redacts
  fillRect(image, 284, 344, 220, 16, [60, 70, 90, 255]);
  fillRect(image, 272, 410, 160, 44, [47, 91, 211, 255]);
  if (withError) {
    fillRect(image, 272, 470, 416, 28, [251, 231, 229, 255]);
    fillRect(image, 284, 478, 260, 12, [180, 35, 24, 255]);
  }
  return image;
}

export function demoStoryPack(): Pack {
  return {
    schema: PACK_SCHEMA,
    kind: 'story',
    ticket: { id: 'DEMO-101', title: 'Checkout keeps the cart after a failed payment', verdict: 'FAILED' },
    env: { name: 'staging', url: 'https://staging.example.test', build: '2026.10.24-3', commit: 'a1b2c3d', testedAt: '2026-10-24T10:00:00Z', tester: 'QA (demo)' },
    summary: 'Two of three acceptance criteria hold. A declined card empties the cart, filed as DEMO-120.',
    images: { form: { file: 'form-ok.png' }, error: { file: 'form-error.png' } },
    cases: [
      {
        id: 'DEMO-102',
        title: 'A valid card completes the order',
        status: 'PASSED',
        expected: 'Order confirmation with the cart total',
        actual: 'Confirmation shown, total matches',
        evidence: [
          { type: 'image', image: 'form', caption: 'Payment form before submit', marks: [{ shape: 'rect', tone: 'ok', x: 272, y: 410, w: 160, h: 44, text: 'Pay' }] },
          { type: 'api', method: 'POST', url: 'https://staging.example.test/api/orders', status: 201, request: { cartId: 'demo-cart-1', card: '[REDACTED]' }, response: { orderId: 'demo-order-9', total: 42.5 } },
        ],
      },
      {
        id: 'DEMO-103',
        title: 'A declined card keeps the cart',
        status: 'FAILED',
        expected: 'Error banner, cart still holds 3 items',
        actual: 'Error banner shown, cart is empty',
        evidence: [
          {
            type: 'image',
            image: 'error',
            caption: 'After the decline',
            marks: [
              { shape: 'ellipse', tone: 'defect', x: 264, y: 462, w: 432, h: 44, text: 'Cart emptied' },
              { shape: 'arrow', tone: 'note', from: [800, 300], to: [700, 480] },
            ],
          },
          { type: 'sql', query: 'select count(*) as items from cart_items where cart_id = \'demo-cart-2\'', columns: ['items'], rows: [[0]], caption: 'The cart row after the decline' },
        ],
      },
      { id: 'DEMO-104', title: 'Saved cards are listed', status: 'DEFERRED', reason: 'Saved cards are behind a flag that is off in staging', followUp: 'DEMO-130' },
    ],
    bugs: [{ id: 'DEMO-120', title: 'Declined payment empties the cart', status: 'OPEN' }],
  };
}

export function demoBugPack(): Pack {
  return {
    schema: PACK_SCHEMA,
    kind: 'bug',
    ticket: { id: 'DEMO-120', title: 'Declined payment empties the cart' },
    env: { name: 'staging', build: '2026.10.25-1', testedAt: '2026-10-25T09:30:00Z', tester: 'QA (demo)' },
    summary: 'Retest on the fix build: the cart is still emptied.',
    bug: {
      status: 'RETEST FAILED',
      severity: 'Major',
      story: 'DEMO-101',
      expected: 'The cart keeps its items after a declined payment',
      actual: 'The cart is empty after a declined payment',
      repro: ['Add three items to the cart', 'Pay with the test card that is always declined', 'Open the cart'],
      thumbnail: 'error',
    },
    // The redaction covers the email field: it is burned into the pixels, never drawn over them
    images: { error: { file: 'form-error.png', redact: [{ x: 280, y: 340, w: 228, h: 24 }] } },
    cases: [
      {
        title: 'Retest on build 2026.10.25-1',
        status: 'FAILED',
        expected: 'Cart holds 3 items',
        actual: 'Cart is empty',
        evidence: [
          { type: 'image', image: 'error', caption: 'After the decline (email redacted)', marks: [{ shape: 'rect', tone: 'defect', x: 272, y: 470, w: 416, h: 28, text: 'Cart emptied' }] },
          { type: 'timeline', events: [{ at: '09:30:02', label: 'POST /api/payments', detail: '402 declined' }, { at: '09:30:02', label: 'DELETE /api/cart', detail: 'called by the error handler' }] },
        ],
      },
    ],
    history: [
      {
        round: 1,
        at: '2026-10-24T10:05:00Z',
        build: '2026.10.24-3',
        cases: [{ title: 'First report', status: 'FAILED', evidence: [{ type: 'note', text: 'Found while testing DEMO-101.' }] }],
      },
    ],
  };
}

/** Writes the two synthetic screenshots and packs; returns the pack paths. */
export function writeDemo(outDir: string): { story: string, bug: string } {
  const storyDir = join(outDir, 'story');
  const bugDir = join(outDir, 'bug');
  mkdirSync(storyDir, { recursive: true });
  mkdirSync(bugDir, { recursive: true });
  const ok = encodePng(demoScreenshot(false));
  const error = encodePng(demoScreenshot(true));
  writeFileSync(join(storyDir, 'form-ok.png'), ok);
  writeFileSync(join(storyDir, 'form-error.png'), error);
  writeFileSync(join(bugDir, 'form-error.png'), error);
  const story = join(storyDir, 'evidence-pack.json');
  const bug = join(bugDir, 'evidence-pack-DEMO-120.json');
  writeFileSync(story, `${JSON.stringify(demoStoryPack(), null, 2)}\n`);
  writeFileSync(bug, `${JSON.stringify(demoBugPack(), null, 2)}\n`);
  return { story, bug };
}
