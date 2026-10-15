# Development log

## Foundation — October 15, 2026

The attached project brief proposes a generic operational ontology platform with a semiconductor launch-risk application. The first implementation deliberately targets the storage, API, ingestion, and inspection path. It does not claim that scenario planning or an agent exists yet.

### Decisions

- Full TypeScript, following the project owner's preference. Fastify provides the HTTP boundary, Zod validates schemas and records, and the frontend and SDK share contracts.
- FalkorDB is mandatory at runtime. No in-memory fallback hides a missing database.
- A single operational graph stores ontology metadata, typed objects, and actual dependency edges. Domain-specific labels are values in validated records rather than string-interpolated Cypher identifiers.
- The semiconductor dataset stays under `examples/`. A second library dataset exercises the same endpoints without changing core code.
- Ingestion validates the full batch before one write query. Mutations are serialized in one API process to keep read-validate-write operations consistent against other API mutations. This is not a claim of distributed transaction safety.
- The first ingestion adapter consumes JSON snapshots. dlt, Airbyte, automatic entity resolution, historical provenance, and sync checkpoints are deferred.
- No premature optimization. The small graph format prioritizes correctness and inspectability. Properties are JSON payloads; indexed native properties and server-side property predicates need a later design.

### Bugs found during verification

- Repeating FalkorDB index creation raises an error. Startup now handles only the specific existing-index response, and an integration test initializes the same graph twice.
- Calling a browser's native fetch as an SDK instance method causes an illegal-invocation error. Browser checks caught it; the SDK now wraps the default fetch call so its receiver remains valid.
- The FalkorDB container entrypoint ignores Docker command arguments. Persistence is configured through its documented implementation variables (`REDIS_ARGS` and `FALKORDB_DATA_PATH`) instead.

### Verification environment

The coding environment has no Docker executable. Real database integration runs use the native FalkorDB 4.18.3 module and bundled Redis 8.6.2 binary obtained from FalkorDBLite 0.10.0. Only those native binaries are used; Python is not an application dependency. Server and test processes must be started within the same execution environment to share their network namespace.

The official `falkordb/falkordb:v4.18.3` image tag and its entrypoint were inspected. The Compose build cannot be verified locally here; a separate GitHub Actions job builds and smoke-tests the actual Compose stack.

### Sources inspected

- Official rules: https://www.wemakedevs.org/hackathons/falkordb/rules
- FalkorDB documentation: https://docs.falkordb.com/
- Official TypeScript client: https://github.com/FalkorDB/falkordb-ts
- Container entrypoint: https://github.com/FalkorDB/FalkorDB/blob/v4.18.3/build/docker/run.sh
- Helix Foundry's README and package manifest: https://github.com/HelixDB/helix-foundry
- dlt filesystem destination: https://dlthub.com/docs/dlt-ecosystem/destinations/filesystem

Helix Foundry is an architectural reference; no implementation code was copied. Broader research into scenario versioning and ontology platforms remains necessary before those subsystems are implemented.

### Observed results

- TypeScript strict check and Vite production build pass.
- 8 schema/record validation tests and 11 real FalkorDB integration tests pass.
- 4 Chromium browser tests pass: object inspection and traversal, independent ontology switching/schema inspection, invalid import handling, and mobile layout without horizontal overflow.
- Desktop (1440px) and mobile (390px) screenshots were visually inspected.
- Browser checks caught a real SDK invocation defect before delivery; API-only checks would not have found it.
- Container build and Compose startup remain delegated to CI because Docker is unavailable in the coding environment.

## GPU application and reusable SDK proof

The project owner redirected work toward the semiconductor application to establish whether the reusable API actually supports a domain workflow. The application lives under `examples/semiconductor/app`, and the deterministic planner lives under `examples/semiconductor/functions`. Neither has direct database access. Generic platform code has no GPU, supplier, or driver types.

The model now enumerates six graph-derived supplier/release alternatives. The default Meridian lead of seven days produces a 20-day repaired-driver plan. Fourteen days makes that route three days late and selects expedited Northstar instead. A 20-day driver repair selects the validated fallback. The math uses graph properties and explicit assumptions, including ordinal risk points and incremental USD costs. It does not treat predicted validation completion as an observed passing test.

Implemented supporting capabilities: OpenAPI/Swagger UI, object/relationship collection queries, typed SDK errors, optional revision checks for property patches, safe additive ontology schemas, scenario overlays, and persisted deterministic function runs.

Scenario state uses a shared immutable snapshot per branched revision plus per-scenario overrides/tombstones. This is copy-on-write at the application layer; it does not pretend to be database-native MVCC. Conflicting scenario edits are rejected through version checks. Tests cover pinned-state isolation, live-update divergence, shared sibling bases, invalid edits, relationship changes, scenario deletion, and function extension outside the semiconductor domain.

Observed verification: 14 unit/model tests, 23 real FalkorDB integration tests, and six Chromium browser tests pass. The first foundation commit's GitHub CI passed both the full verification job and the Docker Compose smoke test. The expanded workflow still requires its own post-commit CI run.

The previous commit’s actual ontology and data were loaded over HTTP, then upgraded using the current seed script. The new GPU fields and fallback relationship registered without deleting existing data. The command-line SDK demo passed its recommendation-change and live-state isolation assertions against that upgraded service. Desktop and mobile launch-workspace screenshots were visually inspected.

## Operational platform expansion

Implemented the six requested priorities as a cohesive prototype: source synchronization and record history; inventory/capacity/qualification-aware GPU scheduling; selective three-way promotion; reviewed external actions; restricted SDK-driven investigation; and access/operations/SDK hardening.

### Correctness boundaries

- Replaced scattered graph writes with a shared commit path that submits operational mutations, history records, source checkpoints, and associated documents in one Cypher query. A single API process still owns serialization.
- CSV/JSON/GitHub connectors preserve external mappings and deterministic identities. No-op synchronization preserves the graph revision. Manual modifications/deletions, pre-existing records, manual extensions, and remaining relationships prevent destructive source reconciliation.
- Supplier qualification is a real `QUALIFIED_FOR` relationship plus an active qualification flag. Production covers only demand not supplied by inventory. Driver features and architecture are hard constraints. A DAG scheduler makes hardware-dependent validation wait for both assembled hardware and software pre-validation, and rejects cycles.
- Scenario promotion compares base, hypothetical, and live values. Independent live property edits survive; overlapping changes are rejected. Approval and live/scenario versions are explicit at mutation boundaries.
- Action preparation is side-effect free. Approval, execution, and reconciliation have distinct scopes and states. Unique markers support remote reconciliation. There is no exactly-once claim or automatic retry after a lost response.
- Investigations use only the public SDK. Their internal credential cannot approve, execute, promote, restore, or administer indexes. Model responses that skip deterministic calculations fail; unsupported approval tools are rejected and budgets are enforced.
- Backups exclude credentials and executable approvals. Restores verify their checksum, require explicit confirmation and revision matching, and advance the revision beyond restored/current contexts.

### Observed verification

- Strict TypeScript, SDK declaration builds, production web build, and independent tarball consumer verification pass.
- The complete suite exercises schema/model logic, native FalkorDB writes, connector reconciliation, token scopes, promotion conflicts, action approval/execution/reconciliation, model-tool restrictions, backup/restore, and browser workflows.
- The actual public GitHub connector fetched this project's public repository metadata over HTTP and persisted one repository object. It sent no GitHub credential.
- The real HTTP seed, command-line recovery demo, diagnostics, and a 1,000-object benchmark ran successfully. Exact measurements and caveats are in `benchmarks.md`.
- The external issue-creation protocol was exercised against a controlled HTTP fixture, including a simulated lost POST response followed by reconciliation. No real GitHub issue was created.
- Model protocol and tool orchestration were tested with controlled compatible responses. No live model was configured; the default UI clearly identifies deterministic orchestration.
- Docker remains unavailable in this coding environment. The actual Compose stack is checked by CI. Earlier foundation and scenario milestone CI runs passed; this expansion needs its own post-commit CI result.

The production gaps remain explicit: one API writer, small-graph full-state reads, bounded snapshot connectors, no durable scheduler or distributed coordination, no enterprise governance, and no assertion of Foundry feature parity. README and operations/API guides describe supported behavior rather than presenting those gaps as implemented features.

## Small connectors and explicit concurrency evidence

Added Notion data-source and Discord channel readers behind the existing source interface. Connections are server-configured, resource-fixed and ontology-allowlisted; tokens are omitted from documents and logical backups. Pagination, response sizes, timeouts and record counts are bounded. Errors leave graph/checkpoints unchanged. These readers retain records absent from later fetches because missing permissions and mutable pagination do not prove deletion. No live account was configured; verification uses protocol fixtures plus real FalkorDB/API sync.

Added evidence for the intended single-server multi-agent use: two simultaneous edits with the same scenario version yield one success and one conflict; separate branches remain isolated and can promote independent properties; a fresh store/service can read the persisted branch. These are API client concurrency tests, not a demonstration of two live models or distributed workers.

Observed local verification: 70 unit/integration tests and nine Chromium browser tests pass. The preceding operational expansion commit passed both CI jobs, including real Docker Compose startup/seed/demo. This connector commit requires its own CI verification.

The new status document lists gaps and performance bottlenecks without conflating endpoint coverage with maturity. The blog plan focuses on measured native graph queries and revision/overlay tradeoffs. It does not claim database-native MVCC, persistent tree structures, GPU acceleration, or a measured speedup from unrun experiments.
