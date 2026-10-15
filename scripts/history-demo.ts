import { strict as assert } from "node:assert";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { GraphClient, GraphApiError } from "@graph/sdk";
import {
  ontologySchema,
  type BackupArchive,
  type ReadSnapshot,
} from "@graph/contracts";
const client = new GraphClient(
  process.env.API_URL ?? "http://127.0.0.1:3001",
  fetch,
  { token: process.env.GRAPH_API_TOKEN },
);
const phase = process.argv[2],
  ontology = "ci-history-archive",
  path = "artifacts/history-restart.json";
if (phase === "prepare") {
  await client.register(
    ontologySchema.parse({
      id: ontology,
      name: "Synthetic history restore drill",
      objectTypes: [
        {
          name: "Record",
          properties: { name: { type: "string", required: true } },
        },
      ],
      relationshipTypes: [],
    }),
  );
  await client.ingest(ontology, {
    objects: [
      {
        id: "record",
        type: "Record",
        properties: { name: "first" },
        provenance: {
          source: "synthetic-restart-drill",
          externalId: "record",
          observedAt: new Date().toISOString(),
        },
      },
    ],
    relationships: [],
  });
  const first = await client.stateAt(ontology);
  await client.patchObject(ontology, "record", {
    properties: { name: "second" },
    expectedRevision: first.revision,
  });
  const archive = await client.backup(ontology, { includeHistory: true }),
    pin = await client.createReadSnapshot(ontology, { ttlSeconds: 3600 });
  await mkdir("artifacts", { recursive: true });
  await writeFile(
    path,
    JSON.stringify({ archive, pin, firstRevision: first.revision }),
  );
  console.log(
    JSON.stringify({
      prepared: true,
      ontology,
      archive: archive.format,
      retainedFrom: archive.temporal?.retainedFrom,
    }),
  );
} else if (phase === "verify") {
  const { archive, pin, firstRevision } = JSON.parse(
    await readFile(path, "utf8"),
  ) as { archive: BackupArchive; pin: ReadSnapshot; firstRevision: number };
  const persisted = await client.stateAt(ontology, { snapshot: pin.id });
  assert.equal(persisted.objects[0].properties.name, "second");
  await client.patchObject(ontology, "record", {
    properties: { name: "later" },
    expectedRevision: persisted.revision,
  });
  await client.restore(
    ontology,
    archive,
    (await client.snapshot(ontology)).revision,
  );
  assert.equal(
    (await client.stateAt(ontology, { revision: firstRevision })).objects[0]
      .properties.name,
    "first",
  );
  assert.equal(
    (await client.stateAt(ontology)).objects[0].properties.name,
    "second",
  );
  await assert.rejects(
    client.stateAt(ontology, { snapshot: pin.id }),
    (e: unknown) => e instanceof GraphApiError && e.status === 409,
  );
  console.log(
    JSON.stringify({
      ontology,
      persistedPinRecovered: true,
      restoredRetainedHistory: true,
      oldPinInvalidated: true,
    }),
  );
} else
  throw Error(
    "Usage: node --import tsx scripts/history-demo.ts prepare|verify",
  );
