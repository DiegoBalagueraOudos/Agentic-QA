# Recorded responses (evidence tracker adapter)

Hand-written replays of the Jira Cloud REST v3 and Xray Cloud GraphQL responses that
`cli/lib/evidence-page/tracker.ts` reads, trimmed to the fields it uses. No live call
produced them: development never writes to a tracker, so every write response here is
DOC-DERIVED (the published response shape of `POST /rest/api/3/issue/{key}/attachments`,
`POST .../comment`, `POST .../remotelink`, `GET .../remotelink?globalId=`, and the Xray
`getTestExecution` / `getTestRunById` queries), never a captured payload. Keys (`ACME-*`),
ids, media ids and names are invented.

The graph: bug `ACME-7101` (filed from story `ACME-7001`) starts with one unrelated
screenshot attached and a Description that already has an `Evidence` heading with the page
link; its thumbnail `ACME-7101-thumbnail.png` becomes attachment `7202`, media
`0a1b2c3d-0000-4000-8000-000000007202`. Test `ACME-7111` runs in execution `ACME-7141`
(issue id `17141`) as run `run-7111`. The size of the thumbnail attachment is filled in by
the test from the PNG it attaches (`fixtures/demo/checkout-error.png`).
