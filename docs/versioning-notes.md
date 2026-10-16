# Letting agents disagree without overwriting reality

Engineering draft, based on the implementation and tests in this repository. The GPU data is synthetic. These are single-writer concurrency controls, not a distributed transaction system.

A launch planner needs to ask two different questions. What was true when this recommendation was made? What would happen if an agent changed the supplier lead time? The first needs stable historical reads. The second needs an isolated working branch and a deliberate way to bring selected changes back.

Historical state uses native object and edge versions in the main FalkorDB graph. Editable scenarios default to independent native graphs, with an explicit native revision/overlay alternative. This gives us a working isolation model, and it makes the remaining cost visible: native graph copying is much more expensive than adding a branch pointer.

## A revision names a state

A coordinated mutation increments an ontology revision. The same Cypher statement updates current objects/edges, closes previous version intervals, appends new versions, writes the commit record and publishes any related checkpoint/history changes. A failed statement cannot acknowledge a revision without its state changes. The API serializes mutation planning through one process-local queue; a second API writer or a direct database mutation would bypass that assumption.

An object version is visible at revision `r` when:

```cypher
v.generation = $generation
AND v.valid_from <= $r
AND (v.valid_to IS NULL OR v.valid_to > $r)
```

Relationship versions carry the same interval fields, between stable identity anchors. Historical traversal filters every edge and the visible endpoint versions. Keeping old vertices alone would not be enough: a current edge could otherwise connect a historical object to something that did not exist at that revision.

The current graph remains a fast view for ordinary CRUD. Historical queries filter native versions in Cypher rather than replaying a JSON audit log in TypeScript. Restoring a logical backup starts a new generation. Default v1 archives restore an operational baseline; optional [v2 archives](temporal-backups.md) preserve retained versions and commits, then append a restore commit above both heads. Neither reconstructs pruned history, old schemas or historical executable code.

## A small write can corrupt a migration baseline

While replacing whole-graph scalar validation with a local patch path, we caught a correctness hazard: the new planner had only the target object's before/after images. Using that delta to initialize history for a legacy ontology would record an incomplete baseline. Current reads could look correct while an as-of read silently lost every untouched record and edge.

The fix initializes temporal metadata from the full legacy state before accepting the small delta; already-versioned ontologies keep the fast path. The regression starts with two objects and one edge at revision 7, removes temporal metadata to model a legacy installation, patches one object, then requires all three identities at the old snapshot and both old values. The [scalar mutation tests](../tests/local-patch.integration.test.ts) also inject native runtime failure and a lost acknowledgment. This is the useful boundary for the optimization: local property validation can replace whole-state planning after migration, but cannot replace the migration baseline itself. The [measured trials](local-patches.md) compare equivalent guarded writes with the same history publication.

## Several reads need one pin

An agent may read the graph and then run a calculation. Two independently resolved “latest” calls could observe different revisions. The SDK can acquire a short-lived, principal-owned read snapshot and pass it to both calls. A snapshot fixes an ontology, generation and revision; it is not a mutable transaction.

The GPU history view uses that contract for the displayed graph and recalculated plan. Its historical controls are read-only. Saved calculation evidence contains the actual read records, edges, rules and source values captured with the run. Asking “why?” after a later edit can therefore return retained evidence rather than inventing a path through today's state.

A pin expires or can be explicitly released. Expired/pruned history produces an error, not a fallback to current data. A restored generation invalidates an old pin. These details matter more to a user than whether the UI calls its control a time machine.

## A branch owns its working graph

The first branch at a live revision projects an ontology-only immutable base graph. Siblings use `GRAPH.COPY` from that base. An edit validates its effective state, prepares another native graph, applies the change and then publishes the new graph reference with an incremented branch version.

Readers use the published graph. An unreferenced candidate cannot become a half-edited visible branch. Acknowledged old candidates are removed; startup/discard collection removes unreferenced keys in the managed namespace. Failure tests cover a failed candidate and an acknowledgment lost after publication. A client with an uncertain outcome must reread the branch version before retrying. [Twelve API-process SIGKILL trials](branch-crash.md) now check this boundary with a real HTTP client: the new state survived publication even when the client saw a transport failure, and startup collection removed the unreferenced graph. Database power-loss behavior is a separate question.

```mermaid
flowchart TD
  B["Immutable native base"] --> A["Agent A graph"]
  B --> C["Agent B graph"]
  A --> N["Validated candidate"]
  N --> P["Published branch reference"]
  P --> M["Reviewed selected merge"]
  C --> M
  M --> L["Live revision"]
```

Promotion requires the expected branch version, expected live revision, selected records/relationships and explicit confirmation. A three-way comparison uses base, branch and live values. Independent property edits may merge; incompatible changes to the same property conflict. The expected live revision prevents a preview from silently applying after another writer changes live state.

This is optimistic concurrency with a selected property-level merge. It is not first-committer-wins for arbitrary read sets, and it does not prove arbitrary cross-record business invariants. An application that makes a decision across several records must revalidate its relevant dependencies before committing. Supplying no expected revision on an ordinary patch permits last-write behavior.

## What we checked

The [concurrent-history workload](concurrency-checker.md) races guarded increments, atomic pair writes, current reads, pinned reads and branch promotion. Its journal records invocation and completion times. The checker rejects a current read older than a completed write, inconsistent contents at one revision, skewed object pairs, dangling edges, a moving pin and a final counter that differs from the number of successful increments.

The checker itself is tested with deliberately broken histories. Real FalkorDB integration runs exercise two seeds. Other tests check native version boundaries, restore generations, overlapping branch edits, selected merge conflicts, candidate publication failures and bounded retention. Milestone CI also stops and restarts both the API and persistent database and verifies a native branch.

These are useful falsifiable checks. They are not exhaustive schedule exploration, partition testing, a full Jepsen test or evidence for multiple API writers.

## Retention is part of the read contract

For a requested retention boundary, vacuum lowers its watermark to the oldest active read pin. If a version began at revision 2 and ends at revision 9, a watermark of 7 must keep it. Removing every version whose start precedes 7 would corrupt the snapshot. Only closed intervals ending at or before the watermark are eligible, along with inaccessible old generations; the current open versions survive.

The operator previews eligible versions, edge versions, commits and protected pins. Apply requires an explicit confirmation and a digest of the reviewed plan. A changed pin, live revision or prior batch invalidates that digest. Each bounded batch advances the retained boundary and records an audit entry atomically with its removals. Another preview is required before continuing.

Current copy-based branches have independent base graphs and do not depend on temporal versions. Opt-in native overlay branches protect their base generation/revision for their entire lifetime. Logical restore exports their base/deltas and rematerializes copy branches rather than retaining invalid old-generation references. Optional [v2 temporal backups](temporal-backups.md) now preserve retained versions and commits in a fresh generation. Reclaiming unreferenced identity anchors remains separate work.

## The cost we have not hidden

Our [performance study](performance-study.md) records first versus sibling creation and one-record edits. `GRAPH.COPY` makes an independent graph; it is not a persistent-tree pointer or zero-copy snapshot. A small edit therefore still incurs full candidate copy, effective-state validation and pointer publication. Diffs still materialize effective graphs. Functions with declared dependency scopes now capture bounded native traversals on live, historical and copy branches; native overlays still materialize their effective input before applying the same scope. The [scope study](function-scopes.md) records exact plans, equality checks and sustained HTTP trials.

The [two-native-backend experiment](branch-study.md) now compares this default with a native base-revision-plus-overlay design. At 5k objects, overlay creation improves substantially but shortest-path requests pay about 27× more because input projection moves to read time. Edits still materialize and validate state. A fair former-JSON-backend comparison remains work. Future experiments must measure creation, edit, read/projection, promotion, cleanup and retained storage at equal semantics. Cheap branch creation alone would be misleading if every algorithm call then materializes the entire base.

The historical JSON-backend comparison, larger mixed-load trials and a configured live model/source demonstration remain in the [complete TODO](TODO.md). The work already supports historical explanations and isolated alternatives. The next claim needs another measurement, not a stronger adjective.
