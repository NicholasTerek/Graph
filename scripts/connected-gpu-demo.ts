import { strict as assert } from "node:assert";
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { FalkorDB } from "falkordb";
import { GraphStore } from "@graph/core";
import { GraphClient } from "@graph/sdk";
import {
  ingestionSchema,
  ontologySchema,
  type SourceConfig,
} from "@graph/contracts";
import { createApp } from "../apps/api/src/app.js";
import { exampleExtensions } from "../examples/server.js";
import type { LaunchResult } from "../examples/semiconductor/functions/launch-readiness.js";
const mode = process.argv[2] ?? "verify";
if (!["verify", "serve"].includes(mode))
  throw Error(
    "Usage: node --import tsx scripts/connected-gpu-demo.ts [verify|serve]",
  );
const capture = await readFile(
    "examples/semiconductor/connected-issue.json",
    "utf8",
  ),
  rows = JSON.parse(capture) as {
    number: number;
    title: string;
    state: string;
    url: string;
    updatedAt: string;
    objectId: string;
  }[];
assert.equal(rows.length, 1);
assert.equal(rows[0].objectId, "gpu-142");
assert.match(
  rows[0].url,
  /^https:\/\/github.com\/pytorch\/pytorch\/issues\/\d+$/,
);
const content = JSON.stringify(
  rows.map((r) => ({
    ...r,
    status: r.state === "closed" ? "resolved" : "open",
  })),
);
const source: SourceConfig = {
  id: "public-engineering-capture",
  name: "Captured public PyTorch issue · 10-day scenario estimate",
  connector: "json",
  mapping: {
    type: "Issue",
    idField: "url",
    objectIdField: "objectId",
    properties: {
      name: { field: "title" },
      status: { field: "status" },
      fixDays: { value: 10 },
    },
    relationships: [
      {
        id: "driver-blocker",
        type: "BLOCKED_BY",
        direction: "in",
        target: { objectId: { value: "driver-26-10" } },
      },
      {
        id: "team",
        type: "OWNED_BY",
        target: { objectId: { value: "graphics-team" } },
      },
    ],
  },
};
const db = await FalkorDB.connect({
    socket: {
      host: process.env.FALKORDB_HOST ?? "127.0.0.1",
      port: Number(process.env.FALKORDB_PORT ?? 6379),
    },
  }),
  namespace = `connected_gpu_${Date.now()}_${process.pid}`,
  store = new GraphStore(db, namespace),
  app = createApp(store, {
    serveWeb: mode === "serve",
    extensions: exampleExtensions({ GRAPH_EXTENSIONS: "semiconductor" }),
  });
try {
  await store.initialize();
  const address = await app.listen({
      host: "127.0.0.1",
      port: mode === "serve" ? Number(process.env.PORT ?? 3103) : 0,
    }),
    client = new GraphClient(address),
    ontology = "semiconductor";
  await client.register(
    ontologySchema.parse(
      JSON.parse(
        await readFile("examples/semiconductor/ontology.json", "utf8"),
      ),
    ),
  );
  const fixture = ingestionSchema.parse(
    JSON.parse(await readFile("examples/semiconductor/data.json", "utf8")),
  );
  await client.ingest(ontology, {
    objects: fixture.objects.filter((o) => o.id !== "gpu-142"),
    relationships: fixture.relationships.filter(
      (r) => r.from !== "gpu-142" && r.to !== "gpu-142",
    ),
  });
  await client.registerSource(ontology, source);
  const preview = await client.syncSource(ontology, source.id, {
    content,
    dryRun: true,
  });
  assert.equal(preview.added.length, 1);
  assert.equal(preview.relationships?.added.length, 2);
  const current = await client.snapshot(ontology);
  await client.syncSource(ontology, source.id, {
    content,
    expectedCheckpoint: preview.checkpoint,
    expectedRevision: current.revision,
  });
  const imported = await client.object(ontology, "gpu-142");
  assert.equal(imported.properties.name, rows[0].title);
  assert.equal(imported.provenance.externalId, rows[0].url);
  assert.equal(imported.properties.fixDays, 10);
  const run = await client.runFunction<LaunchResult>(
    ontology,
    "launch-readiness",
    { productId: "aquila-x900" },
  );
  assert.equal(
    run.output.evidence.find((o) => o.id === "gpu-142")?.properties.name,
    rows[0].title,
  );
  const explanation = await client.explain(ontology, {
    root: "aquila-x900",
    runId: run.id,
    maxDepth: 5,
  });
  assert.ok(
    explanation.contributors.some(
      (c) => c.objectId === "gpu-142" && c.sourceId === source.id,
    ),
  );
  assert.ok(explanation.paths.some((p) => p.target === "gpu-142"));
  const before = await client.snapshot(ontology);
  await client.syncSource(ontology, source.id, {
    content,
    expectedRevision: before.revision,
  });
  assert.equal((await client.snapshot(ontology)).revision, before.revision);
  const branch = await client.createScenario(ontology, {
    id: "repair-estimate",
    name: "20-day operator repair estimate",
    expectedRevision: before.revision,
  });
  await client.patchScenarioObject(ontology, branch.id, "gpu-142", {
    properties: { fixDays: 20 },
    expectedVersion: branch.version,
  });
  const alternate = await client.runFunction<LaunchResult>(
    ontology,
    "launch-readiness",
    { productId: "aquila-x900" },
    branch.id,
  );
  assert.equal(alternate.output.recommendation.releaseId, "driver-26-09");
  assert.deepEqual(await client.snapshot(ontology), before);
  const result = {
    sourceUrl: rows[0].url,
    upstreamUpdatedAt: rows[0].updatedAt,
    captureSha256: createHash("sha256").update(capture).digest("hex"),
    transport:
      "Public GitHub connector capture uploaded through existing JSON source API; not a runtime GitHub reader validation",
    realFields: ["title", "state", "url", "updatedAt"],
    scenarioAssumptions: {
      fixDays: 10,
      hypotheticalFixDays: 20,
      productBinding: "gpu-142 in a fictional launch",
    },
    revision: before.revision,
    runId: run.id,
    recommendation: run.output.recommendation.label,
    scenarioRecommendation: alternate.output.recommendation.label,
    sourceContributorCaptured: true,
    nativePathCaptured: true,
    replayNoOp: true,
    liveUnchanged: true,
    externalWrites: 0,
  };
  if (process.env.CONNECTED_GPU_OUTPUT)
    await writeFile(
      process.env.CONNECTED_GPU_OUTPUT,
      JSON.stringify(result, null, 2) + "\n",
    );
  console.log(
    JSON.stringify(
      { ...result, ...(mode === "serve" ? { address } : {}) },
      null,
      2,
    ),
  );
  if (mode === "serve")
    await new Promise<void>((resolve) => {
      for (const s of ["SIGINT", "SIGTERM"]) process.once(s, () => resolve());
    });
} finally {
  await app.close();
  await store.nativeGraphs.collect(new Set());
  await db.selectGraph(namespace).delete();
  await db.close();
}
