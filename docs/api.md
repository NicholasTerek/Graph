# Developing on Graph

The source SDK is in `packages/sdk`. The platform runs at `http://127.0.0.1:3001`; `/api/docs/` is an interactive reference and `/api/openapi.json` is the machine-readable specification. JSON request bodies are validated with Zod. The GPU application in `examples/semiconductor/app` imports the SDK and domain result types only; it has no database access.

## Read, query, and edit

```ts
import { GraphClient, GraphApiError } from "@graph/sdk";

const client = new GraphClient("http://127.0.0.1:3001");
const schema = await client.ontology("semiconductor");
const page = await client.objects(schema.id, { type: "Supplier", limit: 20 });
const next = page.nextCursor
  ? await client.objects(schema.id, {
      type: "Supplier",
      limit: 20,
      after: page.nextCursor,
    })
  : null;
const dependencies = await client.traverse(schema.id, "aquila-x900", 3, "out");
const supplyEdges = await client.relationships(schema.id, {
  type: "SUPPLIED_BY",
});
```

Collections return `{ items, nextCursor, limit }`, ordered by ID. Limits are 1–100 (default 50); `after` is exclusive. Object lists support `type` and case-insensitive `q` search across IDs, types, and property values. Relationship lists support `type`, `from`, and `to`.

`PUT` replaces the full object record; `PATCH` merges named properties and preserves unspecified fields. A live patch accepts `expectedRevision` for optimistic concurrency. The graph response includes `revision` and an ETag header; a successful patch returns `{ object, revision }`. All structural/property validation runs before mutation.

```ts
const graph = await client.snapshot(schema.id);
await client.patchObject(schema.id, "meridian", {
  properties: { leadDays: 8 },
  expectedRevision: graph.revision,
});
```

## Branch and evaluate

```ts
const graph = await client.snapshot("semiconductor");
let branch = await client.createScenario("semiconductor", {
  id: "investigate-packaging",
  name: "Alternative supplier takes 14 days",
  expectedRevision: graph.revision,
});
branch = await client.patchScenarioObject(
  "semiconductor",
  branch.id,
  "meridian",
  {
    properties: { leadDays: 14 },
    expectedVersion: branch.version,
  },
);
const run = await client.runFunction(
  "semiconductor",
  "launch-readiness",
  {
    productId: "aquila-x900",
  },
  branch.id,
);
const diff = await client.scenarioDiff("semiconductor", branch.id);
```

`runFunction` without a scenario reads a consistent live view. With a scenario, it reads the native graph selected by the scenario version. Run records retain the revision, scenario ID/version, timestamp, input, and validated output. Function input and output JSON schemas are returned by `client.functions(ontology)`.

Use `editScenario` for generic batches: `objects`, `relationships`, `removeObjects`, and `removeRelationships`, plus `expectedVersion`. Edits prepare an independent native graph candidate and publish its pointer after validation. Removing an object while leaving attached relationships is rejected. Removing and upserting the same ID in one edit is rejected. The entire resulting graph is validated before publishing one new branch version.

Use `scenarioGraph` to inspect the materialized graph and `discardScenario` to remove a branch. Live changes require an explicit promotion review and selected-change confirmation; see the promotion endpoints below. A stale branch remains readable and evaluable; its diff reports `stale: true` and the current live revision.

## Register a domain function

Domain logic runs in a trusted server extension, not as uploaded source code. It receives a generic read-only graph interface (`object`, `objects`, and `related`). Register the definition in the server's `functions` option at composition time.

```ts
import { z } from "zod";
import { defineFunction } from "@graph/core";

const countBooks = defineFunction({
  id: "count-books",
  name: "Count books",
  description: "Library inventory",
  ontology: "library",
  input: z.object({}),
  output: z.object({ count: z.number() }),
  execute: ({ graph }) => ({ count: graph.objects("Book").length }),
});
```

The same extension mechanism runs the semiconductor recovery planner and an unrelated library function in integration tests. Schemas describe reusable capabilities; no GPU types live in the core.

## Errors

| HTTP status | Code                      | Meaning                                                          |
| ----------- | ------------------------- | ---------------------------------------------------------------- |
| 400         | `VALIDATION_ERROR`        | Invalid request schema; inspect `issues`                         |
| 400         | `BAD_REQUEST`             | An invalid operation, such as mismatched IDs                     |
| 404         | `NOT_FOUND`               | Missing ontology, object, scenario, or function                  |
| 409         | `CONFLICT`                | Stale revision/version, duplicate branch, or incompatible schema |
| 422         | `DOMAIN_VALIDATION_ERROR` | Property, endpoint, or function constraint violation             |
| 500         | `INTERNAL_ERROR`          | Database or server implementation failure                        |

Responses include `requestId`; the `x-request-id` header carries the same ID. `GraphApiError` preserves status, code, request ID, and validation issues. The initial platform is a trusted local single-process service; it does not claim multi-replica transactional semantics, automatic entity resolution, or production authorization.

## Source synchronization

```ts
await client.registerSource("semiconductor", {
  id: "packaging-feed",
  name: "Packaging CSV",
  connector: "csv",
  mapping: {
    type: "Supplier",
    idField: "id",
    objectIdField: "id",
    properties: {
      leadDays: { field: "leadDays" },
      dailyCapacity: { field: "capacity" },
    },
  },
});
const preview = await client.syncSource("semiconductor", "packaging-feed", {
  content: csv,
  dryRun: true,
});
await client.syncSource("semiconductor", "packaging-feed", {
  content: csv,
  expectedCheckpoint: preview.checkpoint,
  expectedRevision: (await client.snapshot("semiconductor")).revision,
});
```

For existing objects, mapped fields merge with existing properties. Newly created objects must satisfy all required ontology properties. Mappings support `field` or literal `value`; optional `identityField` resolves explicitly shared identities across sources. `objectIdField` binds a record to an existing platform identifier. Property types drive CSV conversion.

`/sources/:id/runs` retains successful and failed sync results. `/objects/:id/history` retains before/after states, including deleted records. `/objects/:id/provenance` combines the current record source with contributing external-ID mappings and historical changes. Source snapshots detect manual field changes/deletions rather than overwriting them. Missing records only delete source-created, unlinked, unextended objects without another contributor.

## Typed property queries and indexes

```ts
await client.createPropertyIndex("semiconductor", "Supplier", "leadDays");
const suppliers = await client.queryObjects("semiconductor", {
  type: "Supplier",
  filters: [{ property: "leadDays", operator: "gte", value: 14 }],
});
const capacity = await client.aggregate("semiconductor", {
  type: "Supplier",
  property: "dailyCapacity",
  operation: "sum",
});
```

Predicates support `eq`, `ne`, `gt`, `gte`, `lt`, `lte`, and string `contains`. Values are bound parameters; property names and types are checked against the ontology. Object nodes carry native `p_` properties alongside their validated JSON records. Filtered queries run in Cypher; aggregate results are computed from the filtered rows inside a consistent API write-queue boundary. This is a small-graph implementation, not a distributed analytics engine.

## Selective scenario promotion

```ts
const review = await client.reviewScenario("semiconductor", scenario.id);
await client.promoteScenario("semiconductor", scenario.id, {
  expectedVersion: review.version,
  expectedRevision: review.liveRevision,
  objects: ["meridian"],
  relationships: [],
  confirm: true,
});
```

Promotion requires `write` and `approve` scopes. The three-way comparison detects conflicting edits to the same property, preserves independent live edits, and validates the resulting graph. Select only IDs present in the scenario diff; stale review versions/revisions fail with 409. There is no automatic branch rebase or distributed merge transaction.

## Reviewed actions

```ts
const proposal = await client.proposeAction("semiconductor", {
  type: "github-recovery-issue",
  input: { runId: run.id },
  idempotencyKey: "recovery-task-for-this-run",
  scenario: scenario.id,
});
```

A reviewer inspects `prepared.target`, `prepared.title`, `prepared.description`, and `digest`. `reviewAction` requires approval scope. `executeAction` separately requires execution scope and the approved version/digest. Execution revalidates the live revision and any scenario version. Reusing a proposal key with another input is rejected. A repeated succeeded execution returns its stored result; uncertain outcomes require reconciliation, not another POST. No action is approved or executed by the agent.

## Investigations

`client.investigate(ontology, { question, root, functionId, input, scenario, maxSteps })` records discovery, graph evidence, calculations, and proposals. With no model, `functionId` and `input` drive explicitly labeled deterministic tools. With a configured model, the model selects from a fixed tool registry. It cannot call arbitrary endpoints or approve/execute/promote. Investigations cannot finish successfully without an actual calculation run.

`client.investigations` lists persisted traces. Historical summaries can provide context to later investigations; they do not replace reading current state. `client.functionRun` reads the structured calculation behind a recommendation. Model prose remains untrusted; use the calculation and evidence records for numbers.

## Authentication, packaging, and errors

Pass a static token or callback as the SDK's third constructor argument: `new GraphClient(baseUrl, fetch, { token })`. The callback can return `undefined` for a local owner session. The client safely invokes native browser fetch and preserves status, error code, request ID, and validation issues.

Additional errors: HTTP 401 `UNAUTHORIZED` for missing/invalid credentials; HTTP 403 `FORBIDDEN` for scope, ontology, Host, or Origin violations. Read, write, approval, execution and admin capabilities are separate; a broad `write` grant does not authorize external execution.

`pnpm build:sdk` emits JS/declarations, and `pnpm --dir packages/contracts pack` / `pnpm --dir packages/sdk pack` create local installable packages. `node scripts/verify-packages.mjs` verifies them in an independent consumer. No npm publication has been performed.

## Native graphs and algorithms

Scenarios now use native FalkorDB graphs, with a compatibility overlay derived on individual metadata reads. See [native storage and recovery](native-graphs.md) for publication, migration and portable backup behavior. `client.algorithms(ontology)` discovers bounded native operations; `client.runAlgorithm(ontology, {algorithm: "pagerank", scenario: "my-scenario"})` runs one. Supported IDs: `shortest-path`, `pagerank`, `betweenness`, `degree`. Algorithm routes require read scope and enforce ontology restrictions. Results include live/base revision, scenario version, parameters and algorithm evidence.

## Explain a calculation

`client.explain(ontology, {root, targets?, runId?, scenario?, maxDepth?})` returns revision-bound claims, native directed paths, object/edge evidence and source checkpoints. New runs retain bounded immutable read sets; old stale runs without captured evidence explicitly omit historical paths. See [evidence semantics](explainability.md). The route uses read scope.

## Historical state and read pins

`client.stateAt(ontology, {revision? , at?, snapshot?, generation?})` selects one committed native visibility context. `client.commits` lists commit metadata; `createReadSnapshot`/`releaseReadSnapshot` manage principal-owned leases for repeatable reads. Routes require read scope. Restores invalidate old generation contexts; reviewed version vacuum protects active pins, while full-history backup remains unimplemented. See [temporal semantics](temporal.md).

### Retention status and reviewed vacuum

`client.historyStatus(ontology)` (`GET /history`) returns the generation, current revision, oldest retained revision and active snapshot count/oldest pin. `client.vacuum(ontology, input)` (`POST /vacuum`) requires admin scope. Preview with `generation`, `expectedRevision`, `retainFrom` and optional bounded `batchSize`. Its watermark accounts for active read pins. Apply requires the returned `digest`, `dryRun: false` and `confirm: true`; a changed plan returns 409. Each batch requires a fresh preview. See [the vacuum contract](vacuum.md) for exact eligibility and restore/branch limits.

### Branch backend choice

`client.createScenario(ontology, {id, name, strategy?: "copy" | "overlay"})` defaults to copy. Overlay branches store a native history-generation/base pin and native deltas. Existing graph/edit/diff/function/explain/review/promote/discard routes work with either. Whole-graph overlay algorithms include temporary projection cost; restored portable branches use copy storage. See [semantics](native-overlays.md) and [measurements](branch-study.md).
