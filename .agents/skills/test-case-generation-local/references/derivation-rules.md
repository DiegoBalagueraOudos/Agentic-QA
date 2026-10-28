# Derivation rules — from a story or a behaviour to a case

> Owner: `test-case-generation-local`. The case file contract is `test-documentation-local/references/local-case-format.md`; when this prose and that file disagree, that file and the script win.
> Jira, Xray and TMS sentences in any cited reference do NOT apply.

## 1. What one case is

A case is an id, a scenario and an expected result. **One (precondition, action) pair per case.** Same-behaviour data variants (several invalid emails, several roles with the same outcome) are rows of one outline, written later by `/test-documentation-local design`, not new cases.

Split into separate cases when ANY of these differ: the precondition, the action, the actor's permission, or the observable outcome class (accepted, rejected, blocked, redirected).

## 2. From a user story

| Source | Cases |
|---|---|
| Each acceptance criterion | At least one case. A criterion with an "and" that joins two outcomes yields one case per outcome class. |
| A stated limit or format (max length, range, date format, allowed characters) | Boundary cases per `agentic-qa-core/references/test-design-doctrine.md` (BVA: at, just inside, just outside) and one invalid-class case per EP partition. |
| A stated role or permission | One case per role that behaves differently, and one denied-access case for a role that must not reach the feature. |
| A state or lifecycle (active, suspended, expired) | One case per legal transition and one for an illegal transition the story forbids. |
| A message, label or notification | The case that triggers it, with the text in the expected result. |
| A rule that combines conditions | A decision table: one case per distinct outcome, not per combination. |
| An absent criterion for an obvious failure (empty required field, duplicate, no permission, server error) | A proposed negative case, `confidence: medium`, flagged as "not in the story" so the user can accept or drop it. |

`origen` = `historia:<story id>`; when the story has no id, the document name and section (`HU V2.1 s3.2`). `oraculo` = `historia`: the expected result is the story's own words.

## 3. From the built project

The expected result is an inference. Read the evidence in this order and cite it in the row:

1. The business maps (`bun run context:map <slug>`): flows, roles, entities, state machines.
2. The OpenAPI contract: required fields, enums, status codes, error shapes.
3. The module source: validators, guards, route permissions, reducers or services that change state, the literal messages.
4. The running app, read-only: what the screen actually shows.

| Evidence | Cases |
|---|---|
| A route or screen | The main flow (one case), the empty state, the permission-denied state. |
| A form validator (required, pattern, min / max, custom) | One case per rule that rejects, plus the accepting boundary. |
| An endpoint with several status codes | One case per documented outcome class (2xx, 400 validation, 401, 403, 404, 409). |
| A guard or a role check | A case with the allowed role and one with a denied role. |
| A state change in the code | One case per transition the code allows. |
| A literal error message | The case that provokes it, with the message in the expected result. |

`origen` = `codigo:<path>` or `codigo:<route or endpoint>`. `oraculo` = `observado`.

**Confidence.** `high`: the code or the contract states the rule. `medium`: only the running app shows it. `low`: inferred from naming or structure. `low` rows are shown in the preview and not written unless the user asks.

**Defect smell.** If the evidence shows the rule is enforced in one layer and not in another (UI validates, API accepts), do NOT write a case that blesses either side. Record a finding with both citations and write the case from the safer behaviour only when a story or the person says which one is right.

## 4. Field defaults

| Field | Rule |
|---|---|
| `tipo` | `P` positive, `N` negative, `S` security or permission, `R` regression-sensitive, `L` boundary, `NF` non-functional, `E2E` cross-screen flow, `Smoke` minimal viability. Combinations as the format reference allows (`L/N`). Default `P`. |
| `prioridad` | `A` when the case guards money, access, isolation between tenants or data loss, or the main flow of the module; `M` for the rest of the specified behaviour; `B` for cosmetic text and rarely used paths. Proposed, shown in the preview. |
| `ola` | `1` for `A` cases of the main flows, `2` for the remaining `A` and the main `M`, `3` for the rest, `0` when the user wants no wave yet. Proposed. |
| `riesgo` | `HIGH`, `MEDIUM` or `LOW`, from the context maps' risk ranking when they exist, else from the `prioridad` rule above. |
| `bloque` / `seccion` | The module and the sub-area, as the sources name them. |
| `funcionalidad` | The feature name from the maps or the story, with its id when it has one. |
| `automatizacion` | Always created as `candidate` / `pendiente`. `/test-documentation-local triage` is the one that moves it. |

## 5. Writing the two sections

- **`--escenario`**: one or two sentences in the project's business language: who does what, in what state. No locators, no selectors, no URLs of environments, no credentials.
- **`--esperado`**: the observable outcome, one sentence per outcome. Quote a literal message exactly when there is one. Never write "works correctly" or "as expected".
- Language: the language of the sources. Identifiers and field names stay as they are.

## 6. The COVERED check

Before the preview, compare each candidate with the existing cases of the same prefix by scenario meaning, not by wording:

- Same precondition, action and outcome -> **COVERED**: report the existing id, create nothing.
- Same precondition and action, different outcome class -> a new case.
- Existing case is broader and includes the candidate as a data row -> **COVERED** with a note "row of <ID>".

Do not edit the existing case to absorb the candidate; that is `/test-documentation-local`.

## 7. Findings

A finding is not a case. It carries: what was seen, the two sources that disagree (or the missing one), the module, and the suggested next step (ask the PO, write the case from the story, run the test and then `/bug-report-local`). Findings go in the report and in `progress.md`.
