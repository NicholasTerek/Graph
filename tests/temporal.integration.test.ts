import { beforeAll, afterAll, describe, it, expect, vi } from "vitest";
import { FalkorDB } from "falkordb";
import { GraphStore, defineFunction } from "@graph/core";
import { z } from "zod";
import { GraphClient } from "@graph/sdk";
import { ontologySchema, type ReadSnapshot } from "@graph/contracts";
import { createApp } from "../apps/api/src/app.js";
const suite = process.env.GRAPH_INTEGRATION === "1" ? describe : describe.skip;
suite("native revision visibility and read snapshots", () => {
  let db: FalkorDB,
    store: GraphStore,
    app: ReturnType<typeof createApp>,
    client: GraphClient;
  const name = `temporal_${Date.now()}_${process.pid}`;
  const provenance = {
    source: "test",
    externalId: "test",
    observedAt: "2026-10-15T00:00:00Z",
  };
  const schema = ontologySchema.parse({
    id: "records",
    name: "Records",
    objectTypes: [
      {
        name: "Record",
        properties: {
          name: { type: "string", required: true },
          amount: { type: "number", required: true },
        },
      },
    ],
    relationshipTypes: [{ name: "NEXT", from: "Record", to: "Record" }],
  });
  const transport =
    (target: ReturnType<typeof createApp>): typeof fetch =>
    async (url, init) => {
      const u = new URL(String(url));
      const response = await target.inject({
        method: (init?.method ?? "GET") as "GET",
        url: u.pathname + u.search,
        headers: init?.headers as Record<string, string>,
        payload: init?.body as string | undefined,
      });
      return new Response(response.statusCode === 204 ? null : response.body, {
        status: response.statusCode,
      });
    };
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
        defineFunction({
          id: "total",
          name: "Sum recorded amounts",
          description: "Test historical function context",
          ontology: "records",
          input: z.object({}).strict(),
          output: z.object({ total: z.number() }),
          execute: ({ graph }) => ({
            total: graph
              .objects("Record")
              .reduce((sum, o) => sum + Number(o.properties.amount), 0),
          }),
        }),
      ],
    });
    await app.ready();
    client = new GraphClient("http://localhost", transport(app));
    await client.register(schema);
    await client.ingest("records", {
      objects: ["a", "b", "c"].map((id) => ({
        id,
        type: "Record",
        properties: { name: id, amount: 1 },
        provenance,
      })),
      relationships: [
        { id: "a-b", type: "NEXT", from: "a", to: "b", provenance },
        { id: "b-c", type: "NEXT", from: "b", to: "c", provenance },
      ],
    });
  });
  afterAll(async () => {
    if (app) await app.close();
    if (db) {
      await store.nativeGraphs.collect(new Set());
      await db.selectGraph(name).delete();
      await db.close();
    }
  });
  it("filters object versions in Cypher and preserves old values", async () => {
    const old = await client.stateAt("records", { revision: 1 });
    expect(old.objects).toHaveLength(3);
    expect((await client.stateAt("records", { revision: 0 })).objects).toEqual(
      [],
    );
    await client.patchObject("records", "a", { properties: { amount: 2 } });
    expect(
      (await client.stateAt("records", { revision: 1 })).objects.find(
        (o) => o.id === "a",
      )!.properties.amount,
    ).toBe(1);
    expect(
      (await client.stateAt("records")).objects.find((o) => o.id === "a")!
        .properties.amount,
    ).toBe(2);
    const native = await db
      .selectGraph(name)
      .query(
        "MATCH (v:ObjectVersion {ontology:'records',id:'a'}) RETURN v.valid_from AS start,v.valid_to AS end,v.p_amount AS amount ORDER BY start",
      );
    expect(native.data).toEqual([
      { start: 1, end: 2, amount: 1 },
      { start: 2, end: null, amount: 2 },
    ]);
    const commits = await client.commits("records");
    expect(commits.items.map((c) => c.revision)).toEqual([0, 1, 2]);
    const at = await client.stateAt("records", {
      at: commits.items[0].committedAt,
    });
    expect(at.revision).toBe(
      commits.items
        .filter((c) => c.committedAt <= commits.items[0].committedAt)
        .at(-1)!.revision,
    );
    await expect(
      client.stateAt("records", { revision: 100 }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      client.stateAt("records", { at: "2000-01-01T00:00:00Z" }),
    ).rejects.toMatchObject({ status: 410 });
  });
  it("evaluates functions against the same pinned historical visibility context", async () => {
    const pin = await client.createReadSnapshot("records", { revision: 1 });
    const historical = await client.runFunction<{ total: number }>(
      "records",
      "total",
      {},
      undefined,
      { snapshot: pin.id },
    );
    const current = await client.runFunction<{ total: number }>(
      "records",
      "total",
      {},
    );
    expect(historical.output.total).toBe(3);
    expect(current.output.total).toBe(4);
    expect(historical.history).toMatchObject({
      generation: pin.generation,
      revision: 1,
    });
    expect(
      historical.evidence?.objects.find((o) => o.id === "a")!.properties.amount,
    ).toBe(1);
    await client.releaseReadSnapshot("records", pin.id);
    await expect(
      client.runFunction("records", "total", {}, "branch", { revision: 1 }),
    ).rejects.toMatchObject({ status: 400 });
  });
  it("versions relationship changes and deletes without dangling historical edges", async () => {
    const before = await client.stateAt("records");
    await client.deleteRelationship("records", "b-c");
    await client.deleteObject("records", "c");
    const old = await client.stateAt("records", { revision: before.revision });
    expect(old.objects.map((o) => o.id)).toContain("c");
    expect(old.relationships.map((r) => r.id)).toContain("b-c");
    const current = await client.stateAt("records");
    expect(current.objects.map((o) => o.id)).not.toContain("c");
    expect(current.relationships.map((r) => r.id)).not.toContain("b-c");
    const oldPath = await client.traverseAt("records", {
      revision: before.revision,
      root: "a",
      depth: 2,
      direction: "out",
    });
    expect(oldPath.objects.map((o) => o.id)).toEqual(["a", "b", "c"]);
    expect(
      (
        await client.traverseAt("records", {
          root: "a",
          depth: 2,
          direction: "out",
        })
      ).objects.map((o) => o.id),
    ).toEqual(["a", "b"]);
    expect(
      (
        await client.traverseAt("records", {
          revision: before.revision,
          root: "c",
          depth: 2,
          direction: "in",
        })
      ).objects.map((o) => o.id),
    ).toEqual(["a", "b", "c"]);
    await expect(
      client.traverseAt("records", { root: "c", depth: 2 }),
    ).rejects.toMatchObject({ status: 404 });
    expect(
      (
        await client.runAlgorithm("records", {
          algorithm: "pagerank",
          revision: before.revision,
          generation: before.generation,
        })
      ).rows[0].id,
    ).toBe("c");
    expect(
      (await client.runAlgorithm("records", { algorithm: "pagerank" })).rows[0]
        .id,
    ).toBe("b");
    for (const state of [old, current]) {
      const ids = new Set(state.objects.map((o) => o.id));
      expect(
        state.relationships.every((r) => ids.has(r.from) && ids.has(r.to)),
      ).toBe(true);
    }
  });
  it("records schema commits and preserves the revision on no-op replay", async () => {
    const state = await client.snapshot("records");
    await client.ingest("records", {
      objects: state.objects,
      relationships: state.relationships,
    });
    expect((await client.stateAt("records")).revision).toBe(state.revision);
    const additive = structuredClone(schema);
    additive.objectTypes[0].properties.enabled = {
      type: "boolean",
      required: false,
    };
    await client.register(additive);
    expect((await client.stateAt("records")).revision).toBe(state.revision + 1);
    expect((await client.commits("records")).items.at(-1)?.revision).toBe(
      state.revision + 1,
    );
  });
  it("pins repeatable reads and rejects released, expired and foreign-owner leases", async () => {
    const pin = await client.createReadSnapshot("records", { ttlSeconds: 60 });
    const captured = await client.stateAt("records", { snapshot: pin.id });
    await client.patchObject("records", "a", { properties: { amount: 3 } });
    expect(await client.stateAt("records", { snapshot: pin.id })).toEqual(
      captured,
    );
    const expired = await client.createReadSnapshot("records", {
      ttlSeconds: 1,
    });
    await store.saveDocument("snapshot", "records", expired.id, {
      ...expired,
      expiresAt: "2000-01-01T00:00:00Z",
    });
    await expect(
      client.stateAt("records", { snapshot: expired.id }),
    ).rejects.toMatchObject({ status: 410 });
    const foreign = await client.createReadSnapshot("records");
    await store.saveDocument("snapshot", "records", foreign.id, {
      ...foreign,
      owner: "someone-else",
    });
    await expect(
      client.stateAt("records", { snapshot: foreign.id }),
    ).rejects.toMatchObject({ status: 403 });
    await client.releaseReadSnapshot("records", pin.id);
    await expect(
      client.stateAt("records", { snapshot: pin.id }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      client.stateAt("records", { revision: 1, at: new Date().toISOString() }),
    ).rejects.toMatchObject({ status: 400 });
  });
  it("starts a new generation after restore and invalidates previous snapshot tokens", async () => {
    const archive = await client.backup("records");
    const old = await client.stateAt("records");
    const pin = await client.createReadSnapshot("records");
    await client.patchObject("records", "a", { properties: { amount: 4 } });
    const revision = (await client.snapshot("records")).revision;
    await client.restore("records", archive, revision);
    const restored = await client.stateAt("records");
    expect(restored.generation).not.toBe(old.generation);
    expect(restored.retainedFrom).toBe(restored.revision);
    expect(restored.objects).toEqual(old.objects);
    await expect(
      client.stateAt("records", { snapshot: pin.id }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      client.stateAt("records", {
        generation: old.generation,
        revision: old.revision,
      }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      client.stateAt("records", { revision: old.revision }),
    ).rejects.toMatchObject({ status: 410 });
    expect(
      (await client.commits("records")).items.map((c) => c.revision),
    ).toEqual([restored.revision]);
  });
  it("establishes a truthful baseline for legacy data instead of inventing earlier versions", async () => {
    const legacy = { ...schema, id: "legacy", name: "Legacy" };
    await client.register(legacy);
    await client.ingest("legacy", {
      objects: [
        {
          id: "old",
          type: "Record",
          properties: { name: "Old record", amount: 7 },
          provenance,
        },
      ],
      relationships: [],
    });
    await db
      .selectGraph(name)
      .query(
        "MATCH (v:ObjectVersion {ontology:'legacy'})-[r:VERSION_OF]->() DELETE r,v WITH count(*) AS n MATCH (c:Commit {ontology:'legacy'}) DELETE c WITH count(*) AS n MATCH (o:Ontology {id:'legacy'}) SET o.historyGeneration=null,o.historyStart=null,o.lastCommitTime=null,o.revision=7",
      );
    const migrated = await client.stateAt("legacy");
    expect(migrated.retainedFrom).toBe(7);
    expect(migrated.revision).toBe(7);
    expect(migrated.objects[0].properties.amount).toBe(7);
    await expect(
      client.stateAt("legacy", { revision: 6 }),
    ).rejects.toMatchObject({ status: 410 });
  });
  it("keeps current and historical records unchanged if the combined write fails", async () => {
    const before = await client.stateAt("records");
    const original = store.temporal.plan.bind(store.temporal);
    const failure = vi
      .spyOn(store.temporal, "plan")
      .mockImplementationOnce(async (...args) => ({
        ...(await original(...args)),
        query: "THIS IS INVALID CYPHER",
      }));
    await expect(
      client.patchObject("records", "a", { properties: { amount: 999 } }),
    ).rejects.toMatchObject({ status: 500 });
    failure.mockRestore();
    expect(await client.stateAt("records")).toEqual(before);
    expect((await client.snapshot("records")).objects).toEqual(before.objects);
  });
  it("allows read-only snapshot leases and enforces principal/ontology boundaries", async () => {
    const first = "history-reader-token-123456789",
      second = "other-history-reader-token-12345";
    const secured = createApp(store, {
      security: {
        tokens: [
          {
            name: "reader",
            token: first,
            scopes: ["read"],
            ontologies: ["records"],
          },
          {
            name: "other",
            token: second,
            scopes: ["read"],
            ontologies: ["records"],
          },
        ],
      },
    });
    await secured.ready();
    const reader = new GraphClient("http://localhost", transport(secured), {
        token: first,
      }),
      other = new GraphClient("http://localhost", transport(secured), {
        token: second,
      });
    try {
      const pin = await reader.createReadSnapshot("records");
      expect(
        (await reader.stateAt("records", { snapshot: pin.id })).revision,
      ).toBe(pin.revision);
      await expect(
        other.stateAt("records", { snapshot: pin.id }),
      ).rejects.toMatchObject({ status: 403 });
      await expect(reader.stateAt("legacy")).rejects.toMatchObject({
        status: 403,
      });
      await reader.releaseReadSnapshot("records", pin.id);
      await expect(
        reader.patchObject("records", "a", { properties: { amount: 5 } }),
      ).rejects.toMatchObject({ status: 403 });
    } finally {
      await secured.close();
    }
  });
  it("prevents mixed-revision state reads during concurrent multi-object writes", async () => {
    const original = await client.snapshot("records");
    const pair = original.objects.filter((o) => ["a", "b"].includes(o.id));
    await client.ingest("records", {
      objects: pair.map((o) => ({
        ...o,
        properties: { ...o.properties, amount: 0 },
      })),
      relationships: [],
    });
    const observations: Awaited<ReturnType<GraphClient["stateAt"]>>[] = [];
    await Promise.all([
      (async () => {
        for (let i = 1; i <= 10; i++)
          await client.ingest("records", {
            objects: pair.map((o) => ({
              ...o,
              properties: { ...o.properties, amount: i },
            })),
            relationships: [],
          });
      })(),
      (async () => {
        for (let i = 0; i < 20; i++)
          observations.push(await client.stateAt("records"));
      })(),
    ]);
    for (const state of observations)
      expect(state.objects.find((o) => o.id === "a")!.properties.amount).toBe(
        state.objects.find((o) => o.id === "b")!.properties.amount,
      );
  });
});
