# ADR-0018 — Sweep Pending Decisions (SPD): the human-facing session asks everything that waits in one structured call, with a prose fallback for harnesses that lack the tool

- **Status:** Proposed (evaluation requested by the owner on 2026-10-22; nothing here is implemented or approved)
- **Date:** 2026-10-22
- **Deciders:** framework owner (boilerplate maintainer). Drafted by the `spd-evaluation` session at the request of the webapp conductor, which adopted SPD the same day (webapp `CLAUDE.md` Rule 21, `agent-decisions.md` §"SPD")
- **Tags:** decisions, multi-harness, orchestration, instructions, hooks
- **Supersedes:** —
- **Superseded by:** —

Every claim below is labelled `measured` (observed on this machine, 2026-10-22), `read` (a document or source opened, with its origin) or `predicted` (inference). Open questions for the owner are in §"Decisions the owner must take".

---

## Context

The webapp repo standardized one habit: a session about to leave something pending for the owner asks all of it at once with Claude Code's `AskUserQuestion` (max 4 questions, recommended option first, a "later" option, escalation to `mkd` when dense), and only the conductor session does it. It named it SPD, sibling of MKD (`read`: webapp `agent-decisions.md`).

This repo already holds most of the surrounding machinery (`read`, all in `.agents/skills/agentic-qa-core/references/` unless noted):

| Need | Where it already lives | What it does not say |
|---|---|---|
| WHETHER a question reaches a person | `decision-protocol.md`: search the record, decide technical calls inside the approved plan, escalate only four kinds (product behaviour, new security posture, irreversible/outward, what a person signs) | nothing about what to do at the end of a turn that still has such items |
| WHICH instrument asks | `decision-elicitation-doctrine.md` §1 ladder: harness prompt for up to three simple questions, `mkd` above three or for one dense tradeoff; last row: no human at the wheel, state the assumption | no batching rule, no "later" answer, no fallback for a harness without a question tool |
| What a person signs, per stage | `stage-gates.md` "The person signs" column | a per-stage list, not a turn-level habit |
| A batched ask in two places | `artifact-lifecycle.md` §4 and `preflight-gate.md` §5 each ask ONE `AskUserQuestion` for their own gap | local to those two flows |
| Conductor vs worker | `orca-orchestration` (worker sends `worker_done`, blocking `ask`, `escalation`); the prompt hook tells a dispatched worker "never SendMessage/AskUserQuestion" (`.agents/hooks/personality-reinject.mjs`, `ORCA_CONTEXT_LINE`) | the conductor's duty to sweep what the workers list |
| The `mkd` deck | user-level skill installed by `cli/install.ts` (`USER_LEVEL_SKILLS`), gated by the doctrine §3 | — |

So the gap is narrow and real: **nothing tells a session that the way to end a turn holding open items is one structured call, not a prose list.** A prose list is the failure SPD removes (the owner has to remember to answer, and the answers arrive unanchored).

`AskUserQuestion` is a Claude Code tool. This repo supports Claude Code, Codex and OpenCode (`agent-harnesses.md` §4.5). Per-harness reality (`read` unless marked; sources opened 2026-10-22):

| Harness | Structured-question tool | Limits | Headless | Subagents / workers |
|---|---|---|---|---|
| Claude Code 2.1.308 (`measured`: binary) | `AskUserQuestion` | 1-4 questions, 2-4 options, automatic "Other", multiselect, previews (code.claude.com/docs/en/agent-sdk/user-input) | in the SDK it goes through the host's `canUseTool`; the binary carries "tool requires user interaction; no prompt available in headless mode" (`measured`, not tied to this tool) | SDK docs say not available to Agent-tool subagents; issues contradict this for foreground subagents. Conflicting |
| Codex CLI 0.159.3 (`measured`) | `request_user_input` | 1-3 questions ("prefer 1"), 2-3 options, "Other" added by the client, no multiselect, no previews (openai/codex `request_user_input_tool.rs`) | `request_user_input is not supported in exec mode` (`measured`: binary) | unverified |
| OpenCode 2.0.20 (`measured`) | `question` (permission key `question`) | header, text, options, `multiple`, custom answer automatic; label max 30 chars (`measured`); per-call caps unverified | `opencode run` disables it (opencode issue #11899) | child sessions do not inherit `question: deny` |
| Gemini CLI (not installed here) | `ask_user` | 1-4 questions, 2-4 options, types `choice`/`text`/`yesno` (geminicli.com/docs/tools/ask-user) | denied non-interactive | unverified |

Two facts from that table drive the design: **Codex caps at three options and, by default, exposes the tool only in Plan mode** (`read`: openai/codex issue #29104, PR #12735; flag `default_mode_request_user_input`), so on Codex the prose fallback is the common path and not an edge case. And **a tool-less turn is not a failed turn**: every harness here already runs headless sessions where the tool is absent, and this repo's own measurement harness (`claude -p`, ADR-0017) is one of them.

The repo has no `Stop` hook on any harness (`measured`: `.claude/settings.json` registers `UserPromptSubmit`, `SessionStart`, `PostToolUse`; `.codex/hooks.json` the same three; the OpenCode adapter uses `experimental.chat.system.transform` and `experimental.session.compacting`).

---

## Decision (proposed)

We will add the sweep as a **short binding paragraph plus one reference section**, with no new skill and no new Critical Rule. SPD sorts out HOW pendings are asked; it never widens WHAT is asked. `decision-protocol.md` still decides what reaches a person.

### 1. The rule, in harness-neutral words (for `AGENTS.md` §2, "ASKING THE HUMAN TO DECIDE")

Append to that paragraph:

> **SWEEP AT THE TURN END (SPD, binding).** Before a message that would leave something waiting on the human, the session that talks to the human asks every such item at once, in ONE structured-question call, instead of listing it in prose. An item counts only if `decision-protocol.md` §5 lets it reach a person: a technical call is decided and reported, never swept. At most three questions per sweep, the recommended option first and marked, a "Later" option unless the item blocks the work; more than three, or one dense tradeoff, goes to `mkd`. A harness with no structured-question tool, or a call the harness refuses, uses the numbered-list fallback in `agentic-qa-core/references/decision-elicitation-doctrine.md` §7. A worker, a subagent and an unattended routine never sweep: they list their pendings in their report and the conductor sweeps them.

Why three and not four: it matches the existing ladder ("more than three decision points" goes to `mkd`) and fits Codex's cap. Claude Code and Gemini can carry four; the repo's number stays three so one text works on all three harnesses.

### 2. The reference section (new §7 in `decision-elicitation-doctrine.md`)

Proposed content, in order:

1. **Who sweeps.** The session that is talking to the human and was not launched by a conductor. A session whose brief names a conductor is a worker: no sweep, it uses `ask`/`escalation` (`orca-orchestration`). A custom-argv terminal a human pastes into counts as a worker when its brief names a conductor. No human at the wheel: no sweep, park and report (`decision-protocol.md` §5, last paragraph).
2. **When.** Before any message that ends with an open item: a decision, an unconfirmed assumption, an item left for later. In plan mode, before `ExitPlanMode`, which stays reserved for approving the plan. What has a sensible default is not pending: decide it, say it in one line, move on.
3. **Portable shape.** Each question: one pending, a short header (12 characters, the Claude/Codex cap), **at most two real options plus "Later"** (the Codex cap of three; Claude Code and Gemini may add a third real option). The recommended option first, labelled "(Recommended)" with the reason in its description. The "Other" free-text entry comes from the tool; do not add one. Each option states its value and its cost, as the doctrine §2 already demands of a deck.
4. **"Later" is an answer.** Record it as deferred in the session's `progress.md` (`session-management.md` §7), do not ask it again in the same session unless it starts to block, and let a new session re-raise it once, only if the handoff lists it.
5. **The answer is the execution contract**, read as §5 of the doctrine already reads a deck result: "Other" text is executed as written; an answer that says the question was not understood means do NOT execute, explain it plainly, ask again.
6. **Mapping table** (the one above, columns Harness / Tool / Cap / Where it is absent). The doctrine keeps the table; AGENTS.md never names a tool.
7. **Fallback, for a harness with no tool, a refused call, or a mode where the tool is off** (Codex outside Plan mode, any headless run):

   ```text
   Pending (3). Answer with the numbers, for example "1a 2b 3 later":
   1. <the question, one sentence> 
      a) <option> (recommended: <why>)   b) <option>   c) later
   2. ...
   ```

   Same content as the structured call: at most three items, a recommended default, a "later" choice, blocking items first. The fallback is a real sweep, not a degraded one. A turn that ends with an unnumbered paragraph of questions is the defect this ADR exists to remove.
8. **What it is not.** Not a license to ask more (the four kinds still bound it); not for a decision `decision-protocol.md` §3 says is settled; not for a routine.

### 3. Placement and smallest change

| Edit | File | Size |
|---|---|---|
| One paragraph appended (text in §1) | `AGENTS.md` §2, "ASKING THE HUMAN TO DECIDE" | about 110 words |
| New §7 "The sweep at the turn end" + the mapping table + fallback template | `.agents/skills/agentic-qa-core/references/decision-elicitation-doctrine.md` | about 60 lines |
| One bullet in the compact rules of `agentic-qa-core` so `REGISTRY.md` carries it to executors (Rule Reachability, AGENTS.md §3) | `agentic-qa-core/SKILL.md` `## Compact Rules`, then `bun run skills:registry` | 3 lines |
| One sentence in every conductor briefing template: "list your pendings in the report; never ask the human" (Rule Reachability: a rule that must bind an executor lives in the reference, the compact rules AND component 7 of the briefing) | `orca-orchestration/templates/COMMON.md` and `references/brief-template.md` | 2 lines |
| Triggers `\bSPD\b`, `\bsweep\b`, `\bpendientes\b` on the section that owns "ASKING THE HUMAN" so the hook routes it | the instruction file's `triggers:` frontmatter, NOT a new ROUTER row (rows are locked by `instructions:check`) | 1 line |

Every edit to `AGENTS.md` or an instruction section goes through `/framework-development` mode `instructions` (AGENTS.md header; ADR-0013). Whether the `AGENTS.md` paragraph fits that file's size budget is not verified here: `instructions:check` decides.

A webapp-style numbered Critical Rule is NOT proposed. The Critical Rules are the break-glass list (credentials, history, attribution); the sweep is conduct, and §2 is where the existing asking paragraph lives.

### 4. How it fits the existing doctrine (point by point)

- **Contradiction with `decision-protocol.md`?** None, if the "counts only if §5 lets it reach a person" sentence stays. Without it, SPD would read as "ask everything that is open", which is the stop-on-everything failure §7 of that file names. This is the single most important wording in the proposal.
- **Contradiction with the orchestration doctrine?** None found. Conductor/worker is already the split (`ask`, `escalation`, `worker_done`). One real friction, `predicted`: `artifact-lifecycle.md` §4 and `preflight-gate.md` §5 instruct "ONE `AskUserQuestion`" inside skills a WORKER may run in a fleet, while the hook tells that worker never to use it. Today the worker's brief wins (it uses `ask`). The new text should say once, in the doctrine, that in a fleet those two flows become a pending in the report. Not verified by running a fleet.
- **Conductor-only wording.** The webapp phrase "knows it is the conductor" is replaced by "talking to the human and not launched by a conductor", because in this repo the main conversation is the command centre by default (AGENTS.md §3) and a QA person's plain session is the common case, not a fleet.

### 5. Where the IQL stages plug in

The sweep is not a stage gate; it is how a stage reports a gate. Each "The person signs" cell in `stage-gates.md` that the current run reaches becomes one question in the sweep, with its evidence attached (Shift-Left open questions to PO/Dev, plan approval before automation code, the filing of a bug, the CAUTION verdict, the merge). A stage report that today ends "waiting for your OK on X, Y, Z" in prose ends with the sweep instead. No gate changes its autonomy level (`stage-gates.md` rule: "No stage changes autonomy level").

### 6. Naming

Keep **SPD / Sweep Pending Decisions**. It is already English, it pairs with `mkd` (Make Decision, which exists here as a user-level skill, `measured`: `USER_LEVEL_SKILLS` in `cli/install.ts`), and the owner uses the acronym in both repos. The Spanish "barrido de decisiones pendientes" stays only as a trigger phrase, per the owner's English-names rule. In running prose use "the sweep".

---

## Test plan

| What | How | Harness | Label |
|---|---|---|---|
| Router sends the right file for sweep prompts | add 4 labelled prompts ("close the session with pendings", "ask the owner the open items", "SPD", "barrido de pendientes") to the router eval, scored as in ADR-0017 | all (shared classifier) | to run |
| Compat contract | extend `agents:compat:check` with one assertion: the doctrine's mapping table has a row for every harness in `HARNESS_FILES` | all three | to run |
| Fallback path in a real session | controlled `claude -p` sessions (the ADR-0017 harness): a task that leaves 3 open items; score the final message for a numbered list with a recommended default and a "later" choice, against the same task before the edit. This is the ONLY path `-p` can exercise, because the tool is absent headless | Claude headless; repeat on `codex exec` and `opencode run` | to run |
| Tool path | interactive session driven through a PTY (`expect`, as the installer dry run does): confirm the model calls the structured tool once with at most 3 questions and records a "Later" in `progress.md` | Claude Code; Codex in Plan mode; OpenCode | to run |
| Worker does not sweep | dispatch one worker with a deliberately open product question; its report lists the pending and the transcript shows no question-tool call | Claude Code worker | to run |
| Over-asking guard | a session with only technical forks inside an approved plan must ask nothing and report them as DECIDED | Claude Code | to run |
| Adherence over time | extend `instructions:audit` with one metric: final assistant messages that end in a question or a "pending" list, with and without a question-tool call or numbered fallback in the last turn; read the baseline before the change and again after a fleet has run on it | Claude Code transcripts first | to build |

## `Stop` hook: not yet

`Stop` exists and can block on Claude Code (exit 2 or `{"decision":"block"}`), Codex (same, with `stop_hook_active` against loops) and Gemini CLI (`AfterAgent`, `deny`) (`read`: code.claude.com/docs/en/hooks, learn.chatgpt.com/docs/hooks, geminicli.com/docs/hooks/reference; none exercised on this machine). OpenCode's `session.idle` is observation only in its docs; injecting a follow-up through the plugin client is `predicted`, unverified.

Recommendation: do not build it in the first change.

- Detecting "the message leaves something pending" is a text heuristic on the last assistant message. False positives (a rhetorical question, a quoted AC) would block a turn that is correct, and a blocked turn costs a full extra model call.
- The repo's own evidence favours measuring first: ADR-0017 moved route reads from 40.0% to 92.9% with a clearer cue and a cap, and added its re-surface hook only as a one-shot reminder whose own effect is still unmeasured.
- Build order: instruction paragraph, then the audit metric, then read the number. If compliance on the audit stays under the owner's floor (propose the same 90% used for binding route recall), add a one-shot `Stop` reminder on Claude Code and Codex, never a hard block, guarded by `stop_hook_active`, and ship the OpenCode adapter later or not at all.

## Consequences

- **Positive:** open items stop leaving the turn as prose; one answer round per turn; a deferred item is recorded instead of forgotten; the same text works on three harnesses with no per-harness instruction copy (AGENTS.md remains the single body, per §4.5).
- **Negative / trade-offs:** about 170 words of always-on or routed instruction; one more thing a weak model can ignore (the rule depends on instruction following; only a hook would enforce it); on Codex outside Plan mode the fallback is the normal path, so the structured call is a Claude Code, Gemini and Plan-mode-Codex benefit; the three-question cap is tighter than Claude Code's four.
- **Neutral / follow-ups:** the Claude 2.1.308 binary also contains a newer question schema (`kind: choice|text|number`); whether it is a gated variant of `AskUserQuestion` is unverified, so the mapping row should be re-read when the harness version moves. Foreground-subagent behaviour of the tool on Claude Code is documented both ways; the rule already forbids workers to ask, so nothing depends on it.

## Alternatives considered

- **Copy the webapp wording (a numbered Critical Rule, max 4 questions, tool named in the rule).** Rejected: names a Claude-only tool in an always-on file shared by three harnesses; a fourth question does not fit Codex; and a Critical Rule is the wrong tier for a conduct habit.
- **A new `sweep` skill.** Rejected: the behaviour is two sentences plus a table, and a skill loads only when triggered, which is exactly when the habit is skipped. The hook-routed instruction section and the compact rules already reach the session.
- **Add it to `mkd`.** Rejected: `mkd` is user-level and optional (doctrine §3 handles its absence), while the sweep must work on a machine that never ran the installer.
- **A `Stop` hook from day one.** Rejected for now, see above.
- **Sweep only when the tool exists.** Rejected: the failure is the prose list, and that happens most where the tool is absent.

## Side question: the worktree-close rule (webapp commit `8342f8f5`)

Verdict: **yes, port it, with the resume exception this repo already documents.** `read`: that commit's message and diff (webapp, 2026-10-19; `worker-release` closes the agent terminal only, five merged worktrees of about 1.8 GB each were left; I did not re-measure the cost here).

Current state in this repo (`read`): `orca-orchestration/SKILL.md` line 24 says "Remove a worktree only after the orphan audit", which allows removal but does not require it; `references/coordinator-playbook.md` §6 lists the audit and, at its item 4, tells the conductor to KEEP the worktree while a session may still be resumed. The webapp rule is blanket and puts its only exception in `roster.md`. The port should keep item 4 as one of the allowed written reasons, otherwise the two rules contradict.

Proposed wording.

`SKILL.md`, replacing the last sentence of the "DO close a finished worker" bullet (and the matching Quick start step 7):

> Release the supervised worker by its dispatch; without a dispatch, COUNT the terminals in that worktree before closing anything, because the stop verb's radius is the whole worktree. `worker-release` closes the agent terminal only: the worktree, its `Setup` terminal and its local branch survive it and pile up. So after the orphan audit the conductor removes the worktree in the same turn (`orca worktree rm --run-hooks`) and confirms with `git worktree list`. A worktree stays only with a written reason and an owner in `roster.md` (a worker session that may still be resumed is such a reason, see the playbook §6 item 4).

`coordinator-playbook.md` §6, after the audit list:

> Removing is part of closing, not a later chore. Removable when ALL hold: its HEAD is an ancestor of the integration branch, `git status --porcelain` shows nothing that is not disposable, `bun run worktree:audit` exits 0, nobody will resume the session (else write why in `roster.md`), and no terminal other than `Setup` is left in it. A worktree some other session created, one not in your roster, is not yours to remove: report it to the owner with the audit. End-of-run check before the final report: `git worktree list` shows only the primary checkout plus the worktrees `roster.md` explains; anything else is a leak, close it or name it.

`worker-contract.md`:

> A worktree YOU created for sub-work is yours to remove before `worker_done`, after copying out any gitignored evidence. Your own worktree is the conductor's to remove: leave nothing gitignored that lives only there, and say in the summary where you copied logs and evidence.

This repo holds the origin copy of the skill; the webapp receives it through `bun sync`, so the edit is made here only.

## Decisions the owner must take

1. Adopt the sweep at all, in the form above (instruction paragraph + doctrine §7, no Critical Rule, no hook)?
2. Cap of three questions per sweep (portable) or four (Claude/Gemini only, with a two-tier text)?
3. Build the audit metric first and decide the `Stop` hook on its number, or skip the hook for good?
4. Port the worktree-close rule now, with the resume exception?
