# API-process crash boundaries

The [raw crash samples](evidence/branch-crash/samples.json) record twelve real SIGKILLs of a separate API worker process: four instrumented boundaries, three trials each, with 1,000 synthetic objects and 999 edges. The database stays alive. This tests API death and managed-graph recovery, not a database crash or power-loss durability.

A parent prepares a fresh live ontology and native-copy branch. A separate Node worker initializes that namespace, listens on loopback, and receives a normal guarded HTTP scenario patch. Hooks kill only that worker before candidate copy, after the candidate update but before pointer publication, after the new pointer is saved but before response, or in Fastify onResponse. A fresh store/scenario service then runs startup index initialization and orphan collection against the surviving database. The script checks the complete branch, expected version/value, unchanged live state and exact graph inventory.

| Kill boundary     | Visible version | Client result | Orphans collected | Median collection/init ms |
| ----------------- | --------------: | ------------- | ----------------: | ------------------------: |
| before-copy       |               0 | unknown       |                 0 |                      6.35 |
| after-candidate   |               0 | unknown       |                 1 |                      6.97 |
| after-publication |               1 | unknown       |                 1 |                      7.06 |
| after-response    |               1 | acknowledged  |                 0 |                      8.19 |

All twelve checks passed. Before publication, the old complete branch remains visible; after publication, the new complete branch remains visible. Candidate/old working graph orphans are collected at startup. After a response the old graph has already been deleted, so there is no orphan. The three observed response-boundary clients received acknowledgment; the harness also permits an unknown transport outcome there because onResponse is not proof of remote delivery. Every unknown outcome remains unknown until the client rereads branch version/state. The script does not silently retry it as a fresh write.

Worker process startup is separately recorded (roughly 0.7–0.8 seconds here). The small collection/init times above exclude process launch, database restart, client reconnection and large orphan inventories. Three samples are descriptive, not p99 recovery guarantees. No partition, mid-GRAPH.COPY interruption, Redis SIGKILL, disk failure or multi-writer claim is made. The [graceful persistent restart drill](temporal-backups.md) and native runtime rollback tests cover different boundaries.

Run `node --import tsx scripts/branch-crash-study.ts` against a disposable FalkorDB. `CRASH_SIZE`, `CRASH_REPEATS` and `CRASH_OUTPUT` select bounded fixtures, repeats and artifact directory. The worker mode is an internal subprocess implementation. Normal completion removes study keys; an interrupted parent can leave a worker/namespace requiring cleanup. The raw metadata records the exact script hash, Node 24.19.0 and Redis/FalkorDB runtime/persistence information. Observed run: Linux, FalkorDB 4.18.3/Redis 8.6.2, RDB/AOF disabled, single API writer at a time. The database remained running throughout all API kills.
