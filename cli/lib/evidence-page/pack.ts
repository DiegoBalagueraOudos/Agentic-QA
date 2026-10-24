/**
 * @fileoverview The evidence pack `evidence-pack/1.0`: types and validator (ADR-0021).
 *
 * A pack is the DATA of one evidence page: the ticket and its verdict, the
 * environment, the cases with their evidence items, the images with their
 * redactions, the earlier retest rounds. The builder renders it; nothing on
 * the page is computed from anything else.
 *
 * Every error names the JSON path of the bad field. The verdict is
 * cross-checked against the CURRENT cases only (history never counts) and a
 * contradicted verdict is refused, never corrected. PASSED and FAILED need an
 * observation (an evidence item); BLOCKED needs a reason; DEFERRED needs a
 * reason and a follow-up key (discovery-driven doctrine §5).
 */

import type { BugStatus, CaseStatus, Verdict } from './statuses.ts';

import { BUG_STATUSES, CASE_STATUSES, isOneOf, VERDICTS } from './statuses.ts';

export const PACK_SCHEMA = 'evidence-pack/1.0';

/** Used when the project has no `board:` block: Xray Test keys share the project key, so one shape holds. */
export const GENERIC_TICKET_KEY = /^[A-Z][A-Z0-9]+-\d+$/;

export const PACK_KINDS = ['story', 'bug'] as const;
export type PackKind = (typeof PACK_KINDS)[number];

export const COORDS = ['px', 'fraction'] as const;
export type Coords = (typeof COORDS)[number];

export const MARK_SHAPES = ['rect', 'ellipse', 'arrow', 'path', 'bubble'] as const;
export type MarkShape = (typeof MARK_SHAPES)[number];

export const MARK_TONES = ['defect', 'ok', 'note'] as const;
export type MarkTone = (typeof MARK_TONES)[number];

export const EVIDENCE_HOSTS = ['claude-artifact', 'local'] as const;
export type EvidenceHost = (typeof EVIDENCE_HOSTS)[number];

export type Point = [number, number];

export interface Box {
  x: number
  y: number
  w: number
  h: number
  /** `px` (default) = the real element box read at capture time; `fraction` = 0..1 of the image. */
  coords?: Coords
}

export interface ImageDecl {
  /** Relative to the pack's folder. */
  file: string
  redact?: Box[]
}

export interface Mark {
  shape: MarkShape
  tone?: MarkTone
  coords?: Coords
  x?: number
  y?: number
  w?: number
  h?: number
  points?: Point[]
  from?: Point
  to?: Point
  text?: string
}

export interface ImageItem { type: 'image', image: string, caption?: string, marks?: Mark[] }
export interface ApiItem { type: 'api', method: string, url: string, status?: number, request?: unknown, response?: unknown, caption?: string }
export interface SqlItem { type: 'sql', query: string, columns?: string[], rows?: unknown[][], caption?: string }
export interface TimelineEvent { at: string, label: string, detail?: string }
export interface TimelineItem { type: 'timeline', events: TimelineEvent[], caption?: string }
export interface NoteItem { type: 'note', text: string }
export type EvidenceItem = ImageItem | ApiItem | SqlItem | TimelineItem | NoteItem;

export interface Case {
  id?: string
  title: string
  status: CaseStatus
  reason?: string
  followUp?: string
  expected?: string
  actual?: string
  evidence?: EvidenceItem[]
}

export interface BugRef { id: string, title: string, status: BugStatus, link?: string }

export interface Round { round: number, at?: string, build?: string, cases: Case[] }

export interface Publication { ref: string, at: string }

export interface Pack {
  schema: typeof PACK_SCHEMA
  kind: PackKind
  ticket: { id: string, title: string, verdict?: Verdict, link?: string }
  env: { name: string, url?: string, build?: string, commit?: string, testedAt?: string, tester?: string }
  summary?: string
  bug?: { status: BugStatus, severity?: string, story?: string, expected?: string, actual?: string, repro?: string[], thumbnail?: string }
  images?: Record<string, ImageDecl>
  cases: Case[]
  bugs?: BugRef[]
  history?: Round[]
  artifact?: { host: EvidenceHost, ref?: string, published?: Publication[] }
}

export type ValidationResult
  = | { ok: true, pack: Pack, warnings: string[] }
    | { ok: false, errors: string[], warnings: string[] };

// ============================================================================
// VALIDATOR
// ============================================================================

type Obj = Record<string, unknown>;

class Checker {
  readonly errors: string[] = [];
  readonly warnings: string[] = [];

  constructor(readonly keyPattern: RegExp) {}

  error(path: string, message: string): void {
    this.errors.push(`${path}: ${message}`);
  }

  object(value: unknown, path: string, allowed: readonly string[]): value is Obj {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      this.error(path, 'must be an object');
      return false;
    }
    for (const key of Object.keys(value)) {
      if (!allowed.includes(key)) {
        this.error(`${path}.${key}`, `is not a field of ${PACK_SCHEMA} here (allowed: ${allowed.join(', ')})`);
      }
    }
    return true;
  }

  string(obj: Obj, key: string, path: string, required: boolean): string | undefined {
    const value = obj[key];
    if (value === undefined) {
      if (required) {
        this.error(`${path}.${key}`, 'is required');
      }
      return undefined;
    }
    if (typeof value !== 'string' || (required && value.trim() === '')) {
      this.error(`${path}.${key}`, required ? 'must be a non-empty string' : 'must be a string');
      return undefined;
    }
    return value;
  }

  number(obj: Obj, key: string, path: string, required: boolean): number | undefined {
    const value = obj[key];
    if (value === undefined) {
      if (required) {
        this.error(`${path}.${key}`, 'is required');
      }
      return undefined;
    }
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      this.error(`${path}.${key}`, 'must be a finite number');
      return undefined;
    }
    return value;
  }

  oneOf<T extends string>(obj: Obj, key: string, path: string, values: readonly T[], required: boolean): T | undefined {
    const value = obj[key];
    if (value === undefined) {
      if (required) {
        this.error(`${path}.${key}`, `is required (one of ${values.join(' | ')})`);
      }
      return undefined;
    }
    if (!isOneOf(values, value)) {
      this.error(`${path}.${key}`, `${JSON.stringify(value)} is not one of ${values.join(' | ')}`);
      return undefined;
    }
    return value;
  }

  key(obj: Obj, key: string, path: string, required: boolean): void {
    const value = this.string(obj, key, path, required);
    if (value !== undefined && !this.keyPattern.test(value)) {
      this.error(`${path}.${key}`, `${JSON.stringify(value)} does not match the ticket key pattern ${this.keyPattern.source}`);
    }
  }

  array(obj: Obj, key: string, path: string, required: boolean): unknown[] | undefined {
    const value = obj[key];
    if (value === undefined) {
      if (required) {
        this.error(`${path}.${key}`, 'is required');
      }
      return undefined;
    }
    if (!Array.isArray(value)) {
      this.error(`${path}.${key}`, 'must be an array');
      return undefined;
    }
    return value;
  }

  point(value: unknown, path: string): void {
    if (!Array.isArray(value) || value.length !== 2 || !value.every(n => typeof n === 'number' && Number.isFinite(n))) {
      this.error(path, 'must be a [x, y] pair of numbers');
    }
  }
}

function checkBox(c: Checker, value: unknown, path: string): void {
  if (!c.object(value, path, ['x', 'y', 'w', 'h', 'coords'])) {
    return;
  }
  for (const k of ['x', 'y', 'w', 'h']) {
    c.number(value, k, path, true);
  }
  for (const k of ['w', 'h']) {
    if (typeof value[k] === 'number' && (value[k]) <= 0) {
      c.error(`${path}.${k}`, 'must be greater than 0');
    }
  }
  c.oneOf(value, 'coords', path, COORDS, false);
}

function checkMark(c: Checker, value: unknown, path: string): void {
  if (!c.object(value, path, ['shape', 'tone', 'coords', 'x', 'y', 'w', 'h', 'points', 'from', 'to', 'text'])) {
    return;
  }
  const shape = c.oneOf(value, 'shape', path, MARK_SHAPES, true);
  c.oneOf(value, 'tone', path, MARK_TONES, false);
  c.oneOf(value, 'coords', path, COORDS, false);
  c.string(value, 'text', path, false);
  if (shape === 'rect' || shape === 'ellipse' || shape === 'bubble') {
    for (const k of ['x', 'y', 'w', 'h']) {
      c.number(value, k, path, true);
    }
  }
  else if (shape === 'arrow') {
    for (const k of ['from', 'to']) {
      if (value[k] === undefined) {
        c.error(`${path}.${k}`, 'is required for an arrow');
      }
      else {
        c.point(value[k], `${path}.${k}`);
      }
    }
  }
  else if (shape === 'path') {
    const points = c.array(value, 'points', path, true);
    if (points !== undefined) {
      if (points.length < 2) {
        c.error(`${path}.points`, 'needs at least 2 points');
      }
      points.forEach((p, i) => c.point(p, `${path}.points[${i}]`));
    }
  }
}

function checkItem(c: Checker, value: unknown, path: string, imageKeys: ReadonlySet<string>): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    c.error(path, 'must be an object');
    return;
  }
  const type = (value as Obj).type;
  switch (type) {
    case 'image': {
      if (!c.object(value, path, ['type', 'image', 'caption', 'marks'])) {
        return;
      }
      const key = c.string(value, 'image', path, true);
      if (key !== undefined && !imageKeys.has(key)) {
        c.error(`${path}.image`, `${JSON.stringify(key)} is not declared in images`);
      }
      c.string(value, 'caption', path, false);
      c.array(value, 'marks', path, false)?.forEach((m, i) => checkMark(c, m, `${path}.marks[${i}]`));
      return;
    }
    case 'api': {
      if (!c.object(value, path, ['type', 'method', 'url', 'status', 'request', 'response', 'caption'])) {
        return;
      }
      c.string(value, 'method', path, true);
      c.string(value, 'url', path, true);
      c.number(value, 'status', path, false);
      c.string(value, 'caption', path, false);
      return;
    }
    case 'sql': {
      if (!c.object(value, path, ['type', 'query', 'columns', 'rows', 'caption'])) {
        return;
      }
      c.string(value, 'query', path, true);
      c.array(value, 'columns', path, false)?.forEach((col, i) => {
        if (typeof col !== 'string') {
          c.error(`${path}.columns[${i}]`, 'must be a string');
        }
      });
      c.array(value, 'rows', path, false)?.forEach((row, i) => {
        if (!Array.isArray(row)) {
          c.error(`${path}.rows[${i}]`, 'must be an array of cells');
        }
      });
      c.string(value, 'caption', path, false);
      return;
    }
    case 'timeline': {
      if (!c.object(value, path, ['type', 'events', 'caption'])) {
        return;
      }
      const events = c.array(value, 'events', path, true);
      if (events !== undefined && events.length === 0) {
        c.error(`${path}.events`, 'needs at least one event');
      }
      events?.forEach((e, i) => {
        const p = `${path}.events[${i}]`;
        if (c.object(e, p, ['at', 'label', 'detail'])) {
          c.string(e, 'at', p, true);
          c.string(e, 'label', p, true);
          c.string(e, 'detail', p, false);
        }
      });
      c.string(value, 'caption', path, false);
      return;
    }
    case 'note': {
      if (c.object(value, path, ['type', 'text'])) {
        c.string(value, 'text', path, true);
      }
      return;
    }
    default:
      c.error(`${path}.type`, `${JSON.stringify(type)} is not one of image | api | sql | timeline | note`);
  }
}

function checkCase(c: Checker, value: unknown, path: string, imageKeys: ReadonlySet<string>): void {
  if (!c.object(value, path, ['id', 'title', 'status', 'reason', 'followUp', 'expected', 'actual', 'evidence'])) {
    return;
  }
  c.key(value, 'id', path, false);
  c.string(value, 'title', path, true);
  const status = c.oneOf(value, 'status', path, CASE_STATUSES, true);
  const reason = c.string(value, 'reason', path, false);
  c.key(value, 'followUp', path, false);
  c.string(value, 'expected', path, false);
  c.string(value, 'actual', path, false);
  const evidence = c.array(value, 'evidence', path, false) ?? [];
  evidence.forEach((item, i) => checkItem(c, item, `${path}.evidence[${i}]`, imageKeys));

  // PASSED and FAILED only on observation (D21): the observation is the evidence
  if ((status === 'PASSED' || status === 'FAILED') && evidence.length === 0) {
    c.error(`${path}.evidence`, `a ${status} case needs at least one evidence item (PASSED and FAILED only on observation)`);
  }
  if ((status === 'BLOCKED' || status === 'DEFERRED') && (reason === undefined || reason.trim() === '')) {
    c.error(`${path}.reason`, `a ${status} case needs the reason it was not run`);
  }
  if (status === 'DEFERRED' && value.followUp === undefined) {
    c.error(`${path}.followUp`, 'a DEFERRED case needs the follow-up ticket key that records the deferral');
  }
}

/** The verdict the current cases allow. History never counts. */
export function verdictOf(cases: readonly Pick<Case, 'status'>[]): Verdict {
  if (cases.some(x => x.status === 'FAILED')) {
    return 'FAILED';
  }
  if (cases.length === 0 || cases.some(x => x.status === 'BLOCKED' || x.status === 'NOT RUN')) {
    return 'PENDING';
  }
  return cases.some(x => x.status === 'PASSED') ? 'PASSED' : 'PENDING';
}

export interface ValidateOptions {
  /** The board's `ticketKeyPattern` when `board:` is configured, else {@link GENERIC_TICKET_KEY}. */
  ticketKeyPattern?: RegExp
}

export function validatePack(raw: unknown, options: ValidateOptions = {}): ValidationResult {
  const c = new Checker(options.ticketKeyPattern ?? GENERIC_TICKET_KEY);
  const top = ['schema', 'kind', 'ticket', 'env', 'summary', 'bug', 'images', 'cases', 'bugs', 'history', 'artifact'];
  if (!c.object(raw, 'pack', top)) {
    return { ok: false, errors: c.errors, warnings: c.warnings };
  }
  const pack = raw;

  if (pack.schema !== PACK_SCHEMA) {
    c.error('schema', `must be "${PACK_SCHEMA}" (got ${JSON.stringify(pack.schema)})`);
  }
  const kind = c.oneOf(pack, 'kind', 'pack', PACK_KINDS, true);

  let verdict: Verdict | undefined;
  if (pack.ticket !== undefined && c.object(pack.ticket, 'ticket', ['id', 'title', 'verdict', 'link'])) {
    c.key(pack.ticket, 'id', 'ticket', true);
    c.string(pack.ticket, 'title', 'ticket', true);
    verdict = c.oneOf(pack.ticket, 'verdict', 'ticket', VERDICTS, kind === 'story');
    c.string(pack.ticket, 'link', 'ticket', false);
  }
  else if (pack.ticket === undefined) {
    c.error('ticket', 'is required');
  }

  if (pack.env !== undefined && c.object(pack.env, 'env', ['name', 'url', 'build', 'commit', 'testedAt', 'tester'])) {
    c.string(pack.env, 'name', 'env', true);
    for (const k of ['url', 'build', 'commit', 'testedAt', 'tester']) {
      c.string(pack.env, k, 'env', false);
    }
  }
  else if (pack.env === undefined) {
    c.error('env', 'is required (at least env.name: where the cases ran)');
  }

  c.string(pack, 'summary', 'pack', false);

  const imageKeys = new Set<string>();
  if (pack.images !== undefined) {
    if (typeof pack.images !== 'object' || pack.images === null || Array.isArray(pack.images)) {
      c.error('images', 'must be an object of { <key>: { file, redact? } }');
    }
    else {
      for (const [key, decl] of Object.entries(pack.images as Obj)) {
        imageKeys.add(key);
        const path = `images.${key}`;
        if (c.object(decl, path, ['file', 'redact'])) {
          c.string(decl, 'file', path, true);
          c.array(decl, 'redact', path, false)?.forEach((box, i) => checkBox(c, box, `${path}.redact[${i}]`));
        }
      }
    }
  }

  const cases = c.array(pack, 'cases', 'pack', true);
  if (cases !== undefined && cases.length === 0) {
    c.error('cases', 'needs at least one case');
  }
  cases?.forEach((x, i) => checkCase(c, x, `cases[${i}]`, imageKeys));

  c.array(pack, 'bugs', 'pack', false)?.forEach((b, i) => {
    const path = `bugs[${i}]`;
    if (c.object(b, path, ['id', 'title', 'status', 'link'])) {
      c.key(b, 'id', path, true);
      c.string(b, 'title', path, true);
      c.oneOf(b, 'status', path, BUG_STATUSES, true);
      c.string(b, 'link', path, false);
    }
  });

  c.array(pack, 'history', 'pack', false)?.forEach((r, i) => {
    const path = `history[${i}]`;
    if (c.object(r, path, ['round', 'at', 'build', 'cases'])) {
      c.number(r, 'round', path, true);
      c.string(r, 'at', path, false);
      c.string(r, 'build', path, false);
      c.array(r, 'cases', path, true)?.forEach((x, j) => checkCase(c, x, `${path}.cases[${j}]`, imageKeys));
    }
  });

  let bugStatus: BugStatus | undefined;
  if (kind === 'bug') {
    if (pack.bug === undefined) {
      c.error('bug', 'is required on a bug pack (status, expected, actual, repro)');
    }
    else if (c.object(pack.bug, 'bug', ['status', 'severity', 'story', 'expected', 'actual', 'repro', 'thumbnail'])) {
      bugStatus = c.oneOf(pack.bug, 'status', 'bug', BUG_STATUSES, true);
      c.string(pack.bug, 'severity', 'bug', false);
      c.key(pack.bug, 'story', 'bug', false);
      c.string(pack.bug, 'expected', 'bug', false);
      c.string(pack.bug, 'actual', 'bug', false);
      c.array(pack.bug, 'repro', 'bug', false)?.forEach((s, i) => {
        if (typeof s !== 'string') {
          c.error(`bug.repro[${i}]`, 'must be a string');
        }
      });
      const thumb = c.string(pack.bug, 'thumbnail', 'bug', false);
      if (thumb !== undefined && !imageKeys.has(thumb)) {
        c.error('bug.thumbnail', `${JSON.stringify(thumb)} is not declared in images`);
      }
    }
  }
  else if (kind === 'story' && pack.bug !== undefined) {
    c.error('bug', 'belongs to a bug pack; a story lists the bugs it filed in bugs[]');
  }

  if (pack.artifact !== undefined && c.object(pack.artifact, 'artifact', ['host', 'ref', 'published'])) {
    c.oneOf(pack.artifact, 'host', 'artifact', EVIDENCE_HOSTS, true);
    c.string(pack.artifact, 'ref', 'artifact', false);
    c.array(pack.artifact, 'published', 'artifact', false)?.forEach((p, i) => {
      const path = `artifact.published[${i}]`;
      if (c.object(p, path, ['ref', 'at'])) {
        c.string(p, 'ref', path, true);
        c.string(p, 'at', path, true);
      }
    });
  }

  // Cross-checks need a structurally valid pack
  if (c.errors.length === 0) {
    const current = pack.cases as Case[];
    const allowed = verdictOf(current);
    if (verdict !== undefined && verdict !== allowed) {
      const culprit = current.findIndex(x => x.status === 'FAILED' || x.status === 'BLOCKED' || x.status === 'NOT RUN');
      const why = culprit >= 0 ? `cases[${culprit}] is ${current[culprit].status}` : 'no current case was observed PASSED';
      c.error('ticket.verdict', `${verdict} contradicts the current cases (they allow ${allowed}: ${why}); history rounds never count`);
    }
    if (allowed === 'PASSED') {
      current.forEach((x, i) => {
        if (x.status === 'DEFERRED') {
          c.warnings.push(`cases[${i}]: DEFERRED (${x.followUp}) is outside this PASSED verdict; list it in the report`);
        }
      });
    }
    // A retest never closes on a deferral (doctrine §5.4)
    if (bugStatus === 'RETEST PASSED' && !current.some(x => x.status === 'PASSED')) {
      c.error('bug.status', 'RETEST PASSED needs a current case observed PASSED');
    }
    if (bugStatus === 'RETEST FAILED' && !current.some(x => x.status === 'FAILED')) {
      c.error('bug.status', 'RETEST FAILED needs a current case observed FAILED');
    }
  }

  if (c.errors.length > 0) {
    return { ok: false, errors: c.errors, warnings: c.warnings };
  }
  return { ok: true, pack: pack as unknown as Pack, warnings: c.warnings };
}

// ============================================================================
// GEOMETRY (needs the image sizes, so the builder runs it after reading them)
// ============================================================================

export interface Size { width: number, height: number }

/** A box in fractions of the image. `px` boxes are divided by the natural size. */
export function toFraction(box: { x: number, y: number, w: number, h: number, coords?: Coords }, size: Size): { x: number, y: number, w: number, h: number } {
  if (box.coords === 'fraction') {
    return { x: box.x, y: box.y, w: box.w, h: box.h };
  }
  return { x: box.x / size.width, y: box.y / size.height, w: box.w / size.width, h: box.h / size.height };
}

export function pointToFraction(point: Point, coords: Coords | undefined, size: Size): Point {
  return coords === 'fraction' ? point : [point[0] / size.width, point[1] / size.height];
}

const EPSILON = 1e-6;

function inside(f: { x: number, y: number, w: number, h: number }): boolean {
  return f.x >= -EPSILON && f.y >= -EPSILON && f.x + f.w <= 1 + EPSILON && f.y + f.h <= 1 + EPSILON;
}

function pointInside(p: Point): boolean {
  return p[0] >= -EPSILON && p[1] >= -EPSILON && p[0] <= 1 + EPSILON && p[1] <= 1 + EPSILON;
}

function markInside(mark: Mark, size: Size): boolean {
  if (mark.shape === 'arrow') {
    return pointInside(pointToFraction(mark.from as Point, mark.coords, size)) && pointInside(pointToFraction(mark.to as Point, mark.coords, size));
  }
  if (mark.shape === 'path') {
    return (mark.points as Point[]).every(p => pointInside(pointToFraction(p, mark.coords, size)));
  }
  return inside(toFraction(mark as Required<Pick<Mark, 'x' | 'y' | 'w' | 'h'>> & Mark, size));
}

/** Every redaction and mark lies inside its image. */
export function checkGeometry(pack: Pack, sizes: Readonly<Record<string, Size>>): string[] {
  const errors: string[] = [];
  for (const [key, decl] of Object.entries(pack.images ?? {})) {
    const size = sizes[key];
    if (size === undefined) {
      continue;
    }
    (decl.redact ?? []).forEach((box, i) => {
      if (!inside(toFraction(box, size))) {
        errors.push(`images.${key}.redact[${i}]: lies outside the ${size.width}x${size.height} image`);
      }
    });
  }
  const walk = (cases: Case[], prefix: string) => cases.forEach((x, i) => (x.evidence ?? []).forEach((item, j) => {
    if (item.type !== 'image') {
      return;
    }
    const size = sizes[item.image];
    (item.marks ?? []).forEach((mark, k) => {
      if (size !== undefined && !markInside(mark, size)) {
        errors.push(`${prefix}[${i}].evidence[${j}].marks[${k}]: lies outside the ${size.width}x${size.height} image ${JSON.stringify(item.image)}`);
      }
    });
  }));
  walk(pack.cases, 'cases');
  (pack.history ?? []).forEach((round, r) => walk(round.cases, `history[${r}].cases`));
  return errors;
}
