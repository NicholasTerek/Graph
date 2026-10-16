# Three branch storage designs under the same workload

The [raw lifecycle samples](evidence/branch-lifecycle/samples.json) compare JSON-base snapshots, native graph copies and native revision overlays on their **common service operations**: create, guarded edit, read, diff and discard. This is a storage experiment, not complete feature parity or a historical end-to-end product benchmark.

The JSON control loads the actual ScenarioService source at commit `9981e20`, recording its SHA-256 and replacing only local dependency import paths. All backends use the current GraphStore, schema validation and one writer queue. The JSON control keeps JSON bases/overlays rather than passing through current automatic native migration. Its old service has no equivalent current promotion, algorithm, ownership or retention contracts; those are deliberately outside this comparison. Existing [native lifecycle trials](branch-study.md) measure promotion separately.

Each backend gets its own fresh namespace and ontology, populated through the public SDK over real HTTP in 500-object batches. Chains contain 1,000 or 10,000 objects and one fewer edge. Three trials per size/backend produce 18 isolated trials and 54 branch operations. Backend order reverses between trials. Within each trial the first branch pays base initialization; siblings retain that base. Edits change 0.1%, 1% and 10% of objects on three simultaneous branches. Creation position and changed fraction are correlated by design, so these trials cannot independently identify their interaction.

Readbacks check object/edge counts, changed-object counts, expected aggregate values and branch versions. A repeated old-version edit must reject. Live state must remain byte-for-byte equal to its baseline. Diffs must contain exactly the changed objects and no changed edges. Discard must leave no scenario/native graph keys, with the live graph unchanged. All checks passed. There are no warmup cells; these are descriptive three-trial medians, not tail percentiles or throughput capacity.

## Observed 10,000-object medians

All timings are milliseconds. RDB increments cover all three retained branches after edits.

| Backend | First create | Second create | Third create | Edit 0.1% | Edit 1% | Edit 10% | Cleanup three | Added RDB bytes |
| ------- | -----------: | ------------: | -----------: | --------: | ------: | -------: | ------------: | --------------: |
| json    |       145.88 |         22.49 |        24.38 |     50.36 |   51.13 |    59.79 |         12.76 |          194964 |
| copy    |       628.49 |         74.96 |        96.16 |    324.88 |  328.60 |   354.02 |         44.57 |         3321828 |
| overlay |         3.95 |          2.94 |         2.63 |    233.72 |  236.57 |   244.01 |         54.12 |           16067 |

The native overlay avoids full base copying at creation, but still reads/materializes and validates effective state during edits. Native copies pay for full candidate copies even at a small changed fraction. JSON controls have cheap shared base references but keep their own read/materialization costs and lack the native queryable topology used by current branch algorithms. This comparison does not justify switching the product back to JSON.

## Memory, persistence and accounting

Raw rows retain `GRAPH.MEMORY USAGE` estimates for every graph in the isolated trial, including the shared native base and each working graph. They also retain base/scenario JSON byte counts, returned-state JSON bytes, Node CPU/RSS and Redis INFO CPU/RSS. Graph memory output is a coarse MB estimate, not exact allocator ownership; RSS may retain freed allocations between trials. INFO sampling itself adds small CPU overhead and is outside wall-time operation spans.

An otherwise empty disposable database runs manual `SAVE` before branches, with all branches retained, and after cleanup. The script records the resulting RDB file sizes. These are actual serialized archive bytes, not exclusive resident memory, live volume size, fsync durability or peak temporary copy space. SAVE work is outside the measured branch operation spans. AOF and automatic RDB snapshots were disabled. Linux `/proc` I/O counters were denied by this host, so temporary copy I/O and peak dump-file bytes remain **unmeasured**. They are not reported as zero.

Run `node --import tsx scripts/branch-lifecycle-study.ts` on an empty disposable FalkorDB. `LIFECYCLE_SIZES`, `LIFECYCLE_REPEATS`, `LIFECYCLE_OUTPUT` and optional `LIFECYCLE_RDB_PATH` control the run. The RDB path must be the actual file configured on the local database. The historical commit must exist in the clone; fetch repository history if using a shallow checkout. Normal completion cleans study graphs; interruption can require namespace cleanup. Exact harness and historical-source hashes are in the raw metadata.

Observed environment: Node 24.19.0, FalkorDB 4.18.3/Redis 8.6.2, Linux on an AMD EPYC 9V74 host, client/API in one Node process and database on loopback. Service operation timings exclude HTTP serialization; fixture ingestion uses the real HTTP API and its elapsed time is recorded separately. No 100k claim is made: the current native algorithm budget stops at 10k objects. Per-process I/O, abrupt database recovery, broader topology and longer branch-count scaling remain separate experiments.
