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

export function liveTransport(): Transport {
  let auth: { baseUrl: string, header: string } | null = null;
  const credentials = (): { baseUrl: string, header: string } => {
    if (auth) { return auth; }
    const instance = resolveAtlassianInstance();
    const warning = formatInstanceMismatchWarning(instance);
    if (warning) { console.warn(warning); }
    const stored = loadConfig();
    const email = process.env.ATLASSIAN_EMAIL || stored?.jira_email;
    const token = process.env.ATLASSIAN_API_TOKEN || stored?.jira_api_token;
    if (!email || !token) {
      throw new Error('Jira credentials are not set: ATLASSIAN_EMAIL and ATLASSIAN_API_TOKEN (see .env.example), or run `bun xray auth login` with --jira-* flags.');
    }
    auth = { baseUrl: instance.baseUrl, header: `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}` };
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
