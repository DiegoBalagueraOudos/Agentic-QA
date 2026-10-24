# Evidence Page (static, offline, one per ticket and per bug)

> Cited by: `sprint-testing` (Stage 2 capture, Stage 3 handoff), `bug-screenshot-annotation` (the direction its output moves to), and any subagent briefed to build or publish evidence. Code: `cli/lib/evidence-page/` and `cli/evidence-page/index.ts`, run through the `evidence` script in `package.json`. Decision record: ADR-0021. The shared bucket and naming rules stay in `evidence-conventions.md`.

The evidence page is ONE self-contained HTML file per story ticket under test, plus one per bug filed. It shows the verdict, the build under test, a board of cases and bugs, and per case the expected/actual pair, annotated screenshots, API calls, SQL results, timelines and notes. Earlier retest rounds stay on it as BEFORE FIX history that never counts in the verdict. It loads nothing at view time: no web fonts, no network, images inlined.

Its DATA is an evidence pack (`evidence-pack/1.0`, a JSON file). The builder renders the pack; the agent never edits the HTML.

---

## 1. Where the files live

All of it sits in the ticket's gitignored `evidence/` folder (`evidence-conventions.md` §1 Bucket B), so the page path never changes, which is what republishing to the same URL depends on:

```
<ticket folder>/evidence/evidence-pack.json            story pack
<ticket folder>/evidence/evidence-pack-<BUG>.json      one per filed bug
<ticket folder>/evidence/evidence-page/index.html      story page (default output)
<ticket folder>/evidence/evidence-page/<BUG>/index.html
<ticket folder>/evidence/<BUG>-thumbnail.png           optional, --thumb
```

Image paths in a pack are relative to the pack's folder and must stay inside it.

---

## 2. The pack

```jsonc
{
  "schema": "evidence-pack/1.0",
  "kind": "story",                        // or "bug"
  "ticket": { "id": "<KEY>", "title": "...", "verdict": "PASSED|FAILED|PENDING", "link": "https://..." },
  "env": { "name": "<env>", "url": "...", "build": "...", "commit": "...", "testedAt": "ISO", "tester": "..." },
  "summary": "...",
  "bug": { "status": "OPEN|FIXED|RETEST PASSED|RETEST FAILED", "severity": "...", "story": "<KEY>",
           "expected": "...", "actual": "...", "repro": ["step"], "thumbnail": "<image key>" },   // bug kind only
  "images": { "<key>": { "file": "shot.png", "redact": [{ "x": 0, "y": 0, "w": 0, "h": 0 }] } },
  "cases": [{ "id": "<KEY>", "title": "...", "status": "PASSED|FAILED|NOT RUN|BLOCKED|DEFERRED",
              "reason": "...", "followUp": "<KEY>", "expected": "...", "actual": "...", "evidence": [] }],
  "bugs": [{ "id": "<KEY>", "title": "...", "status": "<bug status>", "link": "https://..." }],      // story kind
  "history": [{ "round": 1, "at": "ISO", "build": "...", "cases": [] }],                             // BEFORE FIX
  "artifact": { "host": "claude-artifact|local", "ref": "<url>", "published": [{ "ref": "<url>", "at": "ISO" }] }
}
```

Evidence items: `{ "type": "image", "image": "<key>", "caption", "marks": [] }`, `{ "type": "api", "method", "url", "status", "request", "response", "caption" }`, `{ "type": "sql", "query", "columns", "rows", "caption" }`, `{ "type": "timeline", "events": [{ "at", "label", "detail" }] }`, `{ "type": "note", "text" }`.

Marks are DATA drawn over the image on the page: `{ "shape": "rect|ellipse|arrow|path|bubble", "tone": "defect|ok|note", "coords": "px|fraction", "x", "y", "w", "h" | "from": [x, y], "to": [x, y] | "points": [[x, y], ...], "text" }`. `px` (the default) is in the screenshot's own pixels.

**One status enum** serves the pack, the builder, the page and later the board (`cli/lib/evidence-page/statuses.ts`). Each field takes only its subset: case statuses are the sprint source's test statuses, verdicts are PASSED / FAILED / PENDING, bug statuses are OPEN / FIXED / RETEST PASSED / RETEST FAILED. A case marked `RETEST PASSED` is refused, never rendered in a neutral colour.

**What the validator refuses** (every error names the JSON path):

| Rule | Why |
|---|---|
| A PASSED or FAILED case with no evidence item | PASSED and FAILED only on observation (`discovery-driven-doctrine.md` §5) |
| A BLOCKED case with no `reason`; a DEFERRED case with no `reason` or no `followUp` key | a NOT RUN reason is a recorded decision |
| A `ticket.verdict` the CURRENT cases contradict (any FAILED → FAILED; any BLOCKED / NOT RUN, or only deferrals → PENDING) | a verdict is derived, never asserted; history rounds never count |
| A bug `RETEST PASSED` with no current PASSED case, `RETEST FAILED` with no FAILED case | a retest never closes on a deferral |
| A key that does not match the board's `ticket_key_pattern` (generic shape when `board:` is not configured) | one key shape across the board |
| An unknown field, a missing title, a mark or redaction outside its image | a typo must not drop evidence silently |

---

## 3. Capture: marks from the real element box

Place a mark from the element's real box, read at capture time, never by eyeballing the screenshot:

```bash
playwright-cli -s=<KEY> eval "JSON.stringify(document.querySelector('<selector>').getBoundingClientRect())"
```

Write the returned `x`, `y`, `width`, `height` as a mark with `coords: "px"`. With a device scale factor above 1, multiply by it (the screenshot is in device pixels). For a full-page capture of an app that scrolls inside a container, resize the viewport to the content height first and check the capture really holds the whole page. Reading the screenshot to place a mark is the fallback when no selector reaches the element.

Capture screenshots as PNG: a redaction is burned into PNG pixels, and a JPEG with a redaction is refused.

Append to the pack while testing (Stage 2), not at the end: each case gets its evidence the moment it is observed.

---

## 4. Build

```bash
bun run evidence build --pack <ticket folder>/evidence/evidence-pack.json [--thumb] [--host claude-artifact|local] [--json]
```

The build fails closed, in this order: the pack validates; no secret anywhere in it (bearer tokens, JWTs, cookies, private keys, cloud access keys, any value under a key that names a secret unless it is masked as `[REDACTED]` or `***`; emails only warn); every image resolves inside the pack folder and is a PNG or JPEG by its bytes (`.auth` files, HAR, traces and state files are refused); every mark and redaction lies inside its image; redactions are burned into the pixels; the page stays under the size limit (14 MB by default, `--max-mb` up to the hosted page limit of 16). An error names the path and the rule, never the secret's value.

`--thumb` on a bug pack writes the bug thumbnail: `bug.thumbnail` (or the first image of the first FAILED case), redactions burned, marks drawn, at most 1200 px wide.

`bun run evidence demo` builds a synthetic story page and bug page into a gitignored folder, to see the result without real data.

---

## 5. Publish: the host seam

The CLI builds; it never publishes. Hosts are adapters behind `publishEvidence(htmlPath, existingRef?) -> ref`:

| Host | What the agent does | Ref |
|---|---|---|
| `claude-artifact` (default) | Publishes the page with the harness's `Artifact` tool, then runs `bun run evidence record --pack <pack> --url <returned url>` | the artifact URL |
| `local` | Nothing: the report links the page path | the repo-relative path |

The build prints the exact step. For `claude-artifact`:

1. **First publish** (the pack has no `artifact.ref`): `Artifact` publish with `file_path` = the absolute page path and an `icon`.
2. **Every later round** (the pack has `artifact.ref`): `Artifact` with `action: "read"` on that URL first, then publish with the same `file_path` AND `url` = that URL. Omitting `url` mints a second page, and `record` refuses a second URL for the same pack.
3. `bun run evidence record --pack <pack> --url <url>`: accepts only a host listed in `board.evidence.allowed_hosts` of `.agents/project.yaml` (the shipped default when the block is not configured), and for `claude.ai` only `https://claude.ai/artifact/<id>` or `https://claude.ai/code/artifact/<uuid>`.

A harness with no `Artifact` tool uses `--host local`.

---

## 6. Privacy (travels unchanged to every host)

- The page is **private by default**. A session never shares it and never makes a public link; the owner shares it from the page's own share menu.
- **A mark is not a mask.** Anything sensitive in a screenshot goes in the image's `redact` list, which the builder burns into the pixels. A rectangle drawn as a mark can be removed by anyone who opens the HTML.
- Never on a page: traces, HAR files, tokens, cookies, `.auth` files, session state.
- Evidence never leaves through a third-party image service (upload, resize, OCR, hosting), whatever the chat authorises.
- No live publish is part of building: publishing is the agent step above, done on purpose.

---

## 7. Relation to `bug-screenshot-annotation`

That skill flattens callouts into a PNG for a Jira bug. The evidence page keeps marks as data and is the direction: when a ticket has a page, link the page from the report and keep the annotated PNG only where a tracker needs an inline image. Wiring the page link into the ATR, the bug, the QA comment and the Sprint Board is later work.
