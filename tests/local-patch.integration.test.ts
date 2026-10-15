import { beforeAll, afterAll, describe, it, expect, vi } from "vitest";
import { FalkorDB } from "falkordb";
import { GraphStore } from "@graph/core";
import { GraphClient } from "@graph/sdk";
import { ontologySchema } from "@graph/contracts";
import { createApp } from "../apps/api/src/app.js";
const suite = process.env.GRAPH_INTEGRATION === "1" ? describe : describe.skip;
suite("local scalar mutations and their concurrency limits", () => {
  let db: FalkorDB,
    store: GraphStore,
    app: ReturnType<typeof createApp>,
    client: GraphClient;
  const namespace = `local_patch_${Date.now()}_${process.pid}`;
  const seed = async (id: string) => {
    await client.register(
      ontologySchema.parse({
        id,
        name: id,
        objectTypes: [
          {
            name: "Cell",
            properties: {
              value: { type: "number", required: true },
              other: { type: "number", required: true },
              onCall: { type: "boolean", required: true },
            },
          },
        ],
        relationshipTypes: [{ name: "PAIR", from: "Cell", to: "Cell" }],
      }),
    );
    const provenance = {
      source: "fixture",
      externalId: "test",
      observedAt: "2026-10-15T00:00:00Z",
    };
    await client.ingest(id, {
      objects: ["a", "b"].map((id) => ({
        id,
        type: "Cell",
        properties: { value: 0, other: 0, onCall: true },
        provenance,
      })),
      relationships: [
        { id: "a-b", type: "PAIR", from: "a", to: "b", provenance },
      ],
    });
  };
  beforeAll(async () => {
    db = await FalkorDB.connect({
      socket: {
        host: "127.0.0.1",
        port: Number(process.env.FALKORDB_PORT ?? 6379),
      },
    });
    store = new GraphStore(db, namespace);
    await store.initialize();
    app = createApp(store);
    await app.ready();
    client = new GraphClient("http://test", async (url, init) => {
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
    });
  });
  afterAll(async () => {
    await app?.close();
    if (db) {
      await db.selectGraph(namespace).delete();
      await db.close();
    }
  });
  it("preserves unrelated records, edge intervals, before-images and no-op revisions", async () => {
    await seed("local");
    const before = await client.stateAt("local");
    const patch = await client.patchObject("local", "a", {
      properties: { value: 7 },
      expectedRevision: before.revision,
    });
    expect(patch.revision).toBe(before.revision + 1);
    const after = await client.stateAt("local");
    expect(after.relationships).toEqual(before.relationships);
    expect(after.objects.find((o) => o.id === "b")).toEqual(
      before.objects.find((o) => o.id === "b"),
    );
    expect(
      (await client.stateAt("local", { revision: before.revision })).objects,
    ).toEqual(before.objects);
    expect(
      (await client.patchObject("local", "a", { properties: { value: 7 } }))
        .revision,
    ).toBe(after.revision);
    await expect(
      client.patchObject("local", "a", { properties: { unknown: 3 } }),
    ).rejects.toMatchObject({ status: 422 });
    await expect(client.deleteObject("local", "a")).rejects.toMatchObject({
      status: 409,
    });
    const native = await db
      .selectGraph(namespace)
      .roQuery<{
        count: number;
      }>("MATCH (:Identity {ontology:'local'})-[r:HISTORICAL_LINK]->() RETURN count(r) AS count");
    expect(native.data?.[0].count).toBe(1);
  });
  it("rejects one same-revision writer and preserves independent unguarded field edits", async () => {
    await seed("guards");
    const before = await client.stateAt("guards");
    const results = await Promise.allSettled(
      [1, 2].map((value) =>
        client.patchObject("guards", "a", {
          properties: { value },
          expectedRevision: before.revision,
        }),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.find((r) => r.status === "rejected")).toMatchObject({
      reason: { status: 409 },
    });
    await Promise.all([
      client.patchObject("guards", "a", { properties: { value: 9 } }),
      client.patchObject("guards", "a", { properties: { other: 11 } }),
    ]);
    expect((await client.object("guards", "a")).properties).toMatchObject({
      value: 9,
      other: 11,
    });
  });
  it("demonstrates lost increments and cross-record write skew without a revision precondition", async () => {
    await seed("blind");
    const reads = await Promise.all([
      client.object("blind", "a"),
      client.object("blind", "a"),
    ]);
    await Promise.all(
      reads.map((o) =>
        client.patchObject("blind", "a", {
          properties: { value: Number(o.properties.value) + 1 },
        }),
      ),
    );
    expect((await client.object("blind", "a")).properties.value).toBe(1);
    const decisions = await Promise.all([
      client.snapshot("blind"),
      client.snapshot("blind"),
    ]);
    expect(
      decisions.every(
        (s) => s.objects.filter((o) => o.properties.onCall).length === 2,
      ),
    ).toBe(true);
    await Promise.all(
      ["a", "b"].map((id) =>
        client.patchObject("blind", id, { properties: { onCall: false } }),
      ),
    );
    expect(
      (await client.snapshot("blind")).objects.filter(
        (o) => o.properties.onCall,
      ),
    ).toHaveLength(0);
  });
  it("backfills all legacy identities before applying a one-object version delta", async () => {
    await seed("legacy-patch");
    await db
      .selectGraph(namespace)
      .query(
        "MATCH (o:Ontology {id:'legacy-patch'}) SET o.historyGeneration=null,o.historyStart=null,o.lastCommitTime=null,o.revision=7",
      );
    await client.patchObject("legacy-patch", "a", {
      properties: { value: 1 },
      expectedRevision: 7,
    });
    const baseline = await client.stateAt("legacy-patch", { revision: 7 });
    expect(baseline.objects).toHaveLength(2);
    expect(baseline.relationships).toHaveLength(1);
    expect(baseline.objects.every((o) => o.properties.value === 0)).toBe(true);
  });
  it("rolls back a native runtime failure after earlier object writes", async () => {
    await seed("runtime");
    const before = await client.stateAt("runtime");
    const target = store as unknown as {
        rows(q: string, p?: Record<string, unknown>): Promise<unknown[]>;
      },
      original = target.rows.bind(store);
    const injected = vi
      .spyOn(target, "rows")
      .mockImplementation((q, p) =>
        original(
          q,
          p?.objects && q.includes("UNWIND $objects")
            ? {
                ...p,
                objects: [
                  ...(p.objects as unknown[]),
                  { id: "bad", native: { invalid: { nested: true } } },
                ],
              }
            : p,
        ),
      );
    try {
      await expect(
        client.patchObject("runtime", "a", { properties: { value: 99 } }),
      ).rejects.toMatchObject({ status: 500 });
    } finally {
      injected.mockRestore();
    }
    expect(await client.stateAt("runtime")).toEqual(before);
  });
  it("reconciles a lost acknowledgment by rereading and rejects a stale retry", async () => {
    await seed("ack");
    const before = await client.stateAt("ack");
    const target = store as unknown as {
        rows(q: string, p?: Record<string, unknown>): Promise<unknown[]>;
      },
      original = target.rows.bind(store);
    const injected = vi
      .spyOn(target, "rows")
      .mockImplementation(async (q, p) => {
        const rows = await original(q, p);
        if (p?.objects && q.includes("UNWIND $objects"))
          throw Error("Injected lost acknowledgment after native commit");
        return rows;
      });
    try {
      await expect(
        client.patchObject("ack", "a", {
          properties: { value: 1 },
          expectedRevision: before.revision,
        }),
      ).rejects.toMatchObject({ status: 500 });
    } finally {
      injected.mockRestore();
    }
    const committed = await client.stateAt("ack");
    expect(committed.revision).toBe(before.revision + 1);
    expect(committed.objects.find((o) => o.id === "a")!.properties.value).toBe(
      1,
    );
    await expect(
      client.patchObject("ack", "a", {
        properties: { value: 1 },
        expectedRevision: before.revision,
      }),
    ).rejects.toMatchObject({ status: 409 });
  });
});
