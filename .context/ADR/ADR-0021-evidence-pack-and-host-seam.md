# ADR-0021 — Evidence is a versioned pack built into one offline HTML page, published through a host seam

- **Status:** Accepted (by the conductor of the discovery-impl fleet, on the owner's decisions D13, D17, D19 and D21, 2026-10-24)
- **Date:** 2026-10-24
- **Deciders:** framework owner (boilerplate maintainer), through the fleet conductor's plan approval for the `e2-outcomes-evidence` delivery
- **Tags:** evidence, reporting, privacy, hosting, sprint-board
- **Supersedes:** —
- **Superseded by:** ADR-0022 in part (points 1, 4, 5, 6 and 9: the page design, the pack format, the builder; points 2, 3, 7 and 8 stand)

---

## Context

Manual QA evidence in this repo is a set of screenshots in the ticket's gitignored `evidence/` folder, plus annotated PNGs from `bug-screenshot-annotation` (callouts flattened into pixels through a loopback server and a browser capture). The reference implementation this delivery ports replaced that with one page per ticket and per bug, where annotations are data, and measured what hurt before: flattening needed a capture and a manual fix pass per image, and mosaics were illegible. A third-party image service (upload, resize, OCR, hosting) is an exfiltration path and can expose evidence publicly, so evidence must never pass through one. Its own hindsight: the single hosted target was the main coupling, the page loaded web fonts at view time, and ticket and bug statuses lived in separate lists, so a retest status on a case rendered in a neutral colour.

The Sprint Board (later work) needs a link per ticket and per bug and a machine-readable verdict. A future harness may have no hosted artifact tool at all.

## Decision

We will describe evidence as DATA, an evidence pack (`evidence-pack/1.0`), and build it with a Bun/TypeScript builder into ONE self-contained HTML page per ticket and per bug, published through a host adapter seam.

1. **The pack** holds the ticket and its verdict, the environment, the cases with typed evidence items (`image | api | sql | timeline | note`), images with redaction boxes, marks as data with real element-box coordinates, the bugs a story filed, and earlier retest rounds as BEFORE FIX history that never counts in the verdict. Packs and pages live in the ticket's gitignored `evidence/` folder at paths that never change.
2. **One status enum** (`cli/lib/evidence-page/statuses.ts`) serves the schema, the builder, the page and later the board. Case statuses ARE the sprint source's `TestStatus` (ADR-0019); verdicts are PASSED / FAILED / PENDING; bug statuses are OPEN / FIXED / RETEST PASSED / RETEST FAILED. Every status has a tone and every bug status a board bucket, both typed with `satisfies`, so a missing one is a compile error. Each field accepts only its own subset.
3. **The validator is fail-closed** and names the JSON path of every error: PASSED and FAILED need an evidence item (D21), BLOCKED needs a reason, DEFERRED a reason and a follow-up key, a verdict the current cases contradict is refused (never corrected), a bug's RETEST PASSED stands only when the current round allows PASSED with no deferral in it (RETEST FAILED needs a FAILED case), keys follow the board's `ticket_key_pattern`.
4. **The builder refuses secrets** (bearer tokens, JWTs, cookies, private keys, cloud keys, values under secret-named keys unless masked; emails warn), naming the path and the rule, never the value. It refuses image paths outside the pack folder, `.auth` files, HAR, traces and state files, and anything not PNG or JPEG by its bytes. It **burns redactions into the pixels**: a mark is not a mask. Redactions are applied per FILE: two image keys on one screenshot burn the union of their boxes, so no key can inline an unredacted copy. Images inlined without a redaction lose their text, EXIF and comment metadata. It checks the final page against a size limit under the 16 MB hosted page limit, read in decimal megabytes. A link the page renders as `href` must be an absolute http(s) URL.
5. **The page is offline**: inline CSS and script, system fonts, images as data URIs, marks as an SVG overlay. It follows the hosted page contract (no document skeleton, since the host wraps it); built for the `local` host it is a full standalone document with a doctype, so a browser opening it from disk does not fall into quirks mode. The pack, minus image bytes and paths, is embedded as JSON for later readers.
6. **No new dependency.** PNG decode/encode runs on `node:zlib` with a table CRC; JPEG is inlined as-is and cannot take a redaction or a thumbnail. Reason: `bun sync` appends upstream `devDependencies` to a consumer but never installs them, so a synced `cli/` module importing a new package would break downstream until someone ran `bun install`.
7. **Host seam** `publishEvidence(htmlPath, existingRef?) -> ref`. The default host is the Claude hosted artifact, private by default; the CLI cannot call the harness's `Artifact` tool, so it returns the exact agent step (read the existing URL first, republish to the same URL, never mint a second) and `bun run evidence record` stores the returned URL, accepting only a host in `board.evidence.allowed_hosts`. The `local` host returns the page path for harnesses with no hosted equivalent.
8. **Modules live in `cli/lib/evidence-page/` and `cli/evidence-page/`**, never in a folder named `evidence`: the shipped `.gitignore` ignores every `evidence/` folder (that is where captures go), and `bun sync` does not touch a consumer's `.gitignore`, so a module there would be ignored in every consumer repo.
9. **Ownership now:** the agent workflow is a reference, `agentic-qa-core/references/evidence-page.md`; `bug-screenshot-annotation` coexists and points at the page as the direction. Wiring the page link into the ATR, the bug, the QA comment and the board, and deciding whether a dedicated skill or the retirement of the annotation skill follows, is later work.

## Consequences

- **Positive:** one link per ticket and per bug instead of loose images; annotations stay editable data; a credential or an unredacted region cannot reach a page by accident; the page works on any host or none; the board can read the verdict from the embedded pack.
- **Negative / trade-offs:** PNG inlining is larger than JPEG, so big full-page captures hit the size limit sooner (the error names the largest images). JPEG captures cannot be redacted. The codec covers 8-bit non-interlaced PNG only, which is what Chromium writes. Publishing needs an agent step; a CLI-only flow gets the `local` host.
- **Neutral / follow-ups:** recovering a pack from a published page, a tracker attachment host and a CI artifact host are new adapters behind the same seam.

## Alternatives considered

- **`sharp` for image work.** Rejected: native binaries per platform and install-time fragility under Bun, on top of the sync problem in point 6.
- **`pngjs` + `jpeg-js`.** Rejected: pure JS, but new packages a consumer would not have installed after `bun sync`.
- **A Python builder** (as in the reference implementation). Rejected: the repo's modules run on Bun (SPD 2).
- **Supersede `bug-screenshot-annotation` now.** Rejected for this delivery: retiring it touches routing, settings, the onboarding page and the Stage 3 reporting flow, while the page is not yet wired into Stage 3.

## References

- Reference for agents: `.agents/skills/agentic-qa-core/references/evidence-page.md`.
- Bucket and naming rules: `.agents/skills/agentic-qa-core/references/evidence-conventions.md`.
- Board configuration and `allowed_hosts`: ADR-0019.
- Outcome vocabulary: `.agents/skills/agentic-qa-core/references/discovery-driven-doctrine.md` §5.
