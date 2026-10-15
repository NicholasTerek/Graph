# Complete engineering backlog

This is the authoritative checklist for the reusable ontology platform, GPU application and engineering articles. Checked items describe implemented behavior, not production maturity. Unchecked items remain work. A feature is not done merely because an endpoint exists. See [status](status.md), [native graphs](native-graphs.md) and [article experiments](blog-plan.md) for current guarantees.

## Execution order and scope

1. Finish native graph branches and algorithm tools; validate migration/recovery. This provides a working full-copy baseline.
2. Explainability: expose source → object/edge → calculation → recommendation/action evidence, with native query paths and UI.
3. Versioned storage and historical reads; build the correctness harness alongside it. Compare full-copy, former JSON snapshots and native revision/overlay designs before selecting the long-term branch implementation.
4. Performance experiments and measured optimizations; publish raw evidence, not projected results.
5. Finish the real connected GPU agent workflow, setup and failure UX. Exercise independent agents with guarded promotion.
6. One polished entity-resolution example if the core path is convincing. Enterprise breadth and distributed deployment stay deferred.

No promise of finishing every production gap in one session. Work proceeds autonomously through unblocked implementation and verification; credentials and unavailable infrastructure are recorded as blockers, not simulated as successful integrations.

## A. Original reusable platform and GPU goals

### Platform boundary

- [x] Full TypeScript application/API/SDK; FalkorDB as operational store.
- [x] Typed ontology registration, scalar properties, endpoint validation and safe additive schemas.
- [x] Generic object/relationship CRUD, partial updates, cursor lists and bounded traversal.
- [x] Domain-independent SDK and core; GPU schema, functions, actions and UI kept in the example extension.
- [x] OpenAPI, distributable SDK/contracts, independent package consumer check.
- [x] Prove a second domain through its schema/function and registered library workspace, with no domain edits to core; see [extensions](extensions.md).
- [x] Add a documented extension-composition interface instead of hard-coded GPU imports at the server composition root.
- [x] Define the 0.x package/API compatibility policy and reproducible paired SDK/contracts tarballs with source/tool/hash manifest; see [releases](releases.md).
- [x] Track richer types, cardinalities and schema migration needs separately in the extension contract; these remain future capabilities.

### Source ingestion and provenance

- [x] CSV/JSON snapshots and public GitHub repository/issues reads.
- [x] Notion data-source scalar-property and Discord channel-message readers.
- [x] Explicit mappings, deterministic identities and optional shared identity keys.
- [x] Preview/apply checksums, checkpoints, no-op replay and atomic graph/history/checkpoint writes.
- [x] Detect manual source-managed edits/deletions; protect pre-existing/shared/linked entities.
- [x] Bound pagination, record counts, response sizes and timeouts for the new authenticated readers.
- [x] Named server-side connections restricted to resource and ontology; secrets excluded from source records/backups.
- [x] Retain absent Notion/Discord records rather than infer deletion from lost visibility.
- [ ] Validate each authenticated reader using an actual configured demonstration account.
- [x] Add redacted non-probing source-connection status, setup guidance and actionable permission/rate-limit errors in the UI; live-account validation remains separate.
- [x] Register source relationship mappings so imported scalar references become native graph edges, with preview, ownership and temporal history.
- [x] Add scheduled explicit refresh with durable jobs, leases, bounded retries and cancellation; see [job semantics](jobs.md).
- [ ] Add progress/checkpoints for resumable larger imports if measured workloads need them.
- [ ] Keep OAuth, CDC, arbitrary REST adapters and additional SaaS connectors out of the critical path.

### GPU operational model

- [x] Product demand, inventory shortfall, production capacity and duration.
- [x] Supplier/component qualification as a real relationship plus active flag.
- [x] Driver architecture/features, repair, fallback compatibility and validation gates.
- [x] DAG scheduling, cycle rejection, hardware/software dependencies and critical paths.
- [x] Alternative recovery plans, costs, explicit ordinal risk and source evidence.
- [x] Interactive scenario assumptions, timeline and recommendation changes.
- [ ] Replace one bundled input with connected operational/demo data through existing source APIs.
- [x] Link model assumptions to captured contributing inputs and named rules in the GPU planner and explanation view; label synthetic limits as declarations.
- [x] Show exact failed qualification/capacity/driver constraints, rule IDs and captured record links per blocked alternative; distinguish eligible late plans by modeled delay.
- [ ] Model competing orders/yield/stochastic lead times only if the chosen demo requires them.

### Actions and agent loop

- [x] Typed proposal → exact review → approve/reject → explicit execute workflow.
- [x] Version/revision binding, idempotency and uncertain-outcome reconciliation.
- [x] GitHub issue action with repository allowlist and evidence from a registered calculation.
- [x] SDK-only agent tools, budgets, persisted traces and optional compatible model adapter.
- [x] No approve/execute/promote tool available to the agent.
- [x] Native shortest path, PageRank, sampled betweenness and degree via API/SDK/agent tools.
- [ ] Run an actual configured model against the GPU workflow and evaluate its evidence/answer quality.
- [ ] Complete one explicitly approved real external action against a demonstration repository.
- [x] Add a durable investigation/job state machine with cancellation and recovery; source retries are bounded, interrupted agents require explicit retry.
- [x] Add approval expiry/revocation and surface stale context before execution; reviewed deadlines and server-side rechecks prevent external calls after expiry/revocation.
- [x] Add SDK-only capacity/driver alternatives with separate owned copy/overlay branches, saved role-bound investigations and separately authorized human/UI promotion; label scripted-reviewer mode explicitly.
- [x] Enforce branch ownership in the service; scoped kind:agent credentials and ephemeral per-owner investigation delegation prevent sibling edits and live/privileged writes.
- [x] Keep deterministic-tools/model-tools explicit in capabilities, investigations, jobs and demo output; live-model validation remains unchecked.

## B. Explainability — next product milestone

- [x] Define a typed explanation envelope: question/claim, snapshot identity, entities, relationships, source mappings, source checkpoints, rule IDs, calculation run IDs, tool traces and limitations.
- [x] Expose a bounded object explanation endpoint through SDK and agent tools, honoring ontology permissions.
- [x] Return actual native Cypher dependency paths with stable edge IDs and provenance; don't generate a merely plausible path in model text.
- [x] Distinguish direct source evidence, derived model inputs, assumptions and calculated outputs.
- [x] Link recommendation → required tasks/constraints → graph records → source rows/checkpoints.
- [x] Bind explanations to the same revision/scenario version as the calculation; show stale/current context explicitly.
- [x] Show why one recovery beat alternatives and why an alternative failed, without equating centrality to business risk.
- [x] Add an evidence panel with selectable path, source/history links and calculation/agent steps.
- [x] Add a model tool that answers “why” from the typed evidence; include uncertainty/missing evidence.
- [x] Test missing sources, deleted records, cross-ontology access, stale runs, incomplete paths and misleading source text.
- [x] Record a browser workflow: change one supplier assumption → recommendation changes → inspect exact evidence.

## C. Native branching baseline — implementation milestone

- [x] Verify GRAPH.COPY on pinned FalkorDB, rather than assuming Redis COPY compatibility.
- [x] Inspect the pinned implementation: fork, serialize, decode; document full-copy costs.
- [x] Avoid copying unrelated ontologies or control metadata into business algorithm graphs.
- [x] Store native base/branch nodes and relationships, not authoritative JSON overlay blobs.
- [x] Prepare independent candidate graphs and publish only after native edits/validation complete.
- [x] Retain expected-version rejection and selected three-way promotion.
- [x] Query scenario topology directly with native algorithms.
- [x] Migrate legacy JSON scenarios and export/restore portable backups without graph-key injection.
- [x] Test concurrent branch edits, live/sibling isolation, failed publication and lost acknowledgment.
- [x] Collect unreferenced graphs at startup/discard; clean acknowledged superseded candidates.
- [x] Add a reproducible graceful API/database stop/start check to milestone CI.
- [x] Observe the new Compose stop/start check passing for the exact native milestone SHA.
- [ ] Measure copy creation/edit overhead, temporary I/O, memory and disk footprint.
- [ ] Stress copy failure/restart during preparation; quantify orphan cleanup and recovery time.
- [x] Add scoped admin native-graph inventory, reviewed digest and explicit-confirmation collection; test stale reviews and published/foreign graph protection.
- [x] Show branch storage mode, base revision and current version in the planner.

## D. Versioned storage, visibility and “as of” reads

This is planned work. The native-copy implementation is the functional baseline, not an MVCC implementation. Single-writer concurrency control is the target; distributed deployment is not required.

### Design and correctness contract

- [x] Write an ADR comparing full native copies, previous JSON shared bases and a native revision/overlay model, including migration, read path and GC complexity.
- [x] Specify per-ontology monotonically increasing commit revisions and stable logical IDs separately from physical version IDs.
- [x] Define single-call captured reads, version-aware leased multi-read snapshots and unsupported generic multi-call transactions explicitly in the temporal contract.
- [x] Define commit records, timestamp-to-revision mapping, failed-write allocation policy and no-op revision policy.
- [x] Define restore generations/epochs so old snapshot tokens cannot accidentally refer to unrelated restored history.
- [x] Define object AND relationship version visibility, including deletes, endpoint existence and relationship/property updates.
- [x] Choose branch-base and overlay precedence rules, including tombstones, new objects, changed relationships and inherited values.
- [x] State unsupported anomalies/operations: cross-ontology atomicity, direct database writes, multiple API writers and distributed serializability.

### Native version persistence

- [x] Store valid_from and valid_to (exclusive upper bound/absent while current) as native properties for object versions.
- [x] Version relationships natively too; preserve stable relationship IDs and provenance.
- [x] Close old versions, create new versions/edges and advance commit revision in one guarded Cypher write.
- [x] Enforce at most one visible version per logical identity at a chosen revision.
- [x] Create native visibility/identity/commit indexes and inspect ObjectVersion root/full-visibility plans in the [dependency-scope study](function-scopes.md).
- [x] Backfill an initial version baseline without inventing historical timestamps or provenance that was never stored.
- [x] Preserve source checkpoint/history atomicity and action approval invalidation across the migration.
- [x] Export/restore bounded retained versions, commit records and portable branch dependencies with validation, atomic rollback and generation safety; see [v2 backups](temporal-backups.md).

### Historical reads and branches

Implemented opt-in [native overlays](native-overlays.md), with [creation/edit/read/function/algorithm measurements](branch-study.md). Both backends stay explicit; metadata-only creation does not imply cheap evaluation.

- [x] Add read-at-revision and read-at-time endpoints and SDK methods.
- [x] Push `valid_from <= revision AND (valid_to IS NULL OR valid_to > revision)` into Cypher.
- [x] Return one consistent visibility context for objects, relationships, traversals and deterministic functions.
- [x] Support pinned multi-read snapshot tokens/leases if claiming snapshot isolation across API calls.
- [x] Define missing/out-of-retention/future revision errors; don't silently return the current graph.
- [x] Add cheap branch metadata at a pinned revision, native deltas, guarded branch-version publication and explicit shadow/tombstone rules. Old editable branch versions are not retained.
- [x] Make algorithms consume a correctly scoped effective graph; measure temporary projection for overlay branches.
- [x] Benchmark revision/overlay versus native copies at 1k/5k objects. Keep copy as default because creation/edit improve but whole-graph algorithm projection regresses.
- [x] Retain selected promotion and document property-level three-way merge versus read-set/first-committer-wins semantics.
- [ ] If using first-committer-wins, test overlapping writes and decide whether independent properties of one record conflict.
- [x] Explicitly document possible cross-record write skew; generic business-invariant/read-set validation remains unsupported.
- [x] Add an as-of UI scrubber with exact revision/time and read-only historical views.
- [x] Show branch base, divergence and merge conflicts next to the agent alternatives.

### Vacuum and retention

- [x] Compute a reviewed watermark from the requested boundary, active snapshot pins and every native overlay base; independent copy bases do not require temporal pins.
- [x] Keep the version visible at the watermark even if its valid_from is older.
- [x] Remove only versions invisible to all supported/pinned reads; coordinate edge-version cleanup with endpoints.
- [x] Expire/release snapshot leases safely; don't drop active branch bases because an agent went idle.
- [x] Vacuum in bounded resumable batches with dry-run statistics and tests for interrupted collection.
- [x] Expose oldest retained revision, pinned bases, estimated reclaimable versions and storage growth.

## E. Correctness history checker

Call this a small concurrent-history checker, inspired by Jepsen's approach. Do not claim a full Jepsen test or distributed failure coverage.

Implemented: `pnpm check:history` and [its exact workload/checks](concurrency-checker.md). Seeded clients cover read/patch/atomic ingestion/CSV sync/optional registered calculation/branch/edit/promote/discard and stable pins. Eleven injected-anomaly unit tests validate the checker itself. Process/network faults remain separate tests.

- [x] Exercise seeded SDK reads/patches/branches/promotions/CSV sync/discard, with registered pair calculations in milestone tests and optional CLI function selection.
- [x] Journal invocation/completion, input/output, revision/version and explicit success/conflict/failed/unknown outcomes, including cleanup.
- [x] Check guarded increments and explicitly demonstrate blind lost increments and unguarded last-write behavior in local mutation tests.
- [x] Check repeatable pinned reads, object/edge read skew and zero dangling visible edges.
- [ ] Check branch isolation, no partial candidate publication and no stale promotion/action execution.
- [ ] Check temporal visibility intervals and commit/restore generation monotonicity.
- [x] Test same-record guards, independent fields, linked-deletion rejection and deliberate cross-record write skew; do not claim generic serializability.
- [ ] Inject failures before native write, after candidate write, before/after pointer publication and before acknowledgment.
- [ ] Restart API/database and verify persisted histories, pins and cleanup within the documented durability mode.
- [x] Save seeds/full journals, a bounded reduced diagnostic witness and a human-readable failure report; label reducer/replay limits explicitly.
- [x] Run a small seeded suite in milestone CI; put longer concurrent schedules behind `pnpm check:history`. Scheduling itself is nondeterministic.

## F. Performance engineering and blog evidence

### Harness and measurements

Recorded now: [aggregate before/after study](performance-study.md), exact plans, 4,800 requests per implementation, 250/1,000 objects and concurrency 1/8. Fixed request counts, warm local fixtures and three repeats; this is not the entire matrix below.

- [x] Small HTTP baseline command and explicit benchmark limitations.
- [x] Generate deterministic synthetic task dependency DAGs: chain, bounded degree and hubs, with known edge/answer cardinality for the [graph-view study](graph-view-study.md).
- [ ] Separate database-only fixtures from end-to-end platform ingestion so setup shortcuts aren't presented as platform capacity.
- [ ] Measure increasing graph sizes (1k/10k/100k only where actually supported), branch counts and changed-record fractions.
- [ ] Compare native copy, previous JSON-base/overlay implementation and native version/overlay implementation at equal semantics.
- [ ] Measure first/sibling branch creation, edit, evaluation, promotion, cleanup and storage bytes.
- [ ] Measure ingestion: row-by-row versus batched UNWIND, with equal validation/history/durability semantics.
- [x] Capture GRAPH.EXPLAIN and read-only GRAPH.PROFILE for the actual aggregate/reference-page queries and range index; broader dependency queries remain work.
- [x] Record warmups and repeated fixed-duration function trials with p50/p95/p99, achieved completions, errors and CPU/memory; short-trial limits are explicit.
- [x] Add guarded scalar writes with zero/eight closed-loop aggregate readers, alongside 1/8/32 function readers; report achieved load and remaining queue costs.
- [ ] Record per-process CPU/RSS, database memory, serialized bytes and disk/temp copy costs.
- [x] Record hardware, versions, persistence, indexes, network placement and warm/cold state for the aggregate study.
- [x] Commit raw samples, scripts and reproduction commands; build the aggregate chart directly from recorded trials.

### Measured optimizations

- [x] Identify a concrete first aggregate bottleneck before changing storage or caching.
- [x] Push aggregates into native Cypher instead of paging all values through TypeScript.
- [x] Replace repeated GraphView array scans with indexed lookups; preserve ordering/evidence and record equivalent before/after trials.
- [x] Add declared native dependency slices for live/history/copy functions with bounded results and captured context; overlay uses an explicitly reported full-read fallback.
- [x] Use local schema validation and one-object version deltas for scalar patches; preserve broad planning for topology/source/promotion operations and measure equivalent guarded HTTP writes.
- [ ] Measure projection/copy overhead separately from native algorithm execution.
- [x] Preserve aggregate output equivalence and existing conflict tests for the first optimization; require equivalent checks for subsequent changes.
- [x] Record the aggregate before/after results, CPU costs, trial variation and remaining branch-copy tradeoffs; do not infer a speedup from GraphBLAS.
- [ ] Defer read replicas until replication consistency and pinned-snapshot semantics are understood and testable.

### Two articles

- [x] Draft the first concrete aggregate performance article with bottleneck, native plans, actual before/after results and limits. Broader dependency-query article remains work.
- [x] Draft the versioning article around implemented visibility, branch publication, conflicts, tested failure cases and GC, with the measured two-backend comparison.
- [x] Include actual Cypher, visibility invariants, the local-patch legacy-baseline hazard/fix, regression links and reproducible measurements in [the versioning article](versioning-notes.md).
- [x] State single-writer concurrency control rather than distribution in both drafts.
- [x] Label fixture, end-to-end HTTP, separate native PROFILE and unavailable live-model results in the current drafts.

## G. One bounded entity-resolution demo

Implemented and verified in [the supplier identity lab](entity-resolution.md).

- [x] Plant one supplier under three messy spellings across CSV, JSON and GitHub issue fixtures.
- [x] Materialize shared-neighbor evidence (component, product, issue references) as native relationships.
- [x] Define candidate generation and a transparent shared-neighbor score with deterministic tie handling.
- [x] Include a plausible non-match so the demo can reject an ambiguous merge.
- [x] Show the scored evidence and require explicit review before applying a canonical identity.
- [x] Preserve aliases, contributing source IDs, history and reversible merge metadata.
- [x] Update references atomically; test no dangling edges and replay-stable source mappings.
- [x] Label the synthetic bounded example; don't claim general fuzzy entity resolution.

## H. Delivery, access and reliability

- [x] Scoped tokens, ontology restrictions, host/origin checks and request IDs.
- [x] Health, route metrics, diagnostics and logical backups with explicit restore confirmation.
- [x] Smaller reviewable milestone commits, authored as Nicholas with no co-author trailer.
- [x] Full CI on pull requests/manual dispatch/ci/verify milestones rather than every main commit.
- [ ] Improve setup so missing credentials/model/permissions lead to clear UI guidance.
- [x] Add tested [local backup retention](temporal-backups.md), native restore drills, graceful interruption recovery and version-migration rollback instructions. Abrupt power-loss recovery and off-host retention remain unverified.
- [ ] Display source freshness, branch staleness and job recovery status in the UI.
- [ ] Run the final scripted GPU story from a clean installation and record a demo.
- [ ] Keep secrets, employer data and private operational records out of the synthetic demonstration and artifacts.
- [ ] Keep SSO, enterprise policy, arbitrary code execution, multi-writer replication and full Foundry parity explicitly outside the required demo.

## Completion rule

Each milestone needs implementation, relevant tests, exact observed results and any remaining limitation in the same reviewable change. Performance milestones also need raw measurements. Account-dependent verification stays unchecked until performed. A final update must state what is done and what remains; don't convert this backlog into an unsupported completion claim.
