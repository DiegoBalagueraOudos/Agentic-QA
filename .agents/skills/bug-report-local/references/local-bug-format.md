# Local bug format — folder, report, scrub rules, verbs

> Owner: `bug-report-local`. The case file contract is `test-documentation-local/references/local-case-format.md`; the report template is `sprint-testing/references/reporting-templates.md` section 1, used unchanged minus its Jira-only parts. When this file and `scripts/qa-local.ts` disagree, the script wins and the prose is the bug to report.
> Jira sentences in the cited template do NOT apply: labels, custom fields, attachment upload, tracker calls and post-creation links are dropped.

## 1. Folder layout of one bug

One folder per bug in the bugs area of the QA root. The id is `<case id>-BUG-<n>`; `n` is one global consecutive number across all bugs (not per case), from 1.

```
<qa-root>/bugs/<case id>-BUG-<n>/
  report.md                                  report, frontmatter + body (written by the verb, filled by the skill)
  <case id>-BUG-<n>-failure.png              raw failure screenshot, COPIED from the failing test's folder
  <case id>-BUG-<n>-annotated.png            output of bug-screenshot-annotation (visual or positional bugs only)
  <case id>-BUG-<n>-response.txt             optional scrubbed, truncated status / body excerpt (API bugs)
```

Images are linked from `report.md` with relative paths, for example `![failure](AUT-027-BUG-1-failure.png)`, so the Markdown renders offline from the folder. Nothing else belongs in the folder.

## 2. report.md frontmatter

Same simple `key: value` dialect `qa:local` reads and edits line by line. The verb writes it with CRLF line endings.

```yaml
---
id: AUT-027-BUG-1
case: AUT-027
title: "Login: lockout message not shown after the limit"
type: Defect
severity: Major
priority: High
error_type: Functional
environment: Dev
status: open
found_by: "2026-10-23-ola-1"
found_on: 2026-10-23
visual: false
evidence: []
---
```

| Field | Value set | Default | Notes |
|---|---|---|---|
| `id` | `<case id>-BUG-<n>` | allocated | must equal the folder name |
| `case` | an existing case id | the `bug new` argument | the verb refuses an unknown case |
| `title` | free text | `(por completar)` | pattern of template 1.2, `<EPIC>: <COMPONENT>: <ISSUE_SUMMARY>` |
| `type` | Bug, Defect, Improvement | Defect | template 1.0 |
| `severity` | Critical, Major, Moderate, Minor, Trivial | Moderate | section 4 |
| `priority` | Highest, High, Medium, Low, Lowest | derived | written by the verb from `severity`; never passed |
| `error_type` | Functional, Visual, Content, Performance, Crash, Data, Integration, Security | Functional | template 1.6, flag `--error-type`; `--visual` does not change it, so a visual bug passes `--visual --error-type Visual` together |
| `environment` | Dev, QA, UAT, Staging, Production | Dev | template 1.7, inferred from the base URL |
| `status` | open, fixed, verified | open | moves in section 7 |
| `found_by` | the run id (`last_run.run` of the case after `qa:local results`) | empty | flag `--run` |
| `found_on` | local date | the local date at creation | flag `--date` overrides |
| `visual` | true, false | false | flag `--visual` sets true; true means an annotated image is expected |
| `evidence` | list of file names in the folder | `[]` | only files verified on disk |

## 3. report.md body headings

Exactly as the verb writes them, in this order. Unfilled sections hold `(por completar)`; `## Causa raiz` starts as `por investigar`; `## Resultado esperado` is copied from the case's own section.

| Heading | Content |
|---|---|
| `# <bug id>` | the title line |
| `## Resumen` | one paragraph: what is wrong and its impact |
| `## Pasos para reproducir` | ordered list from the case's `## Pasos` or the spec's step titles; variables, never credential values |
| `## Resultado actual` | what the product did: status code, text, element state, scrubbed |
| `## Resultado esperado` | copied from the case; do not reword |
| `## Analisis tecnico` | file or component if known, network status, console message; no secrets |
| `## Impacto` | affected users, blocked functionality, business impact |
| `## Causa raiz` | a value from template 1.8, or `por investigar` |
| `## Workaround` | optional; `(por completar)` or "ninguno" |
| `## Evidencia` | relative links to the files of the `evidence` list; the annotated image first |
| `## Casos relacionados` | the case id, plus related cases |

## 4. Severity matrix and priority mapping

Severity (template 1.4):

| Severity | Criteria |
|---|---|
| Critical | Core blocked, no workaround, data loss |
| Major | Main feature broken, workaround hard |
| Moderate | Feature issue with an easy workaround |
| Minor | Minor issue, low priority |
| Trivial | Cosmetic only |

Priority is derived from severity by the verb (template 1.5):

| Severity | Priority |
|---|---|
| Critical | Highest |
| Major | High |
| Moderate | Medium |
| Minor | Low |
| Trivial | Lowest |

## 5. Evidence rules and what is never copied

- Playwright writes the failure artifacts of a test in a folder of the test-results folder named after the spec, the truncated test title and a hash that changes between runs. It holds `test-failed-1.png` (the failure screenshot), `trace.zip` and `error-context.md`; Playwright also prints the attachment paths in its own output. The evidence subagent finds the failing test's folder (the newest one, or the printed path) and lists it before naming the file.
- The failure screenshot, `test-failed-1.png`, is COPIED from that folder, never moved. `trace.zip` is never copied. `error-context.md` is session material, not copied by default: it can hold a page snapshot with real data.
- List a file in `evidence` only after verifying it on disk in this session (`agentic-qa-core/references/evidence-conventions.md`). The check refuses a listed file that is missing.
- An API bug carries a status code and a scrubbed, truncated body excerpt in `<case id>-BUG-<n>-response.txt`. Never a full response body.
- A non-visual bug has no image beyond the raw failure screenshot, and none is generated.
- The screenshot may show real product data: it stays local, and never goes to an external image service.

NEVER copied into the bug folder or the report:

| Never copied | Why |
|---|---|
| `trace.zip` and any `.zip` | traces hold request headers, cookies and tokens |
| `.har`, video (`.webm`, `.mp4`, `.mov`) | same, and large |
| the `.env` file or any dotenv content | credentials |
| cookies, `Authorization`, `Set-Cookie` and `Cookie` header values | session secrets |
| tokens (JWT shape, `access_token`, `refresh_token`), CSRF values, passwords | credentials |
| the Playwright call log block of an error message | it can carry request headers |
| a full response body | may carry personal data or tokens; excerpt only |

The decorator that records failures masks only a short list of key names, so its output is NOT proof of safety: the skill scrubs, and `bug check` verifies.

## 6. Scrub rules and what `bug check` scans

The scrub is mandatory. An assertion on a plain value prints no call log; an assertion on a locator or a request usually does, so the call log is never copied.

Scrub before writing any excerpt:

1. Drop the call log block of an error message and every line that names a request or response header.
2. Replace the value of any `password`, `token`, `secret`, `cookie`, `csrf`, `authorization` key with `[redacted]`, and any JWT-shaped string or `Bearer` value likewise.
3. Keep the status code, the field names and the visible text that shows the defect; truncate the body to the few lines that prove it.

`bun run qa:local bug check` scans every text file in a bug folder (images are skipped) for these patterns: JWT shape, `Bearer <value>`, `Set-Cookie`, `Cookie:` with a value, and `password`, `refresh_token`, `access_token` or `csrf` followed by a value. It also flags a forbidden file extension (`.zip`, `.har`, `.webm`, `.env`, `.trace`). It reports COUNTS and file names only, never the matched text. It is a pattern scan: a secret in an unrecognised shape passes it, so the scrub rules above stay the first line of defence. It validates `status`, `severity` and `type` as value sets, not `error_type` or `environment`. It verifies the `evidence` list of the frontmatter against disk, but NOT the image links inside the body: after writing, the skill confirms by hand that every link in `report.md` resolves to a file inside the bug folder and that the `evidence` list matches.

## 7. The `bug` verbs

All through `bun run qa:local bug ...`, with the optional `--root <dir>` and `--dry-run` of the other verbs.

| Verb | What it does |
|---|---|
| `bug new <case id> [--title T --type T --severity S --error-type E --environment ENV --run R --date D --visual]` | refuses an unknown case; allocates `n` with a non-recursive folder creation (another session that took the number makes it take the next); writes the `report.md` skeleton; prints the id and `carpeta: <dir>`; never edits a case file. An invalid enum value is a usage error. |
| `bug new <case id> --dry-run` | prints the id and folder it would allocate; writes nothing. Used for the draft preview. |
| `bug status <bug id> <open\|fixed\|verified>` | line-targeted edit of `status`. Legal moves: open -> fixed, fixed -> verified, fixed -> open, verified -> open (reopen). The same status prints "sin cambios"; any other move is refused. |
| `bug check [<bug id>]` | read-only. ERROR for: `report.md` missing, `id` differing from the folder, a `case` with no case file, `status` / `severity` / `type` outside the value sets, an `evidence` entry missing on disk, a forbidden file, a secret pattern. Output lines `ERROR <bug id>: ...` and `Resumen: N bugs, M ERROR`; `sin bugs` when none. |

Exit codes: 0 success; 1 for a usage error or for `bug check` with at least one ERROR. `bun run qa:local index` adds the Bugs section (open and fixed-pending-verification) to `estado.md`.

The link between bug and case is the `case:` field of the report. The case file gets a reference only through `bun run qa:local defect <case id> <bug id>`, which is refused unless the case is a candidate whose recorded run is FAIL (`qa:local results` writes it). Recording a bug does NOT require that link.

## 8. Naming and the annotation skill

- Bug id: `<case id>-BUG-<n>`. Annotated image: `<case id>-BUG-<n>-annotated.png`.
- The annotation skill names its output `{KEY}-BUG-{BUG-KEY}-annotated.png`. Pass KEY = the case id and BUG-KEY = `n` (the bare number). Passing the whole bug id as BUG-KEY would double the case id in the file name.
- Run its steps unchanged, with these local differences:
  - Skip step 9 (the Jira embed).
  - Use `python` (the launcher) for the loopback server, never `python3`, which does not return on this machine.
  - The crop and the HTML stay in the session scratchpad; only the final PNG goes in the bug folder.
  - Capture with an explicit destination path inside the bug folder, and read the PNG back before listing it.
  - Launch `playwright-cli` with the working directory in the session scratchpad, never in the repo root: it creates a `.playwright-cli` folder (snapshots, console logs) in the current directory. A single favicon 404 console error is harmless.
  - Step 5 of the annotation skill orders closing the browser before the resize and the screenshot, which is incoherent. The working order is: open the page, resize the viewport to the canvas, take the screenshot, THEN close. This is an adaptation here; the annotation skill itself is not edited.

### Annotation limits on this machine

- Pillow is not installed and the user declined to install it, so step 2 (the crop) cannot run as written. The crop is OPTIONAL here: when no crop is made, or the whole screenshot is the region, the raw screenshot is the base image of the annotation HTML.
- A crop WITHOUT Pillow works with `playwright-cli` (verified): put the screenshot in a small HTML wrapper whose container has `overflow: hidden` and the image offset to the wanted region, serve it over loopback like the annotation HTML, and take an ELEMENT screenshot with the CSS selector of the container (`screenshot "<selector>" --filename=<path>`). There is no `--clip` option. The wrapper and its output stay in the session scratchpad.
- Never a hand-made or generated image. If the annotation cannot be produced, the report is still written with the raw screenshot and its `## Evidencia` section says the visual evidence is missing and why; `visual` stays true so the gap is visible.
