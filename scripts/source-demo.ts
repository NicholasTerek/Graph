import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import { GraphClient } from "@graph/sdk";
import { ontologySchema } from "@graph/contracts";
const client = new GraphClient(
  process.env.API_URL ?? "http://127.0.0.1:3001",
  fetch,
  { token: process.env.GRAPH_API_TOKEN },
);
const ontology = `sources-${Date.now()}`;
const schema = JSON.parse(
  await readFile(
    new URL("../examples/library/ontology.json", import.meta.url),
    "utf8",
  ),
);
await client.register(
  ontologySchema.parse({
    ...schema,
    id: ontology,
    name: "SDK source relationship demo",
  }),
);
await client.registerSource(ontology, {
  id: "authors",
  name: "CSV author catalog",
  connector: "csv",
  mapping: {
    type: "Author",
    idField: "row",
    identityField: "key",
    properties: { name: { field: "name" }, status: { value: "active" } },
  },
});
await client.syncSource(ontology, "authors", {
  content: "row,key,name\n1,Alex Rivers,Alex Rivers\n2,Morgan Lee,Morgan Lee\n",
});
await client.registerSource(ontology, {
  id: "books",
  name: "JSON books and author references",
  connector: "json",
  mapping: {
    type: "Book",
    idField: "id",
    objectIdField: "id",
    properties: { name: { field: "name" }, status: { value: "available" } },
    relationships: [
      {
        id: "author",
        type: "WRITTEN_BY",
        target: { type: "Author", identity: { field: "author" } },
      },
    ],
  },
});
const before = await client.snapshot(ontology);
const content = JSON.stringify([
  { id: "book-one", name: "The Connected City", author: " ALEX RIVERS " },
  { id: "book-two", name: "Native References", author: "Morgan Lee" },
]);
const preview = await client.syncSource(ontology, "books", {
  content,
  dryRun: true,
});
assert.equal(preview.relationships?.added.length, 2);
assert.equal((await client.snapshot(ontology)).revision, before.revision);
const applied = await client.syncSource(ontology, "books", {
  content,
  expectedCheckpoint: preview.checkpoint,
  expectedRevision: before.revision,
});
const state = await client.snapshot(ontology);
const author = state.objects.find((o) => o.properties.name === "Alex Rivers")!;
const path = await client.runAlgorithm(ontology, {
  algorithm: "shortest-path",
  source: "book-one",
  target: author.id,
});
assert.deepEqual(path.path?.objects, ["book-one", author.id]);
assert.equal(
  (await client.stateAt(ontology, { revision: before.revision })).relationships
    .length,
  0,
);
const replay = await client.syncSource(ontology, "books", { content });
assert.equal(replay.revision, applied.revision);
assert.equal(replay.relationships?.unchanged, 2);
console.log(
  JSON.stringify(
    {
      ontology,
      objects: state.objects.length,
      relationships: state.relationships.length,
      nativePath: path.path,
      revision: state.revision,
      previewAppliedAtomically: true,
      replayPreservedRevision: true,
      historicalTopologyVerified: true,
      fixture: "Synthetic CSV/JSON data; no authenticated remote service",
    },
    null,
    2,
  ),
);
