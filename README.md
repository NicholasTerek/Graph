# Graph

A self-hosted operational ontology platform powered by **FalkorDB**, with an interactive GPU launch-recovery application built on its public TypeScript SDK.

Connect disconnected operational records, investigate dependencies, calculate recovery alternatives, branch hypothetical state, review changes, and prepare approved actions. The core is domain-independent; semiconductor types, scheduling logic, UI, and GitHub action live under `examples/semiconductor`.

**Current scope:** a tested single-process prototype with real graph persistence, repeatable source sync, a deterministic business-function runtime, scenario promotion, bounded agent tools, reviewed actions, and an operations console. This is not a feature-complete replacement for Palantir Foundry or Helix Foundry.

## Run

Requires Docker with Compose v2:

```sh
docker compose up --build -d
docker compose exec app node --import tsx scripts/seed.ts
```

Open **http://localhost:3001**. Choose **Aquila Semiconductor → Launch operations**.

1. With Meridian lead time at **7 days**, the model recommends Meridian packaging and driver repair.
2. Change its lead time to **14 days**, then **Evaluate scenario**. The recommendation changes to expedited Northstar.
3. Change driver repair to **20 days** to select the compatible, previously validated fallback driver.
4. Expand **Inventory & qualification constraints** to vary demand, capacity, or qualification. Inspect the critical-path timeline and failed constraints.
5. Run an investigation, prepare a GitHub recovery issue, or review selected scenario changes for live promotion.
6. Open **Operations console** for source sync, approvals, investigation history, and backups.

All business records and costs are synthetic. The seed registers a packaging CSV feed, a driver JSON feed, and a public GitHub repository reader. It synchronizes only the bundled files; GitHub reads remain an explicit sync operation. Re-running the seed resets demo records to their supplied values and reuses stable identities.

FalkorDB uses append-only persistence in the `graph-data` volume. Published ports bind to localhost. `docker compose down` preserves data; do not add `-v` unless you intend to remove it.

## Implemented capabilities

| Area             | Implemented                                                                                                                                                         |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ontology         | Runtime registration; typed scalar properties and endpoints; safe additive schema changes                                                                           |
| Graph API        | CRUD, partial edits, cursor lists, native property predicates, aggregates, property indexes, bounded Cypher traversal                                               |
| Ingestion        | CSV/JSON snapshots, public GitHub repository/issues, Notion data-source and Discord channel readers; deterministic mappings and optional cross-source identity keys |
| Sync correctness | Preview, checksum binding, checkpoints, safe deletions, no-op replay, detection of manual changes, atomic graph/history/checkpoint writes                           |
| Provenance       | Current source metadata, historical before/after records, and contributing source mappings                                                                          |
| Business logic   | Typed deterministic extensions, read-only graph views, discoverable schemas, persisted calculation runs                                                             |
| Scenarios        | Native FalkorDB base/branch graphs via GRAPH.COPY, object/edge diffs, version checks, selective three-way promotion                                                 |
| Agent            | Bounded tool loop through the public SDK; optional compatible model; explicit deterministic mode without a model; recorded traces and historical summaries          |
| Actions          | Typed proposals, exact review digest, approval/rejection, separate execution, idempotency, failure records, uncertain-outcome reconciliation                        |
| Operations       | Scoped API tokens, ontology restrictions, host/origin checks, backup/restore, health diagnostics, request metrics, distributable SDK/contracts                      |

The agent has **no approval, execution, or promotion tool**. Its internal API credential has read/write scopes only. A human must review the target and contents before an external action can execute.

## Real integrations and credentials

Notion data-source properties and Discord channel messages can also be read using named, ontology-restricted server connections. See [connector setup and limits](docs/connectors.md). These readers are add/update only, explicit syncs; a missing record does not establish remote deletion. Neither was tested against a live account during development.

### GitHub reads and actions

Source connectors read public GitHub data without sending credentials. Pull requests are excluded from issue imports. Pagination limits reject incomplete snapshots rather than deleting records based on partial data.

To enable actual issue creation, set these server variables in a local `.env` file before rebuilding/restarting the app:

```dotenv
GRAPH_ACTION_REPOSITORY=your-account/your-demo-repository
GITHUB_TOKEN=your-repository-scoped-token
```

The token needs issue-write access to the configured demonstration repository. Proposals display the exact repository, title, body, graph revision, and review digest. Approval does not execute anything. The operations console has a separate **Execute approved action** button.

Without a token, execution reports a clear failure. Ambiguous network outcomes become `uncertain`; reconciliation searches for the action's unique issue marker. The system does not promise exactly-once delivery and does not blindly retry an uncertain POST. Definite failures require a newly reviewed proposal after correcting the cause. No real GitHub issue was created during development verification; the external execution path is tested against a controlled HTTP fixture.

### Optional local or hosted model

No model is required for graph operations, calculations, or deterministic investigation. Without one, the UI explicitly labels investigation as **deterministic tool orchestration**.

To use a model supporting Chat Completions function calls:

```dotenv
GRAPH_AGENT_BASE_URL=http://ollama:11434/v1
GRAPH_AGENT_MODEL=qwen3:4b
GRAPH_AGENT_API_KEY=
```

The optional local model service is separate from the default stack:

```sh
docker compose --profile local-ai up -d ollama
docker compose exec ollama ollama pull qwen3:4b
docker compose --profile local-ai up --build -d app
```

For another compatible provider, configure its HTTPS base URL, model, and server-side key. Ollama's compatibility reference is https://docs.ollama.com/api/openai-compatibility. The adapter and tool loop are tested with controlled model responses; a live language model was not available during verification. Calls are bounded by a 60-second investigation timeout and at most 16 tool invocations. Models must support the supplied tool schemas; model quality is not guaranteed.

## Historical reads

Launch operations includes a revision scrubber that recalculates the GPU plan from a pinned read-only snapshot. Native object and relationship visibility runs in Cypher; snapshot leases preserve one generation/revision across reads. Restores establish a new history generation. See [temporal semantics and limits](docs/temporal.md). Reviewed watermark-based vacuum is available in Operations → History & retention. Opt-in revision/overlay branches pin their base and store native deltas; full-history backup remains separate work. See the [branch strategy measurements](docs/branch-study.md).

## Explain decisions

Launch operations includes **Explain this recommendation**: saved calculation rules, native dependency paths, record provenance, source checkpoints and overridden values. Evidence retains its original context after live or branch changes. See [explainability semantics](docs/explainability.md).

## Access control

By default, loopback requests act as `local-owner`. To require credentials, configure `GRAPH_API_TOKENS` as a JSON array in the server environment. Each entry contains `name`, a secret `token` of at least 24 characters, `scopes`, and optional `ontologies`.

Supported scopes: `read`, `write`, `approve`, `execute`, and `admin`. Promotion requires write and approval; restore and index creation require admin. Invalid credentials never fall back to local-owner access. Restricted credentials cannot list or access other ontologies.

The UI's **API access** control stores an entered token for the browser session. CLI scripts use `GRAPH_API_TOKEN`. Swagger UI supports bearer authorization. Credentials belong in local configuration, not source records or git.

Host and Origin checks protect the local workspace. Non-loopback hosting requires explicit `GRAPH_ALLOWED_HOSTS` and `GRAPH_ALLOWED_ORIGINS` configuration and an appropriately secured deployment. These controls are a small prototype permission model, not enterprise RBAC, SSO, or property-level governance.

## Development

Requires Node.js 22+ and pnpm 11.25.0; verification uses Node.js 24.

```sh
npm install --global pnpm@11.25.0
pnpm install --frozen-lockfile
docker compose up -d falkordb
pnpm dev
```

In a separate terminal, run `pnpm seed`, then open http://localhost:5173. Vite proxies `/api` to port 3001. For a built frontend, `pnpm build && pnpm start` serves http://localhost:3001.

Configuration defaults are listed in `.env.example`. Export variables in your shell or use Node's `--env-file` option when starting locally; Docker Compose consumes `.env`. Database configuration includes `FALKORDB_HOST`, `FALKORDB_PORT`, optional `FALKORDB_PASSWORD`, and `GRAPH_NAME`. Scripts accept `API_URL` and `GRAPH_API_TOKEN`.

## Public API and SDK

- Interactive reference: **http://localhost:3001/api/docs/**
- OpenAPI: **http://localhost:3001/api/openapi.json**
- Developer guide: [docs/api.md](docs/api.md)
- Operations guide: [docs/operations.md](docs/operations.md)
- Benchmarks: [docs/benchmarks.md](docs/benchmarks.md)

```ts
import { GraphClient } from "@graph/sdk";

const graph = new GraphClient("http://127.0.0.1:3001", fetch, {
  token: process.env.GRAPH_API_TOKEN,
});
const baseline = await graph.snapshot("semiconductor");
let scenario = await graph.createScenario("semiconductor", {
  id: "supplier-investigation",
  name: "Alternative takes 14 days",
  expectedRevision: baseline.revision,
});
scenario = await graph.patchScenarioObject(
  "semiconductor",
  scenario.id,
  "meridian",
  {
    properties: { leadDays: 14 },
    expectedVersion: scenario.version,
  },
);
const result = await graph.runFunction(
  "semiconductor",
  "launch-readiness",
  {
    productId: "aquila-x900",
  },
  scenario.id,
);
```

Run the same workflow with `pnpm demo` or `docker compose exec app node --import tsx scripts/launch-demo.ts`. It asserts that changing an assumption changes the recommendation while leaving live state untouched.

`pnpm build:sdk` creates independent JavaScript and declaration outputs for `@graph/contracts` and `@graph/sdk`. `node scripts/verify-packages.mjs` packs both, installs them into a separate consumer, and exercises the public imports. The packages have not been published to npm.

## Architecture and guarantees

```text
apps/api                 HTTP, validation, scopes, composition and local server
apps/web                 Generic explorer and operations console
packages/contracts       Zod schemas and shared public types
packages/core            Graph storage, sources, scenarios, functions, actions
packages/sdk             Public HTTP client
packages/agent           Tool orchestration using the SDK, without database access
examples/semiconductor   GPU schema, sources, planner, actions and application
```

FalkorDB is the operational source of truth. `Ontology` nodes store schemas and revisions; `Object` nodes store stable scoped identities, typed native properties, and validated records; `LINK` edges represent actual domain relationships. `Document` nodes retain checkpoints, historical records, native scenario references, calculation runs, actions, and investigation traces. Domain property predicates bind values as parameters and use validated property names; there is no arbitrary Cypher execution endpoint.

A live change, its before/after history, and associated checkpoint/audit documents are submitted in one Cypher write query. Mutations and consistent-state capture are serialized within one API process. Direct database writes, multiple API replicas, and distributed transactions are unsupported.

Scenarios default to isolated native FalkorDB graphs. Set `strategy: "overlay"` when creating a scenario to use native revision/overlay storage instead. The first branch projects an ontology-only immutable base; siblings fork it with `GRAPH.COPY`. Edits prepare a copied candidate, apply native graph changes and publish a versioned pointer after validation. Promotion still merges selected changes against live state and rejects conflicts. This is a full-copy design with single-writer publication, not zero-copy branching or database-native MVCC. [Native storage, algorithms, migration and recovery](docs/native-graphs.md) describes exact costs and guarantees.

Shortest path, PageRank, sampled betweenness centrality and degree are exposed through the API, SDK and agent tools. Scenario algorithms run directly against the native graph; live algorithms currently build a temporary ontology projection. Scores describe topology, not GPU launch risk.

The GPU planner calculates missing inventory and production duration, checks supplier/component qualification, capacity and driver compatibility, then schedules repair, pre-validation, hardware-dependent tests, and final integration using a DAG longest-path calculation. It returns task timing, critical paths, constraint results, costs, and source evidence. Capacity is reserved for one product; yield, competing orders, shipping variability, advanced optimization, and stochastic forecasts remain outside the model. Predicted validation completion is not an actual passing test.

## Verification

```sh
pnpm build
GRAPH_INTEGRATION=1 pnpm test
pnpm exec playwright install chromium
pnpm test:browser
node scripts/verify-packages.mjs
pnpm doctor:graph
pnpm benchmark
```

Integration/browser tests require FalkorDB and use disposable graphs. Unit tests run without a database. CI verifies the build, packaged client, real FalkorDB behavior, browser workflows, and Docker Compose setup. [Development log](docs/development.md) records observed results and limitations.

## Remaining work

The [complete engineering backlog](docs/TODO.md) tracks every original requirement and the added explainability, native branching, temporal/MVCC-style visibility, correctness, performance and UI work. It separates implemented baseline behavior from unimplemented goals.

The [engineering status](docs/status.md) distinguishes implemented mechanisms, tested evidence, and missing production work, including the exact versioning/multi-agent guarantees. The [article plan](docs/blog-plan.md) defines the performance and versioned-scenario experiments needed before publishing claims.

This implements the six requested next steps at prototype scope. Remaining platform work includes richer ontology types and cardinality, distributed write coordination, production governance, large-source ingestion and resumable workers, richer entity-resolution policies, temporal retention and full-history backups, nested/rebased branches, approval revocation/expiry, and production-grade backup retention. Model-backed investigation and authenticated GitHub execution still need verification in the operator's configured environment. A complete Foundry or Helix Foundry port is not claimed.

## Graph Hacks 2026

Target tracks: **Company Brain** and **Agents That Act on Connected Data**. Official rules: https://www.wemakedevs.org/hackathons/falkordb/rules

AI coding assistance (OpenAI Codex) is used for implementation and verification. Participants remain responsible for reviewing and understanding the system. This disclosure is independent of commit authorship.

All included business data is synthetic. No confidential employer information is used. Operational ontology concepts are established ideas, not a claim of conceptual novelty. Project code is MIT licensed; dependencies retain their own licenses. FalkorDB server is distributed separately under SSPLv1.

For measured engineering evidence, see the [aggregate before/after study](docs/performance-study.md), [concurrent-history checker](docs/concurrency-checker.md) and [versioning implementation draft](docs/versioning-notes.md).

[Native overlay semantics](docs/native-overlays.md) and the [copy/overlay study](docs/branch-study.md) describe the explicit backend choice. Creation is cheaper with overlays; whole-graph algorithms currently pay for temporary projection.

Imported scalar references can become source-owned native relationships through `mapping.relationships`; `pnpm demo:sources` verifies an SDK-only CSV/JSON library import with native paths and historical reads. Operations also shows redacted connection/setup state without probing providers. [Relationship mappings](docs/source-relationships.md) · [Status semantics](docs/source-status.md).
