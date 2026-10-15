# Importing references as native relationships

Source mappings can now create native `LINK` edges as well as objects. The same sync preview shows object and relationship additions, updates, removals and unchanged counts. Apply binds the source checksum and optional live revision, then commits objects, edges, their temporal/history records and the source checkpoint together. Preview validates the proposed endpoints/types without changing operational data or the checkpoint.

```ts
await client.registerSource("supply", {
  id: "parts",
  name: "Parts feed",
  connector: "json",
  mapping: {
    type: "Part",
    idField: "row_id",
    objectIdField: "part_id",
    properties: { name: { field: "name" } },
    relationships: [
      {
        id: "supplier",
        type: "SUPPLIED_BY",
        target: { objectId: { field: "supplier_object_id" } },
      },
    ],
  },
});
const preview = await client.syncSource("supply", "parts", {
  content: JSON.stringify(rows),
  dryRun: true,
});
await client.syncSource("supply", "parts", {
  content: JSON.stringify(rows),
  expectedCheckpoint: preview.checkpoint,
  expectedRevision: liveRevision,
});
```

Each relationship mapping has a stable `id`, an ontology relationship `type`, a `target`, optional `direction: "in" | "out"` (default out), and optional `optional: true`. Out means the imported object is the source endpoint; in means it is the destination. A literal target is `{objectId: {value: "known-object"}}`. Target objects must exist after the proposed objects have been mapped, so same-batch references work; imports across sources should load their target source first.

A target can also use the existing exact shared-identity mechanism:

```ts
{ id: "supplier", type: "SUPPLIED_BY",
  target: { type: "Supplier", identity: {field: "supplier_key"} } }
```

This uses the same normalized identity hash as a target object source configured with `identityField`. It trims and lowercases a scalar identity; it is not fuzzy matching or lookup by arbitrary property. A source using `objectIdField` should be referenced by its explicit object ID instead. Missing references fail with 422 unless the mapping is optional. Invalid IDs, unknown relationship types, incompatible endpoint types, duplicate mapping IDs, and non-scalar reference values fail instead of creating dangling edges. There are at most 10 relationship mappings and 5,000 generated relationships per source snapshot, within the existing 2,000-row bound.

## Ownership and replay

A generated edge ID hashes ontology, source ID, relationship-mapping ID and external row ID. It stays stable when the row's target changes. A change closes the old historical edge version and creates the new endpoint version; older read revisions keep the old topology. Replaying an unchanged snapshot preserves the edge's provenance and graph revision.

`Source.managedRelationships` records the exact last managed relationship and whether this source created it. The sync refuses to overwrite a manually edited/replaced/deleted managed edge. Identical pre-existing edges can be adopted without claiming creation ownership, and later snapshot removal cannot delete them. Independently created manual edges remain untouched. Objects with remaining links still block source-driven deletion.

Complete CSV/JSON/GitHub snapshots remove missing source-owned edges before considering missing object deletion. An optional blank reference removes its previous source-owned edge while leaving the row's object. The source cannot delete pre-existing or externally changed edges. Relationship IDs are source-scoped, so two sources referencing the same endpoints create distinct edges; there is no automatic cross-source edge deduplication or shared edge ownership inference.

Notion/Discord remain conservative: an absent row or blank optional scalar reference retains its previously managed edge. A later fetch with reduced visibility is not sufficient evidence of deletion. Their current readers expose scalars, not arbitrary native Notion relation arrays; shared keys must be scalar data supplied by the connection. No new OAuth, background refresh or SaaS relation API is implied.

## Verification and SDK-only demo

`pnpm demo:sources` uses only the SDK against a running API. It registers a uniquely named library ontology, imports authors from CSV, imports books from JSON with shared-identity author references, verifies checksum-bound preview/apply, checks native paths and historical topology, and verifies no-op replay. The synthetic ontology remains for inspection; use a disposable database for repeated demos. `API_URL` and `GRAPH_API_TOKEN` select the service.

Integration tests cover actual native edges, no-op replay, source immutability after sync, endpoint changes/history, missing/type-invalid endpoints, explicit and shared identities, incoming edges, missing-row cleanup, optional edge-only changes, conservative remote visibility, manual edits/deletions, unrelated manual links and bounded rejection. The normal planner/algorithms can follow these relationships because they are graph edges rather than references stored only in JSON records.
