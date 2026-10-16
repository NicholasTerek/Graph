# What batch ingestion saves

The [18-trial summary](evidence/ingestion/summary.json) and per-trial request samples compare 1, 50 and 500 rows per public HTTP ingestion request at 250 and 1,000 total rows, three trials each. There are 3,834 successful measured write requests, 11,250 inserted objects and no measured failures. Batches use the same API validation, single-writer queue, native object versions, audit/revision publication and UNWIND writes. No control bypasses validation or disables history.

**Transaction granularity differs.** One-row writes expose a revision after each row; a 500-row request publishes one atomic commit. They have equal final data and one retained version per object, not identical commit counts or intermediate visibility. Batching buys fewer round trips, planning passes and commit records. Do not use this result to claim an equivalent number of transactions per second.

## Observed 1,000-row medians

| Batch size | Requests / commits | Median total ms | Median rows/s |
| ---------: | -----------------: | --------------: | ------------: |
|          1 |               1000 |        13125.43 |         76.19 |
|         50 |                 20 |          358.72 |       2787.71 |
|        500 |                  2 |           98.74 |      10127.24 |

Each trial begins with a fresh namespace/ontology. Node/API and client share one process; FalkorDB is a separate loopback process. Input records are deterministic scalar objects without edges. There are no warmup requests; batch order reverses every trial. Total latency covers all sequential write requests, excluding schema setup and correctness checks. Per-request samples and p50/p95/p99 summaries are retained, but cells with two requests do not support a tail-latency claim. No concurrent readers/writers or large-source capacity claim is implied.

Every trial checks final values/count/revision, first-commit visibility, one native version per object, revision-preserving replay, and rejection of a batch containing a valid update followed by an invalid record without partial changes. All passed. Redis/Node CPU, graph memory and process RSS are recorded. Persistence settings are identical within the experiment: AOF and automatic RDB saves disabled. No durable-ingestion or connector pagination claim follows from these numbers.

Reproduce with `node --import tsx scripts/ingestion-study.ts` against a disposable FalkorDB instance. `INGEST_SIZES`, `INGEST_REPEATS` and `INGEST_OUTPUT` select bounded sizes/trials/output. Exact script hash, Node 24.19.0, FalkorDB 4.18.3/Redis 8.6.2, CPU and runtime settings are in the summary. Normal completion removes each namespace. The [branch lifecycle study](branch-lifecycle.md) separately records HTTP setup versus service operations; the [in-memory GraphView study](graph-view-study.md) is explicitly a different layer.
