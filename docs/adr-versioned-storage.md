# ADR: native revision visibility before replacing branch storage

Status: accepted implementation direction; the unchecked items in TODO remain incomplete until tested. Deployment scope is one API writer and one FalkorDB instance.

## Baselines and decision

The former implementation stores one JSON base per branched revision plus sparse overlays. It avoids copying each sibling's base but reads/validates whole JSON graphs and cannot run engine procedures directly on an overlay. The current implementation projects an ontology-only native base and forks/edits through GRAPH.COPY. Its native queryability, candidate publication and restart behavior are working; every edit still copies the graph. Both are comparison baselines.

First add native historical versions and pinned read contexts to the operational graph. Keep working copy-based branches while measuring the cost of a revision/overlay branch prototype. Don't replace a correct default because the alternative has a more interesting name.

## Records and atomic commits

- Existing Object/LINK records remain the current operational view.
- ObjectVersion nodes carry logical ID, generation, valid_from, optional exclusive valid_to, native scalar properties, provenance and the API record.
- Stable Identity nodes separate logical identity from physical object-version IDs. HISTORICAL_LINK edges connect these identities and carry independent relationship ID/type, generation, revision interval and record. Updating an object does not require splitting every incident edge version.
- Current changes, closure/creation of version intervals, history/checkpoint documents, commit metadata and the live revision advance must occur in the same Cypher write.
- One visible object version per logical ID and one visible edge version per relationship ID are invariants. A visible edge must have visible endpoints at that revision; object deletion must retire its edges in the same validated commit.
- Revisions are monotonically increasing per ontology, not a global order across ontologies. A no-op data replay keeps the revision; additive schema revisions also need commit metadata. Breaking schema evolution remains unsupported.
- Existing installations establish a baseline at their current revision. Do not fabricate prior history from source timestamps or incomplete event records.

## Reads

Visibility runs in Cypher: `valid_from <= revision AND (valid_to IS NULL OR valid_to > revision)`, with ontology and generation bound as parameters. Every part of an as-of graph read uses the same resolved context. Timestamps select the latest committed revision at/before the requested time; revision IDs remove timestamp ambiguity.

A pinned read token stores ontology, generation, revision, owner and lease expiry. Repeated reads remain stable while live writes progress. Expired/out-of-retention/future contexts fail explicitly. This provides read-snapshot semantics within the specified API contract. It does not create general multi-statement write transactions, prevent all write skew, or imply distributed serializability.

Restore starts a new history generation and establishes a new baseline above current/restored revision counters. Old read tokens must fail with a generation mismatch rather than silently selecting different restored data. Existing copy-based scenario bases remain independently queryable; a future overlay scheme must preserve or reconstruct its generation dependencies.

## Promotion and overlays

Existing promotion is a property-level three-way merge. First-committer-wins on an overlapping record write set is a different policy; it may reject independent edits that currently merge. Compare and document both before changing the contract. Cross-record business invariants require validation of the combined state or read dependencies; a visibility filter cannot prevent write skew by itself.

The opt-in revision/overlay backend now pins a base generation/revision and stores native deltas/tombstones with a guarded current branch version. Reads resolve overlay entries before inherited base records. Relationships and endpoints follow the same rule. Native ranking algorithms may still require an effective-graph projection; include its cost in the benchmark. An O(1) metadata insert does not make scenario evaluation O(1).

## Retention

Vacuum must respect a watermark derived from retained history, active snapshot leases and every branch base that depends on shared historical versions. Keep versions visible at the watermark; remove only versions no supported/pinned read can see, in bounded resumable batches. The first visibility milestone retains all versions rather than implementing unsafe cleanup. Graceful restart tests are separate from power-loss and partition experiments.

## Required evidence

As-of updates/deletes, edge/property changes, pinned repeatable reads, missing/future/expired/generation-mismatched contexts, schema commits, no-op replay, restore boundaries and migration baselines need integration tests. A seeded concurrent-history checker should inspect lost updates, skew, dangling edges and publication failures. Benchmark copy, JSON and revision/overlay designs at equal semantics, with raw data and query plans. Claim only the isolation and performance properties actually tested.

## Measured implementation follow-up

The [native overlay backend](native-overlays.md) now implements this opt-in path, pins retention, supports selected merge and exports portable branches. [1k/5k measurements](branch-study.md) show lower creation/edit costs but higher effective-read and algorithm-projection costs. Copy remains the default. Historical editable branch versions, full temporal backup and a fair JSON-backend comparison remain incomplete.
