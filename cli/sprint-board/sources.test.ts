import { describe, expect, it } from 'bun:test';
import { liveProgressSection, parseLiveProgress } from './sources.ts';

// The pattern liveProgressSection replaced, kept only as the reference it must match.
// eslint-disable-next-line regexp/no-super-linear-backtracking, regexp/no-contradiction-with-assertion
const ORIGINAL = /^## Live Progress\s*$([\s\S]*?)(?=^## |Z)/m;

/** What parseLiveProgress actually consumes: non-blank trimmed lines. */
const lines = (body: string | null | undefined) =>
  body == null ? null : body.split('\n').map(l => l.trim()).filter(Boolean);

const CASES: Record<string, string> = {
  'section then next heading': '# T\n## Live Progress\n- [10:00] a\n- [10:05] b\n## Next\n- x\n',
  'blank and indented lines after header': '## Live Progress  \n\n   \n- a\n\t\n- b\n## Other\n',
  'CRLF line endings': '## Live Progress\r\n- a\r\n- b\r\n## Other\r\n',
  'first header lacks end, second has one': '## Live Progress\n- a\n## Live Progress\n- b\n## End\n',
  'header with trailing text is not a header': '## Live Progress (old)\n- a\n## X\n',
  'no header at all': '# Memory\n- nothing\n',
  'empty section': '## Live Progress\n## Next\n',
};

describe('liveProgressSection', () => {
  // A measured bug: the original ended a section at a literal `Z` instead of end of input.
  it('keeps lines after a UTC timestamp (was cut at the Z)', () => {
    const md = '## Live Progress\n- 2026-10-06 ~14:58Z ALL STAGES DONE\n- later\n';
    expect(lines(liveProgressSection(md))).toEqual(['- 2026-10-06 ~14:58Z ALL STAGES DONE', '- later']);
  });
  it('a header at the very end is an empty section (was no section)', () => {
    expect(lines(liveProgressSection('x\n## Live Progress'))).toEqual([]);
  });
  it('reads a section that runs to the end of the file (was empty)', () => {
    expect(lines(liveProgressSection('## Live Progress\n- a\n- b\n'))).toEqual(['- a', '- b']);
  });

  for (const [name, md] of Object.entries(CASES)) {
    it(`matches the original pattern: ${name}`, () => {
      expect(lines(liveProgressSection(md))).toEqual(lines(ORIGINAL.exec(md)?.[1]));
    });
  }
});

describe('parseLiveProgress times', () => {
  it('reads [HH:MM] even with no space after it, and a bare HH:MM followed by a space', () => {
    const lines = parseLiveProgress('## Live Progress\n- [10:05]RUNNING stage 2\n- 14:02 Stage 1 done\n', '2026-01-14');
    expect(lines.map(l => [l.at, l.text])).toEqual([['2026-01-14T10:05:00Z', 'RUNNING stage 2'], ['2026-01-14T14:02:00Z', 'Stage 1 done']]);
  });
});
