# Merge Line reading (synthetic)

`reading.json` is one invented reading of a repository (`acme/shop`, keys `DEMO-n`) in the shape
`merge-collect.ts` saves under `.session/gitflow-master/raw/`. `prev-snapshot.json` is the snapshot
of the run before it. `expected-wake.json` is what `buildDocuments` builds from both in `wake`
mode; it was checked equal to the source repo's jq program on the same reading in every mode,
except the tracker parity and the documented additions (`DEVIATIONS.md` of the e3 delivery).
Regenerate it only when a change to `merge-build.ts` is intended.
