import { readFileSync } from 'node:fs';

import { describe, expect, test } from 'bun:test';

import { buildManifest, extractAskIds, extractPhases, MANIFEST_PATH, readSources } from '../scripts/gen-install-manifest.ts';

// The manifest generator validates its hand-written half (phases, steps,
// prompts, prerequisites) against the installer sources. Each test below
// mutates one source the way a real change would and expects the build to
// refuse, so `check:manifest` cannot pass on a manifest that lies.

const real = readSources();

function buildError(mutate: (s: typeof real) => Partial<typeof real>): string {
  try {
    buildManifest({ ...real, ...mutate(real) });
  }
  catch (err) {
    return (err as Error).message;
  }
  return '';
}

describe('installer manifest', () => {
  test('the committed manifest is what the generator builds from the current installer', () => {
    const committed = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as unknown;
    expect(committed).toEqual(JSON.parse(JSON.stringify(buildManifest(real))));
  });

  test('phases follow cli/lib/ui/installer-run.ts, in order', () => {
    const manifest = buildManifest(real) as { phases: { id: string }[] };
    expect(manifest.phases.map(p => p.id)).toEqual(extractPhases(real.installerRun).map(p => p.id));
  });

  test('a phase added to installer-run.ts without steps fails the build', () => {
    const msg = buildError(s => ({ installerRun: s.installerRun.replace('{ id: \'done\', title: \'Done\'', '{ id: \'deploy\', title: \'Deploy\', hint: \'x\' },\n      { id: \'done\', title: \'Done\'') }));
    expect(msg).toContain('phase "deploy"');
  });

  test('phases run out of the declared order fail the build', () => {
    const msg = buildError(s => ({ installerRun: s.installerRun.replace(/(\{ id: 'creds'[^\n]*\n)(\s*\{ id: 'jira'[^\n]*\n)/g, '$2$1') }));
    expect(msg).toContain('before');
  });

  test('a step whose code is gone fails the build', () => {
    const msg = buildError(s => ({ install: s.install.replaceAll('\'jira:sync-link-types\'', '\'jira:sync-other\'') }));
    expect(msg).toContain('jira:sync-link-types');
  });

  test('a new prompt no step declares fails the build', () => {
    const msg = buildError(s => ({ install: `${s.install}\nawait ask<boolean>({ id: 'brand-new-question', kind: 'confirm' });\n` }));
    expect(msg).toContain('"brand-new-question"');
  });

  test('template prompt ids are captured as prefix-*', () => {
    // eslint-disable-next-line no-template-curly-in-string
    expect(extractAskIds('await ask<string>({\n  id: `var-${name}`,')).toEqual(['var-*']);
  });

  test('a new blocking preflight check no prerequisite names fails the build', () => {
    const msg = buildError(s => ({ preflight: s.preflight.replace('const [npm, gh, pw, siteR]', 'checks.push({ id: \'ram\', group: L.machine, label: \'RAM\', value: \'-\', state: \'block\', neededBy: \'install\' });\n  const [npm, gh, pw, siteR]') }));
    expect(msg).toContain('preflight check "ram"');
  });
});
