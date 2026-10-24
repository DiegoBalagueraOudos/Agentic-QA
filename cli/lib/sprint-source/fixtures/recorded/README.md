# Recorded responses

Hand-written replays of the Jira REST (`POST /rest/api/3/search/jql`) and Xray
Cloud GraphQL (`getTestRuns`, `getTestPlan`) responses the Jira sources read,
trimmed to the fields they use. No live call produced them: `xray-test-runs.json`
and `xray-test-plan.json` follow the published GraphQL schema shape, not a
captured payload. Keys (`ACME-*`), ids and names are invented.

The graph they describe: `ACME-1` is covered through its ATS `ACME-31` (plus one
direct Test link) and executed in its ATR `ACME-41`; a feature Test Set `ACME-35`
is linked by `Relates` and must not be walked; one run of `ACME-11` sits in an
unrelated execution (`1099`) and must be ignored. `ACME-2` reaches `ACME-14`
through its Test Plan `ACME-51` and re-plans `ACME-13` in a newer re-test
execution `ACME-43`.

`workflows.json`, `fields.json` and `link-types.json` are minimal stand-ins for
`.agents/jira-workflows.json`, `.agents/jira-fields.json` and
`.agents/jira-link-types.json`.

`jira-search-sprint-bugs.json` answers the sprint's bug query (`board.bug_jql`, derived from
`board.jql`): `ACME-21` (also linked to `ACME-1`), `ACME-7022` (created in the sprint, linked to
nothing), `ACME-7024` (a `-0500` offset time that is the next day in UTC) and `ACME-7023` in a `Triage` status the catalog does not know, which must be named and
left out, never counted as open.
