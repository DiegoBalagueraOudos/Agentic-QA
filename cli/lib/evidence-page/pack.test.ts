/* eslint-disable ts/no-explicit-any -- these tests mutate valid packs into invalid shapes on purpose */
import { describe, expect, it } from 'bun:test';

import { demoBugPack, demoStoryPack } from './demo.ts';
import { checkGeometry, GENERIC_TICKET_KEY, validatePack, verdictOf } from './pack.ts';
import { BUG_BUCKET_OF, EVIDENCE_STATUSES, TONE_OF } from './statuses.ts';

const note = [{ type: 'note', text: 'observed' }];

function story(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...structuredClone(demoStoryPack()), ...overrides };
}

function errorsOf(raw: unknown, pattern?: RegExp): string[] {
  const result = validatePack(raw, { ticketKeyPattern: pattern ?? GENERIC_TICKET_KEY });
  return result.ok ? [] : result.errors;
}

describe('the shared status enum', () => {
  it('has a tone for every status and one list for all of them', () => {
    for (const status of EVIDENCE_STATUSES) {
      expect(TONE_OF[status]).toBeDefined();
    }
    expect(EVIDENCE_STATUSES).toContain('RETEST PASSED');
    expect(EVIDENCE_STATUSES).toContain('NOT RUN');
  });

  it('maps bug statuses onto the board bug buckets', () => {
    expect(BUG_BUCKET_OF['RETEST PASSED']).toBe('resolved');
    expect(BUG_BUCKET_OF['RETEST FAILED']).toBe('open');
  });
});

describe('validatePack', () => {
  it('accepts both demo packs', () => {
    expect(validatePack(demoStoryPack()).ok).toBe(true);
    expect(validatePack(demoBugPack()).ok).toBe(true);
  });

  it('names the JSON path of a bad enum value and lists the allowed ones', () => {
    const pack = story();
    (pack.cases as any)[0].evidence[0].marks[0].shape = 'circle';
    expect(errorsOf(pack)).toEqual(['cases[0].evidence[0].marks[0].shape: "circle" is not one of rect | ellipse | arrow | path | bubble']);
  });

  it('refuses a bug status on a case (one enum, per-field subsets)', () => {
    const pack = story();
    (pack.cases as any)[0].status = 'RETEST PASSED';
    expect(errorsOf(pack)[0]).toStartWith('cases[0].status: "RETEST PASSED" is not one of PASSED | FAILED | NOT RUN | BLOCKED | DEFERRED');
  });

  it('refuses unknown fields so a typo never drops evidence silently', () => {
    const pack = story();
    (pack.cases as any)[2].evidance = [];
    expect(errorsOf(pack)[0]).toStartWith('cases[2].evidance: is not a field');
  });

  it('requires a title on every case', () => {
    const pack = story();
    delete (pack.cases as any)[0].title;
    expect(errorsOf(pack)).toContain('cases[0].title: is required');
  });

  it('checks ticket keys against the project pattern', () => {
    expect(errorsOf(story(), /^BK-\d+$/)).toContain('ticket.id: "DEMO-101" does not match the ticket key pattern ^BK-\\d+$');
  });

  it('PASSED and FAILED need an observation, BLOCKED a reason, DEFERRED a reason and a follow-up', () => {
    const pack = story({
      ticket: { id: 'DEMO-1', title: 't', verdict: 'FAILED' },
      cases: [
        { title: 'a', status: 'PASSED' },
        { title: 'b', status: 'FAILED', evidence: note },
        { title: 'c', status: 'BLOCKED' },
        { title: 'd', status: 'DEFERRED', reason: 'flag off' },
      ],
      bugs: undefined,
    });
    expect(errorsOf(pack)).toEqual([
      'cases[0].evidence: a PASSED case needs at least one evidence item (PASSED and FAILED only on observation)',
      'cases[2].reason: a BLOCKED case needs the reason it was not run',
      'cases[3].followUp: a DEFERRED case needs the follow-up ticket key that records the deferral',
    ]);
  });

  it('refuses a verdict the current cases contradict, ignoring history', () => {
    const pack = story({
      ticket: { id: 'DEMO-1', title: 't', verdict: 'PASSED' },
      cases: [{ title: 'a', status: 'PASSED', evidence: note }, { title: 'b', status: 'NOT RUN' }],
      history: [{ round: 1, cases: [{ title: 'old', status: 'FAILED', evidence: note }] }],
      bugs: undefined,
    });
    expect(errorsOf(pack)).toEqual(['ticket.verdict: PASSED contradicts the current cases (they allow PENDING: cases[1] is NOT RUN); history rounds never count']);
  });

  it('a PASSED verdict stands over a FAILED history round, and deferrals warn', () => {
    const pack = story({
      ticket: { id: 'DEMO-1', title: 't', verdict: 'PASSED' },
      cases: [{ title: 'a', status: 'PASSED', evidence: note }, { title: 'b', status: 'DEFERRED', reason: 'r', followUp: 'DEMO-9' }],
      history: [{ round: 1, cases: [{ title: 'old', status: 'FAILED', evidence: note }] }],
      bugs: undefined,
    });
    const result = validatePack(pack);
    expect(result.ok).toBe(true);
    expect(result.warnings).toEqual(['cases[1]: DEFERRED (DEMO-9) is outside this PASSED verdict; list it in the report']);
  });

  it('verdictOf: only deferrals is PENDING, never PASSED', () => {
    expect(verdictOf([{ status: 'DEFERRED' }])).toBe('PENDING');
    expect(verdictOf([{ status: 'PASSED' }, { status: 'BLOCKED' }])).toBe('PENDING');
    expect(verdictOf([{ status: 'PASSED' }, { status: 'FAILED' }])).toBe('FAILED');
  });

  it('a retest closes only on an observed case', () => {
    const bug = structuredClone(demoBugPack()) as any;
    bug.bug.status = 'RETEST PASSED';
    expect(errorsOf(bug)).toContain('bug.status: RETEST PASSED needs a current case observed PASSED');
    bug.bug.status = 'RETEST FAILED';
    bug.cases = [{ title: 'r', status: 'DEFERRED', reason: 'x', followUp: 'DEMO-5' }];
    expect(errorsOf(bug)).toContain('bug.status: RETEST FAILED needs a current case observed FAILED');
  });

  it('a bug pack needs its bug block; a story pack cannot carry one', () => {
    const bug = structuredClone(demoBugPack()) as any;
    delete bug.bug;
    expect(errorsOf(bug)).toContain('bug: is required on a bug pack (status, expected, actual, repro)');
    expect(errorsOf(story({ bug: { status: 'OPEN' } }))).toContain('bug: belongs to a bug pack; a story lists the bugs it filed in bugs[]');
  });

  it('an image item must reference a declared image', () => {
    const pack = story();
    (pack.cases as any)[0].evidence[0].image = 'nope';
    expect(errorsOf(pack)).toContain('cases[0].evidence[0].image: "nope" is not declared in images');
  });
});

describe('checkGeometry', () => {
  it('refuses a redaction or a mark outside its image, px and fraction alike', () => {
    const pack = structuredClone(demoBugPack());
    pack.images!.error.redact = [{ x: 900, y: 10, w: 100, h: 10 }];
    (pack.cases[0].evidence![0] as any).marks = [{ shape: 'rect', coords: 'fraction', x: 0.5, y: 0.5, w: 0.6, h: 0.1 }];
    expect(checkGeometry(pack, { error: { width: 960, height: 600 } })).toEqual([
      'images.error.redact[0]: lies outside the 960x600 image',
      'cases[0].evidence[0].marks[0]: lies outside the 960x600 image "error"',
    ]);
  });

  it('accepts the demo geometry', () => {
    expect(checkGeometry(demoStoryPack(), { form: { width: 960, height: 600 }, error: { width: 960, height: 600 } })).toEqual([]);
  });
});
