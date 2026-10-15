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
