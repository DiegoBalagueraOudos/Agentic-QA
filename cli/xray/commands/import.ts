/**
 * Xray CLI - Import Commands
 *
 * Commands: junit, cucumber, xray
 */

import type { Flags, ImportResult } from '../types/index.js';
import { existsSync, readFileSync } from 'node:fs';
import { findJunitCreations, findXrayJsonCreations, guardMessage } from '../lib/import-guard.js';
import { log } from '../lib/logger.js';
import { getFlag, requireFlag } from '../lib/parser.js';
import { restApi } from '../lib/rest.js';

// ============================================================================
// JUNIT
// ============================================================================

export async function junit(flags: Flags): Promise<void> {
  const file = requireFlag(flags, 'file');
  const projectKey = getFlag(flags, 'project');
  const testPlanKey = getFlag(flags, 'plan');
  const testExecKey = getFlag(flags, 'execution');

  if (!existsSync(file)) {
    throw new Error(`File not found: ${file}`);
  }

  const content = readFileSync(file, 'utf-8');

  // A testcase without a test_key / test_id becomes a NEW Generic Test in Xray.
  const creations = findJunitCreations(content);
  if (creations.length > 0) {
    throw new Error(guardMessage(file, creations));
  }

  log.dim(`Importing JUnit results from ${file}...`);

  let endpoint = '/import/execution/junit';
  const params = new URLSearchParams();
  if (projectKey) {
    params.append('projectKey', projectKey);
  }
  if (testPlanKey) {
    params.append('testPlanKey', testPlanKey);
  }
  if (testExecKey) {
    params.append('testExecKey', testExecKey);
  }

  const queryString = params.toString();
  if (queryString) {
    endpoint += `?${queryString}`;
  }

  const result = await restApi<ImportResult>(endpoint, {
    body: content,
    contentType: 'application/xml',
  });

  log.success('JUnit results imported');
  if (result.key) {
    console.log(`  Test Execution: ${result.key}`);
  }
  log.json(result);
}

// ============================================================================
// CUCUMBER
// ============================================================================

export async function cucumber(flags: Flags): Promise<void> {
  const file = requireFlag(flags, 'file');
  const projectKey = getFlag(flags, 'project');
  const testPlanKey = getFlag(flags, 'plan');
  const testExecKey = getFlag(flags, 'execution');

  if (!existsSync(file)) {
    throw new Error(`File not found: ${file}`);
  }

  const content = readFileSync(file, 'utf-8');

  log.dim(`Importing Cucumber results from ${file}...`);

  let endpoint = '/import/execution/cucumber';
  const params = new URLSearchParams();
  if (projectKey) {
    params.append('projectKey', projectKey);
  }
  if (testPlanKey) {
    params.append('testPlanKey', testPlanKey);
  }
  if (testExecKey) {
    params.append('testExecKey', testExecKey);
  }

  const queryString = params.toString();
  if (queryString) {
    endpoint += `?${queryString}`;
  }

  const result = await restApi<ImportResult>(endpoint, {
    body: content,
    contentType: 'application/json',
  });

  log.success('Cucumber results imported');
  log.json(result);
}

// ============================================================================
// XRAY JSON
// ============================================================================

export async function xray(flags: Flags): Promise<void> {
  const file = requireFlag(flags, 'file');

  if (!existsSync(file)) {
    throw new Error(`File not found: ${file}`);
  }

  const content = readFileSync(file, 'utf-8');

  // An entry with testInfo (or without testKey) can create a Test in Xray.
  const creations = findXrayJsonCreations(JSON.parse(content));
  if (creations.length > 0) {
    throw new Error(guardMessage(file, creations));
  }

  log.dim(`Importing Xray JSON results from ${file}...`);

  const result = await restApi<ImportResult>('/import/execution', {
    body: content,
    contentType: 'application/json',
  });

  log.success('Xray JSON results imported');
  log.json(result);
}
