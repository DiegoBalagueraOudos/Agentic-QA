# Recon Fan-out (step Recon)

Read this when dispatching the Recon agents. Pattern: **Parallel** per
`../../agentic-qa-core/references/dispatch-patterns.md`: one agent per surface or module, no shared state
between them, all dispatched in a single parent message, at most `orchestration.max_workers` at once
(`.agents/project.yaml`). The exploration technique inside each agent is the Trifuerza of
`../../sprint-testing/references/exploration-patterns.md` (§1 UI, §2 API, §3 DB): cite it, never copy it.

---

## 1. Per-agent structured schema (mandatory return shape)

Every Recon agent returns this shape, not free prose. It is what Refute and Handoff consume. The agent
writes it to `recon/<surface>.json` in the session directory and returns the same object.

```json
{
  "surface": "orders (module or flow slice name)",
  "deployed": true,
  "checks_run": [
    "compared 4 orders with discounted and full-price lines",
    "verified the per-customer discount on 6 accounts"
  ],
  "anomalies": [
    {
      "title": "A discounted line total equals its full-price sibling line total",
      "severity_hypothesis": "High",
      "evidence": "order <id>: line total = X, its own quantity x unit price x (1 - discount) gives Y, sibling total = X",
      "repro": "SELECT ... (verbatim SQL or curl)"
    }
  ],
  "observed": [
    {
      "behaviour": "e2e#feature-orders/BR-002 (gap id), or a new kebab id when the maps lack it",
      "what": "the product did <X> when <action> with <data> as <role>",
      "env": "staging",
      "observed_live": true,
      "covered_by": [{ "test": "PROJ-7013", "verdict": "weak", "evidence": "checks the total, not the discount" }]
    }
  ],
  "fixtures_used": ["account <id> (from module-context)"],
  "created_rows": []
}
```

- `deployed: false` means the surface does not exist in this environment yet (missing endpoint, empty
  table, feature flag off). It is an **environment blocker**, not a bug, and never "tested, no anomalies".
- `anomalies[].severity_hypothesis` is a hypothesis, not a verdict: Refute exists because one agent's
  severity read is unreliable. Never skip Refute because Recon called something Critical.
- `observed[]` is the raw material of candidate scenarios. `observed_live: true` only when the agent
  executed it in the environment it names; a code read, a unit test or another environment is
  `observed_live: false` and never becomes a candidate on its own
  (`../../agentic-qa-core/references/discovery-driven-doctrine.md` §5.2).
- `observed[].covered_by` lists every existing test that claims the behaviour, from the coverage view the
  charter passed in, each with a verdict (`exercises` | `weak`) and ONE evidence line. Empty when nothing
  claims it. A `weak` cover is not coverage.
- `created_rows` is mandatory even when empty (`[]`): it is the only cleanup ledger. Every row an agent
  creates appears here as `<table>:<id>` (or `<resource>:<id>` for a non-DB side effect) for Handoff to
  delete and re-read.

---

## 2. Compare at least 2-3 rows before calling something anomalous

The most common false-positive source in a fan-out is generalizing from one row. A loose `GROUP BY` or a
single suspicious value is a lead, not evidence. Before an agent writes an anomaly into its report:

1. Find at least 2-3 more rows with the same shape.
2. Check whether the "anomaly" also appears in rows that should be clean (a control group). If it does,
   it is probably a modeling choice, not a bug.
3. State the detection query precisely enough that a verifier can re-run it verbatim. "Looks off" is not
   reportable.

Measured, then rule: a loose dedupe key matched dozens of records, and most of them were legitimate pairs
that shared a description and a total by coincidence. The real defect, a handful of records whose value
was copied instead of computed, only survived once the key included the fields of the computation and
each record's own invariant was checked (`../../agentic-qa-core/references/adversarial-verification.md` §2).

---

## 3. Tool limits that bite harder in a fan-out

Recon touches many endpoints blind, not one ticket's known routes:

- **API**: the OpenAPI MCP is schema-only; authenticated calls go through `bun run api:login` and curl
  (`../../agentic-qa-core/references/api-testing-doctrine.md`). A schema that disagrees with the live
  response can be a deploy-lag signal, not a bug: check what is deployed before reporting it.
- **DB**: read the live schema before writing a query that leans on a column name
  (`../../agentic-qa-core/references/db-testing-doctrine.md`); project docs drift.
- **Roles**: each role signs in through the app's own login only
  (`../../agentic-qa-core/references/browser-sessions.md` §4); a check that seems to need a shortcut is a
  blocker to report.

---

## 4. Never call anything that sends or pushes downstream

Recon fans out across surfaces an agent has no ticket-level familiarity with. Treat this as a hard
boundary regardless of scope or mode: never call an endpoint, job or command that sends a real email or
notification, pushes data to an external system (accounting, payment, CRM, another team's tracker), or
triggers a bulk operation on real accounts. Those effects cannot be undone.

Read, list and preview endpoints of the same features are fine and often useful. The boundary is anything
that **sends** or **pushes downstream**, not anything that reads.

A project lists its own endpoints under `## Never-call endpoints` in its project-owned
`agent-project.md`; when that section exists, every Recon briefing carries it verbatim in component 7.
When it does not, the rule above still binds, and an agent that is unsure whether a call sends something
does not make it.

---

## 5. Mutation discipline

Mutations are allowed **only** to establish a precondition needed to observe a behaviour, never as an end
in themselves, and only within the mutation budget the charter set.

- **Record every created row** in `created_rows` the moment it is created, never from memory at the end.
- **Clean up at Handoff**: delete every recorded row and re-read it to confirm the delete committed. A
  delete that reports a timeout can still have committed, and one that reports success can have failed:
  only the re-read counts (Critical Rule #16).
- **Orphaned side effects**: a mutation can leave a trace beyond the row (an uploaded blob, a queued job).
  Name it in the session record for a human follow-up rather than leaving it silently.
- **Self-cleaning preview endpoints** (an endpoint whose own insert and delete leave nothing behind) need
  no manual cleanup, but verify that claim once per session by re-reading the id range after calling it.

---

## 6. Briefing for a Recon agent

Fill the 7-component briefing (`../../agentic-qa-core/references/briefing-template.md`) per agent. Example
for a Module-Targeted dispatch on `orders`:

```markdown
**1. Goal**
Recon the orders module on <env> for anomalies in line totals and discounts, and characterize
every behaviour you observe. Return the schema in recon-fanout.md §1.

**2. Context docs**
- <<PRIMARY_ROOT>>/.session/exploratory-testing/<scope>/charter.md
- the module's module-context.md (absolute path)
- .agents/skills/exploratory-testing/references/recon-fanout.md
- .agents/skills/sprint-testing/references/exploration-patterns.md (§2 API, §3 DB)

**3. Project Standards (auto-resolved)**
<compact rules from .agents/skills/REGISTRY.md for exploratory-testing and the tool skills loaded>

**4. Skills to load**
- playwright-cli (only if this agent covers the UI sub-task)

**5. Exact instructions**
1. Read the business rules for the module from `bun run context:map business-data-context --section <id>`.
2. Read the live schema first, then query a dozen orders with discounted and full-price lines; check each line against its
   own formula, not only against its siblings.
3. Compare at least 2-3 rows before flagging anything (recon-fanout.md §2).
4. For every behaviour you observe, fill observed[] with covered_by from the charter's coverage view.
5. Do NOT call anything on the never-call boundary (recon-fanout.md §4).

**6. Report format**
The JSON of recon-fanout.md §1 written to recon/orders.json, plus the session-footer fields
(skills_loaded, mcps_used, clis_used, testing_levels_touched, screenshots_captured) and
secrets_materialized / cleaned.

**7. Rules**
- Credentials by name only, never by value (Critical Rule #1).
- Authenticated API calls via curl with the api:login token, never through the OpenAPI MCP.
- Record every created row immediately, even if you expect to clean it up later.
- Never call anything that sends or pushes downstream; the project's never-call list, if any: <verbatim>.
- PASSED / FAILED only on observation in the named environment; anything else is NOT RUN.
```
