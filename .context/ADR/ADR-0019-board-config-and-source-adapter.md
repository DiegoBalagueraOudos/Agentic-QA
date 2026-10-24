# ADR-0019 — The sprint modules read one `board:` block and one `Source` interface; every status passes through the config or the snapshot fails

- **Status:** Accepted (by the conductor of the discovery-impl fleet, on the owner's decisions D12 and D14, 2026-10-24)
- **Date:** 2026-10-24
- **Deciders:** framework owner (boilerplate maintainer), through the fleet conductor's plan approval for the `e1-config-adapter` delivery
- **Tags:** configuration, project-yaml, tracker-adapter, sprint-board
- **Supersedes:** —
- **Superseded by:** —

---

## Context

The sprint conductor work (a Sprint Board, a Merge Line, an evidence page, then a thin conductor skill) is being ported from a reference implementation that grew inside one client project. The interview of that implementation measured its biggest porting risk: the status vocabulary was hardcoded in several files (a "tested" set, an "arrived in the test environment" literal, bug buckets by regex), so a wrong mapping in another tracker still renders a report, with wrong numbers. The rest of the hardcoded values were the ticket key pattern, the environment name, people, allowed evidence hosts, the mainline branch, the required approvals, the timezone and the logo. Its own author's hindsight: "config and adapter first, features second".

This repo already holds several of those values. `.agents/project.yaml` names the project key, the default environment, the production branch (`git_strategy.branches.production`), the required PR approvals (`git_strategy.policy.require_pr_reviews`), the TMS modality (`testing.tms_cli`) and the Atlassian host (`issue_tracker.atlassian_url`, resolved by `cli/lib/atlassian-instance.ts`). A second copy of any of them is the stale-copy hazard `agent-project-variables.md` documents for the host.

## Decision

We will configure every sprint module through one top-level `board:` block in `.agents/project.yaml`, read directly by `cli/lib/sprint-source/config.ts` (not a template-variable source), and feed every module from one `Source` interface in `cli/lib/sprint-source/`.

1. **Derive, never repeat.** The ticket key pattern defaults to `^<project_key>-\d+$`; the environment, mainline branch, approvals, modality and host are read from their existing keys at load time. The block holds only what has no home yet: the source choice, the ticket query, status buckets, the test status map, people, allowed evidence hosts, timezone and brand.
2. **`board.source: auto`** follows `testing.tms_cli` (`bun xray` = `jira-xray`, anything else = `jira-native`), the same pattern as `testing.tc_creation_stage: auto`, so the two can never disagree. `none` reads a `tickets.yaml` the owner edits, at `board.tickets_file` (default `.context/sprint/tickets.yaml`, versioned, because without a tracker that file is the system of record).
3. **Three implementations** (`jira-xray`, `jira-native`, `none`) return one `SourceSnapshot`: `syncedAt`, the `searched` denominators (always present, zero included), tickets keyed by id with their tests, bugs, and an optional `discover` block. Each adapter takes an injected transport, so tests replay recorded responses and never touch the network.
4. **The status invariant.** Every ticket and bug status sits in exactly one bucket of `board.statuses`; Jira sources name statuses by the workflow slugs of `.agents/jira-workflows.json`, the `none` source by its own strings. A mapped slug the catalog does not know fails at config load. A raw status no bucket lists throws `UnknownStatusError` at snapshot time, naming the item, the value and the config path to add it to. A status is never counted by default.
5. **Ticket buckets** are `not_ready`, `in_test`, `tested`, `blocked`, `dropped`; **bug buckets** are `open`, `fixed`, `resolved`, `discarded`; **test statuses** are `PASSED`, `FAILED`, `NOT RUN`, `BLOCKED`, `DEFERRED`. Later modules build on these names. `PASSED` and `FAILED` are the only executed outcomes, and only on observation; `BLOCKED` (the blocking ladder is open) and `DEFERRED` (a QA deferral recorded with a follow-up) are reasons a test is NOT RUN, per §5 of the discovery-driven doctrine (`agentic-qa-core/references/discovery-driven-doctrine.md`). They are kept apart so the board can show them, they count as NOT RUN in every metric, and `DEFERRED` is never the ROI "Deferred" verdict of test documentation.

## Consequences

- **Positive:** the board, Merge Line and evidence modules start from a vocabulary that cannot miscount in silence. A consumer scaffolded before the block existed learns about it through the schema diff of `.agents/project.schema.yaml`, with no back-fill hook. `bun run board:check` validates the block against the Jira catalogs inside `repo:check`, with no network.
- **Negative / trade-offs:** a project must assign every workflow status of its ticket and bug work types before a Jira snapshot runs; that is deliberate friction. The bucket names are now a contract: renaming one is a superseding ADR. The Xray test-run response used by the tests was recorded by hand from the API shape, not from a live call.
- **Neutral / follow-ups:** no `agents:setup` prompts yet; the delivery that ships `cli/sprint-board` adds them, where the buckets can be suggested from the workflow status categories. The identity leaves of the block are declared in `IDENTITY_PATHS`, so the maintainer copy can carry the dogfood project's values without shipping them.

## Alternatives considered

- **A separate `.agents/board.yaml`.** Isolates the block, but every new file under `.agents/` needs its own blank template, schema diff and updater wiring, and it is a second place to look for project values.
- **Constants in code with env overrides.** The scattering the reference implementation regretted; a status set in code is exactly what miscounted.
- **Statuses keyed by display name.** Display names change with a site's language or a workflow rename; the catalog slugs are what the rest of this repo already validates against.

## References

- `cli/lib/sprint-source/` (the module), `scripts/board-check.ts` (the gate).
- `.agents/README.md` §"`board`" (the block, key by key).
- `test-documentation/references/jira-setup.md` (the TMS modality rule `auto` follows).
- ADR-0018 (the decision sweep used to settle this delivery's open questions).
