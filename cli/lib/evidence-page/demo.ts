/**
 * @fileoverview A synthetic story pack and bug pack that build into the evidence pages.
 *
 * Everything here is invented: a drawn fake UI (no real product, no real data),
 * `DEMO-` keys like the sprint source demo (`cli/lib/sprint-source/fixtures/demo/`).
 * The two packs exercise every part of the page: all five mark shapes, API,
 * SQL, timeline and note items, a compare, a DEFERRED and a BLOCKED case, a
 * redaction, a bug card, and a retest round with its BEFORE FIX history.
 * `bun run evidence demo` writes them under a gitignored folder and builds
 * the story page, the bug page, the bug thumbnail and a review page of both.
 * The screenshots are committed fixtures (`fixtures/demo/`), drawn once.
 */

import type { Pack } from './pack.ts';

import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import { PACK_SCHEMA } from './pack.ts';

export const DEMO_OUT = 'reports/evidence-demo';

/** Synthetic screenshots (a checkout form drawn in flat blocks), committed beside this module. */
export const DEMO_SCREENS = resolve(import.meta.dir, 'fixtures', 'demo');

/** The email field the packs redact, in screenshot pixels. */
export const DEMO_REDACT: [number, number, number, number] = [280, 340, 228, 24];

/** `files` are the repo-relative paths of the drawn screenshots. */
export function demoStoryPack(files: { ok: string, error: string }): Pack {
  return {
    schema: PACK_SCHEMA,
    kind: 'story',
    ticket: {
      id: 'DEMO-7101',
      title: 'Checkout keeps the cart after a failed payment',
      module: 'checkout',
      verdict: 'FAILED',
      bugs: ['DEMO-7120 Major'],
      assignee: 'Dev (demo)',
      qa: 'QA (demo)',
      date: '2026-10-24',
      atp: 'DEMO-7140',
      atr: 'DEMO-7141',
    },
    env: { 'Environment': 'staging', 'Web build': '2026.10.24-3 (a1b2c3d)', 'API build': '2026.10.24-2 (9f8e7d6)', 'Database': 'staging, seeded demo data' },
    summary: 'A valid card completes the order. A declined card empties the cart, filed as DEMO-7120. Saved cards wait for a flag that is off in staging, and the receipt email could not be checked.',
    images: {
      form: { file: files.ok },
      error: { file: files.error, redact: [DEMO_REDACT] },
    },
    tcs: [
      {
        id: 'DEMO-7101-TC1',
        title: 'A valid card completes the order',
        status: 'PASSED',
        note: 'The order is created and the confirmation shows the cart total.',
        evidence: [
          {
            type: 'image',
            ref: 'form',
            label: 'Payment form',
            caption: 'The form before submit',
            coords: 'px',
            annotations: [
              { n: 1, shape: 'rect', x: 272, y: 410, w: 160, h: 44, tone: 'ok', title: 'Pay button', explain: 'Enabled once the card fields are valid.' },
              { n: 2, shape: 'bubble', x: 900, y: 46, text: '3 items', tone: 'note', title: 'Cart badge', explain: 'The cart holds three items before paying.' },
            ],
          },
          {
            type: 'api',
            label: 'Create order',
            method: 'POST',
            url: 'https://staging.example.test/api/orders',
            status: 201,
            ms: '212 ms',
            request: '{\n  "cartId": "demo-cart-1",\n  "card": "<redacted>"\n}',
            response: '{\n  "orderId": "demo-order-9",\n  "total": 42.5\n}',
            curl: 'curl -X POST https://staging.example.test/api/orders -H "Authorization: Bearer $API_TOKEN_DEMO" -d @order.json',
            flags: ['Token redacted', 'Response trimmed'],
          },
        ],
      },
      {
        id: 'DEMO-7101-TC2',
        title: 'A declined card keeps the cart',
        status: 'FAILED',
        note: 'The error banner shows, but the cart is emptied: DEMO-7120.',
        evidence: [
          {
            type: 'image',
            ref: 'error',
            label: 'After the decline',
            caption: 'The cart badge is empty after a declined payment (email burned out)',
            result: 'defect',
            coords: 'px',
            annotations: [
              { n: 1, shape: 'ellipse', cx: 896, cy: 32, rx: 48, ry: 24, tone: 'defect', title: 'Cart emptied', explain: 'The badge shows no items after the decline.' },
              { n: 2, shape: 'arrow', x1: 760, y1: 300, x2: 690, y2: 480, tone: 'note', title: 'Decline banner', explain: 'The decline itself is reported correctly.' },
              { n: 3, shape: 'path', pts: [[284, 506], [400, 512], [520, 504], [660, 510]], tone: 'note', title: 'No retry link', explain: 'Nothing offers to restore the cart.' },
            ],
          },
          {
            type: 'sql',
            label: 'Cart rows',
            db: 'staging · cart_items',
            when: 'right after the decline',
            query: 'select cart_id, count(*) as items from cart_items where cart_id in (\'demo-cart-1\', \'demo-cart-2\') group by cart_id',
            columns: ['cart_id', 'items'],
            rows: [['demo-cart-2', 0], ['demo-cart-1', 3]],
            hl: [0],
            okRows: [1],
            flags: ['Columns verified live', 'Query written for display'],
          },
          {
            type: 'timeline',
            label: 'Requests',
            title: 'What the page called after Pay',
            source: 'browser network log, trimmed',
            events: [
              { t: 0, label: 'POST /api/payments', state: 'req' },
              { t: 180, label: '402 card declined', state: 'wait' },
              { t: 195, label: 'DELETE /api/cart', rows: 3, state: 'bad' },
              { t: 240, label: 'banner rendered', state: 'ok' },
            ],
          },
        ],
        compare: {
          left: { image: 'form', detail: 'TC1, same cart' },
          right: { image: 'error', detail: 'after the decline' },
          caption: 'The same cart before paying and after the decline',
        },
      },
      {
        id: 'DEMO-7101-TC3',
        title: 'Saved cards are listed',
        status: 'DEFERRED',
        note: 'Saved cards are behind a flag that is off in staging; deferred to DEMO-7130.',
        evidence: [{ type: 'note', label: 'Deferral', title: 'Why it was not run', body: 'The saved-cards flag is off in staging. DEMO-7130 records the deferral and runs this case once the flag is on.' }],
      },
      {
        id: 'DEMO-7101-TC4',
        title: 'The receipt email is sent',
        status: 'BLOCKED',
        note: 'The staging mail sink was down for the whole session.',
        evidence: [],
      },
    ],
    bugs: [
      { id: 'DEMO-7120', title: 'Declined payment empties the cart', status: 'RETEST PASSED', severity: 'Major', priority: 'High', from: 'DEMO-7101-TC2', url: '#DEMO-7120', evidence: [] },
    ],
  };
}

export function demoBugPack(files: { error: string, fixed: string }): Pack {
  return {
    schema: PACK_SCHEMA,
    kind: 'bug',
    ticket: {
      id: 'DEMO-7120',
      title: 'Declined payment empties the cart',
      module: 'checkout',
      verdict: 'PASSED',
      verdictNote: 'Fixed: verified in retest 1 on 2026-10-25',
      severity: 'Major',
      priority: 'High',
      parent: 'DEMO-7101',
      parentTitle: 'Checkout keeps the cart after a failed payment',
      date: '2026-10-25',
    },
    env: { 'Environment': 'staging', 'Web build': '2026.10.25-1 (c3d4e5f)', 'API build': '2026.10.25-1 (0a1b2c3)' },
    summary: 'The fix holds: after a declined card the cart keeps its three items. The original finding is kept below as history.',
    repro: {
      steps: ['Add three items to the cart', 'Pay with the test card that is always declined', 'Look at the cart badge'],
      frequency: '3 of 3',
      expected: 'The cart keeps its three items after a declined payment.',
      actual: 'The cart is empty after a declined payment.',
    },
    images: {
      error: { file: files.error, redact: [DEMO_REDACT] },
      fixed: { file: files.fixed, redact: [DEMO_REDACT] },
    },
    currentRound: 1,
    rounds: [
      { round: 0, date: '2026-10-24', build: '2026.10.24-3' },
      { round: 1, date: '2026-10-25', build: '2026.10.25-1' },
    ],
    tcs: [
      {
        id: 'DEMO-7120-retest-1',
        kind: 'retest',
        round: 1,
        date: '2026-10-25',
        title: 'The cart keeps its items after a decline',
        status: 'PASSED',
        note: 'Retest 1: the cart keeps its three items and the banner offers a retry.',
        evidence: [
          {
            type: 'image',
            ref: 'fixed',
            label: 'After the fix',
            result: 'pass',
            coords: 'px',
            annotations: [{ n: 1, shape: 'rect', x: 860, y: 18, w: 72, h: 28, tone: 'ok', title: 'Cart kept', explain: 'Three items after the decline.' }],
          },
          { type: 'image', ref: 'error', label: 'Actual: cart emptied', round: 0, result: 'defect' },
        ],
        compare: { left: { image: 'error' }, right: { image: 'fixed' }, caption: 'Same steps, before and after the fix' },
      },
      {
        id: 'DEMO-7120-repro',
        kind: 'repro',
        round: 0,
        title: 'A declined card empties the cart',
        status: 'FAILED',
        note: 'Reproduced 3 of 3 on build 2026.10.24-3.',
        evidence: [
          {
            type: 'image',
            ref: 'error',
            label: 'Cart after the decline',
            result: 'defect',
            coords: 'px',
            annotations: [{ n: 1, shape: 'ellipse', cx: 896, cy: 32, rx: 48, ry: 24, tone: 'defect', title: 'Cart emptied', explain: 'The badge shows no items.' }],
          },
          { type: 'api', label: 'Cart cleared', method: 'DELETE', url: 'https://staging.example.test/api/cart', status: 204, ms: '31 ms', response: '(no body)', flags: ['Called by the error handler'] },
        ],
      },
    ],
    bugs: [],
  };
}

/** Copies the synthetic screenshots and writes the packs; image paths are relative to `root`. Returns the pack paths. */
export function writeDemo(outDir: string, root: string): { story: string, bug: string } {
  const dir = resolve(outDir);
  const storyDir = join(dir, 'story');
  const bugDir = join(dir, 'bug');
  mkdirSync(storyDir, { recursive: true });
  mkdirSync(bugDir, { recursive: true });
  const shot = (folder: string, name: string, screen: 'ok' | 'error' | 'fixed') => {
    const path = join(folder, name);
    copyFileSync(join(DEMO_SCREENS, `checkout-${screen}.png`), path);
    return relative(root, path);
  };
  const story = join(storyDir, 'evidence-pack.json');
  const bug = join(storyDir, 'evidence-pack-DEMO-7120.json');
  writeFileSync(story, `${JSON.stringify(demoStoryPack({ ok: shot(storyDir, 'DEMO-7101-tc1-form.png', 'ok'), error: shot(storyDir, 'DEMO-7101-tc2-decline.png', 'error') }), null, 2)}\n`);
  writeFileSync(bug, `${JSON.stringify(demoBugPack({ error: shot(storyDir, 'DEMO-7101-tc2-decline.png', 'error'), fixed: shot(bugDir, 'DEMO-7120-retest-1-fixed.png', 'fixed') }), null, 2)}\n`);
  return { story, bug };
}
