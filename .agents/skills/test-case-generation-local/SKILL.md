---
name: test-case-generation-local
description: "Local-files variant (no Jira, no Xray, no TMS) that CREATES the manual-test cases of a project as Markdown files under the project's QA root, one file per case, through `bun run qa:local case new`. Two entry points: `stories <path>` derives cases from user stories and acceptance criteria (Markdown, Word, PDF or Excel), and `code [scope]` derives them from an already-built project (context maps, source code, OpenAPI contract, the running app explored read-only). `gaps` cross-checks both and lists stories nobody built and behaviour nobody specified. Use for: generar casos de prueba, crear los casos desde las historias de usuario, generar casos del proyecto ya desarrollado, casos locales sin Jira, cobertura de historias, definir prefijos de modulo, qué casos faltan. Cases from code carry `oraculo: observado` and stay out of the automation queue until a person confirms the expected result. Do NOT use to triage, design or give verdicts to existing cases (use test-documentation-local), to write tests (test-automation-local), or to report a defect (bug-report-local)."
license: MIT
compatibility: [claude-code, codex, opencode]
metadata:
  kind: workflow
  stage_owner: true
# compact_rules is consumed VERBATIM by scripts/build-skill-registry.ts. Keep it equal to
# the `## Compact Rules` section below.
compact_rules: |
  - Local files only. Cases are Markdown under the QA root; the contract is `test-documentation-local/references/local-case-format.md`. Never call Jira, Xray or acli tools; never read or write a secret (`.env`, tokens, passwords).
  - A case file is created ONLY by `bun run qa:local case new <PREFIX>`; the id is allocated by the script. Never write a case file by hand, never count files to invent a number, never edit an existing case.
  - Preview first: Phases 1 to 3 are read-only. Show the per-module count and the case table, and wait for the user's OK before the first `case new`.
  - Prefixes are the project's, defined once with the user and kept in `<qa-root>/prefijos.md`. Never invent a prefix and never reuse one for another module.
  - `origen` always names the source (`historia:<id>` or `codigo:<path>`). A story gives `--oraculo historia`; behaviour read from code or the running app gives `--oraculo observado` and is NOT automatable until the person runs `qa:local case confirm <ID>`.
  - Never take observed behaviour for correct behaviour: when the system and a story disagree, write the case from the story and list the divergence as a finding, not as a case.
  - One (precondition, action) pair per case; same-behaviour data variants are rows of one outline, not new cases. Re-running never duplicates: a candidate whose scenario already exists is reported as COVERED, not created.
  - `prioridad`, `ola` and `riesgo` are proposals taken from the context maps and shown in the preview; the user owns them.
  - Credentials, tokens and personal data never enter a case. A document converted to text lives in the session scratchpad, not in the repo.
---

## Forbidden invocations

**NEVER invoke `/sdd-*` skills from this workflow.** This skill ships self-contained. To change the framework, `scripts/` or this skill itself, exit and use `/framework-development`. Boundary enforced by `scripts/lint-skills.ts`; see `.agents/skills/agentic-qa-core/references/skill-composition-strategy.md` §4.

# Test Case Generation Local

Create the manual-test cases of a project as local Markdown files, from the two places a QA team can start: the **user stories** (the project is being specified) or the **project already built** (the code, the contract and the running app are the only truth). The cases it writes are the input of `/test-documentation-local`, then `/test-automation-local`, then `/bug-report-local`.

Same doctrine as `/test-documentation` (Analyze -> Prioritize -> Document) applied before any case exists: this skill is the only one allowed to create case ids, and it does so through the script.

---

## Dependencies

Requires `agentic-qa-core`. Loads on demand:

- `test-documentation-local/references/local-case-format.md` — **MANDATORY first read.** Fields, body sections, ID chain, the `qa:local` verbs.
- `references/derivation-rules.md` — how a story or a behaviour becomes cases: techniques, field defaults, the writing rules for `Escenario` and `Resultado esperado`, the COVERED check.
- `references/input-formats.md` — how to read Markdown, Word, PDF and Excel inputs, and what never leaves the scratchpad.
- `agentic-qa-core/references/test-design-doctrine.md` — EP / BVA / state / decision table / pairwise, cited by path.
- The context skills of the project (`business-e2e-context`, `business-api-context`, `business-domain-context`, `business-data-context`) through `bun run context:map <slug>`, when they exist.
- `agentic-qa-core/references/briefing-template.md`, `dispatch-patterns.md`, `orchestration-doctrine.md`, `session-management.md`, `session-footer-contract.md`, `skill-refinement-protocol.md`, `upstream-feedback.md` — cited inline where used.

## Compact Rules

- **Local only.** Cases are Markdown under the QA root; the contract is `test-documentation-local/references/local-case-format.md`. Never call Jira, Xray or acli tools; never read or write a secret (`.env`, tokens, passwords).
- **Creation only through the script.** A case file is created ONLY by `bun run qa:local case new <PREFIX>`; the id is allocated by the script (exclusive create, one number per prefix). Never write a case file by hand, never count files to invent a number, never edit an existing case (that is `/test-documentation-local`).
- **Preview before writing.** Phases 1 to 3 are read-only. Show the per-module count and the case table, and wait for the user's OK before the first `case new`.
- **Prefixes belong to the project.** Defined once with the user and kept in `<qa-root>/prefijos.md`: 2 to 6 uppercase letters or digits, starting with a letter. Never invent one, never reuse one for another module.
- **Provenance and oracle.** `origen` names the source (`historia:<id>` or `codigo:<path>`). A story gives `--oraculo historia`. Behaviour read from code or the running app gives `--oraculo observado`: the expected result is an inference, `qa:local next` skips the case, and only the person's `qa:local case confirm <ID>` releases it.
- **Observed is not correct.** When the system and a story disagree, the case follows the story and the divergence is a finding in the report, never a case that blesses the defect.
- **Case identity.** One (precondition, action) pair per case; same-behaviour data variants are rows of one outline. Re-runs never duplicate: a candidate whose scenario already exists is COVERED and is reported, not created.
- **Priority is a proposal.** `prioridad`, `ola` and `riesgo` come from the context maps, are shown in the preview and are the user's to change.
- **Nothing sensitive in a case.** No credential, token or personal data. A converted document lives in the session scratchpad, never in the repo.

---

## Mode routing

First token of `$ARGUMENTS` is the mode; the rest is forwarded.

| Mode | Input | What it does |
|---|---|---|
| `prefixes` | none | Define or review the module prefixes (`<qa-root>/prefijos.md`). Runs by itself the first time any other mode starts. |
| `stories <path...>` | files or folders: `.md`, `.txt`, `.docx`, `.pdf`, `.xlsx` | Derive cases from user stories and acceptance criteria. Oracle `historia`. |
| `code [scope]` | a module, a screen, an endpoint group, or none for the whole project | Derive cases from the built project. Oracle `observado`. |
| `gaps [stories <path...>] [code scope]` | both sources | Cross-check: stories with no implementation, behaviour with no story, divergences. Writes only the cases the user approves from the findings. |

No mode, or ambiguous: ask which one, and say in one line what each needs. Unknown first token: list the four modes.

---

## Subagent Dispatch Strategy

> **Orchestration & Session contracts**: this skill follows `agentic-qa-core/references/orchestration-doctrine.md` (mandatory subagent dispatch, main thread is command center) AND `agentic-qa-core/references/session-management.md` (Phase 0 resume check, plan-first persistence at `.session/<skill-slug>/<scope>/`, archive on completion). Phase 0 and Phase 1 (plan write) are NOT optional.

This skill is **per-scope**. `<scope>` is lowercase kebab-case: `stories-hu-v2`, `code-tenants`, `gaps-all`, `<YYYY-MM-DD>-adhoc`. Session state lives at `.session/test-case-generation-local/<scope>/{plan.md, progress.md}`; the cases stay in the case files, never duplicated into the session.

Every dispatch follows the 7-component briefing in `agentic-qa-core/references/briefing-template.md`; the pattern per step follows `agentic-qa-core/references/dispatch-patterns.md`. A briefing always lists: the sources to read (exact paths), the module and prefix, the format reference first, the allowed writes (NONE for extraction subagents), the forbidden actions (Compact Rules), the return shape (the candidate table below), the DoD.

| Step | Pattern | Subagent role |
|---|---|---|
| Phase 0 — resume check, prefixes | inline | orchestrator only |
| Phase 1 — inventory of sources and existing cases | inline | orchestrator reads the case list and `prefijos.md` |
| Phase 2 — extraction | Parallel | one read-only subagent per module (cap 5); `code` mode: UI, API and data sources in separate subagents when the scope is large; each returns the candidate table |
| Phase 3 — consolidate, dedupe, preview | inline | the orchestrator merges the tables, runs the COVERED check, shows the preview |
| Phase 4 — `case new` writes | inline | the orchestrator runs every write itself, one case at a time, in table order |
| Phase 5 — check, index, report | inline | `check` + `index` |

The candidate table every extraction subagent returns, one row per case: module, prefix, title, tipo, prioridad proposed, riesgo, origen, oraculo, escenario, resultado esperado, source citation (document and section, or file and symbol), confidence (high / medium / low).

- **On any failure**: STOP, report the partial state (which ids were created, which not), offer retry / skip / abort. No auto-fix, no deleting created files. See `agentic-qa-core/references/orchestration-doctrine.md`.
- **Blocker or a skill defect**: report it upstream per `agentic-qa-core/references/upstream-feedback.md`, drafted and redacted locally, filed only on explicit OK.

---

## Phase 0 — Resume check, prefixes, preconditions (MANDATORY, inline)

1. Resolve the prospective `<scope>` from the invocation (`stories HU V2.pdf` -> `stories-hu-v2`, `code tenants` -> `code-tenants`, `gaps` -> `gaps-all`). A scope that does not match the shape above is renamed, not used as typed.
2. Check `.session/test-case-generation-local/<scope>/progress.md`. Absent: continue. Present: read `plan.md` and the tail of `progress.md`; show last completed step, next step and the ids already created; offer **resume / restart / abort**. On `restart`, archive to `.session/.archive/<YYYY-MM-DD>-test-case-generation-local-<scope>-aborted/` first.
3. Read `test-documentation-local/references/local-case-format.md`.
4. **Prefixes.** Read `<qa-root>/prefijos.md`.
   - Absent, or a module in scope has no row: ask the user. Offer a proposal built from the modules the sources name (one line per module: prefix, module, scope in one sentence) and wait for the answer. Write the file only after the OK. Format: a Markdown table `| Prefijo | Modulo | Alcance |`.
   - A prefix is valid when it matches 2 to 6 characters of A-Z0-9 starting with a letter; the script refuses anything else.
5. Run `bun run qa:local check`. ERROR: stop and show the lines. A project with no cases yet passes with 0 cases: that is the expected state of a new project, continue.
6. When cases already exist, list those of the prefixes in scope (`bun run qa:local next 1000 --prefix <P>` for the candidates, the folder for the rest); they feed the COVERED check. With no cases `next` and `index` answer "no hay casos": expected, not an error to fix.

Write `.session/test-case-generation-local/<scope>/plan.md` (goal, mode, sources, modules and prefixes, approach table, risks, verification checklist) before extracting; append the Phase 0 entry to `progress.md`.

---

## Mode: stories

1. **Inventory the sources.** Read each input following `references/input-formats.md`. Record for every story: id (or a stable label), title, role, acceptance criteria, and any rule, limit, state or message it names. A story without acceptance criteria is listed as a finding and still yields cases from its stated behaviour, marked confidence `low`.
2. **Dispatch extraction** (Phase 2), one subagent per module. Each applies `references/derivation-rules.md`: one case per acceptance criterion at minimum, then the technique checks (boundaries, negatives, permissions, states). `origen` is `historia:<id>`; `oraculo` is `historia`.
3. **Consolidate** (Phase 3): merge the tables, drop duplicates across stories, run the COVERED check against the existing cases, and flag stories that conflict with each other as findings (never resolved silently).
4. Continue to Preview and write.

## Mode: code

1. **Pick the evidence, in this order**, and cite it in every row: the business maps (`bun run context:map business-e2e-context`, then the API, data and domain maps); the OpenAPI contract in `api/`; the source of the module in scope (routes, components, validators, guards, state transitions, error messages); the running app, read-only, through `/playwright-cli` (observe and screenshot, create or change nothing, never log in with a secret read from `.env`).
2. **Dispatch extraction** (Phase 2) per module and, for a large scope, per source (UI, API, data). Each applies `references/derivation-rules.md`. `origen` is `codigo:<path or route>`; `oraculo` is `observado`.
3. **The expected result is what the system does, not what it should do.** Write it in neutral business words and mark the confidence: `high` when the code or the contract states the rule (a validator, an enum, a documented status code), `medium` when only the running app shows it, `low` when it is a guess from naming. A row with `low` confidence is shown in the preview but not offered for writing unless the user asks for it.
4. **Findings, not cases**, for anything that looks like a defect: a field that is validated in the UI and not in the API, a state with no way out, an error message that contradicts the label. List them in the report with the evidence; the user decides whether to run `/bug-report-local` after an automated test confirms them.
5. Continue to Preview and write.

## Mode: gaps

1. Run `stories` extraction and `code` extraction in read-only form (Phases 1 and 2, no writes).
2. Build one matrix: story/criterion on one axis, implemented behaviour on the other. Classify every row: **MATCH** (both agree), **STORY-ONLY** (specified, not found in the system), **CODE-ONLY** (built, no story), **DIVERGENT** (both exist, they disagree).
3. Show the matrix and a count per class. Offer cases only where the user chooses: MATCH rows become cases with `origen: historia:<id>` and oracle `historia`; STORY-ONLY rows become cases from the story (they will fail when automated, which is the finding); CODE-ONLY rows follow the `code` rules with oracle `observado`; DIVERGENT rows follow the story and the divergence is recorded in the report.
4. Continue to Preview and write with the rows the user selected.

---

## Preview and write (Phases 3 and 4, shared by every mode)

1. **Preview.** Show: the per-module count of cases to create, then one table (prefix, title, tipo, prioridad, ola, riesgo, origen, oraculo, confidence), then the COVERED list (candidates skipped because the scenario already exists) and the findings. Ask for one decision: **create all / create a subset (name the prefixes or rows) / change the table / abort**. Nothing is written before the answer.
2. **Write**, only the approved rows, one at a time and inline, in table order:

   ```
   bun run qa:local case new <PREFIX> --title "<title>" --tipo <P|N|S|R|L|NF|E2E|Smoke> \
     --prioridad <A|M|B> --ola <K> --funcionalidad "<feature>" --riesgo "<risk>" \
     --origen "<historia:ID | codigo:path>" --oraculo <historia|observado> \
     --bloque "<block>" --seccion "<section>" --escenario "<text>" --esperado "<text>"
   ```

   Run it with `--dry-run` for the first row of a session and show the id it would take. Record each id the script prints in `progress.md` next to its row.
3. **Verify at the destination**: after the last write, `bun run qa:local check` must show no ERROR, and the folder of each prefix must hold exactly the ids recorded in `progress.md`. A mismatch is reported, never patched by hand.
4. **Confirm oracles.** For `observado` cases, show the list and ask the person to review the expected results. For each one they approve as correct, run `bun run qa:local case confirm <ID>`; the others stay `observado` and out of the automation queue. Never confirm on the person's behalf.
5. `bun run qa:local index` regenerates `estado.md` in the QA root.

---

## Close (MANDATORY)

1. Light verifier: `qa:local check` shows no ERROR; the ids created equal the ids approved; no case was written without a source in `origen`; every `observado` case is either confirmed by the person or still excluded from `qa:local next`.
2. Print the two chat blocks of `agentic-qa-core/references/session-footer-contract.md` (skills / MCPs / CLIs used, testing levels touched, with "none" where expected-but-untouched). Chat only.
3. Lessons noticed are PROPOSED to `.session/test-case-generation-local/<scope>/refinements.md` per `agentic-qa-core/references/skill-refinement-protocol.md`; never applied to a live skill.
4. Archive the session per `agentic-qa-core/references/session-management.md`.
5. **Next command**: `/test-documentation-local triage <scope>` to check the automation verdicts, then `/test-documentation-local design <ID>` for the candidates, then `/test-automation-local next 5`. Cases still `observado` wait for the person's confirmation first.
