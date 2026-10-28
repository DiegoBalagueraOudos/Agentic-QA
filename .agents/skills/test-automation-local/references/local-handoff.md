# Local handoff — from case file to passing ATC

> Owner: `test-automation-local`. The case file contract is `test-documentation-local/references/local-case-format.md`; when the two disagree, the script `scripts/qa-local.ts` wins and the prose is the bug to report.
> Jira, Xray and TMS sentences in any reference cited here do NOT apply. §9 says which references are usable and where their Jira prose sits.

## 1. Case -> ATC mapping and the ID chain

One id runs end to end, and nothing renames it:

| Place | Form |
|---|---|
| case id, filename, frontmatter `id` | `AUT-002` |
| ATC in the component | `@atc('AUT-002')` (string literal, never a template) |
| `test()` title in the spec | starts with the case id: `AUT-002: should ... when ...` |
| key in `reports/atc_results.json` | `AUT-002` |
| `automation.atc` and `last_run` | `AUT-002` |

Rules:

- **1 ATC : 1 case id.** Data variants of the SAME case may be parameterised rows inside that ATC; two case ids never share one ATC (results and lifecycle are per id).
- A case is a (precondition, action) pair, so it maps to one complete mini-flow, never a single click. The method name is `{verb}{Resource}{Scenario}`, for example `loginWithInvalidCredentials`.
- An ATC never calls another ATC. Reusable precondition chains go in a Steps class, undecorated.
- Group cases into components by screen: cases of one screen share one page component and each owns one ATC.

## 2. Locator baseline for an SPA without `data-testid`

If the target SPA ships no `data-testid` attributes (common in Angular apps), use this baseline, in order of preference:

1. **Role and accessible name**: `getByRole('button', { name: 'Iniciar sesión' })`.
2. **Visible text**: `getByText('Administrador del sistema')`; use `.first()` when the text repeats.
3. **Form binding attribute**: `input[formControlName="username"]` for inputs that carry no label.
4. **Structural fallback** (sibling or CSS class) only when 1-3 do not identify the element, and noted in the plan as fragile.

Rules from the original doctrine that stay: **locators inline** in the ATC; extract to a `private readonly` arrow function of the class only at **2+ uses** inside the same component; never a `locators/*.ts` file. Every locator is confirmed against the real screen with `/playwright-cli` during Plan, not written from memory. If the project later adds test ids, `test-automation/references/data-testid-strategy.md` is the doctrine to follow.

Waits: web-first assertions (`toBeVisible`, `toHaveURL`) and `waitForLoadState`; never `waitForTimeout`.

## 3. How results flow

```
@atc  ->  reports/.atc_partial.ndjson  ->  reports/atc_results.json   (KataReporter, end of run)
                                              |
                          bun run qa:local results [--accept]
                                              |
         runs/<date>-<scope>/ (run.json, run.md)  +  each case's last_run
                                              |
                         --accept: en_automatizacion -> automatizado
                                              |
                          bun run qa:local index  ->  estado.md
```

- The decorator records PASS or FAIL per ATC execution and rethrows the error, so the test still fails. No Jira link is added when no tracker URL is configured.
- `results` reads the report, it does not run tests. Run the suite first; a missing report is a no-op.
- `--accept` moves a case to `automatizado` only when it is `en_automatizacion` and its ATC passed (or `EXPECTED_FAIL` for a known defect). A failing case stays `en_automatizacion`.
- The skill never edits `last_run`, `automation` or `estado_automatizacion` by hand.
- Do not set a tracker write-back variable on for local runs; this skill needs none.

## 4. Known defects, product bugs and the Bun exit code

The manual-run state of the user's matrix is not an input of this flow. A case is its id, scenario and expected result; the observations section of a case is non-authoritative notes of a previous manual run (useful to design a test, never a gate). Every case is tested again from scratch, and a case that failed or was blocked in a manual run is queued and planned like any other. Legacy manual-run fields in old files are tolerated and ignored.

**Known defect** (only after a failing automated run):

- A failing AUTOMATED run is a new finding. Only after it fails (`last_run.result=FAIL`, written by `qa:local results`) may `qa:local defect <ID> <ref>` record `id_defecto` and `defecto_conocido: true`; the script refuses it otherwise. The reference comes from the user, never from prose and never guessed.
- Only after that, and only if the user decides to keep the suite green, the test carries `test.fail(true, 'DEFECT <ref>')`. It keeps asserting the CORRECT behaviour from `## Resultado esperado`, never the bug. The script maps FAIL -> `EXPECTED_FAIL` and PASS -> `UNEXPECTED_PASS` (flagged in `estado.md`, never auto-closed).
- **Unverified**: the interaction of `test.fail` with the `@atc` decorator. The decorator records FAIL in the report and rethrows inside a step; Playwright inverts the outcome of the test, but whether the report row and the inversion line up is not proven. Validate on the first such case, alone, and write the result to the session notes. Fallback if it does not compose: a conditional skip plus a status field, with no change to the case format.

### 4a. Product bug found by a failing test

The product-bug flow is owned by `/bug-report-local`; this section is the summary and the hand-off. This skill does not file the bug.

1. Judge the failure (entry condition). A selector, data or timing problem is a test fix, not a bug. A failure that reproduces and contradicts `## Resultado esperado` is a PRODUCT defect.
2. For a PRODUCT defect, hand off to `/bug-report-local <case id>`. It gathers the evidence, proposes the report and waits for the user's OK before any file is created; the report format, the folder layout, the evidence and scrub rules and the `qa:local bug` verbs are in `bug-report-local/references/local-bug-format.md`.
3. Naming, for the existing annotation skill: KEY = the case id and BUG-KEY = the bug number `n`, which yields `<case id>-BUG-<n>-annotated.png`. Passing the whole bug id as BUG-KEY would repeat the case id in the file name.
4. The case gets no annotation until the user gives a reference and decides to keep the suite green (known defect above).

### 4b. Bun exit code after an all-passed run

On Windows the test command may print the all-tests-passed summary and then end with exit code 9, a Bun runtime teardown assertion. Rules:

- The run is judged by the report lines and `reports/atc_results.json`, not by that exit code.
- Types and lint must still exit 0.
- The observed exit code is mentioned in the session report.
- Do not try to fix the runtime from a case, and do not treat the code as a product or test failure when the report shows every ATC passed.

## 5. Surface: ui or api, and the session-fixture consequence

Each case is classified `ui` or `api` in Plan (the `qa:local` value for a UI case is `e2e`; an API case is `api`).

- **ui**: driven through the browser with the `{ ui }` fixture. The SPA performs its own session handshake, so the UI path needs nothing extra.
- **api**: a call to a back-end endpoint. When the back end requires a real session handshake and encrypts the request and response payloads, a plain request with a username and password is not what the product accepts. An API test therefore needs a fixture that performs the handshake and the encryption exactly as the SPA does.

Consequence for this skill:

- If that fixture is part of the framework, an api case may be automated with it, like any other.
- If it is not (the preflight and the plan check this against the fixtures on disk), the case is **not automated**. The plan lists it as blocked with the fixture named, and it is handed back to the user. Plaintext calls, a disabled encryption flag or a hand-copied token are not substitutes: they would test a door the product does not have, and the results would be false confidence.
- Building the fixture is a separate `/framework-development` change over the fixture files; this skill never edits them.

## 6. Session-less specs and the saved session

Login cases must start with NO logged-in browser, while the `e2e` project may be wired to depend on a setup project that logs in once and saves the browser state. Do not assume how this is wired. At Plan time read `playwright.config.ts` and answer, in the plan: does the project that runs these specs apply a saved session; if so, can a spec start clean (for example with an empty storage state for that spec file) without editing the config? If the answer needs a config change, that is a `/framework-development` item to hand to the user, not an edit made here.

Lockout risk: a negative login case sends wrong credentials against a real account. Ask the user for a disposable account or an agreed attempt budget before planning one, and record it in the plan's risks.

## 7. Adaptation checklist the preflight probes

Expressed as questions; the skill answers them by reading, never by assuming:

- [ ] The scaffold signals of `agentic-qa-core/references/preflight-gate.md` §4 (generic `Example*` components and specs, the example schema file) are absent.
- [ ] The login page component is written for this product (its labels and fields), not the generic template.
- [ ] The auth setup saves a session the way this product creates one (not a token-interception template).
- [ ] `bun run vars:check` exits 0; the base URL and the test-user variable names exist in the configuration.
- [ ] The environment's URL answers, and the certificate situation is known (self-signed or not).
- [ ] `.env` holds the test-user values (the skill checks presence through `vars:check`, never the values).
- [ ] `kata-manifest.json` has no stale entries and no id collides with a case id.
- [ ] Any red here is handed to `/test-framework-adaptation`; the skill never runs it and never edits framework files.

## 8. Test data

Variable names live in the case (`## Datos`); values come from the environment or a factory at run time. A negative login uses a generated wrong password; valid credentials come only from `config.testUser`. Discover -> Modify -> Generate and the "each test creates its own data" rule are in `test-automation/references/test-data-management.md`.

## 8b. Maps first

Behaviour facts come from the generated context maps with `bun run context:map <slug> --section <id>`; the plan cites the section (for example "from map <slug>#<section>"). Product source is read only for execution details the maps do not carry: a numeric threshold, how a timer or limiter is implemented, exact endpoint paths, what the fixtures already support.

## 8c. Secrets in steps, headers, traces and reports

- Never put `@step` or `@atc` on a method whose arguments carry a token, cookie or credential. The decorator masks only a short list of key names, so a refresh token placed in a step title leaks to console and reports.
- A token travelling in an explicit header is wrapped so a transport failure rethrows a sanitised error (no call log, no headers).
- Use `trace: 'off'` at FILE level (not inside describe) in a spec that handles a live session token.
- After any Code or fix step the orchestrator searches the generated report folders for token patterns: counts only, never printing values.

## 8d. Patterns that held in the first run

- **Shared lock.** A test that provokes a shared lock (a login limiter per address) always releases it in a finally, measures the wait from the first and last rate-limit response and never relies only on UI state, and runs with workers 1.
- **Client timers.** Control them with the page clock installed BEFORE the app starts, with margins to absorb real time. The case states that server-side expiry is not exercised when the timestamp header skews.
- **Isolated sessions.** They come from an empty storage state plus the test's own crypto session and cookie jar; a destructive step (logout) never touches the shared saved session.
- **Positive control.** Prove a mechanism works before asserting that it rejects.
- **Generated users.** Negative attempts use generated users, never the real account.

## 9. Which original references are usable

Checked by searching each file for Jira, Xray, TMS, acli, `jira:sync` and `{{jira.` prose.

| Reference | Verdict | Where the Jira / TMS prose is |
|---|---|---|
| `kata-architecture.md` | cited | Steps-vs-ATC row and the adoption steps mention a TMS; ignore them. Layers, fixtures, ATC rules apply. |
| `typescript-patterns.md` | cited | none |
| `e2e-patterns.md` | cited | one checklist line says an ATC id matches a TMS case; here it matches a case file id. |
| `test-data-management.md` | cited | none |
| `data-testid-strategy.md` | cited (for contrast and a future adoption) | none |
| `review-checklists.md` | cited | two lines ask for real TMS ids and a linked TMS case; replace by "id equals an existing case file". |
| `api-patterns.md` | not cited now (no api case is automatable until the fixture exists); no Jira prose | none |
| `atc-tracing.md` | NOT cited | heavy TMS sync mechanics throughout; the local flow is section 3 here. |
| `planning-playbook.md` | NOT cited | built around Jira tickets and Epic trees; the local plan shape is in SKILL.md Phase 1. |
| `automation-standards.md` | NOT cited | TMS-bound naming and quality-gate rows; its useful parts repeat the cited files. |
| `ci-integration.md`, `batch-fleet.md`, `explain-tests.md` | NOT cited | tracker write-back and fleet protocol, outside this skill's scope. |
