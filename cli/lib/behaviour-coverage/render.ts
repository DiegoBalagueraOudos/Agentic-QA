/**
 * @fileoverview `gap-list.md`: the gap list for a person. Deterministic: the
 * same `GapList` renders the same text. Every count is shown with what it was
 * counted from, and a bucket the run could not measure says `unknown`, never 0.
 */

import type { Bucket, ClassifiedBehaviour, GapList } from './types.ts';

import { BUCKETS } from './types.ts';

const esc = (text: string): string => text.replace(/\|/g, '\\|').replace(/\n/g, ' ');

/** A bucket the sources could not measure: manual-only without the TMS, automated without the manifest. */
export function unmeasured(list: GapList): Set<Bucket> {
  const out = new Set<Bucket>();
  if (list.sources.tms.state !== 'read') { out.add('manual-only'); }
  if (list.sources.manifest.state !== 'read') { out.add('automated'); }
  return out;
}

function bucketCell(list: GapList, bucket: Bucket): string {
  const n = list.denominators.buckets[bucket];
  return unmeasured(list).has(bucket) ? `unknown (${n} judged, unverified)` : String(n);
}

function coveredCell(b: ClassifiedBehaviour): string {
  if (b.covered_by.length === 0) { return 'none'; }
  return b.covered_by.map((r) => {
    const flags = [r.verdict === 'weak' ? 'weak' : null, r.counted ? null : 'not counted', r.stale ? 'stale' : null, r.outside_regression ? 'outside regression' : null]
      .filter(Boolean);
    return `\`${r.test}\`${flags.length > 0 ? ` (${flags.join(', ')})` : ''}`;
  }).join(', ');
}

export function renderGapList(list: GapList): string {
  const s = list.sources;
  const d = list.denominators;
  const byId = new Map(list.behaviours.map(b => [b.id, b]));
  const out: string[] = [
    '# Coverage gap list',
    '',
    `Run \`${list.run_id}\` · generated ${list.generated_at} · by \`project-context\` mode \`coverage\``,
    '',
    '## Sources',
    '',
    '| Source | State |',
    '|---|---|',
    ...s.maps.map(m => `| ${m.skill} map | ${m.state}${m.state === 'generated' ? ` (${m.sections.length} sections)` : ''} |`),
    `| TMS (${s.tms.modality}) | ${s.tms.state}${s.tms.reason ? `: ${esc(s.tms.reason)}` : ''} |`,
    `| KATA manifest | ${s.manifest.state}${s.manifest.ref ? ` at ${s.manifest.ref}` : ''}${s.manifest.warning ? `: ${esc(s.manifest.warning)}` : ''} |`,
    `| MTP cache | ${s.mtp.state} (\`${s.mtp.path}\`) |`,
    '',
    '## Totals',
    '',
    `${d.behaviours} behaviours judged (from a seed of ${d.seed}; ${d.seed_unjudged} structured rule ids still unjudged). ${d.tests.inventory} tests in the inventory (${d.tests.automated} automated, ${d.tests.manual} manual).`,
    '',
    '| Bucket | Behaviours |',
    '|---|---|',
    ...BUCKETS.map(b => `| ${b} | ${bucketCell(list, b)} |`),
    `| **gaps** (weak + uncovered) | ${d.gaps} |`,
    '',
    '## Gaps, by MTP risk',
    '',
  ];
  if (list.gaps.length === 0) { out.push('No gaps among the judged behaviours.'); }
  else {
    out.push('| # | Risk | Bucket | Module | Behaviour | Covered by | Tech Story |', '|---|---|---|---|---|---|---|');
    list.gaps.forEach((id, i) => {
      const b = byId.get(id)!;
      out.push(`| ${i + 1} | ${b.risk ? `${b.risk.level} (${esc(b.risk.flow)})` : 'unranked'} | ${b.bucket} | ${esc(b.module)} | \`${b.id}\` ${esc(b.title)} | ${coveredCell(b)} | ${b.tech_story ?? '-'} |`);
    });
  }

  const covered = list.behaviours.filter(b => b.bucket === 'automated' || b.bucket === 'manual-only');
  out.push('', '## Covered', '');
  if (covered.length === 0) { out.push('None.'); }
  else {
    out.push('| Bucket | Module | Behaviour | Covered by |', '|---|---|---|---|');
    for (const b of covered) { out.push(`| ${b.bucket} | ${esc(b.module)} | \`${b.id}\` ${esc(b.title)} | ${coveredCell(b)} |`); }
  }

  const stale = list.behaviours.filter(b => b.stale || b.covered_by.some(r => r.stale));
  if (stale.length > 0) {
    out.push('', '## Stale judgments (re-judge first)', '', ...stale.map(b => `- \`${b.id}\`${b.stale ? ': its map text changed' : ''}${b.covered_by.some(r => r.stale) ? `: test changed (${b.covered_by.filter(r => r.stale).map(r => r.test).join(', ')})` : ''}`));
  }

  const diff = list.diff;
  out.push('', '## Since the previous run', '');
  if (!diff.previous_run) { out.push('First run: nothing to compare.'); }
  else {
    out.push(
      `Compared with \`${diff.previous_run}\`: ${diff.closed.length} closed, ${diff.regressed.length} regressed, ${diff.changed.length} changed bucket, ${diff.added.length} added, ${diff.removed.length} removed.`,
      ...diff.changed.map(c => `- \`${c.id}\`: ${c.from} -> ${c.to}`),
      ...diff.added.map(id => `- \`${id}\`: added`),
      ...diff.removed.map(id => `- \`${id}\`: removed`),
    );
  }

  const gapsSection: string[] = [];
  for (const m of s.maps) {
    if (m.state !== 'generated') { gapsSection.push(`- The ${m.skill} map is ${m.state}: its behaviours are not in this list. Run \`project-context ${m.map}\`.`); }
  }
  for (const bucket of unmeasured(list)) { gapsSection.push(`- \`${bucket}\` was not measured: ${bucket === 'automated' ? 'no KATA manifest' : `TMS not read${s.tms.reason ? ` (${esc(s.tms.reason)})` : ''}`}.`); }
  if (d.seed_unjudged > 0) { gapsSection.push(`- ${d.seed_unjudged} structured rule ids are not judged yet: ${list.unjudged_seed.slice(0, 20).map(id => `\`${id}\``).join(', ')}${d.seed_unjudged > 20 ? ', ...' : ''}`); }
  for (const w of list.warnings) { gapsSection.push(`- ${w}`); }
  out.push('', '## Discovery Gaps', '', ...(gapsSection.length > 0 ? gapsSection : ['None recorded.']));
  return `${out.join('\n')}\n`;
}
