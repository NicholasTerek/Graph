# Captured dependency slices

Trusted function definitions can declare `scope(input) => ({root, depth, direction})`. Roots are validated identifiers, depth is 1–5 and direction is out/in/both. The function receives the induced graph of records reachable within that window, including edges between its returned objects. Authors must ensure that the window contains every dependency their function needs; an omitted dependency is not automatically fetched later. Functions without a scope retain their full-ontology view.

Live and native-copy reads traverse native Object/LINK graphs. Historical reads filter object and edge intervals in Cypher at one resolved revision/generation. Capture stays inside the single-writer queue, and the function executes afterward against its immutable indexed view. An overlay currently materializes its full effective graph before applying the same window in TypeScript. Saved runs report `inputScope.materialization` as `native-slice` or `overlay-full-read`, plus captured counts. Cheap overlay creation still does not imply cheap evaluation.

All dependency traversal APIs now reject windows above 2,000 objects or 5,000 relationships instead of returning a partial answer. Limits apply to historical, live and scoped copy/overlay calculations. Depth/result limits do not fully bound the engine's path enumeration cost; the native query timeout remains necessary. An oversized or missing root fails explicitly. Snapshot leases and scenario versions retain their existing consistency rules.

The GPU function declares an outgoing five-hop scope. The measured fixture captures 13 connected objects; unrelated teams do not enter its view. Tests compare answers and actual-read evidence against the full implementation for chain, bounded-degree and hub fixtures across live/history/copy/overlay contexts, and exercise an oversized window. The generic library availability function intentionally still scans its complete domain.

## Sustained HTTP comparison

The same binary runs a full-input control and scoped GPU function with identical calculation logic. Both include HTTP, validation, calculation, captured evidence and persisted run records. Synthetic unrelated teams grow the ontology to 1k/5k objects; they do not invent more GPU demand or branch complexity. Fixture ingestion uses the public SDK in batches of at most 1,000 and is timed separately. This measures isolation from unrelated data, not realistic growth of one connected recovery graph.

| Objects | Callers | Full median p50, ms | Scoped median p50, ms | Full median completions/s | Scoped median completions/s |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 1,000 | 1 | 11.36 | 6.37 | 81.7 | 143.5 |
| 1,000 | 8 | 75.22 | 37.14 | 103.2 | 210.3 |
| 1,000 | 32 | 273.86 | 133.77 | 111.5 | 237.1 |
| 5,000 | 1 | 30.85 | 6.49 | 31.6 | 142.7 |
| 5,000 | 8 | 241.38 | 41.88 | 32.4 | 184.8 |
| 5,000 | 32 | 960.04 | 147.51 | 33.4 | 211.0 |

Each cell is the median of three two-second trials after ten warmups, with implementation order alternated. There are 9,424 completed requests and zero errors across 36 trials. Trials stop issuing at the deadline and drain in-flight calls; throughput uses actual elapsed time. This is closed-loop load: queuing raises latency and slows offered load. High-concurrency results expose the single-writer capture/evidence queue, not linear read scaling. Empirical p50/p95/p99, every sample, process CPU/RSS and database CPU/memory are retained in the evidence. Short trials and limited tails do not establish a production SLO or long-run stability.

Node 24.19.0, FalkorDB 4.18.3/Redis 8.6.2, AMD EPYC 9V74, local loopback, warm fixtures; RDB saves and AOF were disabled for this disposable run. API and load client share one Node process, so CPU/RSS include both. Run documents are deleted between trials outside timing; memory measurements include allocator/GC/history effects and are not isolated per-function allocation. No replicas or disk durability throughput are measured.

Native EXPLAIN/PROFILE show an indexed root and variable-length traversal producing 13 records. The historical root query uses an ObjectVersion index and filters the validity interval; the all-visible query still examines the generation's candidate versions. An index does not remove interval filtering or make full historical scans constant time. Profiles are separate read-only executions, not the HTTP sample timings.

Reproduce with `node --import tsx scripts/function-scope-study.ts` against a disposable database. `SCOPE_STUDY_DURATION_MS`, `SCOPE_STUDY_REPEATS` and `SCOPE_STUDY_OUTPUT` control the run. [Summary and raw samples](evidence/function-scope/summary.json) and the 1k/5k native plans accompany this change. CSV timestamps/latencies are rounded to microseconds. This optimization does not eliminate full-state mutation planning, source-document loading, overlay materialization or connected-graph traversal costs.
