# Recorded responses

Hand-written replays of the Jira REST (`POST /rest/api/3/search/jql`) and Xray
Cloud GraphQL (`getTestRuns`) responses the Jira sources read, trimmed to the
fields they use. No live call produced them: `xray-test-runs.json` in
particular follows the published GraphQL schema shape, not a captured payload.
Keys (`ACME-*`), ids and names are invented. `workflows.json` and
`fields.json` are minimal stand-ins for `.agents/jira-workflows.json` and
`.agents/jira-fields.json`.
