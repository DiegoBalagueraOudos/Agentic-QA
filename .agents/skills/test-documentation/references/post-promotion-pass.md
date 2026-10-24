# Post-promotion `merged` pass (mode `post-promotion`)

Load only for mode `post-promotion`. The pass moves a TC from `{{jira.status.test_case.pull_request}}` to
`{{jira.status.test_case.automated}}` once its test code is on the production branch, and does nothing
else: no Analyze, no ROI, no new Test, no verdict change. Canon:
`../../agentic-qa-core/references/discovery-driven-doctrine.md` §6.

Who calls it: `/git-flow-master` hands it off when a promotion into the production branch merges ("Promotion
landed on `<production>`: run the post-promotion `merged` pass"). Under a single-branch strategy the ticket PR
merges straight into the production branch and nothing hands the pass off automatically: run it on request
after the merge, and the `/test-automation` light stage verifier is the backstop that finds a TC left at
`{{jira.status.test_case.pull_request}}` with its spec already on the production branch.

> **Prerequisite**: load `/acli` before any `[ISSUE_TRACKER_TOOL]` call below.

## 1. Inputs

| Input | Read from |
|---|---|
| The production branch | `git_strategy.branches.production` in `.agents/project.yaml` |
| The TCs to check | every `test_case` at `{{jira.status.test_case.pull_request}}`; an argument after the mode (a Story, a coverage Tech Story or a module) narrows it |
| Where each TC's code lives | the `automation-plan.md` that names the TC, under the Epic's committed `test-specs/` tree, as it reads on the production branch |

## 2. Steps

1. `git fetch origin <production>`.
2. List the TCs: `[ISSUE_TRACKER_TOOL] Search` with JQL
   `project = {{PROJECT_KEY}} AND status = "{{jira.status.test_case.pull_request}}"`, restricted to the `test_case`
   work type.
3. For each TC, both checks on `origin/<production>`:
   - **The ATC**: `git show origin/<production>:kata-manifest.json` lists an ATC whose id is the TC key.
   - **The spec file**: `git grep -l <TC_KEY> origin/<production> -- '.context/PBI/epics/*/test-specs/'` finds the
     automation plan; the test file it names exists, `git cat-file -e origin/<production>:<spec path>`.
   Presence is checked by path, never by commit ancestry: a squash promotion rewrites the commits.
4. **CI green on the production branch**: the suite workflow's latest run on `<production>` at or after the
   commit that carries the spec concluded `success` (`gh run list --branch <production> --json databaseId,conclusion,headSha`).
   No run found, or a red one: the TC stays at `{{jira.status.test_case.pull_request}}` and the report says why.
5. Both checks and CI pass: fire `{{jira.transition.test_case.merged}}`, set labels `+automated -automation-candidate`,
   and comment `Automated: <spec path> on origin/<production>@<short sha>, CI <run url>`. An unmapped slug runs
   the fallback in `../../agentic-qa-core/references/artifact-lifecycle.md` §4.
6. Read every transitioned TC back through `[ISSUE_TRACKER_TOOL]` (the sync never writes a Test: `test_case`
   declares `sync: never`) and confirm the status
   (Critical Rule #16). The transition call returning success is not the check.

## 3. What this pass never does

- Fire `merged` for a merge into an integration branch or a suite trunk (`branches.integration`,
  `branches.ephemeral_pattern`): that TC is not automated yet.
- Touch a TC at any other status, change a verdict, or edit a Test body.
- Run git writes: it reads `origin/<production>` and never commits, merges or pushes.

## 4. Report

One table, then the light stage verifier lines that apply (`../../agentic-qa-core/references/artifact-lifecycle.md` §5):

```
| TC | Spec path | On <production> | CI | Action |
|----|-----------|-----------------|----|--------|
| <TC_KEY> | tests/e2e/<module>/<file>.test.ts | yes | <run id> success | merged, read back automated |
| <TC_KEY> | (not found) | no | n/a | stays at pull_request |
```
