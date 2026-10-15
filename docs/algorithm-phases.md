# Where native algorithm time goes

Native algorithm execution is only one part of a platform request. This study separates the existing algorithm route into non-overlapping service spans without changing its production behavior. [Raw measurements](evidence/algorithm-phases/samples.json) contain every measured request and the exact script SHA-256; the source commit records the production implementation before adding this harness.

Two directed chains contain 1,000/999 and 5,000/4,999 objects/edges. Setup uses the public SDK over real loopback HTTP, in 500-object ingestion batches with validation and history enabled. Identical unchanged copy and overlay branches start at the same live revision. This is synthetic chain topology, not GPU workload capacity or general graph scaling.

For each size, run shortest path from r-0 to r-8 with depth 10, outgoing degree top 10, and PageRank top 10 in live/copy/overlay contexts. Each cell gets one excluded warmup and five sequential measured requests; mode order reverses between trials. There are 90 measured successes plus 18 warmups, no failed requests, exact path/score-row equality across contexts, and asserted projection/query/cleanup call counts. There is one client and no concurrent writes. Tail latency and saturation are not measured by five samples.

## Observed 5,000-object medians, milliseconds

| Algorithm     | Context |  Total | Native projection | Algorithm query | Guard queries | Cleanup | Other |
| ------------- | ------- | -----: | ----------------: | --------------: | ------------: | ------: | ----: |
| shortest-path | live    | 251.10 |            205.05 |            1.09 |         10.87 |    0.23 | 35.18 |
| shortest-path | copy    |   9.41 |              0.00 |            1.26 |          5.04 |    0.00 |  3.18 |
| shortest-path | overlay | 250.11 |            193.18 |            1.09 |         10.40 |    0.22 | 42.25 |
| degree        | live    | 229.11 |            180.26 |            3.94 |          9.75 |    0.25 | 34.99 |
| degree        | copy    |  11.19 |              0.00 |            3.33 |          4.76 |    0.00 |  2.99 |
| degree        | overlay | 242.37 |            186.32 |            3.87 |          9.66 |    0.27 | 43.88 |
| pagerank      | live    | 225.24 |            178.24 |            3.54 |          9.93 |    0.23 | 33.89 |
| pagerank      | copy    |  10.10 |              0.00 |            2.50 |          4.70 |    0.00 |  2.97 |
| pagerank      | overlay | 234.95 |            177.36 |            3.56 |          9.70 |    0.23 | 42.89 |

Each column is its own sample median, so columns need not sum to the median total. Per-request phases do sum; the harness rejects overlapping accounting. Native projection creates an indexed temporary business graph and populates it. Algorithm query means the driver round trip including decoding, not engine-only execution. Guard queries count nodes/edges and resolve path endpoints. Cleanup measures the awaited graph removal, not completion of asynchronous memory reclamation. Other includes input reads, historical/base resolution, API queue/planning, HTTP serialization and client handling.

The copy branch already owns a native graph, so it has no per-request projection or deletion. Its earlier base/copy creation, edits, retained storage and promotion costs are excluded here; this is not a total-lifecycle comparison. Live and overlay requests create and delete one temporary graph per call. The result explains why a cheap overlay branch can still be expensive to evaluate: much of the cost occurs before the native algorithm query. It does not show that PageRank itself needs replacement or that every graph has these timings.

## Reproduction and limits

Run `node --import tsx scripts/algorithm-phases-study.ts` against a disposable FalkorDB instance. `ALGORITHM_SIZES`, `ALGORITHM_REPEATS` and `ALGORITHM_OUTPUT` control bounded sizes, 3–30 repeats and output directory. The script creates its own namespace and cleans up on normal completion; abrupt termination may need namespace cleanup. It wraps native service boundaries only in the study process, with instrumentation overhead shared across all modes. Answer equality is checked on every warmup and measured request.

Observed environment: v24.19.0, Linux, AMD EPYC 9V74 80-Core Processor (9 logical CPUs reported to Node), FalkorDB 4.18.3 / Redis 8.6.2. API/client share one Node process; database uses loopback. RDB snapshots and AOF were disabled (`--save '' --appendonly no`); native graph copy may still use temporary dump files. This study does not measure their disk/I/O footprint. Results include warm process/database effects and shared-host scheduling; no CPU pinning, isolated-host claim, restart workload or durability comparison is implied. The [branch study](branch-study.md) measures creation/edit/read/function behavior separately.
