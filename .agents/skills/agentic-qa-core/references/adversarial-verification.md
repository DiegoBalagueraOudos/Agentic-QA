# Adversarial Verification and Tie-break

> Cited by: `exploratory-testing` (its Refute and Tie-break steps), `sprint-testing`
> (`references/exploration-patterns.md` §"Finding triage", before a finding becomes a bug proposal).
> Companions: `./defect-management-doctrine.md` (how a surviving finding is classified and filed),
> `./discovery-driven-doctrine.md` §4 (a surviving finding on behaviour with no AC is still `observed`,
> and a person decides whether it is intended), `./dispatch-patterns.md` (the Parallel pattern the
> verifiers use).

Read this when verifying an anomaly before it is reported. This is what separates an evidence-backed
finding from a plausible-looking one: a recon pass produces leads, and a lead becomes a finding only after
someone whose job is to kill it has failed to.

---

## 1. The refute mandate

For every anomaly with a `severity_hypothesis` of Medium or higher, dispatch a **Parallel** verifier per
`./dispatch-patterns.md` whose job is not to confirm it but to **refute** it. Give it the anomaly and
instruct it to actively try to explain it away as:

- a join fan-out (the "duplicate" is really N legitimate rows from a 1:N join, not one row counted twice),
- a data quirk (a known-weird-but-intended value, such as a legacy migration artifact),
- intended behaviour (the code does exactly what the business rule says, just not what a guide or a
  map says),
- a harness artifact (the recon agent's own query, fixture or role produced the anomaly, not the app).

**A finding survives only if the verifier cannot refute it.** When two verifiers reach different
verdicts on the same finding, do not average them or pick the more alarming one: escalate to the
tie-break (§4).

This inverts the usual review posture on purpose. An agent asked "is this a bug?" tends to agree with
whatever framing it is handed. An agent asked "prove this is NOT a bug" has to do real verification work
to close out cleanly, which is exactly the discipline that catches an over-eager first read.

---

## 2. Check the row's own invariant, not just that it differs from another row

Measured, then rule: a first verifier dismissed two rows as "two different kinds of line, not a
duplicate" because they differed in the fields that define their kind. That check compared the rows **to
each other**. It never checked whether the disputed row satisfied **its own** rule. It did not: its total
broke the formula its own fields define, and it matched the other row's total exactly. That is a copy,
not a coincidence of two valid values, and it was a real defect.

**The rule.** When verifying an anomaly in a computed value (money, a count, a status derived from other
fields), always ask two questions, not one:

1. Does this row satisfy **its own** stated invariant (formula, constraint, state rule), independent of
   any other row? Prove the invariant on an undisputed row first.
2. Does it also, suspiciously, match something it has no invariant-based reason to match?

A "no" to question 1 together with a "yes" to question 2 is strong evidence of a real bug. A "yes" to
question 1 usually means the anomaly is a false positive, however question 2 comes out.

---

## 3. Execute the competing hypotheses, never infer them

When a verifier's argument depends on "the live path behaves like X", it runs the actual query, API call
or UI flow and pastes the command and its output, side by side with the competing hypothesis's command
and output. Inferring the mechanism from a response shape, a code read or "this looks like the buggy
path" is not verification: a right verdict with an unexecuted mechanism still propagates the wrong
mechanism into the bug report and from there into the fix.

This is the same posture as the observation rule (`./discovery-driven-doctrine.md` §5.2): evidence about
the system is not an execution of it.

---

## 4. The tie-break belongs to the conductor

When two verifiers disagree, or one verifier's refutation depends on an assumption nobody can check
without reading more code, the session that owns the run resolves it itself. A third verifier hoping for
a majority only adds noise on top of two inconclusive opinions.

**Resolve it with:**

1. A decisive query or API call that distinguishes the two hypotheses (not a repeat of either verifier's
   own query).
2. A direct read of the code path that is actually live (the backend or frontend repository named in
   `.agents/project.yaml`): which route, handler and caller a real user reaches, not what a guide says
   should happen.

**Never let one agent's verdict stand unchallenged on a data-integrity, money or security finding.** These
are the categories where both errors cost most: a real defect reported as refuted, or a wrong mechanism
reaching an engineer who did not write the code.

Measured, then rule: two verifiers disagreed on whether a module with visibly wrong arithmetic was live.
The tie-break was a router read plus a navigation check, which showed the module served only a hidden
legacy route no menu links to. The defect was real, but its severity dropped to match how few users can
reach it. Map endpoint -> handler -> caller -> navigation entry before sizing any finding on a screen.

---

## 5. Known false-positive trap categories

Traps that already produced a false positive once are recorded so the next run does not rediscover them.
The instances are project facts and live in the project's own record (the module's `## Module Context (QA)`
section, or `agent-project.md`); this file keeps only the categories:

| Category | Shape | Check before reporting |
|---|---|---|
| Hidden twin | a legacy or unlinked screen, route or job that consumes different code than the customer-facing one | map endpoint -> handler -> caller -> navigation entry; size severity by reachability |
| Placeholder values | sentinel data (hashes of empty strings, default ids, seed rows) that a naive aggregate counts as real | exclude the sentinels explicitly in the detection query and say which ones |
| Sparse environment data | a test environment with too little recent activity to observe "regressed this sprint" | say so in the finding; date it by the closest creation timestamp, never by a business date |
| Schema drift | a column, enum or field that the project docs describe differently from the live store | read the live schema before writing a query that leans on a name |

A verifier that hits one of these writes it into the finding's "why it was refuted" line, so the record
explains itself.
