# Native scenarios and algorithm tools

## Storage and publication

Live objects remain in the platform graph, scoped by ontology. Copying that entire graph would also copy unrelated ontologies and control metadata. Instead, the first branch at a revision projects only that ontology's business objects and native `LINK` relationships into an immutable base graph. Siblings reuse the base reference and call **`GRAPH.COPY base destination`** to produce independent graphs.

Each branch registry entry stores base revision, base graph key, current graph key, version and timestamps. It does not store business objects or the authoritative overlay in a JSON document. Native graphs contain business objects/edges, scalar `p_*` properties and serialized record properties used by the generic API. No control/metadata vertices participate in algorithms.

An edit validates the resulting graph, copies the previous native graph to a fresh candidate, applies only changed nodes/edges in one Cypher write, then publishes the candidate key and next scenario version in one registry-document write. The candidate is invisible through public scenario APIs until publication. Failed preparation leaves the previous pointer intact. A lost publication acknowledgment may mean the new version committed: reread the branch version instead of blindly retrying. The acknowledged old graph is removed after publication. Unpublished candidates or old graphs left by interruption are collected at startup or discard by comparing namespace-scoped keys with persisted base/branch references.

This favors an explicit recovery boundary over in-place cross-graph updates. It also means **every successful edit copies a whole graph**. It is not cheap copy-on-write or a performance improvement over sparse overlays by assumption. The pinned FalkorDB 4.18.3 [copy implementation](https://github.com/FalkorDB/FalkorDB/blob/v4.18.3/src/commands/cmd_copy.c) forks, serializes to a temporary file and decodes into a new graph. The destination is independent; the operation costs memory, disk I/O and time.

All coordinated mutations still pass through one API writer. There is no atomic distributed transaction spanning native keys and the registry; prepare-before-publication makes incomplete candidates unreachable under that model. No guarantee covers direct database changes or multiple API replicas. The API must not start until migration/reference collection finishes. Unknown copy outcomes can temporarily leave an unreferenced candidate until the next collection. This is not crash-proof GC under arbitrary concurrent database administration.

## Compatibility and promotion

The public scenario API and expected-version semantics remain. Metadata reports `storage: "falkordb"` with graph references. `GET` of an individual scenario derives a compatibility `overlay` by comparing native base and current graphs; the registry's overlay field stays empty. Diff, deterministic functions and action preparation read native branch state. Native algorithms query that state directly without materializing a JSON overlay in TypeScript.

Promotion still compares base, branch and current live values. It applies selected changes, preserves unrelated properties, rejects conflicts/dangling edges and increments the scenario version. It does not automatically replace the whole live graph. Three-way merge is not the same policy as rejecting every write since a branch base; domain invariants still need domain validation.

Existing JSON bases/overlays migrate to native graphs at startup, or on first access after restoring a logical backup. Migration preserves branch version, base revision and effective contents; candidates publish only when complete. Logical backups remain portable JSON archives: native bases export as snapshots and branches export as derived overlays, with all graph keys removed. Restore rejects embedded native references and rematerializes graphs from portable contents. Runtime storage being native does not require a database-specific backup format.

## Algorithms

```ts
await client.algorithms("semiconductor");
const evidence = await client.runAlgorithm("semiconductor", {
  algorithm: "shortest-path",
  source: "aquila-x900",
  target: "northstar",
  direction: "out",
  maxDepth: 10,
  scenario: "my-scenario",
});
const ranking = await client.runAlgorithm("semiconductor", {
  algorithm: "betweenness",
  scenario: "my-scenario",
  samplingSize: 32,
  samplingSeed: 42,
  limit: 20,
});
```

`GET /api/ontologies/:ontology/algorithms` discovers supported tools. `POST /api/ontologies/:ontology/algorithms/run` needs read scope, not write scope. Both enforce ontology access; graph names and arbitrary Cypher are never accepted as request inputs.

| Algorithm       | Native operation                                                      | Interpretation                                                                                |
| --------------- | --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `shortest-path` | `shortestPath` in Cypher, 1–20 hops, out/in only                      | One unweighted route; null if no route within the bound; identical endpoints have zero hops   |
| `pagerank`      | `algo.pageRank('Object','LINK')`                                      | Relative directed topological importance; not business risk                                   |
| `betweenness`   | `algo.betweenness` with fixed labels/types, explicit seed and samples | Approximate bridge score; up to 128 sampled sources; engine direction/normalization semantics |
| `degree`        | `indegree`/`outdegree`                                                | Number of matching native edges; includes parallel business relationships                     |

All algorithms currently consider every business relationship type together through native `LINK` edges; domain type lives in the edge's `type` property. Type-specific projections and weighted paths are future work. `direction` affects shortest path and degree; undirected shortest path is rejected because the pinned engine does not support it; PageRank remains directed and betweenness uses the native procedure's semantics. Parameters are echoed for reproducibility; unused parameters do not change a procedure's semantics. Scores cannot substitute for GPU scheduling or launch-risk calculations.

Each query has a 3-second engine timeout. Graphs are capped at 10,000 objects and 50,000 edges and rankings return at most 100 rows. Scenario calls query their isolated graph directly. Live calls build a temporary ontology-only projection of a consistent captured live state and remove it afterward. That projection/serialization cost is real and must be included in end-to-end measurements; it is not a zero-copy live analytics path. Native ranking procedures receive graph-wide budgets, so a result limit alone is not treated as a compute limit.

The agent discovers algorithms with `discover_algorithms` and invokes them with `graph_algorithm`, using the investigation's scenario unless overridden. Results and traces carry revision and scenario version. A successful algorithm can ground a topology-only answer. An investigation requesting a domain function still needs deterministic function evidence. The agent cannot promote or approve/execute actions.

## Verification and recovery check

Integration tests run against actual FalkorDB 4.18.3, not procedure mocks. They check known shortest paths and bounds, PageRank isolation, reproducible sampled centrality, degree, empty graphs, real branch edge changes, sibling/live isolation, lost publication acknowledgments, failed candidate publication, collection, portable backups/restores, migration, access scopes and agent dispatch. Existing merge/stale-version/action/browser suites still apply.

Prepare a uniquely named scenario after seeding:

```sh
docker compose exec app node --import tsx scripts/native-demo.ts prepare restart-check-1
docker compose stop app falkordb
docker compose up -d --wait
docker compose exec app node --import tsx scripts/native-demo.ts verify restart-check-1
```

The verification checks persisted branch content/version, unchanged live state and native algorithm queries after restart. This is a **graceful stop/start** check, not a power-loss or network-partition experiment. CI runs this on the real Compose stack. The script leaves the scenario for inspection and refuses to overwrite an existing ID.

References: [copy source pinned to v4.18.3](https://github.com/FalkorDB/FalkorDB/blob/v4.18.3/src/commands/cmd_copy.c), [PageRank](https://docs.falkordb.com/algorithms/pagerank), [betweenness](https://docs.falkordb.com/algorithms/betweenness-centrality), [path functions](https://docs.falkordb.com/cypher/functions#shortestpath).
