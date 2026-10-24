# ADR-0022 — The evidence page is the reference implementation's page, copied, and its builder is the reference builder

- **Status:** Accepted (by the conductor of the discovery-impl fleet, on the owner's rule for wave 3 and the owner's CHANGE-01 decision, 2026-10-24)
- **Date:** 2026-10-24
- **Deciders:** framework owner (boilerplate maintainer), through the fleet conductor's plan approval for the `e2b-evidence-identical` delivery
- **Tags:** evidence, reporting, privacy, hosting, sprint-board
- **Supersedes:** ADR-0021 in part (points 1, 4, 5, 6 and 9)
- **Superseded by:** —

---

## Context

ADR-0021 shipped an evidence page with its own design, its own pack format (`evidence-pack/1.0`) and a TypeScript builder with a zero-dependency image codec. The owner rejected the design: the page must look and behave exactly like the reference implementation the delivery was ported from, which the owner had already iterated with its readers (viewer, retest history, compare labels, pills, palette, fonts). Rebuilding that design by hand drifts on every detail, and keeping a second builder in another language means every later change to the reference has to be ported twice. The reference builder is a Python script on Pillow; Python is expected on the machines this repo runs on.

## Decision

We will copy the reference implementation's evidence page and builder, and change only what is specific to its project.

1. **The page is a verbatim copy.** `evidence-artifact.html`, `shared.css` and `shared.js` live in the `evidence-artifact` skill's `templates/`, byte-identical to the reference except two code comments (a path and an example key). The Google Fonts links and the host markup stay. Nobody edits them per ticket; a design change is an owner request.
2. **The pack is the reference's format under a new generic id, `evidence-pack/2.0`.** `evidence-pack/1.0` is refused with one line naming the replacement, never read as a different shape. Ticket keys follow `board.ticket_key_pattern` (ADR-0019), passed to the builder, never a hardcoded key shape.
3. **The builder is the reference `scripts/build.py`** (Python 3.9+ and Pillow), copied into the skill: same modes (`--pack --out`, `--thumb`, `--extract`), same JPEG q88 native-size inlining, same history marking, compare labels and mark conversion, so the page is the reference's by construction. Measured: on twin synthetic packs the two builders produce byte-identical embedded data and the same markup except the comment lines of point 1.
4. **The safety rules of ADR-0021 move into that builder**, each with a regression test (`scripts/test_build.py`, stdlib `unittest` plus Pillow): the extended secret scanner, redactions burned once per resolved file (the union of every key's boxes), images confined to the repo root and refused when they are session state, HAR or traces, links rendered as `href` limited to http(s) and in-page deep links, the size guard naming the largest images, the verdict and retest rules judged on the current round, unknown fields refused. A JPEG capture now takes a burned redaction (Pillow decodes it); ADR-0021 refused it only because it had no decoder.
5. **One status enum** in `cli/lib/evidence-page/statuses.json`, read by the TypeScript module the Sprint Board imports and by `build.py`. The list is add-only.
6. **TypeScript keeps what touches no image**: `bun run evidence` (`build` and `extract` call `build.py` after checking that Python and Pillow are installed, naming the one install command when not; `record`; `demo`), the host seam and `record`'s allowed-host check (ADR-0021 point 7, unchanged). The TypeScript renderer, PNG codec and raster code are deleted.
7. **The agent workflow is a T1 skill, `evidence-artifact`**, adapted from the reference skill (its tracker-specific image recipe left out). It replaces `agentic-qa-core/references/evidence-page.md`, which stays as a one-line pointer. `bug-screenshot-annotation` stays and points to the skill.

## Consequences

- **Positive:** the page the owner approved is the page users get; a later change to the reference ports as a diff of copied files; one validator (the one that renders) checks every pack, also before `record` writes a URL; JPEG captures can be redacted.
- **Negative / trade-offs:** the evidence page now needs Python 3.9+ and Pillow on the machine, a dependency outside Bun; `bun sync` delivers the script but not Pillow, so a consumer installs it once (the CLI names the command). The page loads its web fonts at view time again (the reference does). The installer's external-tool table does not list Python yet.
- **Neutral / follow-ups:** tracker attachment hosts (embedding the thumbnail in the bug) and a CI host stay adapters behind the host seam; adding Python and Pillow to the installer's checks is open.

## Alternatives considered

- **Keep the TypeScript builder and port `build.py` into it** (the approved plan before CHANGE-01). Rejected by the owner: identical output by construction beats identical output by porting, and a hand-written JPEG encoder is code the reference does not need.
- **Restyle the ADR-0021 page to look like the reference.** Rejected: a redesign drifts on every detail the owner already settled.
- **Reuse `evidence-pack/1.0` for the new shape.** Rejected: one id must never name two shapes.

## References

- Agent workflow: `.agents/skills/evidence-artifact/SKILL.md`, `references/workflow.md`, `references/pack-schema.md`, `references/privacy.md`.
- Builder and tests: `.agents/skills/evidence-artifact/scripts/build.py`, `scripts/test_build.py`; CLI `cli/evidence-page/index.ts`.
- Earlier decision: ADR-0021 (host seam, `record`, module paths still stand).
