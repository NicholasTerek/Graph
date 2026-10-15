import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { FalkorDB } from "falkordb";
import { GraphStore } from "@graph/core";
import { GraphClient } from "@graph/sdk";
import { createApp } from "../apps/api/src/app.js";
import { exampleExtensions } from "../examples/server.js";
import { twoAgentDemo } from "../scripts/two-agent-demo.js";
const suite = process.env.GRAPH_INTEGRATION === "1" ? describe : describe.skip;
suite("separate agent identities and owned alternatives", () => {
  let db: FalkorDB,
    store: GraphStore,
    app: ReturnType<typeof createApp>,
    capacity: GraphClient,
    driver: GraphClient,
    reviewer: GraphClient;
  const namespace = `agents_${Date.now()}_${process.pid}`;
  beforeAll(async () => {
    db = await FalkorDB.connect({
      socket: {
        host: "127.0.0.1",
        port: Number(process.env.FALKORDB_PORT ?? 6379),
      },
    });
    store = new GraphStore(db, namespace);
    await store.initialize();
    const local = createApp(store);
    await local.ready();
    for (const [url, file] of [
      ["/api/ontologies", "ontology.json"],
      ["/api/ontologies/semiconductor/ingest", "data.json"],
    ]) {
      const r = await local.inject({
        method: "POST",
        url,
        payload: JSON.parse(
          readFileSync(`examples/semiconductor/${file}`, "utf8"),
        ),
      });
      expect(r.statusCode).toBeLessThan(300);
    }
    await local.close();
    const tokens = ["capacity-agent", "driver-agent", "human-reviewer"].map(
      (name) => ({
        name,
        token: `fixture-${name}`.padEnd(40, "x"),
        scopes:
          name === "human-reviewer"
            ? (["read", "write", "approve"] as const)
            : (["read", "write"] as const),
        ontologies: ["semiconductor"],
        kind:
          name === "human-reviewer" ? ("human" as const) : ("agent" as const),
      }),
    );
    app = createApp(store, {
      extensions: exampleExtensions(),
      security: {
        tokens: tokens.map((t) => ({ ...t, scopes: [...t.scopes] })),
      },
    });
    await app.ready();
    const clients = tokens.map(
      (token) =>
        new GraphClient(
          "http://test",
          async (url, init) => {
            const u = new URL(String(url));
            const r = await app.inject({
              method: (init?.method ?? "GET") as "GET",
              url: u.pathname + u.search,
              headers: init?.headers as Record<string, string>,
              payload: init?.body as string,
            });
            return new Response(r.statusCode === 204 ? null : r.body, {
              status: r.statusCode,
            });
          },
          { token: token.token },
        ),
    );
    [capacity, driver, reviewer] = clients;
  });
  afterAll(async () => {
    await app?.close();
    if (db) {
      await store.nativeGraphs.collect(new Set());
      await db.selectGraph(namespace).delete();
      await db.close();
    }
  });
  it("saves two isolated role-bound investigations and permits only a separately authorized promotion", async () => {
    const result = await twoAgentDemo(capacity, driver);
    const [one, two] = result.results;
    expect(one.branch.owner).toBe("capacity-agent");
    expect(two.branch.owner).toBe("driver-agent");
    expect(one.investigation.mode).toBe("deterministic-tools");
    await expect(
      driver.patchScenarioObject("semiconductor", one.branch.id, "meridian", {
        properties: { leadDays: 99 },
        expectedVersion: one.branch.version,
      }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      driver.editScenario("semiconductor", one.branch.id, {
        expectedVersion: one.branch.version,
        removeObjects: ["meridian"],
      }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      driver.discardScenario("semiconductor", one.branch.id),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      capacity.patchObject("semiconductor", "meridian", {
        properties: { leadDays: 99 },
      }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      capacity.enqueueJob("semiconductor", {
        kind: "source-sync",
        sourceId: "unused",
      }),
    ).rejects.toMatchObject({ status: 403 });
    const queued = await capacity.enqueueJob("semiconductor", {
      kind: "investigation",
      request: { question: "Owned queued work", maxSteps: 8 },
      notBefore: new Date(Date.now() + 86400000).toISOString(),
    });
    await expect(
      driver.cancelJob("semiconductor", queued.id, queued.version),
    ).rejects.toMatchObject({ status: 403 });
    const cancelled = await capacity.cancelJob(
      "semiconductor",
      queued.id,
      queued.version,
    );
    const retried = await capacity.retryJob(
      "semiconductor",
      queued.id,
      cancelled.version,
    );
    await capacity.cancelJob("semiconductor", retried.id, retried.version);
    const review = await reviewer.reviewScenario(
      "semiconductor",
      one.branch.id,
    );
    const input = {
      expectedVersion: review.version,
      expectedRevision: review.liveRevision,
      objects: ["meridian"],
      relationships: [],
      confirm: true as const,
    };
    await expect(
      capacity.promoteScenario("semiconductor", one.branch.id, input),
    ).rejects.toMatchObject({ status: 403 });
    const promoted = await reviewer.promoteScenario(
      "semiconductor",
      one.branch.id,
      input,
    );
    expect(promoted.result.actor).toBe("human-reviewer");
    expect(
      (await capacity.snapshot("semiconductor")).objects.find(
        (o) => o.id === "meridian",
      )!.properties.leadDays,
    ).toBe(14);
    expect(
      (await driver.scenarioGraph("semiconductor", two.branch.id)).objects.find(
        (o) => o.id === "gpu-142",
      )!.properties.fixDays,
    ).toBe(4);
  });
});
