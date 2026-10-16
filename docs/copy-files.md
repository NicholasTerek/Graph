# Observing native graph copy's temporary file

Kernel `/proc` I/O counters were inaccessible on the measurement host. Rather than treating missing counters as zero, this [six-sample microbenchmark](evidence/copy-files/samples.json) observes the temporary file FalkorDB itself logs while copying an owned graph.

A disposable Redis/FalkorDB subprocess runs on loopback. The parent only accepts a dump event whose source graph matches the current study graph. It opens that logged UUID `.dump` file read-only as soon as it appears. Keeping the descriptor open lets the parent inspect final file length and allocated blocks after FalkorDB unlinks the pathname. The benchmark checks the path really disappears, closes the held descriptor, compares every cloned object/edge against its source and removes both clone and source. All checks passed.

| Objects / edges | Median copy ms | Dump bytes | Allocated bytes |
| --------------- | -------------: | ---------: | --------------: |
| 1000 / 999      |          84.06 |     648256 |          651264 |
| 10000 / 9999    |         131.87 |    6462896 |         6463488 |

Each size has one excluded warmup and three measured sequential copies of a directed chain. Dump byte counts were identical within a size. `allocatedBytes` is `stat.blocks × 512`; it is filesystem block accounting, not observed physical device reads/writes, storage throughput or fsync durability. Holding a descriptor extends the unlinked file's block lifetime until the observer closes it. The operation's temporary file is measured; a whole-process peak across concurrent copies is not. A failed/missed observation throws instead of producing a zero-size sample.

The 10k copy materialized about 6.46 MB in a temporary dump even though `GRAPH.COPY` looks like a single API call. The [lifecycle experiment](branch-lifecycle.md) separately measures retained RDB archive bytes and full service create/edit costs. Those representations, fixtures and timings differ; do not divide one by the other to claim compression or total device I/O.

## Reproduction

Set `REDIS_SERVER` and `FALKORDB_MODULE` to compatible local executable/module paths, then run `COPY_FILE_OUTPUT=artifacts/copy-files/local node --import tsx scripts/copy-file-study.ts`. It launches its own disposable database on port 6389 (`COPY_FILE_PORT` overrides), rejects startup failure, and stops that process on completion. It does not connect to a production database. The observed module logs UUID dump paths under `/tmp`; another engine version with different logging/path behavior may require adapting the observer rather than assuming a missing file is free.

Setup directly creates synthetic native business graphs, without API ingestion, validation/history or branch metadata. This isolates `GRAPH.COPY`; it is not platform ingestion capacity or an end-to-end scenario benchmark. Exact script hash, Node/CPU, Redis/FalkorDB versions and persistence settings are in the raw metadata. Observed: Node 24.19.0, FalkorDB 4.18.3/Redis 8.6.2 on Linux/AMD EPYC 9V74, AOF and automatic RDB disabled, client and database on one host, no concurrent workload. Three warm samples do not establish p99 or production capacity.

Raw kernel physical-I/O counters, abrupt database failure and power-loss behavior remain unverified production characteristics. The measured dump length/allocation/cleanup covers the prototype's copy-space experiment without making those stronger claims.
