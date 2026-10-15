# Engineering article plan

## Direction

Explain a concrete workload, the expensive path, the chosen mechanism, the evidence, and the limits. A feature checklist does not explain a systems contribution. PlanetScale's [query optimization example](https://planetscale.com/blog/arewefastyet-query-optimization-with-insights) uses slow queries, diagnosis, an index change and measured effects; its [benchmarking guidance](https://planetscale.com/blog/on-benchmarking) distinguishes workload, infrastructure, throughput and latency. Use that level of specificity without borrowing their results or claiming comparable scale.

## Article 1: Following a launch blocker through a graph

Working title: **What does a supplier delay break? Measuring dependency queries with FalkorDB.**

Open with a GPU launch blocked by packaging and driver validation. Show the business entities and native relationships, the exact Cypher query and parameter values, then the execution plan. Explain why following relationships is the workload, rather than presenting FalkorDB as a generic JSON store.

FalkorDB uses GraphBLAS and sparse adjacency matrices internally ([upstream](https://github.com/FalkorDB/FalkorDB)). Our application uses native relationships and Cypher; it does not implement GraphBLAS operations or GPU acceleration. The GPU is the business domain. Query plan/profile evidence must show what the chosen workload actually exercises; the engine architecture alone does not prove an application speedup.

### Experiments to run before publication

- Fix random seeds and generate plausible bounded-degree supplier/component/product/test graphs, with hub-heavy and chain cases reported separately. Verify expected outputs and result cardinality. Avoid path explosion hiding behind tiny returned sets.
- Report 1k, 10k and 100k object scales only when the actual platform can ingest and operate correctly at each scale. A direct database fixture is allowed for engine tests but must be labeled separately from end-to-end ingestion.
- Compare a fair bulk snapshot plus in-process traversal baseline with native bounded Cypher. Report cached in-memory traversal separately so transport/serialization are not confused with algorithm cost. Do not invent an N+1 baseline merely to make the graph look fast.
- Capture `GRAPH.EXPLAIN` and read-only `GRAPH.PROFILE` output for the actual queries. Report per-operator records/time, end-to-end HTTP latency, payload bytes, p50/p95/p99, throughput, timeouts/errors and CPU/RSS by process. Profiling executes the query: use read-only queries on disposable fixtures.
- Warm up, run fixed-duration repeated trials, vary readers (1/8/32), and state whether load is closed- or open-loop. Include mixed reads/writes separately and report both achieved load and response time.
- Record hardware, software versions, persistence/index settings, warm/cold policy, client/server placement, raw samples and reproduction commands. Make one measured improvement and rerun the same workload.

### Current blockers

The original smoke benchmark remains documented. A [new before/after aggregate study](performance-study.md) now includes repeated trials, raw latency samples, CPU/RSS, parameterized EXPLAIN/PROFILE, 250/1,000 objects and 1/8 concurrent callers. Aggregation now runs in native Cypher. This is a measured implementation improvement, but larger/topology-dependent dependency queries, fixed-duration and mixed workloads remain work. Functions and scenario reads still materialize full graphs; mutation planning still loads current state.

## Article 2: Letting agents disagree without overwriting reality

Working title: **One graph, two recovery plans: versioned scenarios on FalkorDB.**

Start two analysts from the same revision: one changes supplier lead time, another changes capacity or driver repair. The current implementation uses a shared native base plus independent GRAPH.COPY candidates. Show version-checked edits, calculations against each state, then explicit selected promotion. Include simultaneous edit rejection and a conflicting promotion example.

Explain the current native-copy design with optimistic concurrency, candidate publication and one writer. Compare it with the former JSON overlay design and the proposed native revision/overlay visibility model before choosing the final article implementation. Native GRAPH.COPY is not zero-copy or MVCC. Native valid_from/valid_to visibility, leased repeatable reads and reviewed bounded watermark vacuum are now implemented and tested. Cheap native overlay branches and full temporal backups are still incomplete. A [versioning draft](versioning-notes.md) describes the actual mechanisms and failure boundaries. See [status](status.md) and the [complete backlog](TODO.md).

Measure first versus sibling branch creation, storage bytes versus full-clone baselines, increasing changed-record counts, branch evaluation, promotion latency and conflict behavior. Show how costs grow with base size and overlay size. Account for materialization and document rewriting, not just the small stored overlay. Do not promise constant-time branches or lock-free readers without implementing and measuring them.

End with choices we deliberately did not make: distributed writers, automatic conflict resolution, deep branch trees and generic transaction MVCC. Explain the workload that would force each choice to change.

## Publication gate

Both posts need reproducible results and limitations beside the claims. A measured before/after optimization is recorded, and both technical drafts have concrete evidence. A configured live model/source demonstration, broader dependency/topology performance trials and a fair branch-strategy comparison remain outstanding. Tests establish correctness properties; they are not throughput benchmarks. Keep proposed results labeled as experiments until run.

References: [FalkorDB profile command](https://docs.falkordb.com/commands/graph.profile), [PlanetScale benchmarking](https://planetscale.com/blog/on-benchmarking), [PlanetScale query optimization](https://planetscale.com/blog/arewefastyet-query-optimization-with-insights).

The complete added work (explainability first, temporal visibility, concurrency checker, retention watermark, reproducible benchmark matrix, UI branch/as-of controls and bounded entity resolution) is tracked in [TODO](TODO.md). The roadmap is not evidence that those mechanisms already exist.
