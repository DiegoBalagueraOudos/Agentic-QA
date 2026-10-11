#!/usr/bin/env bun
/**
 * @fileoverview The preflight of `bun run up` (installer-ui `preflight.md` §3):
 * everything that would make the update fail halfway, checked in seconds,
 * before any question and any write.
 *
 *   bun cli/preflight.ts --for up [--json]
 *
 * `--json` prints the checklist (id, group, verdict, observed, needed_by, fix)
 * and exits 0 (all clear), 1 (warnings) or 2 (something blocks), for CI and
 * agents. The updater imports `runPreflight` in-process and renders the same
 * rows in the terminal and in the page. `--for setup` arrives with delivery 3.
 *
 * Built-ins only (`node:*` and sibling files that are `node:*` too), proven by
 * `cli/lib/ui/imports.test.ts`: it is the one check that must work on a clone
 * with no `node_modules`.
 *
 * Shared file: byte-identical in agentic-qa-boilerplate and agentic-dev-boilerplate.
 */

import type { Check, Lang } from './lib/ui/events.ts';

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { formatBytes, freeBytes, isLocalSource, parseVersion, reachable, readJson, runCmd, versionAtLeast, worktreeInfo } from './lib/probes.ts';
import { BRAND } from './lib/ui/brand.ts';

export type Verdict = 'clear' | 'warn' | 'block';

export interface PreflightCheck extends Check {
  id: string
  /** The page phase that fails without it. */
  neededBy: string
  /** The command that fixes it, when there is one. */
  fix?: string
}

export interface PreflightResult {
  checks: PreflightCheck[]
  verdict: Verdict
  /** One line for the verdict bar. */
  text: string
  ms: number
}

export interface UpPreflightOptions {
  cwd: string
  /** `owner/repo` (through gh) or a local clone path (plain git, no gh session). */
  templateRepo: string
  /** Repo-relative path of the update lock. */
  lockFile: string
  lang: Lang
  /** Rows the caller adds (a pending cross-harness migration, for instance). */
  extra?: PreflightCheck[]
  /** Free-space threshold below which `disk` warns. Default 500 MB. */
  minFreeBytes?: number
}

const T = {
  es: {
    tools: 'Herramientas',
    net: 'Red',
    machine: 'Esta máquina',
    bunMsg: 'Instala Bun 1.0 o más nuevo: <code>curl -fsSL https://bun.sh/install | bash</code>.',
    nodeMsg: 'Los hooks de tu agente corren con Node. Instala Node 18+ (nodejs.org o <code>brew install node</code>). La actualización sigue sin él.',
    gitMissing: 'git no está instalado. El actualizador necesita git 2.25 o más nuevo.',
    gitOld: (v: string): string => `Tu git es ${v}. El actualizador necesita 2.25+: <code>brew upgrade git</code> / <code>apt install git</code>.`,
    ghMissing: 'El actualizador descarga el boilerplate con GitHub CLI. Instálalo (cli.github.com) y corre <code>gh auth login</code>.',
    ghAuth: 'GitHub CLI no tiene sesión. Corre <code>gh auth login</code> y vuelve a comprobar.',
    ghLocal: 'fuente local, no hace falta',
    netMsg: 'GitHub no responde. Revisa tu conexión o tu VPN; no se cambió nada.',
    wtMsg: (p: string): string => `Corre el actualizador en el checkout principal (<code>${p}</code>), no en un worktree. Los worktrees reciben la actualización cuando haces merge.`,
    wtOk: 'checkout principal',
    lockCorrupt: (f: string): string => `El lock de actualización está dañado. Restáuralo con <code>git checkout -- ${f}</code>.`,
    lockOld: 'Tu lock usa un formato anterior y se va a migrar (sin cambiar datos).',
    lockMissing: 'primera actualización',
    diskLow: 'Poco espacio para la descarga temporal y la copia de seguridad.',
    free: 'libres',
    clear: (n: number, s: string): string => `Todo listo: ${n} comprobaciones en ${s} s.`,
    warn: (n: number): string => `Nada bloquea. ${n} aviso(s): revisa las filas marcadas.`,
    block: (n: number): string => `${n} cosa(s) impiden empezar. Arréglalas y vuelve a comprobar; no se cambió nada.`,
  },
  en: {
    tools: 'Tools',
    net: 'Network',
    machine: 'This machine',
    bunMsg: 'Install Bun 1.0 or newer: <code>curl -fsSL https://bun.sh/install | bash</code>.',
    nodeMsg: 'Your agent\'s hooks run on Node. Install Node 18+ (nodejs.org or <code>brew install node</code>). The update continues without it.',
    gitMissing: 'git is not installed. The updater needs git 2.25 or newer.',
    gitOld: (v: string): string => `Your git is ${v}. The updater needs 2.25+: <code>brew upgrade git</code> / <code>apt install git</code>.`,
    ghMissing: 'The updater downloads the boilerplate with GitHub CLI. Install it (cli.github.com) and run <code>gh auth login</code>.',
    ghAuth: 'GitHub CLI has no session. Run <code>gh auth login</code> and check again.',
    ghLocal: 'local source, not needed',
    netMsg: 'GitHub does not answer. Check your connection or VPN; nothing was changed.',
    wtMsg: (p: string): string => `Run the updater from the main checkout (<code>${p}</code>), not from a worktree. Worktrees receive the update when you merge.`,
    wtOk: 'main checkout',
    lockCorrupt: (f: string): string => `The update lock is damaged. Restore it with <code>git checkout -- ${f}</code>.`,
    lockOld: 'Your lock uses an older format and will be migrated (no data changes).',
    lockMissing: 'first update',
    diskLow: 'Low disk space for the temporary download and the backup.',
    free: 'free',
    clear: (n: number, s: string): string => `All set: ${n} checks in ${s} s.`,
    warn: (n: number): string => `Nothing blocks. ${n} warning(s): see the marked rows.`,
    block: (n: number): string => `${n} thing(s) stop the start. Fix them and check again; nothing was changed.`,
  },
} as const;

export function verdictOf(checks: Check[]): Verdict {
  if (checks.some(c => c.state === 'block')) { return 'block'; }
  if (checks.some(c => c.state === 'warn')) { return 'warn'; }
  return 'clear';
}

export async function runUpPreflight(o: UpPreflightOptions): Promise<PreflightResult> {
  const t0 = Date.now();
  const L = T[o.lang];
  const local = isLocalSource(o.templateRepo);
  const checks: PreflightCheck[] = [];

  // Network first: it is the only slow probe, so it runs while the rest is checked.
  const net = local ? null : reachable('https://github.com', 3000);

  // Tools
  const bunV = process.versions.bun ?? '';
  checks.push(versionAtLeast(parseVersion(bunV), [1, 0, 0])
    ? { id: 'bun', group: L.tools, label: 'Bun', value: bunV, state: 'ok', neededBy: 'fetch' }
    : { id: 'bun', group: L.tools, label: 'Bun', value: bunV || '-', state: 'block', msg: L.bunMsg, neededBy: 'fetch' });

  // Warn, not block, for `up`: the updater itself never runs node, and CI
  // images built on Bun alone have none (preflight.md asks block for setup).
  const node = runCmd('node', ['--version'], { timeoutMs: 2000 });
  const nodeV = parseVersion(node.stdout);
  checks.push(node.ok && versionAtLeast(nodeV, [18, 0, 0])
    ? { id: 'node', group: L.tools, label: 'Node', value: node.stdout.replace(/^v/, ''), state: 'ok', neededBy: 'apply' }
    : { id: 'node', group: L.tools, label: 'Node', value: node.ok ? node.stdout : '-', state: 'warn', msg: L.nodeMsg, neededBy: 'apply' });

  const git = runCmd('git', ['--version'], { timeoutMs: 2000 });
  const gitV = parseVersion(git.stdout);
  if (!git.ok) {
    checks.push({ id: 'git-version', group: L.tools, label: 'git', value: '-', state: 'block', msg: L.gitMissing, neededBy: 'fetch' });
  }
  else if (!versionAtLeast(gitV, [2, 25, 0])) {
    checks.push({ id: 'git-version', group: L.tools, label: 'git', value: gitV?.join('.') ?? git.stdout, state: 'block', msg: L.gitOld(gitV?.join('.') ?? git.stdout), neededBy: 'fetch', fix: 'brew upgrade git' });
  }
  else {
    checks.push({ id: 'git-version', group: L.tools, label: 'git', value: gitV!.join('.'), state: 'ok', neededBy: 'fetch' });
  }

  if (local) {
    checks.push({ id: 'gh-auth', group: L.tools, label: 'GitHub CLI', value: L.ghLocal, state: 'info', neededBy: 'fetch' });
  }
  else {
    const gh = runCmd('gh', ['auth', 'status'], { timeoutMs: 4000 });
    if (gh.missing) {
      checks.push({ id: 'gh-auth', group: L.tools, label: 'GitHub CLI', value: '-', state: 'block', msg: L.ghMissing, neededBy: 'fetch' });
    }
    else if (!gh.ok) {
      checks.push({ id: 'gh-auth', group: L.tools, label: 'GitHub CLI', value: '-', state: 'block', msg: L.ghAuth, neededBy: 'fetch', fix: 'gh auth login' });
    }
    else {
      const ver = parseVersion(runCmd('gh', ['--version'], { timeoutMs: 2000 }).stdout);
      checks.push({ id: 'gh-auth', group: L.tools, label: 'GitHub CLI', value: ver ? ver.join('.') : 'ok', state: 'ok', neededBy: 'fetch' });
    }
  }

  // Machine
  const wt = worktreeInfo(o.cwd);
  if (wt?.linked) {
    checks.push({ id: 'worktree', group: L.machine, label: 'Checkout', value: 'worktree', state: 'block', msg: L.wtMsg(wt.primaryRoot ?? '…'), neededBy: 'fetch' });
  }
  else {
    checks.push({ id: 'worktree', group: L.machine, label: 'Checkout', value: L.wtOk, state: 'ok', neededBy: 'fetch' });
  }

  const lock = readJson(join(o.cwd, o.lockFile));
  if (lock.state === 'corrupt') {
    checks.push({ id: 'lock', group: L.machine, label: 'Lock', value: o.lockFile, state: 'block', msg: L.lockCorrupt(o.lockFile), neededBy: 'detect', fix: `git checkout -- ${o.lockFile}` });
  }
  else if (lock.state === 'missing') {
    checks.push({ id: 'lock', group: L.machine, label: 'Lock', value: L.lockMissing, state: 'info', neededBy: 'detect' });
  }
  else {
    const version = (lock.value as { schemaVersion?: unknown } | null)?.schemaVersion;
    checks.push(typeof version === 'number' && version < 7
      ? { id: 'lock', group: L.machine, label: 'Lock', value: `v${version}`, state: 'info', msg: L.lockOld, neededBy: 'detect' }
      : { id: 'lock', group: L.machine, label: 'Lock', value: typeof version === 'number' ? `v${version}` : 'ok', state: 'ok', neededBy: 'detect' });
  }

  const min = o.minFreeBytes ?? 500 * 1024 ** 2;
  const free = [freeBytes(tmpdir()), freeBytes(o.cwd)].filter((n): n is number => n !== null);
  const least = free.length ? Math.min(...free) : null;
  checks.push(least === null
    ? { id: 'disk', group: L.machine, label: 'Disco', value: '-', state: 'info', neededBy: 'apply' }
    : { id: 'disk', group: L.machine, label: o.lang === 'es' ? 'Disco' : 'Disk', value: `${formatBytes(least)} ${L.free}`, state: least < min ? 'warn' : 'ok', ...(least < min ? { msg: L.diskLow } : {}), neededBy: 'apply' });

  // Network
  if (net) {
    const r = await net;
    checks.push(r.ok
      ? { id: 'net-github', group: L.net, label: 'github.com', value: `${r.ms} ms`, state: 'ok', neededBy: 'fetch' }
      : { id: 'net-github', group: L.net, label: 'github.com', value: '-', state: 'block', msg: L.netMsg, neededBy: 'fetch' });
  }

  checks.push(...(o.extra ?? []));
  const verdict = verdictOf(checks);
  const ms = Date.now() - t0;
  const text = verdict === 'clear'
    ? L.clear(checks.length, (ms / 1000).toFixed(1).replace('.', o.lang === 'es' ? ',' : '.'))
    : verdict === 'warn'
      ? L.warn(checks.filter(c => c.state === 'warn').length)
      : L.block(checks.filter(c => c.state === 'block').length);
  return { checks, verdict, text, ms };
}

/** Markup-free text of a row message, for the terminal. */
export function plainMsg(msg: string): string {
  return msg.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

/** The checklist as the `--json` format: one object per row. */
export function preflightJson(r: PreflightResult): { verdict: Verdict, checks: { id: string, group: string, verdict: Check['state'], observed: string, needed_by: string, fix: string | null, message: string | null }[] } {
  return {
    verdict: r.verdict,
    checks: r.checks.map(c => ({ id: c.id, group: c.group ?? '', verdict: c.state, observed: c.value ?? '', needed_by: c.neededBy, fix: c.fix ?? null, message: c.msg ? plainMsg(c.msg) : null })),
  };
}

export function exitCodeOf(v: Verdict): number {
  return v === 'block' ? 2 : v === 'warn' ? 1 : 0;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const forIdx = argv.indexOf('--for');
  const target = forIdx >= 0 ? argv[forIdx + 1] : 'up';
  if (target !== 'up') {
    process.stderr.write(`preflight: --for ${target} is not available yet (only "up").\n`);
    process.exit(2);
  }
  const env = process.env;
  const lang: Lang = (env.LC_ALL || env.LC_MESSAGES || env.LANG || '').toLowerCase().startsWith('en') ? 'en' : 'es';
  const r = await runUpPreflight({
    cwd: process.cwd(),
    templateRepo: env.UPEX_TEMPLATE_REPO || BRAND.templateRepo,
    lockFile: '.template/boilerplate.lock.json',
    lang,
  });
  if (argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify(preflightJson(r), null, 2)}\n`);
  }
  else {
    for (const c of r.checks) {
      const g = c.state === 'ok' ? '✔' : c.state === 'warn' ? '▲' : c.state === 'block' ? '✖' : '–';
      process.stdout.write(`${g} ${c.label}  ${c.value ?? ''}${c.msg ? `\n    ${plainMsg(c.msg)}` : ''}\n`);
    }
    process.stdout.write(`${plainMsg(r.text)}\n`);
  }
  process.exit(exitCodeOf(r.verdict));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
