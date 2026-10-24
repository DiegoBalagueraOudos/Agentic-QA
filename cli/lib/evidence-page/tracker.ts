/**
 * @fileoverview The tracker side of the evidence page: put a bug's ONE thumbnail
 * into the tracker and link a published page from an issue (ADR-0021, its
 * tracker amendment; the `evidence-artifact` skill, `references/workflow.md` §3-§4).
 *
 *   attachThumbnail(BUG, png)   the PNG embedded at the END of the bug's Description
 *                               (append only), read back; a Description the edit
 *                               screen refuses falls back to a structured comment
 *   linkEvidence(KEY, page)     a remote link with a stable globalId (a retest
 *                               republishes to the same URL: one link, updated)
 *
 * Per modality: `jira-native` and `jira-xray` write through Jira REST; `jira-xray`
 * also reaches a Test Run when one is named (the PNG as run evidence, the TC deep
 * link appended to the run comment); `none` writes nothing and says where the
 * thumbnail and the link live.
 *
 * Every write is read back at its destination (Rule #16) and a mismatch is an
 * error naming what is missing. The network goes through an injected `TrackerIO`:
 * the live one reuses the repo's clients (the acli media helper for the upload and
 * the media id, `cli/lib/sprint-source/transport.ts` for JSON calls, `cli/xray` for
 * GraphQL), the tests replay recorded responses, and `--dry-run` runs the same code
 * against an in-memory tracker that only records the calls.
 */

import type { AttachmentDataInput } from '../../xray/types/index.ts';
import type { SourceKind } from '../sprint-source/types.ts';

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';

import { JiraHttpError } from '../sprint-source/transport.ts';

// ============================================================================
// IO
// ============================================================================

export type JiraMethod = 'GET' | 'POST' | 'PUT';

/** What the acli helper's upload returns (the first attachment of the response). */
export interface UploadedAttachment { id: string, filename: string, content: string, size?: number }

export interface TrackerIO {
  /** Jira REST JSON call; `null` for an empty body. Throws `JiraHttpError` on an error status. */
  jira: <T>(method: JiraMethod, path: string, body?: unknown) => Promise<T | null>
  /** `POST /rest/api/3/issue/{key}/attachments` (multipart `file`, `X-Atlassian-Token: no-check`). */
  upload: (issueKey: string, filePath: string) => Promise<UploadedAttachment>
  /** The media-services UUID behind an attachment's content URL (its redirect). */
  mediaId: (contentUrl: string) => Promise<string>
  /** Xray Cloud GraphQL. */
  xray: <T>(query: string, variables: Record<string, unknown>) => Promise<T>
  /** A Jira key to its numeric issue id (Xray takes ids). */
  issueId: (key: string) => Promise<string>
}

/** Xray queries and mutations used here, verbatim from `cli/xray/lib/graphql.ts` (passed in, so this module stays import-light). */
export interface XrayDocs {
  getTestExecution: string
  getTestRunById: string
  addEvidenceToTestRun: string
  updateTestRunComment: string
}

// ============================================================================
// RESULT
// ============================================================================

export type RunRef = { runId: string } | { test: string, execution: string };

export interface TrackerResult {
  ok: boolean
  /** What was written, skipped and read back, in order, one line each. */
  lines: string[]
  error?: string
  /** attach: the thumbnail is in the Description (or, after a fallback, the comment) and read back. */
  embedded?: boolean
  /** attach: the Description could not be written; the image went into a comment instead. */
  fellBack?: boolean
}

export interface EvidenceTracker {
  readonly kind: SourceKind
  attachThumbnail: (bugKey: string, pngPath: string, run?: RunRef) => Promise<TrackerResult>
  linkEvidence: (targetKey: string, page: { url: string, title?: string }, run?: RunRef & { caseId?: string }) => Promise<TrackerResult>
}

// ============================================================================
// ADF
// ============================================================================

export interface AdfNode { type: string, attrs?: Record<string, unknown>, content?: AdfNode[], text?: string }
export interface AdfDoc { type: 'doc', version: 1, content: AdfNode[] }

/** The media-node helpers of the acli skill (`.agents/skills/acli/scripts/jira-attach-media.ts`). */
export interface MediaHelpers {
  buildMediaNode: (mediaId: string, opts?: { width?: number, height?: number, alt?: string, layout?: string }) => AdfNode
  imageSize: (buf: Uint8Array) => { width: number, height: number } | null
}

/** Whether an ADF tree holds a `media` node with this id. */
export function adfHasMedia(node: unknown, mediaId: string): boolean {
  if (typeof node !== 'object' || node === null) { return false; }
  const n = node as AdfNode;
  if (n.type === 'media' && n.attrs?.id === mediaId) { return true; }
  return Array.isArray(n.content) && n.content.some(child => adfHasMedia(child, mediaId));
}

/** The document with one node appended at the end; a missing Description becomes a fresh doc. Never edits what is there. */
export function appendToDoc(doc: unknown, node: AdfNode): AdfDoc {
  const base = (typeof doc === 'object' && doc !== null && (doc as AdfDoc).type === 'doc' && Array.isArray((doc as AdfDoc).content))
    ? doc as AdfDoc
    : { type: 'doc' as const, version: 1 as const, content: [] };
  return { ...base, version: 1, content: [...base.content, node] };
}

// ============================================================================
// JIRA SHAPES (only the fields read)
// ============================================================================

interface JiraAttachment { id: string, filename: string, size?: number, content: string }
interface JiraIssueView { key: string, fields: { attachment?: JiraAttachment[], description?: unknown } }
interface JiraComment { id: string, body?: unknown }
interface JiraRemoteLink { id?: number | string, globalId?: string, object?: { url?: string, title?: string } }
interface XrayRun { id: string, comment?: string | null, evidence?: Array<{ id: string, filename: string }> | null, test?: { jira?: { key?: string } } }

const PNG_MAGIC = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];

export function isPng(bytes: Uint8Array): boolean {
  return bytes.length >= 8 && PNG_MAGIC.every((b, i) => bytes[i] === b);
}

/** The stable remote-link id of a page: the URL without its fragment, so a deep link and the page share one link. */
export function evidenceGlobalId(url: string): string {
  return `evidence-page:${url.split('#')[0]}`;
}

/** The TC deep link line the workflow appends to a run comment (`workflow.md` §3 step 6). */
export function deepLinkLine(url: string, ticketKey: string, caseId: string): string {
  return `Evidence: ${url.split('#')[0]}#${ticketKey}.${caseId}`;
}

// ============================================================================
// FACTORY
// ============================================================================

export function createEvidenceTracker(kind: SourceKind, io: TrackerIO, docs: XrayDocs, media: () => Promise<MediaHelpers>): EvidenceTracker {
  if (kind === 'none') { return noneTracker(); }
  const xray = kind === 'jira-xray';

  /** Resolve a Test Run before any write: a wrong TC or execution writes nothing. */
  const resolveRun = async (run: RunRef | undefined): Promise<XrayRun | null> => {
    if (run === undefined) { return null; }
    if (!xray) { throw new Error(`a Test Run is an Xray object; the ${kind} source has none (drop --run / --test / --exec)`); }
    let runId: string;
    if ('runId' in run) {
      runId = run.runId;
    }
    else {
      const execId = await io.issueId(run.execution);
      const exec = await io.xray<{ getTestExecution: { testRuns?: { results?: XrayRun[] } } | null }>(docs.getTestExecution, { issueId: execId });
      const found = exec.getTestExecution?.testRuns?.results?.find(r => r.test?.jira?.key === run.test);
      if (found === undefined) { throw new Error(`${run.test} has no run in ${run.execution}: add the test to the execution first (bun xray exec add-tests)`); }
      runId = found.id;
    }
    const read = await io.xray<{ getTestRunById: XrayRun | null }>(docs.getTestRunById, { id: runId });
    if (read.getTestRunById === null) { throw new Error(`Test Run ${runId} not found in Xray`); }
    return read.getTestRunById;
  };

  const readRun = async (id: string): Promise<XrayRun> => {
    const read = await io.xray<{ getTestRunById: XrayRun | null }>(docs.getTestRunById, { id });
    if (read.getTestRunById === null) { throw new Error(`Test Run ${id}: not found on read-back`); }
    return read.getTestRunById;
  };

  return {
    kind,

    async attachThumbnail(bugKey, pngPath, run) {
      const lines: string[] = [];
      try {
        const bytes = readPng(pngPath);
        const name = basename(pngPath);
        const target = await resolveRun(run);

        // 1. what the bug already holds
        const issuePath = `/rest/api/3/issue/${bugKey}?fields=attachment,description`;
        const before = await io.jira<JiraIssueView>('GET', issuePath);
        if (before === null) { throw new Error(`${bugKey}: empty response`); }
        const same = (before.fields.attachment ?? []).find(a => a.filename === name && a.size === bytes.length);
        let mediaId: string | null = null;
        if (same !== undefined) {
          mediaId = await io.mediaId(same.content);
          lines.push(`${bugKey}: ${name} is already attached (attachment ${same.id})`);
        }

        let embedded = false;
        let fellBack = false;
        if (mediaId !== null && adfHasMedia(before.fields.description, mediaId)) {
          lines.push(`${bugKey}: the thumbnail is already in the Description, nothing written`);
          embedded = true;
        }
        else {
          // 2. upload unless it is there, 3. its media id
          if (mediaId === null) {
            const uploaded = await io.upload(bugKey, pngPath);
            lines.push(`${bugKey}: attached ${uploaded.filename} (attachment ${uploaded.id})`);
            mediaId = await io.mediaId(uploaded.content);
          }
          const helpers = await media();
          const size = helpers.imageSize(bytes);
          const node = helpers.buildMediaNode(mediaId, { width: size?.width, height: size?.height, alt: name });

          // 4. append to the Description, or fall back to a structured comment
          let commentId: string | null = null;
          try {
            await io.jira('PUT', `/rest/api/3/issue/${bugKey}`, { fields: { description: appendToDoc(before.fields.description, node) } });
            lines.push(`${bugKey}: thumbnail appended to the end of the Description`);
          }
          catch (err) {
            if (!(err instanceof JiraHttpError) || err.status !== 400) { throw err; }
            const comment = await io.jira<JiraComment>('POST', `/rest/api/3/issue/${bugKey}/comment`, { body: evidenceCommentDoc(node) });
            if (comment === null || !comment.id) { throw new Error(`${bugKey}: the fallback comment returned no id`); }
            commentId = comment.id;
            fellBack = true;
            lines.push(`${bugKey}: the Description cannot be edited (HTTP 400: not on the edit screen?); thumbnail posted in an "Evidence" comment ${commentId} instead`);
          }

          // 5. read back at the destination
          const after = await io.jira<JiraIssueView>('GET', issuePath);
          const named = (after?.fields.attachment ?? []).filter(a => a.filename === name);
          if (named.length === 0) { throw new Error(`read-back: ${bugKey} holds no attachment named ${name}`); }
          if (!named.some(a => a.size === undefined || a.size === bytes.length)) { throw new Error(`read-back: ${bugKey} ${name} is ${named.map(a => a.size).join(' / ')} bytes, the file is ${bytes.length}`); }
          if (commentId === null) {
            if (!adfHasMedia(after?.fields.description, mediaId)) { throw new Error(`read-back: ${bugKey}'s Description does not hold media ${mediaId}`); }
          }
          else {
            const back = await io.jira<JiraComment>('GET', `/rest/api/3/issue/${bugKey}/comment/${commentId}`);
            if (!adfHasMedia(back?.body, mediaId)) { throw new Error(`read-back: comment ${commentId} on ${bugKey} does not hold media ${mediaId}`); }
          }
          embedded = true;
          lines.push(`read-back OK: ${bugKey} holds ${name} (${bytes.length} bytes) and the image is in its ${fellBack ? 'Evidence comment' : 'Description'}`);
        }

        // jira-xray: the same PNG as the Test Run's evidence
        if (target !== null) {
          if ((target.evidence ?? []).some(e => e.filename === name)) {
            lines.push(`Test Run ${target.id}: ${name} is already its evidence, nothing written`);
          }
          else {
            const evidence: AttachmentDataInput[] = [{ filename: name, mimeType: 'image/png', data: Buffer.from(bytes).toString('base64') }];
            await io.xray(docs.addEvidenceToTestRun, { id: target.id, evidence });
            const back = await readRun(target.id);
            if (!(back.evidence ?? []).some(e => e.filename === name)) { throw new Error(`read-back: Test Run ${target.id} evidence does not list ${name}`); }
            lines.push(`read-back OK: Test Run ${target.id} lists ${name} as evidence`);
          }
        }
        return { ok: true, lines, embedded, fellBack };
      }
      catch (err) {
        return { ok: false, lines, error: (err as Error).message };
      }
    },

    async linkEvidence(targetKey, page, run) {
      const lines: string[] = [];
      try {
        const target = await resolveRun(run);
        const globalId = evidenceGlobalId(page.url);
        const title = page.title ?? `${targetKey} Evidence page`;
        await io.jira('POST', `/rest/api/3/issue/${targetKey}/remotelink`, { globalId, relationship: 'Evidence', object: { url: page.url, title } });
        lines.push(`${targetKey}: remote link "${title}" -> ${page.url} (globalId ${globalId}: a republish updates it)`);
        const back = await io.jira<JiraRemoteLink | JiraRemoteLink[]>('GET', `/rest/api/3/issue/${targetKey}/remotelink?globalId=${encodeURIComponent(globalId)}`);
        const links = back === null ? [] : Array.isArray(back) ? back : [back];
        const found = links.find(l => l.globalId === globalId);
        if (found === undefined) { throw new Error(`read-back: ${targetKey} has no remote link with globalId ${globalId}`); }
        if (found.object?.url !== page.url) { throw new Error(`read-back: ${targetKey}'s evidence link points at ${found.object?.url ?? '(none)'}, not ${page.url}`); }
        lines.push(`read-back OK: ${targetKey} links ${page.url}`);

        if (target !== null) {
          const caseId = run?.caseId ?? target.test?.jira?.key;
          if (caseId === undefined) { throw new Error(`Test Run ${target.id}: no test key to name the case; pass --case <id>`); }
          const line = deepLinkLine(page.url, targetKey, caseId);
          const current = target.comment ?? '';
          if (current.split('\n').includes(line)) {
            lines.push(`Test Run ${target.id}: the comment already carries ${line}`);
          }
          else {
            await io.xray(docs.updateTestRunComment, { id: target.id, comment: current === '' ? line : `${current}\n${line}` });
            const after = await readRun(target.id);
            if (!(after.comment ?? '').split('\n').includes(line)) { throw new Error(`read-back: Test Run ${target.id} comment does not carry ${line}`); }
            lines.push(`read-back OK: Test Run ${target.id} comment carries ${line}`);
          }
        }
        return { ok: true, lines };
      }
      catch (err) {
        return { ok: false, lines, error: (err as Error).message };
      }
    },
  };
}

function noneTracker(): EvidenceTracker {
  return {
    kind: 'none',
    async attachThumbnail(bugKey, pngPath) {
      readPng(pngPath);
      return { ok: true, lines: [`no tracker (board.source none): nothing attached to ${bugKey}; the thumbnail stays at ${pngPath} and the report links it`], embedded: false };
    },
    async linkEvidence(targetKey, page) {
      return { ok: true, lines: [`no tracker (board.source none): nothing linked on ${targetKey}; the link lives in the pack's artifact.url and on the board (bun run board evidence-artifact ${targetKey} ${page.url})`] };
    },
  };
}

/** `## Evidence` + the image, the shape of the fallback comment (`.agents/jira-required.yaml` fallback convention). */
function evidenceCommentDoc(node: AdfNode): AdfDoc {
  return { type: 'doc', version: 1, content: [{ type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Evidence' }] }, node] };
}

function readPng(pngPath: string): Uint8Array {
  if (!existsSync(pngPath)) { throw new Error(`${pngPath}: no such file (build it with bun run evidence build --pack <bug pack> --thumb <png>)`); }
  const bytes = new Uint8Array(readFileSync(pngPath));
  if (!isPng(bytes)) { throw new Error(`${pngPath}: not a PNG by its bytes`); }
  return bytes;
}

// ============================================================================
// DRY RUN: the same code against an in-memory tracker that records every call
// ============================================================================

export interface DryRunIO extends TrackerIO { calls: string[] }

/** Long base64 payloads are printed by size, never inline. */
function printable(body: unknown): string {
  return JSON.stringify(body, (key, value) => (key === 'data' && typeof value === 'string' && value.length > 120 ? `<base64, ${value.length} chars>` : value));
}

/**
 * An empty tracker: every issue starts with no attachment, no Description, no
 * link; the named Test Run exists with no evidence and no comment. So the dry run
 * prints the calls of a first run; a live run reads first and may skip some.
 */
export function dryRunIO(run?: RunRef): DryRunIO {
  const calls: string[] = [];
  const issues = new Map<string, { attachments: JiraAttachment[], description: unknown, comments: JiraComment[], links: JiraRemoteLink[] }>();
  const issue = (key: string) => {
    let state = issues.get(key);
    if (state === undefined) {
      state = { attachments: [], description: null, comments: [], links: [] };
      issues.set(key, state);
    }
    return state;
  };
  const runs = new Map<string, XrayRun>();
  const runOf = (id: string): XrayRun => {
    let state = runs.get(id);
    if (state === undefined) {
      state = { id, comment: '', evidence: [], test: { jira: { key: run !== undefined && 'test' in run ? run.test : undefined } } };
      runs.set(id, state);
    }
    return state;
  };

  return {
    calls,
    async jira<T>(method: JiraMethod, path: string, body?: unknown): Promise<T | null> {
      calls.push(`${method} ${path}${body === undefined ? '' : ` ${printable(body)}`}`);
      const m = /^\/rest\/api\/3\/issue\/([^/?]+)(\/[^?]*)?(?:\?(.*))?$/.exec(path);
      if (m === null) { return null; }
      const [, key, sub = '', query = ''] = m;
      const state = issue(key);
      if (sub === '' && method === 'GET') { return { key, fields: { attachment: state.attachments, description: state.description } } as T; }
      if (sub === '' && method === 'PUT') {
        state.description = (body as { fields: { description: unknown } }).fields.description;
        return null;
      }
      if (sub === '/comment' && method === 'POST') {
        const comment = { id: '<new comment id>', body: (body as { body: unknown }).body };
        state.comments.push(comment);
        return comment as T;
      }
      if (sub.startsWith('/comment/')) { return (state.comments.find(c => c.id === decodeURIComponent(sub.slice('/comment/'.length))) ?? null) as T; }
      if (sub === '/remotelink' && method === 'POST') {
        const link = body as JiraRemoteLink;
        state.links = [...state.links.filter(l => l.globalId !== link.globalId), { ...link, id: '<link id>' }];
        return { id: '<link id>' } as T;
      }
      if (sub === '/remotelink') {
        const globalId = new URLSearchParams(query).get('globalId');
        return state.links.filter(l => globalId === null || l.globalId === globalId) as T;
      }
      return null;
    },
    async upload(issueKey, filePath) {
      const bytes = readFileSync(filePath);
      calls.push(`POST /rest/api/3/issue/${issueKey}/attachments multipart file=${basename(filePath)} (${bytes.length} bytes, sha256 ${createHash('sha256').update(bytes).digest('hex')}) header X-Atlassian-Token: no-check`);
      const attachment = { id: '<new attachment id>', filename: basename(filePath), size: bytes.length, content: '<attachment content url>' };
      issue(issueKey).attachments.push(attachment);
      return attachment;
    },
    async mediaId(contentUrl) {
      calls.push(`GET ${contentUrl} (redirect not followed: the media id is read from its Location)`);
      return '<media id>';
    },
    async xray<T>(query: string, variables: Record<string, unknown>): Promise<T> {
      const name = /\b(?:query|mutation)\s+(\w+)/.exec(query)?.[1] ?? 'GraphQL';
      calls.push(`Xray GraphQL ${name} ${printable(variables)}`);
      if (name === 'GetTestExecution') {
        return { getTestExecution: { testRuns: { results: [runOf('<run id>')] } } } as T;
      }
      if (name === 'GetTestRunById') { return { getTestRunById: runOf(String(variables.id)) } as T; }
      if (name === 'AddEvidenceToTestRun') {
        const target = runOf(String(variables.id));
        target.evidence = [...(target.evidence ?? []), ...(variables.evidence as AttachmentDataInput[]).map(e => ({ id: '<evidence id>', filename: e.filename }))];
        return { addEvidenceToTestRun: { addedEvidence: [], warnings: [] } } as T;
      }
      if (name === 'UpdateTestRunComment') {
        runOf(String(variables.id)).comment = String(variables.comment);
        return { updateTestRunComment: null } as T;
      }
      return {} as T;
    },
    async issueId(key) {
      calls.push(`GET /rest/api/3/issue/${key}?fields=issuetype (the numeric id Xray takes)`);
      return `<id of ${key}>`;
    },
  };
}

// ============================================================================
// LIVE
// ============================================================================

const ACLI_MEDIA_HELPER = '../../../.agents/skills/acli/scripts/jira-attach-media.ts';

/** The acli skill's media helpers, loaded only when a tracker write needs them. */
export async function loadMediaHelpers(): Promise<MediaHelpers & { readCredential: (name: string) => string | null, uploadAttachment: (key: string, path: string) => Promise<UploadedAttachment>, resolveMediaId: (url: string) => Promise<string> }> {
  return import(ACLI_MEDIA_HELPER);
}

/**
 * The live IO, built from the repo's existing clients. Both credential readers
 * (the acli helper reads the environment then `.env.local` / `.env`; the REST
 * transport reads the environment then the `bun xray auth login` store) are
 * checked BEFORE the first call, so a run never writes half of its steps.
 */
export async function liveTrackerIO(): Promise<{ io: TrackerIO, docs: XrayDocs }> {
  const helper = await loadMediaHelpers();
  const names = ['ATLASSIAN_EMAIL', 'ATLASSIAN_API_TOKEN'];
  const missing = names.filter(n => helper.readCredential(n) === null);
  if (missing.length > 0) {
    throw new Error(`Jira credentials not set for the upload: ${missing.join(', ')}. Fill them in .env (see .env.example), then restart the agent session.`);
  }
  const { jiraAuth, jiraRequest } = await import('../sprint-source/transport.ts');
  const auth = jiraAuth();
  const { graphql, MUTATIONS, QUERIES } = await import('../../xray/lib/graphql.ts');
  const { resolveIssueId } = await import('../../xray/lib/jira.ts');
  return {
    io: {
      jira: async (method, path, body) => jiraRequest(auth, method, path, body),
      upload: helper.uploadAttachment,
      mediaId: helper.resolveMediaId,
      xray: graphql,
      issueId: resolveIssueId,
    },
    docs: xrayDocs(QUERIES, MUTATIONS),
  };
}

export function xrayDocs(queries: Record<string, string>, mutations: Record<string, string>): XrayDocs {
  return {
    getTestExecution: queries.getTestExecution,
    getTestRunById: queries.getTestRunById,
    addEvidenceToTestRun: mutations.addEvidenceToTestRun,
    updateTestRunComment: mutations.updateTestRunComment,
  };
}
