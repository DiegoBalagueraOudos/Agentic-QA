---
name: test-documentation-local
description: "Local-files variant (no Jira, no Xray, no TMS) of /test-documentation. Triages, designs and gives an automation verdict to the manual-test cases kept as Markdown files under the project's QA root, and keeps their state through `bun run qa:local`. Modes: triage <scope> (is each case's verdict still right), design <ID> (add Precondiciones / Pasos / Datos), verdict <ID> <value> \"reason\", report (check + estado.md). Use for: documentar casos locales, veredicto de automatizacion, triage de una ola, disenar un caso AUT-002, candidate / manual / deferred / no_aplica, estado de automatizacion. Do NOT use when Jira/Xray is configured -> /test-documentation. Do NOT use for writing test code (/test-automation-local) or running suites (/regression-testing)."
license: MIT
compatibility: [claude-code, codex, opencode]
metadata:
  kind: workflow
  stage_owner: true
# compact_rules is consumed VERBATIM by scripts/build-skill-registry.ts. Keep it equal to
# the `## Compact Rules` section below.
compact_rules: |
  - Local files only. The case store is the Markdown tree under the QA root; the contract is `references/local-case-format.md`. Never read or write the user-story folder of the context tree, the Jira mirror (`.context/PBI/`) or any secret.
  - Never call Jira, Xray or acli tools, even if a cited reference says to. Jira / Xray / TMS prose inside a cited reference does not apply; `references/local-case-format.md` wins.
  - Verdict (`automatizacion`) and lifecycle (`estado_automatizacion`) change ONLY through `bun run qa:local verdict|status|defect|results`. Never hand-edit YAML for those fields or for `id_defecto`, `automation`, `last_run`.
  - Only `candidate` + `pendiente` cases are offered to automation. A `manual`, `deferred` or `no_aplica` case is never offered.
  - Priority (`ola`, `prioridad`) is user-owned. Never re-rank; `qa:local next` only sorts.
  - The manual-run state of the user's matrix is not an input: a case is its id, scenario and expected result, and every case is tested again from scratch. The observations section is non-authoritative notes of a previous manual run, never a gate.
  - Known defect only after a failing AUTOMATED run: `qa:local defect <ID> <ref>` is refused without `last_run.result=FAIL`; the reference comes from the user, never from prose. Never invent a missing precondition: propose `manual` or `deferred`.
  - The imported verdict is respected. Change it only when ROI or a hard blocker justifies it, record the reason, and tell the user.
---

## Forbidden invocations

**NEVER invoke `/sdd-*` skills from this workflow.** This skill ships self-contained. To change the framework, `scripts/` or this skill itself, exit and use `/framework-development`. Boundary enforced by `scripts/lint-skills.ts`; see `.agents/skills/agentic-qa-core/references/skill-composition-strategy.md` §4.

# Test Documentation Local

Take the manual-test cases that already live as local Markdown files, check that each case's automation verdict is right, add the business-level design the automation will need, and keep a trustworthy state per case. No Jira, no Xray, no TMS: the files and `bun run qa:local` are the whole system.

Same doctrine as `/test-documentation` (Analyze -> Prioritize (ROI) -> Document), applied to given cases instead of a ticket: the cases already exist, so this skill UPDATES them and never creates case ids silently.

---

## Dependencies

Requires `agentic-qa-core`. Loads on demand:

- `references/local-case-format.md` — **MANDATORY first read.** Fields, body sections, ID chain, verdict vs lifecycle, the known-defect rule, the `qa:local` verbs, the ROI procedure.
- `agentic-qa-core/references/test-design-doctrine.md` — Jira-free canon for technique-driven checks (EP / BVA / state / decision table / pairwise). Cited by path.
- `test-documentation/references/tms-conventions.md` §9 — ROI formula and bands only; ignore every TMS sentence around it.
- `agentic-qa-core/references/briefing-template.md`, `dispatch-patterns.md`, `orchestration-doctrine.md`, `session-management.md`, `session-footer-contract.md`, `skill-refinement-protocol.md`, `upstream-feedback.md` — cited inline where used.

## Compact Rules

- **Local only.** The case store is the Markdown tree under the QA root; its contract is `references/local-case-format.md`. Never read or write the user-story folder of the context tree, the Jira mirror (`.context/PBI/`) or any secret (`.env`, tokens, passwords).
- **No Jira tooling.** Never call Jira, Xray or acli tools. Jira / Xray / TMS prose inside a cited reference does not apply; `references/local-case-format.md` wins.
- **State only through the script.** Verdict and lifecycle change ONLY through `bun run qa:local verdict|status|defect|results`. Never hand-edit YAML for `automatizacion`, `estado_automatizacion`, `id_defecto`, `automation` or `last_run`. Run with `--dry-run` first when unsure.
- **Only `candidate` + `pendiente` is automated.** A `manual`, `deferred` or `no_aplica` case is never offered to automation.
- **Priority is not re-ranked.** `ola` and `prioridad` come from the user's index. `qa:local next` only sorts; propose a re-rank in chat, never apply it.
- **Manual-run state is not an input.** A case is its id, scenario and expected result; every case is tested again from scratch. The observations section is non-authoritative notes of a previous manual run, never a gate. Legacy manual-run fields in old files are tolerated and ignored.
- **Known defect only after a failing automated run.** `qa:local defect <ID> <ref>` is refused without `last_run.result=FAIL`; the reference comes from the user, never from prose. Only then, and only if the user keeps the test green, the expected-failure annotation applies and the test still asserts the CORRECT behaviour. Never invent a missing precondition: propose `manual` or `deferred`.
- **Respect the imported verdict.** Compute ROI only to justify a change. A change needs `--reason`, is shown to the user, and is never silent.
- **Existing fields and sections are never renamed or edited.** `design` only inserts the new sections between `## Resultado esperado` and `## Observaciones / evidencia de la ejecucion manual`.
- **Do not re-run the converter** in the QA root's `_tools/` folder over existing files once `qa:local` has written to them.
- **Selectors never enter case files.** Locators belong to automation, inline in the KATA component.

---

## Mode routing

First token of `$ARGUMENTS` is the mode; the rest is forwarded.

| Mode | Input | What it does |
|---|---|---|
| `triage <scope>` | `ola N`, a prefix (`AUT`), or case ids | Verify each case in scope: is the verdict still right? Propose changes, never apply silently. |
| `design <ID>` | one case id | Add `## Precondiciones`, `## Pasos`, `## Datos` from the case's own text, project context and a read-only look at the screen. |
| `verdict <ID> <value> "reason"` | id, `candidate\|manual\|deferred\|no_aplica`, reason | Set the verdict through `qa:local verdict`. |
| `report` | none | `qa:local check` + `qa:local index`, then show `estado.md`. |

No mode, or ambiguous: ask which one. Unknown first token: list the four modes.

---

## Subagent Dispatch Strategy

> **Orchestration & Session contracts**: this skill follows `agentic-qa-core/references/orchestration-doctrine.md` (mandatory subagent dispatch — main thread is command center) AND `agentic-qa-core/references/session-management.md` (Phase 0 resume check, plan-first persistence at `.session/<skill-slug>/<scope>/`, archive on completion). Phase 0 (resume check) and Phase 1 (plan write) are NOT optional. The orchestrator also applies the per-stage **Definition-of-Done gates** in `agentic-qa-core/references/stage-gates.md`: verify a stage's DoD (planning stages include the Test-Design Checklist) BEFORE recording its progress checkpoint and advancing.

This skill is **per-scope**. `<scope>` is lowercase kebab-case: `ola-1`, `aut`, `aut-002`, `<YYYY-MM-DD>-adhoc`. Session state lives at `.session/test-documentation-local/<scope>/{plan.md, progress.md}`; domain content stays in the case files, never duplicated into the session.

Every dispatch follows the 7-component briefing in `agentic-qa-core/references/briefing-template.md`; the pattern per step follows `agentic-qa-core/references/dispatch-patterns.md`. A briefing always lists: the case ids, the exact files to read (the format reference first), the allowed writes (only `qa:local` verbs and the three body sections), the forbidden actions (Compact Rules), the expected return shape, the DoD, and the error protocol.

| Step | Pattern | Subagent role |
|---|---|---|
| Phase 0 — resume check, scope resolution | inline | orchestrator only |
| Phase 1 — analyze (read cases) | Single | inline for <= 10 cases; one read-only Analyze subagent returns a verdict table for larger scopes |
| Phase 2 — verdict decisions and ROI | inline | decisions live in the orchestrator |
| Phase 3 — `design` of several cases | Parallel | one subagent per case group (<= 5 cases each, cap 5); each returns the proposed sections, the orchestrator inserts and runs the check |
| Phase 3 — `qa:local` writes | inline | the orchestrator runs every state-changing verb itself, in order |
| Report | inline | `check` + `index` |

- **On any failure**: STOP, report the partial state (which cases changed, which not), offer retry / skip / abort. No auto-fix, no auto-rollback. See `agentic-qa-core/references/orchestration-doctrine.md`.
- **Blocker or a skill defect** (a wrong step, a rule that contradicts the script): report it upstream per `agentic-qa-core/references/upstream-feedback.md` — drafted and redacted locally, filed only on explicit OK, verified with `gh issue view`.

---

## Phase 0 — Resume check and scope (MANDATORY, inline)

1. Resolve the prospective `<scope>` from the invocation (`triage ola 1` -> `ola-1`, `triage AUT` -> `aut`, `design AUT-002` -> `aut-002`, `report` -> `<YYYY-MM-DD>-adhoc`). A scope that does not match the shape above is renamed, not used as typed.
2. Check `.session/test-documentation-local/<scope>/progress.md`.
3. Absent: continue to step 4.
   Present: read `plan.md` and the tail of `progress.md`; show last completed step, next step, and cases already changed; offer **resume / restart / abort**. On `restart`, archive to `.session/.archive/<YYYY-MM-DD>-test-documentation-local-<scope>-aborted/` first.
4. Run `bun run qa:local check`. ERROR: stop and show the lines (the store is inconsistent; nothing is written until it is fixed). WARN and INFO: list the ones touching this scope and continue.
5. Run `bun run qa:local next 5` (plus the scope's `--ola` / `--prefix`) to see the current queue, so the scope is grounded in the data and not in memory.

Write `.session/test-documentation-local/<scope>/plan.md` (goal, mode, case ids in scope, approach table above, risks, verification checklist) before changing any case; append the Phase 0 entry to `progress.md`.

---

## Mode: triage

1. **Read** every case in scope: frontmatter plus the three body sections. List them with `bun run qa:local next 1000 --ola N` for the automatable ones; read `manual` / `deferred` / `no_aplica` cases directly. The observations section is background only.
2. **Check each verdict** against the evidence in the case itself:
   - needs hardware, a physical device, biometrics, a MAC or a GPS fix -> propose `manual`.
   - cross-cutting trait (responsive, accessibility, XSS, performance) asserted as its own case -> propose `deferred` with the receiving suite named (the "deferral is not omission" rule in the doctrine reference).
   - one-time validation, no regression value -> propose `deferred`.
   - `candidate` and nothing contradicts it -> leave it alone.
3. **Technique check** (a CHECK, not a generator): for an `L` scenario ask whether a boundary case is missing; for a happy path ask whether a negative or security variant exists. Report gaps as PROPOSALS for new cases for the user to approve; never create a case id silently. Once the user approves them, `/test-case-generation-local` creates them.
4. **Missing preconditions**: for a case whose precondition cannot be built from its own text, propose `manual` or `deferred` with a reason. Never invent the precondition, and never treat a note of a previous manual run as a verdict.
5. **Present one table**: id, current verdict, proposed verdict, reason, ROI when computed. Wait for the user's answer per row.
6. **Apply** approved changes with `bun run qa:local verdict <ID> <value> --reason "<reason>"`; a defect reference is recorded with `bun run qa:local defect <ID> <ref>` only after a failing automated run (the script refuses otherwise).
7. Continue to Report.

## Mode: design

1. Run only for a `candidate` case. Another verdict: say so and stop.
2. Read the case, `.context/project-config.md` when present, the project's ADRs under the `.context/ADR` folder, and the business maps via `bun run context:map business-e2e-context` (or the matching context skill for the surface).
3. Confirm the screen or endpoint read-only when the case text is not enough (load `/playwright-cli`; observe only, create or change nothing). Unknowns are asked, not invented.
4. Draft the three sections following `references/local-case-format.md`:
   - `## Precondiciones` — business-level state, buildable from a cold environment.
   - `## Pasos` — Gherkin with structured comments (`# === PRECONDITIONS ===`, `# === ACTION ===`, `# === VALIDATIONS ===`), variables instead of literals.
   - `## Datos` — variable names and how to obtain them. Never a credential value; credentials come from the environment at run time.
5. Apply the TC-identity rule: one (precondition, action) pair per case; same-behaviour data variants are rows of one outline, not new cases.
6. Insert the sections between `## Resultado esperado` and `## Observaciones / evidencia de la ejecucion manual`. Frontmatter fields `precondiciones` / `datos` are written only when the format reference says so, and never for `automatizacion` / `estado_automatizacion`.
7. Run `bun run qa:local check` and show the diff of the case.

## Mode: verdict

`verdict <ID> <value> "reason"` maps 1:1 to `bun run qa:local verdict <ID> <value> --reason "<reason>"`.

- `manual`, `deferred`, `no_aplica` require the reason; the script refuses without it.
- The case must be `pendiente`; if it is `en_automatizacion` or `automatizado`, the lifecycle goes back first through `qa:local status`, with the user's OK.
- Changing the imported verdict: show the old and new value and the reason, then apply. When ROI backs the change, record the factors under `roi` in the format reference's shape.
- The script's refusal text is the answer to relay; do not work around it by editing the file.

## Mode: report

1. `bun run qa:local check` — show ERROR / WARN / INFO counts and the lines touching the scope.
2. `bun run qa:local index` — regenerates `estado.md` in the QA root (never `prioridad-automatizacion.md`, which is converter-owned).
3. Show the sections that answer the user's questions: per wave counts, last run, failing, known defects, next queue.

`estado.md` also lists the open bugs (a Bugs section).

---

## ROI (only to justify a change)

Procedure, factor scales and bands: `references/local-case-format.md` section "ROI procedure", which cites `test-documentation/references/tms-conventions.md` §9. Rule of thumb from the original: if most candidates would end up Candidate or Manual, apply the Phase-0 filter questions more strictly.

---

## Close (MANDATORY)

1. Light verifier: `bun run qa:local check` shows no ERROR; every case this session changed shows the intended verdict; no verdict change was applied without a recorded reason.
2. Print the two chat blocks of `agentic-qa-core/references/session-footer-contract.md` (skills / MCPs / CLIs used, testing levels touched, with "none" where expected-but-untouched). Chat only.
3. Lessons noticed are PROPOSED to `.session/test-documentation-local/<scope>/refinements.md` per `agentic-qa-core/references/skill-refinement-protocol.md`; never applied to a live skill.
4. Archive the session per `agentic-qa-core/references/session-management.md`.
5. **Next command**: for the cases left `candidate` + `pendiente`, run `/test-automation-local next 5` (or `/test-automation-local case <ID>`). Cases that stayed `manual` or `deferred` are terminal here.
