import { afterAll, beforeAll, describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { FalkorDB } from "falkordb";
import { GraphStore, ScenarioService, defineFunction } from "@graph/core";
import { GraphClient, GraphApiError } from "@graph/sdk";
import { createApp } from "../apps/api/src/app.js";
import { platformFunctions } from "../apps/api/src/extensions.js";
import { z } from "zod";
import type { LaunchResult } from "../examples/semiconductor/functions/launch-readiness.js";
const suite = process.env.GRAPH_INTEGRATION === "1" ? describe : describe.skip;
suite("GPU application through the public SDK", () => {
  let db: FalkorDB,
    store: GraphStore,
    app: ReturnType<typeof createApp>,
    client: GraphClient;
  const name = `workflow_${Date.now()}_${process.pid}`;
  const read = (path: string) => JSON.parse(readFileSync(path, "utf8"));
  beforeAll(async () => {
    db = await FalkorDB.connect({
      socket: {
        host: process.env.FALKORDB_HOST ?? "127.0.0.1",
        port: Number(process.env.FALKORDB_PORT ?? 6379),
      },
    });
    store = new GraphStore(db, name);
    await store.initialize();
    app = createApp(store, {
      functions: [
        ...platformFunctions,
        defineFunction({
          id: "count-books",
          name: "Count books",
          description: "Generic extension proof",
          ontology: "library",
          input: z.object({}),
          output: z.object({ count: z.number() }),
          execute: ({ graph }) => ({ count: graph.objects("Book").length }),
        }),
      ],
    });
    await app.ready();
    const transport: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      const response = await app.inject({
        method: (init?.method ?? "GET") as "GET",
        url: url.pathname + url.search,
        headers: init?.headers as Record<string, string>,
        payload: init?.body as string | undefined,
      });
      return new Response(response.statusCode === 204 ? null : response.body, {
        status: response.statusCode,
        headers: response.headers as Record<string, string>,
      });
    };
    client = new GraphClient("http://graph.test", transport);
    for (const example of ["semiconductor", "library"]) {
      const schema = read(`examples/${example}/ontology.json`);
      await client.register(schema);
      await client.ingest(schema.id, read(`examples/${example}/data.json`));
    }
  });
  afterAll(async () => {
    await app?.close();
    if (db) {
      await db.selectGraph(name).delete();
      await db.close();
    }
  });
  it("publishes usable OpenAPI paths and function contracts", async () => {
    const docs = (await app.inject("/api/openapi.json")).json();
    expect(docs.openapi).toMatch(/^3\./);
    expect(
      docs.paths["/api/ontologies/{ontology}/objects/{id}"].patch,
    ).toBeTruthy();
    expect(
      docs.paths["/api/ontologies/{ontology}/scenarios"].post.requestBody,
    ).toBeTruthy();
    expect((await app.inject("/api/docs/")).statusCode).toBe(200);
    expect(
      (await client.functions("semiconductor"))[0].inputSchema,
    ).toHaveProperty("properties.productId");
  });
  it("paginates deterministically and filters objects and edges", async () => {
    const first = await client.objects("semiconductor", { limit: 3 });
    expect(first.items).toHaveLength(3);
    expect(first.nextCursor).toBe(first.items[2].id);
    const second = await client.objects("semiconductor", {
      limit: 3,
      after: first.nextCursor!,
    });
    expect(second.items.every((o) => o.id > first.nextCursor!)).toBe(true);
    const suppliers = await client.objects("semiconductor", {
      type: "Supplier",
    });
    expect(suppliers.items).toHaveLength(2);
    expect(
      (
        await client.objects("semiconductor", { q: "memory regression" })
      ).items.map((o) => o.id),
    ).toEqual(["gpu-142"]);
    expect(
      (
        await client.relationships("semiconductor", {
          from: "aquila-x900",
          limit: 2,
        })
      ).nextCursor,
    ).toBeTruthy();
    expect((await client.relationship("semiconductor", "r01")).type).toBe(
      "REQUIRES",
    );
  });
  it("calculates an evidence-backed recovery plan from live data", async () => {
    const run = await client.runFunction<LaunchResult>(
      "semiconductor",
      "launch-readiness",
      { productId: "aquila-x900" },
    );
    expect(run.output.baseline.readyDays).toBe(40);
    expect(run.output.baseline.delayDays).toBe(19);
    expect(run.output.recommendation.hardware[0].supplierId).toBe("meridian");
    expect(run.output.recommendation.readyDays).toBe(20);
    expect(run.output.plans).toHaveLength(6);
    expect(run.output.evidence.map((e) => e.id)).toEqual(
      expect.arrayContaining([
        "northstar",
        "gpu-142",
        "memory-validation",
        "graphics-team",
        "customer-orbit",
      ]),
    );
    expect(run.output.customers).toHaveLength(2);
    expect(run.output.teams[0].id).toBe("graphics-team");
    expect(run.scenarioId).toBeNull();
  });
  it("changes the winning plan at 14 days without mutating live state", async () => {
    const before = await client.snapshot("semiconductor");
    const branch = await client.createScenario("semiconductor", {
      id: "recovery-test",
      name: "14-day alternative",
      expectedRevision: before.revision,
    });
    const patched = await client.patchScenarioObject(
      "semiconductor",
      branch.id,
      "meridian",
      { properties: { leadDays: 14 }, expectedVersion: 0 },
    );
    expect(patched.version).toBe(1);
    const run = await client.runFunction<LaunchResult>(
      "semiconductor",
      "launch-readiness",
      { productId: "aquila-x900" },
      branch.id,
    );
    expect(run.output.recommendation.hardware[0].supplierId).toBe("northstar");
    expect(run.output.recommendation.hardware[0].expedited).toBe(true);
    expect(run.output.recommendation.readyDays).toBe(20);
    expect(
      run.output.plans.find((p) => p.id === "meridian_driver-26-10")?.delayDays,
    ).toBe(5);
    expect(await client.snapshot("semiconductor")).toEqual(before);
    const diff = await client.scenarioDiff("semiconductor", branch.id);
    expect(diff.objects).toHaveLength(1);
    expect(diff.objects[0].before?.properties.leadDays).toBe(7);
    expect(diff.objects[0].after?.properties.leadDays).toBe(14);
    expect(diff.stale).toBe(false);
  });
  it("rejects stale scenario edits and invalid hypothetical records atomically", async () => {
    await expect(
      client.patchScenarioObject("semiconductor", "recovery-test", "meridian", {
        properties: { leadDays: 1 },
        expectedVersion: 0,
      }),
    ).rejects.toMatchObject({ status: 409, code: "CONFLICT" });
    await expect(
      client.patchScenarioObject("semiconductor", "recovery-test", "meridian", {
        properties: { leadDays: "wrong" },
        expectedVersion: 1,
      }),
    ).rejects.toMatchObject({ status: 422 });
    expect(
      (await client.scenario("semiconductor", "recovery-test")).version,
    ).toBe(1);
    expect(
      (
        await client.scenarioGraph("semiconductor", "recovery-test")
      ).objects.find((o) => o.id === "meridian")?.properties.leadDays,
    ).toBe(14);
  });
  it("shares one immutable base among sibling scenarios", async () => {
    await client.createScenario("semiconductor", {
      id: "sibling",
      name: "Sibling",
    });
    expect(await store.documents("base", "semiconductor")).toHaveLength(1);
    expect(
      (await client.scenarioGraph("semiconductor", "sibling")).objects.find(
        (o) => o.id === "meridian",
      )?.properties.leadDays,
    ).toBe(7);
    await client.discardScenario("semiconductor", "sibling");
    expect(await store.documents("base", "semiconductor")).toHaveLength(1);
  });
  it("keeps a pinned base when live state changes and supports optimistic patches", async () => {
    const before = await client.snapshot("semiconductor");
    const updated = await client.patchObject("semiconductor", "northstar", {
      properties: { leadDays: 30 },
      expectedRevision: before.revision,
    });
    expect(updated.revision).toBe(before.revision + 1);
    await expect(
      client.patchObject("semiconductor", "northstar", {
        properties: { leadDays: 99 },
        expectedRevision: before.revision,
      }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      client.createScenario("semiconductor", {
        id: "stale-create",
        name: "Stale",
        expectedRevision: before.revision,
      }),
    ).rejects.toMatchObject({ status: 409 });
    const pinned = await client.scenarioGraph("semiconductor", "recovery-test");
    expect(
      pinned.objects.find((o) => o.id === "northstar")?.properties.leadDays,
    ).toBe(28);
    expect(
      (await client.scenarioDiff("semiconductor", "recovery-test")).stale,
    ).toBe(true);
    const reopened = await new ScenarioService(new GraphStore(db, name)).state(
      "semiconductor",
      "recovery-test",
    );
    expect(reopened).toEqual(pinned);
  });
  it("supports relationship removal/addition and rejects dangling hypothetical graphs", async () => {
    const branch = await client.createScenario("library", {
      id: "library-branch",
      name: "Library changes",
    });
    await expect(
      client.editScenario("library", branch.id, {
        removeObjects: ["author-1"],
        expectedVersion: 0,
      }),
    ).rejects.toMatchObject({ status: 422 });
    await client.editScenario("library", branch.id, {
      removeObjects: ["author-1"],
      removeRelationships: ["written-1"],
      expectedVersion: 0,
    });
    const diff = await client.scenarioDiff("library", branch.id);
    expect(diff.relationships[0].kind).toBe("removed");
    expect(diff.objects[0].kind).toBe("removed");
    const original = await client.object("library", "author-1");
    await client.editScenario("library", branch.id, {
      objects: [original],
      relationships: [await client.relationship("library", "written-1")],
      expectedVersion: 1,
    });
    const restored = await client.scenarioDiff("library", branch.id);
    expect(restored.objects).toHaveLength(0);
    expect(restored.relationships).toHaveLength(0);
  });
  it("registers an unrelated function without GPU-specific platform changes", async () => {
    const run = await client.runFunction<{ count: number }>(
      "library",
      "count-books",
      {},
    );
    expect(run.output.count).toBe(1);
    await expect(
      client.runFunction("library", "launch-readiness", {
        productId: "aquila-x900",
      }),
    ).rejects.toMatchObject({ status: 404 });
  });
  it("records run history and returns structured errors", async () => {
    expect((await client.runs("semiconductor")).length).toBeGreaterThanOrEqual(
      2,
    );
    try {
      await client.objects("semiconductor", { limit: 500 });
      throw new Error("Should fail");
    } catch (error) {
      expect(error).toBeInstanceOf(GraphApiError);
      expect(error).toMatchObject({ status: 400, code: "VALIDATION_ERROR" });
      expect((error as GraphApiError).issues).toBeTruthy();
      expect((error as GraphApiError).requestId).toBeTruthy();
    }
    await expect(
      client.runFunction("semiconductor", "launch-readiness", {
        productId: "meridian",
      }),
    ).rejects.toMatchObject({ status: 422 });
  });
  it("permits safe additive schema registration but rejects breaking changes", async () => {
    const schema = await client.ontology("library");
    const extended = {
      ...schema,
      objectTypes: schema.objectTypes.map((t) =>
        t.name === "Book"
          ? {
              ...t,
              properties: {
                ...t.properties,
                genre: { type: "string" as const, required: false },
              },
            }
          : t,
      ),
    };
    await client.register(extended);
    expect(
      (await client.ontology("library")).objectTypes.find(
        (t) => t.name === "Book",
      )?.properties.genre,
    ).toBeTruthy();
    await expect(
      client.register({
        ...extended,
        objectTypes: extended.objectTypes.map((t) =>
          t.name === "Book"
            ? {
                ...t,
                properties: {
                  ...t.properties,
                  genre: { type: "number", required: false },
                },
              }
            : t,
        ),
      }),
    ).rejects.toMatchObject({ status: 409 });
  });
  it("discards a branch without changing live state or its recorded runs", async () => {
    const before = await client.snapshot("semiconductor");
    await client.discardScenario("semiconductor", "recovery-test");
    await expect(
      client.scenarioGraph("semiconductor", "recovery-test"),
    ).rejects.toMatchObject({ status: 404 });
    expect(await client.snapshot("semiconductor")).toEqual(before);
    expect((await client.runs("semiconductor")).length).toBeGreaterThan(0);
  });
});
