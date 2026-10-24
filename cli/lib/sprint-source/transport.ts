/**
 * @fileoverview The only door the Jira sources have to the network.
 *
 * Adapters receive a `Transport`, so their tests replay recorded responses and
 * never open a socket. The live one resolves the host through
 * `cli/lib/atlassian-instance.ts` (the yaml wins over a stale env copy) and
 * reads credentials by NAME only: `ATLASSIAN_EMAIL` / `ATLASSIAN_API_TOKEN`,
 * else the login `bun xray auth login` stored. Xray goes through the existing
 * `cli/xray` client, which owns its token.
 */

import { loadConfig } from '../../xray/lib/config.ts';
import { graphql } from '../../xray/lib/graphql.ts';
import { formatInstanceMismatchWarning, resolveAtlassianInstance } from '../atlassian-instance.ts';

export interface Transport {
  /** Jira REST: GET without a body, POST with one. `path` starts at `/rest/`. */
  jira: <T>(path: string, body?: unknown) => Promise<T>
  /** Xray Cloud GraphQL. */
  xray: <T>(query: string, variables: Record<string, unknown>) => Promise<T>
}

export interface JiraAuth { baseUrl: string, header: string }

/**
 * The Jira host and the Basic header, resolved once per call site: the host
 * from `.agents/project.yaml` (a stale env copy only warns), the credentials by
 * NAME from the environment, else the `bun xray auth login` store. Throws with
 * the variable names when either is missing; never prints a value.
 */
export function jiraAuth(): JiraAuth {
  const instance = resolveAtlassianInstance();
  const warning = formatInstanceMismatchWarning(instance);
  if (warning) { console.warn(warning); }
  const stored = loadConfig();
  const email = process.env.ATLASSIAN_EMAIL || stored?.jira_email;
  const token = process.env.ATLASSIAN_API_TOKEN || stored?.jira_api_token;
  if (!email || !token) {
    throw new Error('Jira credentials are not set: ATLASSIAN_EMAIL and ATLASSIAN_API_TOKEN (see .env.example), or run `bun xray auth login` with --jira-* flags.');
  }
  return { baseUrl: instance.baseUrl, header: `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}` };
}

/**
 * One Jira REST call with any verb, for the writers (the evidence tracker
 * adapter). An empty response body (a `PUT` answers 204) returns `null`.
 */
export async function jiraRequest<T>(auth: JiraAuth, method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<T | null> {
  const response = await fetch(`${auth.baseUrl}${path}`, {
    method,
    headers: { 'Authorization': auth.header, 'Accept': 'application/json', 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new JiraHttpError(method, path, response.status, `${response.statusText}${detail ? ` ${detail.slice(0, 300)}` : ''}`);
  }
  const text = await response.text();
  return text === '' ? null : JSON.parse(text) as T;
}

/** A Jira REST call that answered with an error status; `status` lets a caller fall back (a 400 on a field). */
export class JiraHttpError extends Error {
  constructor(readonly method: string, readonly path: string, readonly status: number, detail: string) {
    super(`Jira REST ${method} ${path} failed: ${status} ${detail}`);
    this.name = 'JiraHttpError';
  }
}

export function liveTransport(): Transport {
  let auth: JiraAuth | null = null;
  const credentials = (): JiraAuth => {
    auth ??= jiraAuth();
    return auth;
  };

  return {
    async jira<T>(path: string, body?: unknown): Promise<T> {
      const { baseUrl, header } = credentials();
      const response = await fetch(`${baseUrl}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'Authorization': header, 'Accept': 'application/json', 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (!response.ok) { throw new Error(`Jira REST ${path} failed: ${response.status} ${response.statusText}`); }
      return (await response.json()) as T;
    },
    async xray<T>(query: string, variables: Record<string, unknown>): Promise<T> {
      return graphql<T>(query, variables);
    },
  };
}
