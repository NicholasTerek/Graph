# Developing on Graph

The source SDK is in `packages/sdk`. The platform runs at `http://127.0.0.1:3001`; `/api/docs/` is an interactive reference and `/api/openapi.json` is the machine-readable specification. JSON request bodies are validated with Zod. The GPU application in `examples/semiconductor/app` imports the SDK and domain result types only; it has no database access.

## Read, query, and edit

```ts
import { GraphClient, GraphApiError } from '@graph/sdk';

const client = new GraphClient('http://127.0.0.1:3001');
const schema = await client.ontology('semiconductor');
const page = await client.objects(schema.id, { type: 'Supplier', limit: 20 });
const next = page.nextCursor
  ? await client.objects(schema.id, { type: 'Supplier', limit: 20, after: page.nextCursor })
  : null;
const dependencies = await client.traverse(schema.id, 'aquila-x900', 3, 'out');
const supplyEdges = await client.relationships(schema.id, { type: 'SUPPLIED_BY' });
```

Collections return `{ items, nextCursor, limit }`, ordered by ID. Limits are 1–100 (default 50); `after` is exclusive. Object lists support `type` and case-insensitive `q` search across IDs, types, and property values. Relationship lists support `type`, `from`, and `to`.

`PUT` replaces the full object record; `PATCH` merges named properties and preserves unspecified fields. A live patch accepts `expectedRevision` for optimistic concurrency. The graph response includes `revision` and an ETag header; a successful patch returns `{ object, revision }`. All structural/property validation runs before mutation.

```ts
const graph = await client.snapshot(schema.id);
await client.patchObject(schema.id, 'meridian', {
  properties: { leadDays: 8 },
  expectedRevision: graph.revision,
});
```

## Branch and evaluate

```ts
const graph = await client.snapshot('semiconductor');
let branch = await client.createScenario('semiconductor', {
  id: 'investigate-packaging',
  name: 'Alternative supplier takes 14 days',
  expectedRevision: graph.revision,
});
branch = await client.patchScenarioObject('semiconductor', branch.id, 'meridian', {
  properties: { leadDays: 14 },
  expectedVersion: branch.version,
});
const run = await client.runFunction('semiconductor', 'launch-readiness', {
  productId: 'aquila-x900',
}, branch.id);
const diff = await client.scenarioDiff('semiconductor', branch.id);
```

`runFunction` without a scenario reads a consistent live view. With a scenario, it evaluates the pinned base plus its overlay. Run records retain the revision, scenario ID/version, timestamp, input, and validated output. Function input and output JSON schemas are returned by `client.functions(ontology)`.

Use `editScenario` for generic batches: `objects`, `relationships`, `removeObjects`, and `removeRelationships`, plus `expectedVersion`. Upserts merge into the overlay; removed IDs become tombstones. An upsert clears the corresponding tombstone. Removing an object while leaving attached relationships is rejected. Removing and upserting the same ID in one edit is rejected. The entire resulting graph is validated before saving one new overlay version.

Use `scenarioGraph` to inspect the materialized graph and `discardScenario` to remove a branch. There is no implicit live mutation and no promotion endpoint yet. A stale branch remains readable and evaluable; its diff reports `stale: true` and the current live revision.

## Register a domain function

Domain logic runs in a trusted server extension, not as uploaded source code. It receives a generic read-only graph interface (`object`, `objects`, and `related`). Register the definition in the server's `functions` option at composition time.

```ts
import { z } from 'zod';
import { defineFunction } from '@graph/core';

const countBooks = defineFunction({
  id: 'count-books', name: 'Count books', description: 'Library inventory',
  ontology: 'library', input: z.object({}), output: z.object({ count: z.number() }),
  execute: ({ graph }) => ({ count: graph.objects('Book').length }),
});
```

The same extension mechanism runs the semiconductor recovery planner and an unrelated library function in integration tests. Schemas describe reusable capabilities; no GPU types live in the core.

## Errors

| HTTP status | Code | Meaning |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Invalid request schema; inspect `issues` |
| 400 | `BAD_REQUEST` | An invalid operation, such as mismatched IDs |
| 404 | `NOT_FOUND` | Missing ontology, object, scenario, or function |
| 409 | `CONFLICT` | Stale revision/version, duplicate branch, or incompatible schema |
| 422 | `DOMAIN_VALIDATION_ERROR` | Property, endpoint, or function constraint violation |
| 500 | `INTERNAL_ERROR` | Database or server implementation failure |

Responses include `requestId`; the `x-request-id` header carries the same ID. `GraphApiError` preserves status, code, request ID, and validation issues. The initial platform is a trusted local single-process service; it does not claim multi-replica transactional semantics, automatic entity resolution, or production authorization.
