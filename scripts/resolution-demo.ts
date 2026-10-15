import { strict as assert } from "node:assert";
import { FalkorDB } from "falkordb";
import { GraphStore } from "@graph/core";
import { GraphClient } from "@graph/sdk";
import { createApp } from "../apps/api/src/app.js";
import { exampleExtensions } from "../examples/server.js";
import {
  seedResolution,
  replayResolutionSources,
  resolutionFixtureFetch,
} from "../examples/entity-resolution/fixtures.js";
import { resolutionOntology } from "../examples/entity-resolution/model.js";
import type { ResolutionResult } from "../examples/entity-resolution/functions.js";
import {
  prepareResolution,
  prepareResolutionUndo,
  promoteResolution,
} from "../examples/entity-resolution/workflow.js";
const mode = process.argv[2] ?? "verify";
if (!["serve", "verify"].includes(mode))
  throw Error("Usage: pnpm demo:resolution [serve|verify]");
const db = await FalkorDB.connect({
  socket: {
    host: process.env.FALKORDB_HOST ?? "127.0.0.1",
    port: Number(process.env.FALKORDB_PORT ?? 6379),
  },
});
const namespace = `resolution_demo_${Date.now()}_${process.pid}`,
  store = new GraphStore(db, namespace);
const app = createApp(store, {
  serveWeb: mode === "serve",
  extensions: exampleExtensions({ GRAPH_EXTENSIONS: "supplier-resolution" }),
  connectorFetch: resolutionFixtureFetch,
});
try {
  await store.initialize();
  const url = await app.listen({
      host: "127.0.0.1",
      port: mode === "serve" ? Number(process.env.PORT ?? 3102) : 0,
    }),
    client = new GraphClient(url);
  await seedResolution(client);
  if (mode === "serve") {
    console.log(
      JSON.stringify({
        url,
        fixture:
          "Synthetic CSV/JSON and intercepted GitHub issue fixture; no live provider account",
        instructions:
          "Open Supplier identity review. Select the three matched aliases, inspect changes and confirm promotion; then review reversal.",
      }),
    );
    await new Promise<void>((resolve) => {
      for (const signal of ["SIGINT", "SIGTERM"])
        process.once(signal, () => resolve());
    });
  } else {
    const before = await client.snapshot(resolutionOntology),
      score = await client.runFunction<ResolutionResult>(
        resolutionOntology,
        "supplier-candidates",
        {},
      );
    const aliases = score.output.aliases
      .filter((a) => a.status === "matched")
      .map((a) => a.id);
    assert.equal(aliases.length, 3);
    assert.equal(
      score.output.aliases.filter((a) => a.status === "ambiguous").length,
      1,
    );
    const review = await prepareResolution(
      client,
      aliases,
      "canonical-packaging",
    );
    assert.deepEqual(await client.snapshot(resolutionOntology), before);
    await promoteResolution(client, review, true);
    const merged = await client.snapshot(resolutionOntology);
    assert.equal(
      merged.relationships.filter(
        (r) => r.type === "ORDERED_FROM" && r.to === "canonical-packaging",
      ).length,
      3,
    );
    await replayResolutionSources(client);
    assert.equal(
      (await client.snapshot(resolutionOntology)).revision,
      merged.revision,
    );
    const undo = await prepareResolutionUndo(client, review.resolutionId);
    await promoteResolution(client, undo, true);
    const reverted = await client.snapshot(resolutionOntology),
      ids = new Set(reverted.objects.map((o) => o.id));
    assert.equal(
      reverted.relationships.filter((r) => r.type === "RESOLVES_TO").length,
      0,
    );
    assert.ok(
      reverted.relationships.every((r) => ids.has(r.from) && ids.has(r.to)),
    );
    assert.deepEqual(
      reverted.relationships
        .filter((r) => r.type === "ORDERED_FROM")
        .map((r) => [r.id, r.to]),
      before.relationships
        .filter((r) => r.type === "ORDERED_FROM")
        .map((r) => [r.id, r.to]),
    );
    console.log(
      JSON.stringify(
        {
          fixture: "Synthetic bounded example; GitHub responses intercepted",
          reviewMode: "scripted-reviewer",
          scoreRun: { id: score.id, revision: score.revision, ...score.output },
          resolutionId: review.resolutionId,
          reviewedBranch: review.scenarioId,
          mergedRevision: merged.revision,
          sourceReplayNoOp: true,
          reversed: true,
          auditRetained:
            reverted.objects.find((o) => o.id === review.resolutionId)
              ?.properties.status === "reverted",
          noDanglingReferences: true,
        },
        null,
        2,
      ),
    );
  }
} finally {
  await app.close();
  await store.nativeGraphs.collect(new Set());
  await db.selectGraph(namespace).delete();
  await db.close();
}
