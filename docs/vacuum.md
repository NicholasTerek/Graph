# Reviewed history retention and a safe watermark

Vacuum is explicit and admin-only; it does not run in the background. Operations → History & retention shows the current/oldest retained revisions, active read-snapshot count, a requested boundary and a preview. Apply requires the exact preview digest and confirmation. A current live revision/history generation precondition prevents applying an outdated plan.

```ts
const status = await client.historyStatus("semiconductor");
const options = {
  generation: status.generation,
  expectedRevision: status.revision,
  retainFrom: status.revision,
  batchSize: 100,
};
const plan = await client.vacuum("semiconductor", { ...options, dryRun: true });
// Inspect plan.watermark, protectedSnapshots and eligible counts first.
await client.vacuum("semiconductor", {
  ...options,
  dryRun: false,
  digest: plan.digest,
  confirm: true,
});
```

The effective watermark is the minimum of the requested retained revision and the active, unexpired pins in this history generation. The implementation also has a dependency hook for a future native overlay branch; existing full-copy branches need no temporal pin because their base graphs are independent. A plan with a dependency below already-retired history fails rather than attempting to resurrect deleted versions.

Suppose object versions are A1 `[1,2)`, A2 `[2,3)`, and A3 `[3,∞)`. Retention requests revision 3 but a reader pins revision 2. The watermark is 2: A1 can be removed; A2 must remain even though its valid_from is older than the requested retention boundary. After the pin releases, watermark 3 permits removing A2. A3 remains current. Relationships follow the same interval rule.

Eligible object/relationship versions are in older, invalidated restore generations or have valid_to <= watermark. Eligible commit entries are in old generations or have revision < watermark. Open versions visible at the watermark are retained. Stable Identity nodes remain; this milestone does not reclaim unreferenced identity anchors.

Each apply atomically removes at most 1–1,000 entries **per kind** (default 100), advances the logical retained boundary and records an audit document. Partial physical cleanup can resume by obtaining another preview and applying the next batch. Old physical records may remain until later batches, but reads/commit lists immediately honor the retained boundary. There is no claim that one batch reclaims all storage.

The digest includes generation, live revision, prior retention boundary, requested/effective watermark, active pin identities/leases, dependency list, batch size and eligible counts. Creating/releasing/expiring a pin, writing business data, or a previous batch changes the plan; stale applies fail with 409. Clearing the checkbox or changing the requested boundary invalidates UI confirmation. Read-only tokens can inspect basic history status but cannot preview/apply pruning.

Snapshot reads, writes, pin creation/release and vacuum use the same single-server queue. That prevents a pin from arriving between watermark capture and deletion. A pin accepted after pruning cannot select already-retired history. This is not coordination across independent writers or database administrators. A plan digest is a review guard, not a substitute for those boundaries.

Tests use one-entry batches, hold a pin through pruning, release it and resume to completion, verify all current records after each batch, check no-op/live revision stability, reject changed-pin digests and missing confirmations, enforce admin scope, and prove an older native copy branch remains readable after its corresponding temporal history is removed. The browser checks preview/protected pin/confirmation behavior without pruning its shared fixture history.
