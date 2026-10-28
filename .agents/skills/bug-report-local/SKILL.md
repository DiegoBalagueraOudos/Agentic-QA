---
name: bug-report-local
description: "Local-files variant (no Jira, no Xray) of the bug-reporting step. When an automated test fails and the failure is judged a PRODUCT defect, judges it (product vs test vs environment), gathers read-only evidence, proposes ONE one-screen draft, waits for the user's OK, and only then writes the complete report (report.md plus images) in a per-bug folder of the bugs area of the QA root, through `bun run qa:local bug`. Visual or positional bugs run the existing bug-screenshot-annotation skill unchanged. Use for: reportar bug, bug de producto, informe de bug, reporta este bug para AUT-027, a failing automated test judged a product defect, report this bug for AUT-027, write the bug report of a failing case. Do NOT use when Jira is configured -> /sprint-testing. Do NOT use only to annotate a screenshot -> /bug-screenshot-annotation. Do NOT use to fix or rewrite a failing test -> /test-automation-local."
license: MIT
compatibility: [claude-code, codex, opencode]
metadata:
  kind: workflow
  stage_owner: true
# compact_rules is consumed VERBATIM by scripts/build-skill-registry.ts. Keep it equal to
# the `## Compact Rules` section below.
compact_rules: |
  - Local only. Reports live in the bugs area of the QA root; the contract is `references/local-bug-format.md`. Never call Jira, Xray or acli tools; Jira prose in the cited report template does not apply.
  - Never create a file or folder before the user chooses "create the report". Phases 1 and 2 are read-only; the draft is shown first.
  - Judge before proposing: a selector, timeout, data or precondition failure is a TEST defect (no report); a connection or gateway failure is ENVIRONMENT (no report); only a reproduced failure that contradicts the case's expected result is a PRODUCT candidate.
  - The bug id `<case id>-BUG-<n>` is allocated ONLY by `bun run qa:local bug new`. Never count folders or invent a number by hand.
  - Never copy a trace, `.zip`, `.har`, video or `.env`, nor a cookie, `Authorization` / `Set-Cookie` / `Cookie` value, token, password or the Playwright call log of an error message. API evidence is a scrubbed, truncated excerpt, never a full body.
  - A visual or positional bug runs the existing `bug-screenshot-annotation` skill unchanged (KEY = the case id, BUG-KEY = n, its Jira embed step skipped, `python` never `python3`, intermediates in the session scratchpad). A non-visual bug gets no image. Never a hand-made or generated image.
  - Pillow is not installed and the user declined it: the annotation crop is optional; the raw screenshot is the base image; if the visual evidence cannot be produced, write the report with the raw screenshot and say so.
  - List an evidence file in the report only after verifying it on disk. Copy the failure screenshot, never move it.
  - Every `qa:local bug` write is done inline by the orchestrator. The skill never edits a case file; the case link is `qa:local defect <case id> <bug id>` only after a failing recorded run and the user's decision.
---

## Forbidden invocations

**NEVER invoke `/sdd-*` skills from this workflow.** This skill ships self-contained. To change the framework, `scripts/` or this skill itself, exit and use `/framework-development`. Boundary enforced by `scripts/lint-skills.ts`; see `.agents/skills/agentic-qa-core/references/skill-composition-strategy.md` §4.

# Bug Report Local — Judge, Evidence, Confirm, Write

Turn a failing automated test that is a real PRODUCT defect into a complete local bug report: text, steps, evidence and, for visual bugs, an annotated image. No Jira, no Xray: the per-bug folder and `bun run qa:local bug` are the whole system.

It is the owner of the bug flow that `/test-automation-local` hands over when a failure is judged a product defect. It can also be called directly: "report this bug for AUT-027".

---

## Dependencies

Requires `agentic-qa-core`. Loads on demand:

- `references/local-bug-format.md` — **MANDATORY first read.** Folder layout, report fields and headings, value sets, scrub rules, the `bug` verbs, naming, the annotation limits on this machine.
- `bug-screenshot-annotation/SKILL.md` — the annotation process, cited by path and used unchanged.
- `sprint-testing/references/reporting-templates.md` section 1 — headings, severity matrix, priority mapping, error type, environment; used unchanged, its Jira-only parts (labels, custom fields, attachments, tracker calls) do not apply.
- `test-documentation-local/references/local-case-format.md` — the case contract and the `qa:local` verbs; `test-automation-local/references/local-handoff.md` section 4 for known defects.
- `agentic-qa-core/references/evidence-conventions.md`, `briefing-template.md`, `dispatch-patterns.md`, `orchestration-doctrine.md`, `session-management.md`, `stage-gates.md`, `session-footer-contract.md`, `skill-refinement-protocol.md`, `upstream-feedback.md` — cited inline where used.
- `/playwright-cli` (only to re-run a spec or capture the annotation).

## Compact Rules

- **Local only.** Reports live in the bugs area of the QA root; the contract is `references/local-bug-format.md`. Never call Jira, Xray or acli tools; Jira prose in the cited report template does not apply.
- **Confirm first.** Never create a file or folder before the user chooses "create the report". Phases 1 and 2 are read-only; the draft is shown first.
- **Judge before proposing.** A selector, timeout, data or precondition failure is a TEST defect (no report); a connection or gateway failure is ENVIRONMENT (no report); only a reproduced failure that contradicts the case's expected result is a PRODUCT candidate.
- **The script numbers bugs.** The bug id `<case id>-BUG-<n>` is allocated ONLY by `bun run qa:local bug new`. Never count folders or invent a number by hand.
- **No secrets, no traces.** Never copy a trace, `.zip`, `.har`, video or `.env`, nor a cookie, `Authorization` / `Set-Cookie` / `Cookie` value, token, password or the Playwright call log of an error message. API evidence is a scrubbed, truncated excerpt, never a full body.
- **Visual bugs use the existing annotation skill.** It runs unchanged (KEY = the case id, BUG-KEY = n, its Jira embed step skipped, `python` never `python3`, intermediates in the session scratchpad). A non-visual bug gets no image. Never a hand-made or generated image.
- **No Pillow here.** Pillow is not installed and the user declined it: the annotation crop is optional; the raw screenshot is the base image; if the visual evidence cannot be produced, write the report with the raw screenshot and say so.
- **Evidence is verified.** List an evidence file in the report only after verifying it on disk. Copy the failure screenshot, never move it.
- **Writes are inline, cases are untouched.** Every `qa:local bug` write is done by the orchestrator. The skill never edits a case file; the case link is `qa:local defect <case id> <bug id>` only after a failing recorded run and the user's decision.

---

## Subagent Dispatch Strategy

> **Orchestration & Session contracts**: this skill follows `agentic-qa-core/references/orchestration-doctrine.md` (mandatory subagent dispatch, main thread is command center) AND `agentic-qa-core/references/session-management.md` (Phase 0 resume check, plan-first persistence, archive on completion). The orchestrator applies the Definition-of-Done gates in `agentic-qa-core/references/stage-gates.md` before recording a checkpoint and advancing.

This skill is **per-scope**. `<scope>` is the lower-case case id, for example `aut-027`. Session state lives at `.session/bug-report-local/<scope>/{plan.md, progress.md}`; the report itself lives in the bug folder, never duplicated into the session.

Every dispatch follows the 7-component briefing in `agentic-qa-core/references/briefing-template.md`; the pattern per step follows `agentic-qa-core/references/dispatch-patterns.md`. A briefing always lists: the case id, the files to read (the format reference first, the case file, the spec, the report template section), the allowed actions (evidence gathering is READ-ONLY: no write under the QA root, no `qa:local bug` call), the forbidden actions (Compact Rules), the return shape, the DoD and the error protocol.

| Step | Pattern | Subagent role |
|---|---|---|
| Phase 0 — resume check, scope | inline | orchestrator only |
| Phase 1 — Judge and Phase 2 — Evidence | Single | ONE read-only Evidence subagent: re-runs the one failing spec once, reads the case, the screenshot and the scrubbed error, returns a findings table and the proposed fields |
| Phase 3 — draft and confirmation gate | inline | the orchestrator asks the single question |
| Phase 4 — annotation (visual bugs only) | Single | one subagent loads `bug-screenshot-annotation` and returns the verified path of the annotated image |
| Phase 4 — every `qa:local bug` write, copies, report fill, check | inline | the orchestrator, in order |

- **On any failure**: STOP, report the partial state (which files exist in the bug folder), offer retry / skip / abort. No auto-fix, no auto-delete of a created folder.
- **Blocker or a skill defect** (a wrong step, a rule that contradicts the script): report it upstream per `agentic-qa-core/references/upstream-feedback.md` — drafted and redacted locally, filed only on explicit OK, verified with `gh issue view`.

---

## Session banner

Print once at start, before anything else:

```
bug-report-local | scope: <scope> | case: <case id>
verdict: <pending|product|test|environment> | gate: <awaiting|created|skipped> | phase: <0|1|2|3|4|5>
```

---

## Phase 0 — Resume check and scope (MANDATORY, inline)

1. Resolve the case id from the invocation or from the hand-off of `/test-automation-local`; the scope is the lower-case id (`AUT-027` -> `aut-027`). A scope that does not match that shape is renamed, not used as typed. If no case id can be resolved, ask for it.
2. Check `.session/bug-report-local/<scope>/progress.md`.
3. Absent: continue.
   Present: read `plan.md` and the tail of `progress.md`; show the last completed phase, the next phase and whether a bug folder was already created; offer **resume / restart / abort**. On `restart`, archive to `.session/.archive/<YYYY-MM-DD>-bug-report-local-<scope>-aborted/` first. A bug folder already created is never deleted by the skill.
4. Run `bun run qa:local check`. ERROR: stop and show the lines. Confirm the case exists (`bun run qa:local bug new <case id> --dry-run` refuses an unknown case and writes nothing).
5. Write `.session/bug-report-local/<scope>/plan.md` (goal, case id, phases, risks, verification checklist) before Phase 1; append the Phase 0 entry to `progress.md`.

---

## Phase 1 — Judge (read-only)

Dispatch: the single Evidence subagent (shared with Phase 2). Decide product vs test vs environment, in this order:

1. **Reproduction.** Re-run the single failing spec ONCE (a confirmation, not a retry to hide flakiness). The same failure at the same assertion is reproducible. A different or intermittent result is NOT reported: it is a test or environment issue.
2. **Contradiction.** Compare the failing assertion with the case's `## Resultado esperado`. The observed behaviour must contradict it.
3. **Failure signature.**
   - Locator not found, strict-mode violation, timeout with the page otherwise in the expected state, data collision, precondition error -> **TEST defect**: go back to `/test-automation-local`; no report.
   - Connection refused, proxy 502 or 503 page, TLS error -> **ENVIRONMENT**: no report.
   - A wrong status code, wrong body field, wrong text, wrong redirect, or an element the case says must exist and that is absent in the screenshot -> **PRODUCT candidate**.
4. **Ambiguous expectation.** When the expected result is ambiguous, read the behaviour fact from the maps with `bun run context:map <slug> --section <id>` before judging ("maps first"); cite the section in the draft.

A TEST or ENVIRONMENT verdict ends the flow with the reason shown; nothing is written.

## Phase 2 — Evidence (read-only)

Same Evidence subagent, same turn. It returns, without writing under the QA root:

1. The path of the failure screenshot (verified on disk), and whether the bug is visual or positional. Playwright writes the failure artifacts in a folder of the test-results folder named after the spec and the truncated test title plus a hash that changes between runs. The subagent finds the failing test's folder (the newest one, or the path Playwright prints in the run output), takes `test-failed-1.png` as the failure screenshot to COPY (never move) and never copies `trace.zip`. `error-context.md` in that folder is session material, not copied by default: it can hold a page snapshot with real data.
2. The scrubbed error: assertion text, status code, a truncated body excerpt, console message. The call log, headers and tokens are dropped per `references/local-bug-format.md`; the scrub is mandatory (an assertion on a plain value prints no call log, an assertion on a locator or a request usually does).
3. The reproduction steps from the case's `## Pasos` or the spec's step titles, and the environment inferred from the base URL (report template 1.7).
4. A proposed title, type, severity, error type and visual yes/no, with a one-line reason each.

A trace, `.zip`, `.har`, video or `.env` is never opened for copying; a trace is session material until scrubbed (`agentic-qa-core/references/evidence-conventions.md`).

---

## Phase 3 — Draft and confirmation gate (inline)

1. Get the id preview: `bun run qa:local bug new <case id> --dry-run` (prints the id it would allocate, writes nothing).
2. Show ONE one-screen draft: id preview, title, type, severity and the priority it maps to, error type, environment, visual yes/no, the evidence list (failure screenshot, excerpt, annotation if visual), the two-line summary and the reason it is a product defect.
3. Ask ONE question with these options:
   1. Create the report.
   2. It is a test defect: go back to fix the test.
   3. Environment, not a bug.
   4. Skip.
4. **NOTHING is written before the user chooses 1.** Options 2 to 4 end the flow: 2 hands back to `/test-automation-local`, 3 and 4 record the decision in `progress.md` only. The user's edits to the draft are applied before writing.

## Phase 4 — Write (inline, after option 1)

1. `bun run qa:local bug new <case id> --title "<title>" --type <T> --severity <S> --error-type <E> --environment <ENV> --run <run id> [--visual]`. For a visual bug pass `--visual --error-type Visual` together: the verb defaults `error_type` to Functional and `--visual` does not change it. Read the id and the folder from the two output lines. `--run` is the `last_run.run` of the case after `qa:local results`; omit it when no run was recorded.
2. Copy the failure screenshot into the folder as `<case id>-BUG-<n>-failure.png`. Write the scrubbed excerpt, when there is one, as `<case id>-BUG-<n>-response.txt`.
3. **Visual or positional bug**: dispatch the annotation subagent, which loads `bug-screenshot-annotation` and runs it unchanged with KEY = the case id and BUG-KEY = n, so the output is `<case id>-BUG-<n>-annotated.png` in the bug folder. Skip its Jira embed step, use `python`, keep the crop and HTML in the session scratchpad. The crop step needs Pillow, which is missing and declined: the crop is optional (the raw screenshot is the base image) or made without Pillow as described in the reference, section 8. Launch `playwright-cli` with the working directory in the session scratchpad, never in the repo root: it creates a `.playwright-cli` folder in the current directory. A single favicon 404 console error is harmless. The annotation skill's step 5 lists closing the browser before the resize and screenshot; the working order is open, resize the viewport to the canvas, screenshot, then close. If the annotation cannot be produced, say so in the report and keep the raw screenshot. Never fabricate an image. State the final path in chat the moment it lands (`agentic-qa-core/references/session-footer-contract.md`).
4. Fill `report.md` with the sections from the format reference: summary, steps, actual and expected result, technical analysis, impact, root cause, workaround, evidence links, related cases; and the frontmatter `evidence` list with only the files verified on disk.
5. Confirm every image link in `report.md` resolves to a file inside the bug folder and that the frontmatter `evidence` list matches the files linked and verified on disk. `bug check` does not cover the links in the body, so this step is manual.
6. `bun run qa:local bug check <bug id>`: no ERROR. On ERROR, show the counts and file names and fix the file named; never paste a matched value.

---

## Phase 5 — Close (MANDATORY)

1. Light verifier: `bun run qa:local bug check <bug id>` shows no ERROR, every image link in the body resolves inside the bug folder, and every file in the report's evidence list was verified on disk in this session.
2. Print the two chat blocks of `agentic-qa-core/references/session-footer-contract.md` (skills / MCPs / CLIs used, testing levels touched, with "none" where expected-but-untouched; screenshot paths verified on disk, annotated image first). Chat only.
3. Lessons noticed are PROPOSED to `.session/bug-report-local/<scope>/refinements.md` per `agentic-qa-core/references/skill-refinement-protocol.md`; never applied to a live skill.
4. Archive the session per `agentic-qa-core/references/session-management.md`.
5. **Next commands**, in order:
   1. `bun run qa:local results --scope <scope>`: records the FAIL in the case (`last_run`) and also writes a run folder (run.json and run.md) in the QA root; needed before any `defect`. With `--accept`, a case already `automatizado` does not change.
   2. Only if the user decides to keep the suite green: `bun run qa:local defect <case id> <bug id>`, followed by the `test.fail` annotation done by `/test-automation-local`.
   3. `bun run qa:local index`: the bug appears in the Bugs section of `estado.md`.

   Later status moves are `bun run qa:local bug status <bug id> fixed|verified`.

---

## Anti-patterns

- **B1.** NEVER create the folder or any file before the user chose "create the report".
- **B2.** NEVER number a bug by hand or by counting folders; only `qa:local bug new` allocates `<case id>-BUG-<n>`.
- **B3.** NEVER copy a trace, `.zip`, `.har`, video, `.env`, cookie, token, password, `Authorization` / `Set-Cookie` / `Cookie` value, the Playwright call log or a full response body.
- **B4.** NEVER report a selector timeout, a data collision or an unreachable environment as a product bug.
- **B5.** NEVER produce a hand-made or generated image; no image at all is better than a fabricated one.
- **B6.** NEVER pass the local bug id as BUG-KEY to the annotation skill: KEY = the case id, BUG-KEY = n, or the file name doubles the case id.
- **B7.** NEVER edit a case file or run `qa:local defect` as part of reporting; the link is a separate decision after a failing recorded run.
- **B8.** NEVER call Jira, Xray or acli, and never push or open a PR from here.
