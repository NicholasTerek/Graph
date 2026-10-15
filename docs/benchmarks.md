# Measured API baseline

Measured with the actual HTTP API, Node.js 24.19.0, FalkorDB 4.18.3, and Redis 8.6.2 in the coding environment. This used the native database binaries because Docker is unavailable locally. It is a single-client smoke benchmark, not a database comparison or a production capacity claim.

Dataset: 1,000 objects and 999 chain relationships. Ingestion includes validation and before/after history creation. A native range index was created for the queried numeric property. Read latency includes HTTP, serialization, the TypeScript server/client, and database work.

| Operation                           | Samples |      p50 |      p95 |
| ----------------------------------- | ------: | -------: | -------: |
| Numeric-filtered page of 50 objects |      25 | 3.522 ms | 6.716 ms |
| Five-hop directed traversal         |      25 | 3.736 ms | 5.184 ms |

The initial batch ingest took **149.795 ms**. No concurrent clients, network latency, large payloads, cold-start distribution, or sustained workload were measured. Results depend on the machine and graph topology.

Reproduce with `pnpm benchmark` against a running service. `BENCH_OBJECTS` accepts 10–2,000; `API_URL` and `GRAPH_API_TOKEN` select the service and credential. The script creates a uniquely named disposable ontology and leaves it for inspection. Use a disposable database for repeated benchmarking.

## Repeated before/after study

The [aggregate optimization study](performance-study.md) supersedes this smoke test for aggregate-performance claims. Run `pnpm benchmark:study` for verified answers, repeated trials, concurrent callers, raw samples, CPU/memory and native plans. It also records descriptive first/sibling branch and edit costs. The 25-sample numbers above are historical measurements from an earlier implementation and are not a current capacity result.
