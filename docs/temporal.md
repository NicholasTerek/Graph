# Native historical visibility and read snapshots

Business writes now maintain native ObjectVersion nodes and HISTORICAL_LINK edges in the operational FalkorDB graph. Versions carry a history generation and an interval `[valid_from, valid_to)`; an absent valid_to means current within that generation. Relationship versions join stable Identity nodes so a property update does not require splitting every incident edge version. Current Object/LINK records remain the fast operational view.

The existing single Cypher mutation now also closes old intervals, creates replacement versions, records a commit and updates the history head. Before/after documents, source checkpoints and graph changes remain in that same query. Invalid writes leave both current and historical state unchanged. Additive schema changes receive commit entries; no-op graph replay does not advance the revision. Historical schema reconstruction is not implemented: schemas evolve additively and historical reads return recorded properties.

## API and SDK

```ts
const commits = await client.commits("semiconductor");
const old = await client.stateAt("semiconductor", { revision: 1 });
const byTime = await client.stateAt("semiconductor", {
  at: "2026-10-15T04:00:00.000Z",
});
const pin = await client.createReadSnapshot("semiconductor", {
  ttlSeconds: 300,
});
const first = await client.stateAt("semiconductor", { snapshot: pin.id });
// Live writes can advance; a repeated read with this token selects the same revision.
const second = await client.stateAt("semiconductor", { snapshot: pin.id });
await client.releaseReadSnapshot("semiconductor", pin.id);
```

Routes: `GET /commits`, `POST /state/at`, `POST /snapshots`, `DELETE /snapshots/:id`, all under `/api/ontologies/:ontology`. They need read scope. Snapshot leases belong to the named principal and ontology; another principal cannot use/release them. TTL is 1–3,600 seconds, default 300, with at most 100 active leases per ontology. Pins are read coordination records and do not advance the business revision.

Select at most one of revision, at (ISO UTC timestamp), or snapshot. With none, capture the latest committed context. An optional generation rejects a mismatched history explicitly. Commit lists are ascending, up to 100 entries per page; pass the last revision as `after` to continue. Results include revision, generation, committedAt and earliest retained revision.

Visibility predicates execute in Cypher, for both objects and relationships: `valid_from <= revision AND (valid_to IS NULL OR valid_to > revision)`. The API captures and reads one context under its writer queue, then checks identity uniqueness and edge endpoints. This prevents mixed-revision state reads within the supported single-server contract. A pin extends the same revision selection across separate reads; it does not create a write transaction or distributed isolation.

Time resolution uses indexed numeric epoch milliseconds and selects the latest revision at/before the time. Stored ISO timestamps remain available for display. Commits sharing a timestamp select the latest revision; use explicit revisions for unambiguous selection. A test caught incorrect timestamp selection during implementation before switching the query to numeric time comparisons.

## Boundaries and migration

- Existing installations establish a native baseline at their current revision before serving requests. Earlier revisions fail with 410; their contents are not invented from source timestamps or partial history documents.
- Future revisions fail with 409, missing revisions with 404, expired leases with 410 and cross-principal/ontology access with 403.
- Restore creates a new history generation and baseline above previous/current revision counters. Old pins/generation selectors fail with 409. A revision before the new baseline fails with 410.
- Logical backups currently restore operational state and portable scenarios, **not the full temporal version history**. Restoring establishes a new baseline. Lease tokens are excluded. Full history backup/import is a separate backlog item.
- Versions are retained without vacuum in this milestone. Safe watermark-based reclamation still requires active snapshot and future overlay-branch dependency accounting. Storage will grow with changes.
- Copy-based native scenarios continue to use their independent base graphs. Revision/overlay branching is a planned comparison prototype, not the current default.
- No general serializable write transactions, replica reads, power-loss guarantee or protection from direct database/multiple API writers is claimed. General multi-query traversal endpoints do not automatically inherit a pin; clients must use the version-aware read API.

Tests cover native scalar visibility, updates/deletes, relationship endpoint validity, schema/no-op commits, timestamp selection, stable pin reads, lease ownership/expiry/release, restore generations, migration baselines, failed combined writes and concurrent multi-object writes/read observations.
