---
name: test-automation-local
description: "Local-files variant (no Jira, no Xray, no TMS) of /test-automation. Plans, writes and reviews KATA Playwright tests for the manual-test cases kept as Markdown files under the project's QA root, one ATC per case id, and keeps their state through `bun run qa:local`. Entry points: next <N>, ola <K>, prefix <P>, case <ID>. Use for: automatizar casos locales, siguiente lote de casos candidatos, automatizar la ola 1, automatizar AUT-002, escribir el ATC de un caso local, login con KATA sin Jira, bug de producto hallado al automatizar. Do NOT use when Jira/Xray is configured -> /test-automation. Do NOT use for documenting or re-judging verdicts (/test-documentation-local) or running suites (/regression-testing)."
license: MIT
compatibility: [claude-code, codex, opencode]
metadata:
  kind: workflow
  stage_owner: true
# compact_rules is consumed VERBATIM by scripts/build-skill-registry.ts. Keep it equal to
# the `## Compact Rules` section below.
compact_rules: |
  - Local files only. Cases are the Markdown tree under the QA root; contracts are `test-documentation-local/references/local-case-format.md` and `references/local-handoff.md`. Never call Jira, Xray or acli tools; Jira / Xray / TMS prose in a cited reference does not apply.
  - Plan -> Code -> Review, in order, never skipping Plan. Wait for plan approval before any code.
  - Only `candidate` + `pendiente` cases from `bun run qa:local next`. Never automate a `manual`, `deferred` or `no_aplica` verdict; never invent a missing precondition. The manual-run state of the user's matrix is not an input: every case is tested again from scratch, and the observations section is non-authoritative notes.
  - 1 ATC : 1 case id. `@atc('<case id>')` as a string literal; never merge case ids; an ATC never calls another ATC.
  - State changes ONLY through `bun run qa:local status|results|defect`. Never hand-edit case YAML (verdict, lifecycle, `id_defecto`, `automation`, `last_run`). Never re-rank `ola` / `prioridad`.
  - API-surface cases that need the project's API session fixture (for example an encrypted-session handshake, recorded in a project ADR) are NOT automated and NOT hand-rolled with plaintext calls: record the block in the plan and return them to the user.
  - Credentials come from `.env` at run time via `config.testUser`; the skill never reads, prints or writes them. Locators inline, role / visible text / `formControlName` first, extracted only at 2+ uses.
  - Never put `@step` or `@atc` on a method whose arguments carry a token, cookie or credential: the decorator masks only a short list of key names. A token in an explicit header is wrapped so a transport failure rethrows a sanitised error. `trace: 'off'` at FILE level in a spec that handles a live session token. After any Code or fix step the orchestrator searches the generated report folders for token patterns (counts only).
  - A failing automated run is a new finding. Only after it fails may `qa:local defect <ID> <ref>` record a reference, and only then, if the user keeps the test green, annotate `test.fail(true, 'DEFECT <ref>')` while still asserting the CORRECT behaviour. How `test.fail` composes with `@atc` is unverified: confirm on the first such case.
  - Product bug found by a failing test: a failure judged a product defect is handed to `/bug-report-local`, which proposes the report and waits for the user's OK; this skill does not file the bug.
  - The test command may print all-passed and still end with exit code 9 (a Bun teardown assertion on Windows): judge the run by the report lines and `reports/atc_results.json`, report the observed code, never fix the runtime from a case. Types and lint must still exit 0.
  - Review needs the 3 verifiers (`test`, `types:check`, `lint:check`) plus a REQUIRED separate verifier (`/pr-review-lead` or `/judgment-day`) that did not write the code. On any failure STOP: retry / skip / abort, no auto-fix.
---

## Forbidden invocations

**NEVER invoke `/sdd-*` skills from this workflow.** This skill ships self-contained. To change the framework, `scripts/` or this skill itself, exit and use `/framework-development`. Boundary enforced by `scripts/lint-skills.ts`; see `.agents/skills/agentic-qa-core/references/skill-composition-strategy.md` §4.

# Test Automation Local — Plan, Code, Review

Turn the manual-test cases that already live as local Markdown files into KATA-compliant Playwright tests. No Jira, no Xray, no TMS: the case files, `bun run qa:local` and `reports/atc_results.json` are the whole traceability system.

Same doctrine and pipeline as `/test-automation` (Plan -> Code -> Review), with the case id replacing the ticket id. The test-documentation side (format, verdict, state script) belongs to `/test-documentation-local`; this skill consumes its `candidate` + `pendiente` cases.

---

## Dependencies

Requires `agentic-qa-core`. Loads on demand:

- `references/local-handoff.md` — **MANDATORY first read.** Case -> ATC mapping, locator baseline for the SPA, results flow, known defects and product bugs, the Bun exit code, surface api vs ui, adaptation checklist, which original references are usable.
- `test-documentation-local/references/local-case-format.md` — the case file contract and the `qa:local` verbs.
- `test-automation/references/kata-architecture.md`, `typescript-patterns.md`, `e2e-patterns.md`, `test-data-management.md`, `review-checklists.md` — KATA doctrine, cited by path. Their Jira / Xray / TMS sentences do not apply (`references/local-handoff.md` lists them).
- `agentic-qa-core/references/briefing-template.md`, `dispatch-patterns.md`, `orchestration-doctrine.md`, `session-management.md`, `stage-gates.md`, `session-footer-contract.md`, `skill-refinement-protocol.md`, `upstream-feedback.md` — cited inline where used.
- `/playwright-cli` (only browser path, for exploring screens) and `/playwright-best-practices` (loaded in every Code subagent).

## Compact Rules

- **Local only.** Cases are the Markdown tree under the QA root; contracts are `test-documentation-local/references/local-case-format.md` and `references/local-handoff.md`. Never call Jira, Xray or acli tools; Jira / Xray / TMS prose in a cited reference does not apply.
- **Plan -> Code -> Review, in order.** Never skip Plan; wait for the user's approval of the plan before any code.
- **Only `candidate` + `pendiente`** cases from `bun run qa:local next`. Never automate a `manual`, `deferred` or `no_aplica` verdict; never invent a missing precondition. The manual-run state of the user's matrix is not an input: every case is tested again from scratch, and the observations section is non-authoritative notes.
- **1 ATC : 1 case id.** `@atc('<case id>')` as a string literal; never merge case ids into one ATC; an ATC never calls another ATC.
- **State only through the script.** `bun run qa:local status|results|defect`. Never hand-edit case YAML (verdict, lifecycle, `id_defecto`, `automation`, `last_run`). Never re-rank `ola` / `prioridad`.
- **API surface is gated.** Cases needing the project's API session fixture (for example an encrypted-session handshake, recorded in a project ADR) are NOT automated and NOT hand-rolled with plaintext calls: record the block in the plan and return them to the user.
- **No secrets.** Credentials come from `.env` at run time via `config.testUser`; the skill never reads, prints or writes them. Locators inline, role / visible text / `formControlName` first, extracted only at 2+ uses.
- **Secrets never reach a step title.** Never put `@step` or `@atc` on a method whose arguments carry a token, cookie or credential: the decorator masks only a short list of key names. A token in an explicit header is wrapped so a transport failure rethrows a sanitised error. `trace: 'off'` at FILE level in a spec that handles a live session token. After any Code or fix step the orchestrator searches the generated report folders for token patterns (counts only).
- **A failing automated run is a new finding.** Only after it fails may `qa:local defect <ID> <ref>` record a reference, and only then, if the user keeps the test green, annotate `test.fail(true, 'DEFECT <ref>')` while still asserting the CORRECT behaviour. How `test.fail` composes with `@atc` is unverified: confirm on the first such case.
- **Product bug found by a failing test.** A failure judged a product defect is handed to `/bug-report-local`, which proposes the report and waits for the user's OK; this skill does not file the bug.
- **Bun exit code.** The test command may print all-passed and still end with exit code 9 (a Bun teardown assertion on Windows): judge the run by the report lines and `reports/atc_results.json`, report the observed code, never fix the runtime from a case. Types and lint must still exit 0.
- **Review is gated.** 3 verifiers (`test`, `types:check`, `lint:check`) plus a REQUIRED separate verifier (`/pr-review-lead` or `/judgment-day`) that did not write the code. On any failure STOP: retry / skip / abort, no auto-fix.

---

## Entry points

First token of `$ARGUMENTS` selects the input; the rest is forwarded.

| Invocation | Cases taken |
|---|---|
| `next <N>` | the first N rows of `bun run qa:local next <N>` |
| `ola <K>` | the queue of `bun run qa:local next 1000 --ola <K>` |
| `prefix <P>` | the queue of `bun run qa:local next 1000 --prefix <P>` |
| `case <ID>` | one case; it must appear in the queue, or the skill says why it does not (its verdict is not `candidate`, or its lifecycle is not `pendiente`) and stops |

No argument or an unknown first token: list the four entry points and ask.

---

## Subagent Dispatch Strategy

> **Orchestration & Session contracts**: this skill follows `agentic-qa-core/references/orchestration-doctrine.md` (mandatory subagent dispatch, main thread is command center) AND `agentic-qa-core/references/session-management.md` (Phase 0 resume check, plan-first persistence, archive on completion). The orchestrator applies the Definition-of-Done gates in `agentic-qa-core/references/stage-gates.md` before recording a checkpoint and advancing.

This skill is **per-scope**. `<scope>` is lowercase kebab-case: `ola-1`, `aut`, `aut-002`, `next-5-<YYYY-MM-DD>`. Session state lives at `.session/test-automation-local/<scope>/{plan.md, progress.md}`; it is a thin index that cites the automation plan in the QA root, never a copy of it.

Every dispatch follows the 7-component briefing in `agentic-qa-core/references/briefing-template.md`; the pattern per step follows `agentic-qa-core/references/dispatch-patterns.md`. A briefing always lists: the case ids, the context docs (`references/local-handoff.md`, the case files, `kata-manifest.json`, the KATA references cited there), the allowed writes (plan, components, fixture registration, specs, and `qa:local` verbs only), the forbidden actions (Compact Rules), the return shape (changed files with one line each), the DoD and the error protocol.

- **Playwright craft guidance by file.** Every Code, Plan and Review briefing gives, as a file to read, the SKILL.md of the Playwright best-practices skill in the skills folder of the user profile, plus the project-level copy if present, because the Skill tool cannot load that skill inside a subagent. Keep the instruction to load it with the Skill tool where the host allows.

| Step | Pattern | Subagent role |
|---|---|---|
| Phase 0 and the readiness preflight | inline | orchestrator only |
| Phase 1 — Plan | Single | one Plan subagent reads the cases, the manifest and the screens (via `/playwright-cli`) and returns the plan |
| Phase 2 — Code | Sequential | one Code subagent per component group; edits many files in isolation |
| Phase 3 — `test` / `types:check` / `lint:check` | Parallel | three Verifier subagents |
| Phase 3 — separate verifier | Single | `/pr-review-lead` or `/judgment-day` in a clean context; never the Code subagent |
| Phase 3 — aggregation, `results --accept`, `index` | inline | the orchestrator runs the state-changing verbs itself, in order |

- **Code phase scope rule**: the orchestrator reads the summary a Code subagent returns, not the diffs; it runs `git diff` inline if the user wants them.
- **On any failure**: STOP, return the failing report verbatim, present **retry / skip / abort**. No auto-fix, no re-dispatch of Code without approval, no auto-rollback of `qa:local` state.
- **Blocker or a skill defect** (a wrong step, a rule that contradicts the script): report it upstream per `agentic-qa-core/references/upstream-feedback.md` — drafted and redacted locally, filed only on explicit OK, verified with `gh issue view`.

---

## Session banner

Print once at start, before anything else:

```
test-automation-local | scope: <scope> | input: <next N | ola K | prefix P | case ID>
cases: <ids> | plan: <awaiting|approved> | phase: <0|1|2|3>
```

---

## Phase 0 — Resume check and scope (MANDATORY, inline)

1. Resolve the prospective `<scope>` from the invocation (`ola 1` -> `ola-1`, `prefix AUT` -> `aut`, `case AUT-002` -> `aut-002`, `next 5` -> `next-5-<date>`). A scope that does not match the shape above is renamed, not used as typed.
2. Check `.session/test-automation-local/<scope>/progress.md`.
3. Absent: continue to the readiness preflight.
   Present: read `plan.md` and the tail of `progress.md`; show the last completed phase, the next phase and the cases already moved to `en_automatizacion`; offer **resume / restart / abort**. On `restart`, archive to `.session/.archive/<YYYY-MM-DD>-test-automation-local-<scope>-aborted/` first.

## Readiness preflight (MANDATORY, before Phase 1)

Doctrine: `agentic-qa-core/references/preflight-gate.md` (args are answers; probe, do not assume; one checklist; STOP on a blocking RED). Probes, read-only; the checklist form of the adaptation items is in `references/local-handoff.md`:

| Probe | RED means |
|---|---|
| Framework adapted: the `Example*` scaffold signals of `preflight-gate.md` §4 are absent and the login component is the project's own | STOP. Hand the user `/test-framework-adaptation` (and `/project-discovery` first when the context is missing). Never run them yourself. |
| Environment reachable, base URL known | STOP and ask which URL runs. |
| Test-user credentials present in `.env` for the active environment, checked by `bun run vars:check` only | STOP. The user fills `.env`; the skill never opens or prints it. |
| Playwright browsers installed (`bun run pw:install` available) | Offer the install, with approval. |
| `bun run qa:local check` shows 0 ERROR | STOP and show the lines; nothing is planned on an inconsistent store. |
| `kata-manifest.json` clean (`bun run kata:manifest:check`) | Offer `bun run kata:manifest`. |
| `/playwright-cli` available (UI scope) | STOP and name how to enable it. |

Surface the REDs as ONE checklist. Continue only when every blocking row is GREEN.

---

## Phase 1 — Plan

Dispatch: **Single** Plan subagent (briefing per `agentic-qa-core/references/briefing-template.md`).

1. **Ask once, up front**: whether review fixes that stay inside the approved scope may be applied without asking each round (default: ask). Record the answer in the session `progress.md`.
2. **Maps first.** Behaviour facts come from the generated context maps with `bun run context:map <slug> --section <id>`; cite the section in the plan (for example "from map <slug>#<section>"). Product source is read only for execution details the maps do not carry: a numeric threshold, how a timer or limiter is implemented, exact endpoint paths, what the fixtures already support.
3. **Take the cases** from `bun run qa:local next` per the entry point. Read each case file (frontmatter and the three body sections; also `## Precondiciones` / `## Pasos` / `## Datos` when `/test-documentation-local design` added them).
4. **Gate each case**: not `candidate` + `pendiente` -> excluded with the reason; if one is hand-picked, say why it is refused. A case that failed or was blocked in a previous manual run is planned like any other: that history is background, not a gate. A case found infeasible while planning goes back to the user as `/test-documentation-local verdict <ID> manual "<reason>"`.
5. **Classify the surface** per case, `ui` or `api` (`references/local-handoff.md` §5). An `api` case needing the project's API session fixture (for example an encrypted-session handshake, recorded in a project ADR) is **not automated**: the plan lists it as blocked with the fixture named, and it is returned to the user. Never write plaintext calls to get around it.
6. **Anti-duplication**: load `kata-manifest.json`; no `@atc` id may already exist for a case, and an existing component is extended, never duplicated.
7. **Explore the real screens** with `/playwright-cli` (the only browser path), read-only, to get role / visible-text / `formControlName` locators. Locators are verified, not guessed.
8. **Group the cases into components** (for example the four login cases into one login page component) and decide fixture per `references/local-handoff.md` and the KATA fixture rules: UI only -> `{ ui }`.
9. **Test data**: variable names only; discover, modify or generate per `test-automation/references/test-data-management.md`; credentials by `config.testUser`.
10. **Check the saved-session question** from `references/local-handoff.md` §6 against `playwright.config.ts`; record the finding in the plan.
11. **Write the plan** to the automation folder of the QA root, `automation/<scope>/automation-plan.md`, with this shape:

```
.context/QA/automation/<scope>/automation-plan.md
  ## Cases            id | surface | verdict gate | component.method | spec path
  ## Excluded         id | reason (verdict, lifecycle, api blocked)
  ## Components       new vs extended, fixture, locators found
  ## Test data        variable names and source
  ## Risks           lockout, shared state, session handling
```

Also write the thin session index `.session/test-automation-local/<scope>/plan.md` (goal, inputs, approach, phases, risks, verification checklist).

Present the plan and **wait for approval**. After approval append the Phase 1 entry to `progress.md`.

## Phase 2 — Code

Dispatch: **Sequential**, one Code subagent per component group. Each subagent loads `/playwright-best-practices` alongside this skill, plus `test-automation/references/kata-architecture.md`, `typescript-patterns.md` and `e2e-patterns.md`.

1. **Open the lifecycle** per case, before the first line of code:
   `bun run qa:local status <ID> en_automatizacion --atc <ID> --spec <path> --surface e2e`
   (`--surface api` for an api case; the script accepts `e2e` or `api`). Use `--dry-run` first when unsure.
2. Implement in this order:
   1. **Types** at the top of the component file.
   2. **Component** extending the base class: helpers first (no decorator), then ATCs with `@atc('<case id>')`, a complete mini-flow named `{verb}{Resource}{Scenario}`.
   3. **Fixture registration** in the UI fixture (or API fixture); Steps classes are instantiated directly, not registered.
   4. **Spec** under `tests/e2e/<module>/` (or `tests/integration/<module>/`), one `test()` per case, titled with the case id.
3. **Per spec**, in this order:

```bash
bun run test <path/to/spec>
bun run types:check
bun run lint:check
```

4. **Tests always assert the CORRECT behaviour** from `## Resultado esperado`, never the bug. A failing run is a new finding (Phase 3). Only after it fails, once the user gave a reference and decided to keep the suite green, the test gets `test.fail(true, 'DEFECT <ref>')`. **Unverified**: how `test.fail` interacts with the `@atc` decorator (which records FAIL and rethrows inside `test.step`). Validate it on the FIRST such case, alone, before batching more. Fallback if it does not compose: a conditional skip plus a status field, with no change to the case format. Record the outcome in the session `progress.md` and propose a refinement.
5. A case that cannot be completed: `bun run qa:local status <ID> pendiente` (with the user's OK) and report why.
6. After each Code subagent returns, append a Phase 2 entry to `progress.md` listing changed files and cases.

## Phase 3 — Review

Dispatch: **Parallel**, then **Single** for the separate verifier. Checklists: `test-automation/references/review-checklists.md` (cited by path; its TMS lines do not apply — the equivalent here is that every `@atc` id equals a case id with a case file).

1. **Three verifiers in parallel**, each in its own subagent: `bun run test <scope specs>`, `bun run types:check`, `bun run lint:check`. Types and lint exit 0, zero retries used. The test command is judged by its report lines and `reports/atc_results.json`: it may print the all-passed summary and still end with exit code 9 (see `references/local-handoff.md` section 4b); mention the observed code in the session report and do not try to fix the runtime from a case.
2. **Separate verifier (REQUIRED)**: `/pr-review-lead` or `/judgment-day` against the diff, in a clean context that did not write the code. Skipping it is a Review DoD failure. Pass it the case files and the plan so it checks 1 ATC : 1 case id, correct-behaviour assertions, and no plaintext API shortcuts.
3. **Aggregate.** Any failure: STOP, show the report verbatim, offer **retry / skip / abort**. No auto-fix.
   - After every fix agent the orchestrator itself re-runs the whole suite, types, lint and manifest regeneration BEFORE re-launching the blind judges.
   - The judges get identical briefs: the same target, criteria and round history.
   - A finding rated differently by the two judges is triaged by the orchestrator with evidence and shown to the user, never silently dropped.
   - Fixes that stay inside the approved scope follow the answer recorded in Phase 1 (default: ask each round).
4. On ACCEPT, the orchestrator runs, in order:

```bash
bun run kata:manifest
bun run test <scope specs>
bun run qa:local results --accept --scope <scope>
bun run qa:local check
bun run qa:local index
```

   `results --accept` moves `en_automatizacion` cases to `automatizado` only when the ATC passed in the ingested run (or `EXPECTED_FAIL` for a known defect); a case that did not pass stays `en_automatizacion` and is reported. `UNEXPECTED_PASS` is reported as "defect probably fixed" and never closed automatically.
5. A failing automated test judged a PRODUCT defect is a new finding: it is not fixed here and it gets no annotation until the user gives a reference through `qa:local defect`. Hand it off to `/bug-report-local <case id>` (summary in `references/local-handoff.md` section 4a); that skill proposes the report and waits for the user's OK, and this skill does not file the bug.
6. Append the Phase 3 entry to `progress.md`.

---

## Close (MANDATORY)

1. Light verifier: `bun run qa:local check` shows no ERROR; each case this session touched is `automatizado`, or still `en_automatizacion` with the reason shown, or `pendiente` by explicit decision; `bun run kata:manifest:check` is clean; every product bug found has its confirmed per-bug folder or an explicit decision not to record it.
2. Print the two chat blocks of `agentic-qa-core/references/session-footer-contract.md` (skills / MCPs / CLIs used and testing levels touched, with "none" where expected-but-untouched; screenshot paths verified on disk). Chat only.
3. Lessons noticed are PROPOSED to `.session/test-automation-local/<scope>/refinements.md` per `agentic-qa-core/references/skill-refinement-protocol.md`; never applied to a live skill.
4. Archive the session per `agentic-qa-core/references/session-management.md` (on REJECT do not archive).
5. **Next command**: the Local gate is green; this skill does not branch, push or open PRs. Hand off to `/git-flow-master` for the commit, and run `/test-automation-local next 5` for the next batch. Cases returned as infeasible or api-blocked go to `/test-documentation-local` (`verdict` or `triage`); API cases wait for the encrypted-session fixture, a separate `/framework-development` change.

---

## Anti-patterns

- **T1.** NEVER hand-edit case YAML or the generated `estado.md`; the script is the only writer.
- **T2.** NEVER write code before the plan is approved, even for one case.
- **T3.** NEVER put a selector in a case file, nor a credential or token anywhere in a spec, fixture or plan.
- **T4.** NEVER use `waitForTimeout`; wait for a condition. No retries to hide a flaky test.
- **T5.** NEVER assert the bug; assert the correct behaviour, and mark an expected failure only after a failing run, a user-given reference and the user's decision.
- **T6.** NEVER mix test code and product code, and never touch the framework, `scripts/` or `.env` from here: use `/framework-development` or the user.
- **T7.** NEVER put `@step` or `@atc` on a method whose arguments carry a token, cookie or credential: the decorator masks only a short list of key names, so a refresh token in a step title leaks to console and reports. Wrap a token travelling in an explicit header so a transport failure rethrows a sanitised error (no call log, no headers); use `trace: 'off'` at FILE level (not inside describe) in a spec that handles a live session token; after any Code or fix step search the generated report folders for token patterns (counts only, never printing values).
