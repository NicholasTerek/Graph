# Graph

A self-hosted operational ontology platform powered by **FalkorDB**, with a synthetic semiconductor operations example. Define your own object types and relationships, ingest records with provenance, and investigate dependencies across connected operations.

**Status: first working foundation.** The registry, graph APIs, JSON ingestion, TypeScript SDK, and interactive explorer are implemented. Scenario overlays, business functions, agent orchestration, and action approvals are planned, not implemented.

## Run locally

Requires Docker with Compose v2. All published ports bind to localhost. This is a trusted local workspace without authentication; keep it local.

```sh
docker compose up --build -d
docker compose exec app node --import tsx scripts/seed.ts
```

Open **http://localhost:3001**. Select Aquila Semiconductor, click an object, and trace its dependencies. Switch to City Library to explore a completely different ontology using the same core and APIs. Use **Ontology registry** to inspect schemas, the upload icon beside **Ontologies** to register a JSON schema, and **Import data** to load a JSON dataset.

FalkorDB data persists in the `graph-data` Docker volume with append-only persistence enabled. `docker compose down` preserves it. Re-running the seed replaces example records by stable ID; it does not duplicate them.

### Development

Requires Node.js 22+ and pnpm 11.25.0.

```sh
npm install --global pnpm@11.25.0
pnpm install --frozen-lockfile
docker compose up -d falkordb
pnpm dev
```

In another terminal:

```sh
pnpm seed
```

Open the Vite URL shown in the terminal (normally http://localhost:5173). Vite proxies `/api` to port 3001. For a production frontend without Docker, run `pnpm build` then `pnpm start` and open http://localhost:3001.

Configuration: `FALKORDB_HOST`, `FALKORDB_PORT`, optional `FALKORDB_PASSWORD`, `GRAPH_NAME`, `PORT`, `HOST`. `.env.example` documents defaults; export variables in your shell or use Node's `--env-file=.env` when starting the server. Seed scripts accept `API_URL`.

## What works

- Runtime ontology registration, introspection, and strict property validation.
- Generic object replacement, relationship creation, reads, and explicit deletion APIs.
- Replayable JSON ingestion with source identity, external ID, and observation timestamp on every record.
- Server-side, directed Cypher traversal with a configurable depth of 1–5.
- A generic interactive relationship map, object inspector, schema browser, search, and uploads.
- Two independent example ontologies loaded through the public TypeScript SDK and HTTP API.

## Architecture

```text
apps/api             Fastify HTTP boundary and server lifecycle
apps/web             React + Vite + React Flow management UI
packages/contracts   Zod schemas and shared TypeScript types
packages/core        Domain-independent validation and FalkorDB queries
packages/sdk         HTTP client used by the UI and ingestion scripts
examples             Ontologies and synthetic datasets, outside the core
scripts              Public-API seed workflow and fixture generation
```

FalkorDB is the operational source of truth. Schema metadata is stored in `Ontology` nodes, objects in `Object` nodes, and relationships as real `LINK` edges. Domain type names are validated metadata rather than interpolated Cypher labels. Every object is scoped by `(ontology, id)`; relationship IDs are unique within an ontology through the serialized write path. Range indexes support ontology and object lookups.

The initial representation stores validated properties and provenance as JSON records alongside indexed identity/type fields. This keeps arbitrary property names out of query construction. Property-level filtering and indexing are future work; current graph operations use structural Cypher traversals, not property predicates over the JSON payload.

### Graph model and essential query

Aquila X900 requires an advanced package supplied by a delayed vendor. It also needs a software release blocked by a driver issue and a failed validation test. Its launch connects to synthetic customer commitments. These are actual edges persisted in FalkorDB, not a frontend-only diagram.

The explorer uses the following pattern (the depth is a validated integer, capped at five):

```cypher
MATCH p=(root:Object {ontology: $ontology, id: $root})-[:LINK*1..3]->(target:Object {ontology: $ontology})
UNWIND nodes(p) AS n
WITH DISTINCT n
RETURN n.record AS record
ORDER BY n.id
```

The API then retrieves relationships between the returned objects to show the induced subgraph. Direction controls discovery; the displayed subgraph includes all edges between discovered objects. Without FalkorDB, the registry, ingestion, explorer, and traversals cannot run.

## Public API

| Method | Route | Purpose |
|---|---|---|
| GET | `/api/health` | Verify a real FalkorDB query |
| GET / POST | `/api/ontologies` | List / register schemas |
| GET | `/api/ontologies/:ontology` | Read a schema |
| GET | `/api/ontologies/:ontology/graph` | Read objects and relationships |
| POST | `/api/ontologies/:ontology/ingest` | Validate and upsert a JSON batch |
| GET / PUT / DELETE | `/api/ontologies/:ontology/objects/:id` | Read / replace / delete an object |
| PUT / DELETE | `/api/ontologies/:ontology/relationships/:id` | Upsert / delete a relationship |
| GET | `/api/ontologies/:ontology/traverse?root=ID&depth=3&direction=out` | Bounded traversal (`out`, `in`, `both`) |

See `examples/library/ontology.json` and `data.json` for the smallest complete schema and ingestion format. Object and relationship IDs must start with a letter and contain only letters, digits, underscores, and hyphens, up to 64 characters. Ontology definitions are immutable in this milestone; a different schema under an existing ID returns HTTP 409. Exact registration replays are accepted.

Batches are fully validated before a single Cypher write query. Invalid endpoints or properties reject the whole batch. Object types and relationship endpoints cannot be changed in place. Object deletion rejects connected nodes; remove their relationships explicitly first. Upserts replace the entire record, including its provenance, rather than keeping historical versions.

## Verification

```sh
pnpm build
pnpm test
pnpm test:integration
pnpm exec playwright install chromium
pnpm test:browser
```

Integration and browser checks require FalkorDB on the configured address. Unit tests run without it; integration tests are opt-in with `GRAPH_INTEGRATION=1`. Tests use disposable, uniquely named graphs and delete only those graphs. CI runs the build, unit tests, real FalkorDB integration tests, and browser checks.

See [development log](docs/development.md) for observed verification results and limitations. No performance claims are made yet.

## Next milestones

1. Register deterministic business functions and return evidence with their results.
2. Add isolated scenario overlays with a pinned base revision and explicit object/edge diffs.
3. Calculate launch recovery alternatives from graph data, then show recommendations changing with assumptions.
4. Add a tool-calling agent and a reviewed GitHub action with approval and audit records.
5. Benchmark, polish the demo, and write the engineering article.

The first milestone is deliberately one API process. Mutations are serialized within that process; direct database writes and multiple API replicas are unsupported. Snapshot reads are not database-wide revision snapshots. Traversal and full-graph reads target small demonstration graphs; pagination, path-explosion protection beyond depth/time limits, multi-source entity resolution, checkpointed connectors, authentication, and production governance are not implemented.

## Graph Hacks 2026

Target tracks: **Company Brain** and **Agents That Act on Connected Data**. The latter requires the planned agent and approved action workflow before it is a credible submission. Official rules: https://www.wemakedevs.org/hackathons/falkordb/rules

Development uses AI coding assistance (OpenAI Codex) for implementation and verification. Participants remain responsible for reviewing and understanding the submitted system. This disclosure is independent of commit authorship.

All included business data is synthetic. No real employer data is included. This is an implementation of established operational ontology concepts, not a claim to have invented them.

Project code is MIT licensed; dependencies retain their own licenses. FalkorDB server is distributed separately under SSPLv1.
