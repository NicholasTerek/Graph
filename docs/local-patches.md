# Local validation for scalar updates

`patchObject` previously fetched one record, then loaded the complete ontology through the general ingestion planner to update it. The optimized path validates the merged record against its object schema and sends only that object's before/after delta to the same atomic native commit builder. A scalar patch cannot change the logical ID, object type or relationship endpoints. No generic cross-record business invariant is promised, so those constraints do not require loading unrelated records. Batch ingestion, source sync, deletion, promotion and scenario edits retain their broader validation paths.

Expected revision checks remain inside the writer queue. History closure, replacement version, before/after audit, commit and head still publish in one Cypher statement. Identical patches preserve the revision. An installation without temporal metadata first backfills its complete current state; a one-object delta must never become an incomplete legacy baseline. The generic native mutation statement is unchanged, so this removes TypeScript full-state materialization rather than establishing constant-time database writes.

Tests preserve unrelated records and edge intervals, read the before-image at its old revision, reject invalid fields and linked deletion, reject a same-revision race, retain independent field updates and exercise legacy migration. Native runtime failure rolls back state/history together. A lost acknowledgment after the native commit produces an error, but rereading finds the committed value and a guarded retry rejects the old revision.

## What the precondition does not provide

Two clients can both read counter 0 and submit value 1 without an expected revision. Both requests can succeed while the result is 1. Similarly, two clients can each observe two on-call records and then independently turn off a different record. Both fields are schema-valid and the result has nobody on call. These intentional anomaly tests establish the boundary: callers needing a snapshot-based decision must supply/revalidate its revision or implement domain invariant validation. Native historical visibility alone does not create serializable business transactions.

## Equivalent HTTP measurement

The benchmark loads the exact predecessor method from commit `724128b`, runs it on the same store through an identically validated HTTP route, and compares the local path. Both perform a sequential guarded scalar update, atomic version/history persistence, identical response shape and ETag, and verify each value/revision. Fixtures use public SDK ingestion. Three trials alternate order after ten warmups; each has 80 successful writes. A second workload adds eight closed-loop native sum readers, whose results must fit the possible committed writer interval. History is retained throughout each fixture.

| Objects | Aggregate readers | Full-planning median p50, ms | Local median p50, ms | Full median writes/s | Local median writes/s |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 1,000 | 0 | 18.85 | 5.44 | 52.1 | 174.6 |
| 1,000 | 8 | 24.92 | 11.61 | 39.2 | 83.8 |
| 5,000 | 0 | 67.13 | 9.20 | 14.5 | 104.9 |
| 5,000 | 8 | 80.12 | 23.33 | 12.2 | 41.5 |

There are 1,920 acknowledged guarded writes and 7,776 aggregate reads across 24 trials, with zero observed errors/invariant violations. [Raw latency samples and CPU/memory summaries](evidence/local-patch/summary.json) include empirical p50/p95/p99 for both operations. These fixed-count warm trials are distinct from the fixed-duration [function study](function-scopes.md); they do not establish long-run tail behavior. Mixed readers reduce write throughput substantially even after the optimization, exposing remaining database/serialization/queue costs.

Node 24.19.0, FalkorDB 4.18.3/Redis 8.6.2, AMD EPYC 9V74, local loopback, AOF/RDB saves disabled. API and client share one Node process; CPU/RSS include both, while database CPU/memory are recorded separately. This is not disk-durable throughput. Prior history and allocator state accumulate across alternating trials, and the connected fixture has no edges; edge preservation is checked separately by correctness tests. Other processes and GC contribute noise.

Reproduce with `node --import tsx scripts/local-patch-study.ts` against a disposable database, with the predecessor commit available. `PATCH_STUDY_SAMPLES`, `PATCH_STUDY_REPEATS` and `PATCH_STUDY_OUTPUT` control the experiment. The source hash of the predecessor is recorded. This benchmark does not bypass validation/history for the control, invent an N+1 API baseline, or compare unguarded writes to guarded ones.
