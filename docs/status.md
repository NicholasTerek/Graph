# Engineering status and evidence

This is a single-server operational ontology prototype. A feature having an endpoint does not establish production readiness. The following separates implemented mechanisms, observed evidence, and missing work.

| Area            | Implemented and tested                                                                                                                                  | Remaining work                                                                                                                                       |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Persistence     | FalkorDB graph records, relationships, history and operational documents; Compose persistence configuration                                             | Crash/power-loss recovery experiments, restore drills and retention policies                                                                         |
| Versions        | Live revision counter; per-record before/after history; shared persisted branch base per revision; sparse overlays                                      | Arbitrary historical graph reads, history retention/GC, nested branches, rebase                                                                      |
| Concurrency     | Single-process serialization; scenario compare-and-set versions; selected three-way promotion; conflicting-property rejection                           | Database-enforced coordination across API replicas; formal isolation spec and fault injection                                                        |
| Multiple agents | Independent API clients can branch, edit, calculate, compare and propose; simultaneous same-version edits reject one writer; independent branches merge | Coordinator, durable task queue, branch ownership, agent-scoped credentials, delegation/cancellation/retry workflows, live multi-model demonstration |
| Sources         | CSV/JSON, public GitHub, bounded Notion and Discord readers; mappings, previews, checkpoints and manual-edit protection                                 | Live Notion/Discord validation, OAuth, scheduler/CDC, richer property types, relationship mappings, large resumable imports                          |
| Functions       | Typed deterministic server extensions; pinned calculation contexts and saved results                                                                    | Bounded graph slices, extension discovery/installation, CPU/resource isolation                                                                       |
| Agents          | Restricted SDK tools and optional compatible provider; protocol fixtures and deterministic mode                                                         | Live model evaluation, answer-quality dataset and workload-specific budgets                                                                          |
| Actions         | Explicit proposal/review/execute states, version binding, idempotency, uncertain-outcome reconciliation                                                 | Live authenticated provider test, approval expiry/revocation, durable executor and additional actions                                                |
| API/access      | Typed SDK/OpenAPI, scoped tokens, ontology restrictions, loopback checks                                                                                | Identity/SSO, per-object governance, online token management, tenant isolation audit                                                                 |
| Performance     | Native property predicates/indexes and native bounded traversal; reproducible small HTTP baseline                                                       | Realistic topology, concurrency/duration, p99, resource metrics, query profiles, write/branch scaling and regression gates                           |
| Analytics       | Filtered object queries and aggregates                                                                                                                  | Native aggregate pushdown (currently paginated to TypeScript), joins/transformation pipelines, analytical snapshot layer                             |
| Product         | Explorer, GPU recovery planner, source/action/investigation operations                                                                                  | Guided onboarding, schema/mapping suggestions and full credential setup UI                                                                           |

## What versioning means here

Each live graph mutation advances a revision. Creating a scenario saves a full JSON base snapshot if that revision has not yet been branched. Sibling scenarios refer to the same stored base. Each scenario stores changed objects/relationships and deletion IDs. Reads materialize base plus overlay in TypeScript. Before/after history is retained separately.

This borrows ideas from snapshot versioning and optimistic concurrency. It is **not database-native MVCC**: readers do not acquire general transaction snapshots, there are no transaction visibility timestamps, no multi-statement snapshot isolation guarantee, and no serializability claim. A single API process serializes coordinated mutations. Two API writers or direct database writes bypass those assumptions and are unsupported. Individual read endpoints, including multi-query traversal, are not automatically atomic across concurrent mutations.

Expected live revisions are optional on some public mutations; clients must supply them when stale-write rejection is required. Scenario edits require an expected branch version. Promotion requires branch version, live revision, selected changes, and explicit confirmation. It compares base, branch, and current live values; independent property edits survive and overlapping changed values conflict. This does not validate business invariants across every combination of independently valid changes; domain validation must cover those invariants.

The first branch at a revision costs a full snapshot. Siblings reuse its stored base but still materialize/validate a full graph when edited or evaluated. Overlays replace whole changed records and are rewritten as one document, rather than using a persistent HAMT/B-tree with path copying. There is no branch history or overlay garbage collector. Branches avoid full database graph clones; that alone does not make branch edits O(changes).

Tests now include simultaneous requests against the same branch (one succeeds and one receives 409), two independent branches merging separate properties, overlapping promotion conflict rejection, live-state isolation, and reading a persisted branch through a fresh store/service instance. These establish useful single-server behavior, not distributed correctness.

## Scope priorities

For the GPU application and a defensible engineering article, prioritize the items below rather than full Helix Foundry parity:

1. Configure a small real source and one real model; demonstrate source → graph evidence → isolated alternatives → reviewed action.
2. Profile actual dependency queries and measure how native traversal scales with graph size/topology and concurrent readers.
3. Remove measured platform bottlenecks: full-state mutation planning, full-state function views, repeated array scans, TypeScript aggregation, and globally serialized consistency work.
4. Measure branch storage, creation, edit, evaluation and promotion costs; improve only the expensive paths and retain conflict tests.
5. Add restart/failure experiments and document exactly what survived and what needed reconciliation.

Distributed deployment, enterprise governance, dozens of connectors, and a general-purpose analytics suite are separate projects. They are not prerequisites for this demonstration.
