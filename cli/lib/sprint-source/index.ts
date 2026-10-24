/**
 * @fileoverview Entry point of the sprint source layer (ADR-0019).
 *
 * `cli/sprint-board`, the Merge Line and the evidence page import from here:
 * load the config, build the source it names, take a snapshot.
 */

import type { BoardConfig } from './config.ts';
import type { NoneSourceOptions } from './none.ts';
import type { Transport } from './transport.ts';
import type { Source } from './types.ts';

import { createJiraNativeSource } from './jira-native.ts';
import { createJiraXraySource } from './jira-xray.ts';
import { createNoneSource } from './none.ts';
import { liveTransport } from './transport.ts';

export * from './config.ts';
export { CatalogStatusError } from './jira-common.ts';
export { TicketsFileError } from './none.ts';
export * from './status-map.ts';
export type { Transport } from './transport.ts';
export * from './types.ts';

export interface CreateSourceOptions extends NoneSourceOptions {
  /** Jira sources only; defaults to the live transport. */
  transport?: Transport
}

export function createSource(config: BoardConfig, options: CreateSourceOptions = {}): Source {
  switch (config.source) {
    case 'none': return createNoneSource(config, options);
    case 'jira-native': return createJiraNativeSource(config, options.transport ?? liveTransport());
    case 'jira-xray': return createJiraXraySource(config, options.transport ?? liveTransport());
  }
}
