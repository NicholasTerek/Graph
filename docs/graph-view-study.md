# Indexing captured function inputs

The GPU function repeatedly follows typed dependencies in an immutable `GraphView`. The predecessor scanned every relationship for each `related` call and then scanned objects for each endpoint. The new view constructs ID, type and incoming/outgoing adjacency maps once, retaining input order and parallel edges. Function evidence still records actual reads, returns defensive clones and keeps the same truncation limits. Snapshot acquisition and full-ontology loading are unchanged.

The script evaluates the exact predecessor from commit `d55146c` against the new implementation, including construction/cloning and evidence accounting. It asserts identical output and captured evidence before measuring. Synthetic task DAGs are chains, three-predecessor bounded-degree graphs, and supplier-like hubs. These are in-memory function-view fixtures, not platform ingestion or database capacity measurements.

| Tasks | Topology | Scanning median ms | Indexed median ms |
| ---: | --- | ---: | ---: |
| 1,000 | Chain | 36.00 | 7.56 |
| 1,000 | Bounded | 77.20 | 16.32 |
| 1,000 | Hub | 27.97 | 6.49 |
| 5,000 | Chain | 472.41 | 38.76 |
| 5,000 | Bounded | 1,205.90 | 81.57 |
| 5,000 | Hub | 354.79 | 33.92 |

Each cell has five trials after one warmup, alternating implementation order. Every trial constructs a view, follows outgoing dependencies once for every task, sums endpoint duration and captures evidence. Five trials support descriptive medians, not p99 claims. This targeted traversal-heavy workload benefits substantially; one-lookup functions can instead pay an extra indexing cost. The maps retain additional references and arrays, so reduced CPU does not imply reduced heap. Raw process RSS is recorded but includes both implementations, warmup and GC; it is not isolated per-view memory allocation.

Reproduce with `node --import tsx scripts/graph-view-study.ts` from the repository with its predecessor commit available. Node version, CPU, baseline source hash, topology, answer, elapsed time, process CPU and RSS are recorded in [raw samples](evidence/graph-view-study.json). Equivalence tests additionally cover incoming direction, parallel edges, absent types, missing objects and mutation isolation. This does not replace native traversal profiling, bounded function slices, or sustained mixed HTTP load experiments.
