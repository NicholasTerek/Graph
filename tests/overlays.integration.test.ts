import { beforeAll, afterAll, describe, it, expect, vi } from "vitest";
import { FalkorDB } from "falkordb";
import { GraphStore, ScenarioService } from "@graph/core";
import { GraphClient } from "@graph/sdk";
import { ontologySchema } from "@graph/contracts";
import { createApp } from "../apps/api/src/app.js";
const suite = process.env.GRAPH_INTEGRATION === "1" ? describe : describe.skip;
suite("native revision overlay scenarios", () => {
  let db: FalkorDB,
    store: GraphStore,
    app: ReturnType<typeof createApp>,
    client: GraphClient;
  const namespace = `overlay_${Date.now()}_${process.pid}`;
  const provenance = {
    source: "test",
    externalId: "fixture",
    observedAt: "2026-10-15T00:00:00Z",
  };
  const object = (id: string, amount = 1) => ({
    id,
    type: "Record",
    properties: { name: id, amount },
    provenance,
  });
  const edge = (id: string, from: string, to: string) => ({
    id,
    type: "NEXT",
    from,
    to,
    provenance,
  });
  const seed = async (id: string) => {
    await client.register(
      ontologySchema.parse({
        id,
        name: id,
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
      }),
    );
    await client.ingest(id, {
      objects: [object("a"), object("b"), object("c")],
      relationships: [edge("a-b", "a", "b"), edge("b-c", "b", "c")],
    });
  };
  beforeAll(async () => {
    db = await FalkorDB.connect({
      socket: {
        host: process.env.FALKORDB_HOST ?? "127.0.0.1",
        port: Number(process.env.FALKORDB_PORT ?? 6379),
      },
    });
    store = new GraphStore(db, namespace);
    await store.initialize();
    app = createApp(store);
    await app.ready();
    client = new GraphClient("http://overlay.test", async (url, init) => {
      const u = new URL(String(url));
      const r = await app.inject({
        method: (init?.method ?? "GET") as "GET",
        url: u.pathname + u.search,
        headers: init?.headers as Record<string, string>,
        payload: init?.body as string | undefined,
      });
      return new Response(r.statusCode === 204 ? null : r.body, {
        status: r.statusCode,
      });
    });
  });
  afterAll(async () => {
    await app?.close();
    if (db) {
      await store.nativeGraphs.collect(new Set());
      await db.selectGraph(namespace).delete();
      await db.close();
    }
  });
  it("creates metadata-only branches and natively shadows values, edges and tombstones", async () => {
    await seed("visibility");
    const keys = await db.list();
    const branch = await client.createScenario("visibility", {
      id: "one",
      name: "One",
      strategy: "overlay",
    });
    const sibling = await client.createScenario("visibility", {
      id: "two",
      name: "Two",
      strategy: "overlay",
    });
    expect(branch.storage).toBe("falkordb-overlay");
    expect(await db.list()).toEqual(keys);
    expect(await store.documents("base", "visibility")).toEqual([]);
    await client.patchObject("visibility", "a", { properties: { amount: 20 } });
    const edit = await client.editScenario("visibility", "one", {
      expectedVersion: 0,
      objects: [object("a", 7), object("d", 9)],
      relationships: [edge("a-b", "a", "d")],
      removeObjects: ["c"],
      removeRelationships: ["b-c"],
    });
    expect(edit.version).toBe(1);
    expect(
      (await client.scenarioGraph("visibility", "one")).objects.map((o) => [
        o.id,
        o.properties.amount,
      ]),
    ).toEqual([
      ["a", 7],
      ["b", 1],
      ["d", 9],
    ]);
    expect(
      (await client.scenarioGraph("visibility", sibling.id)).objects.map(
        (o) => o.properties.amount,
      ),
    ).toEqual([1, 1, 1]);
    expect((await client.object("visibility", "a")).properties.amount).toBe(20);
    const rows = await db
      .selectGraph(namespace)
      .query(
        "MATCH (s:BranchObject {ontology:'visibility',scenario:'one'}) RETURN s.id AS id,s.deleted AS deleted,s.p_amount AS amount ORDER BY id",
      );
    expect(rows.data).toEqual([
      { id: "a", deleted: false, amount: 7 },
      { id: "c", deleted: true, amount: null },
      { id: "d", deleted: false, amount: 9 },
    ]);
    const links = await db
      .selectGraph(namespace)
      .query(
        "MATCH (a:Identity {ontology:'visibility'})-[r:BRANCH_LINK]->(b:Identity {ontology:'visibility'}) WHERE r.scenario='one' RETURN a.id AS source,b.id AS target",
      );
    expect(links.data).toEqual([{ source: "a", target: "d" }]);
    expect(
      (
        await new ScenarioService(new GraphStore(db, namespace)).state(
          "visibility",
          "one",
        )
      ).scenarioVersion,
    ).toBe(1);
    await expect(
      client.editScenario("visibility", "one", {
        expectedVersion: 1,
        removeObjects: ["d"],
      }),
    ).rejects.toMatchObject({ status: 422 });
    expect((await client.scenario("visibility", "one")).version).toBe(1);
  });
  it("keeps overlapping edits guarded, handles lost acknowledgments, and leaves failed preparation invisible", async () => {
    await seed("publication");
    await client.createScenario("publication", {
      id: "one",
      name: "One",
      strategy: "overlay",
    });
    const publish = vi.spyOn(store.nativeOverlays, "publish");
    publish.mockRejectedValueOnce(new Error("Before query"));
    await expect(
      client.patchScenarioObject("publication", "one", "a", {
        expectedVersion: 0,
        properties: { amount: 5 },
      }),
    ).rejects.toMatchObject({ status: 500 });
    expect(
      (await client.scenarioGraph("publication", "one")).objects[0].properties
        .amount,
    ).toBe(1);
    publish.mockRestore();
    const actual = store.nativeOverlays.publish.bind(store.nativeOverlays);
    vi.spyOn(store.nativeOverlays, "publish").mockImplementationOnce(
      async (...args) => {
        await actual(...args);
        throw Error("Lost acknowledgment");
      },
    );
    await expect(
      client.patchScenarioObject("publication", "one", "a", {
        expectedVersion: 0,
        properties: { amount: 5 },
      }),
    ).rejects.toMatchObject({ status: 500 });
    vi.restoreAllMocks();
    expect((await client.scenario("publication", "one")).version).toBe(1);
    const outcomes = await Promise.allSettled(
      [6, 7].map((amount) =>
        client.patchScenarioObject("publication", "one", "a", {
          expectedVersion: 1,
          properties: { amount },
        }),
      ),
    );
    expect(outcomes.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.find((r) => r.status === "rejected")).toMatchObject({
      reason: { status: 409 },
    });
  });
  it("rolls back a native runtime failure without publishing partial deltas", async () => {
    await seed("rollback");
    await client.createScenario("rollback", {
      id: "one",
      name: "One",
      strategy: "overlay",
    });
    await client.patchScenarioObject("rollback", "one", "a", {
      expectedVersion: 0,
      properties: { amount: 5 },
    });
    const before = await client.scenarioGraph("rollback", "one");
    const target = store.nativeOverlays as unknown as {
      query: (
        q: string,
        p: Record<string, unknown>,
      ) => Promise<Record<string, unknown>[]>;
    };
    const query = target.query.bind(target);
    const injected = vi.spyOn(target, "query").mockImplementationOnce((q, p) =>
      query(q, {
        ...p,
        objects: [
          ...(p.objects as unknown[]),
          { id: "bad", invalid: { nested: true } },
        ],
      }),
    );
    await expect(
      store.nativeOverlays.publish(
        {
          ...(await new ScenarioService(store).reference("rollback", "one")),
          version: 2,
        },
        before,
        {
          ...before,
          objects: before.objects.map((o) =>
            o.id === "a"
              ? { ...o, properties: { ...o.properties, amount: 99 } }
              : o,
          ),
        },
      ),
    ).rejects.toThrow();
    injected.mockRestore();
    expect(await client.scenarioGraph("rollback", "one")).toEqual(before);
  });
  it("rejects an obsolete generation but allows explicit discard", async () => {
    await seed("generation");
    await client.createScenario("generation", {
      id: "one",
      name: "One",
      strategy: "overlay",
    });
    const revision = (await client.snapshot("generation")).revision;
    await store.transact("generation", revision, async (state) => ({
      state,
      revisionFloor: revision + 1,
      result: null,
    }));
    await expect(
      client.scenarioGraph("generation", "one"),
    ).rejects.toMatchObject({ status: 409 });
    await client.discardScenario("generation", "one");
    expect(await client.scenarios("generation")).toEqual([]);
  });
  it("projects effective topology for algorithms and explanations and cleans temporary keys", async () => {
    await seed("algorithms");
    await client.createScenario("algorithms", {
      id: "one",
      name: "One",
      strategy: "overlay",
    });
    await client.editScenario("algorithms", "one", {
      expectedVersion: 0,
      removeRelationships: ["b-c"],
      relationships: [edge("a-c", "a", "c")],
    });
    const keys = (await db.list()).sort();
    const path = await client.runAlgorithm("algorithms", {
      algorithm: "shortest-path",
      scenario: "one",
      source: "a",
      target: "c",
    });
    expect(path.path?.objects).toEqual(["a", "c"]);
    const why = await client.explain("algorithms", {
      root: "a",
      targets: ["c"],
      scenario: "one",
    });
    expect(why.paths[0].objects).toEqual(["a", "c"]);
    expect((await db.list()).sort()).toEqual(keys);
  });
  it("preserves selected three-way promotion and rejects overlapping live values", async () => {
    await seed("promotion");
    await client.createScenario("promotion", {
      id: "one",
      name: "One",
      strategy: "overlay",
    });
    await client.patchScenarioObject("promotion", "one", "a", {
      expectedVersion: 0,
      properties: { amount: 10 },
    });
    await client.patchObject("promotion", "b", { properties: { amount: 20 } });
    const review = await client.reviewScenario("promotion", "one");
    expect(review.conflicts).toEqual([]);
    await client.promoteScenario("promotion", "one", {
      expectedVersion: review.version,
      expectedRevision: review.liveRevision,
      objects: ["a"],
      relationships: [],
      confirm: true,
    });
    expect((await client.object("promotion", "b")).properties.amount).toBe(20);
    await client.patchObject("promotion", "a", { properties: { amount: 30 } });
    expect(
      (await client.reviewScenario("promotion", "one")).conflicts.length,
    ).toBeGreaterThan(0);
  });
  it("pins retained history until discard and then allows pruning", async () => {
    await seed("retention");
    await client.createScenario("retention", {
      id: "one",
      name: "One",
      strategy: "overlay",
    });
    await client.patchObject("retention", "a", { properties: { amount: 2 } });
    const h = await client.historyStatus("retention");
    const args = {
      generation: h.generation,
      expectedRevision: h.revision,
      retainFrom: h.revision,
    };
    const pinned = await client.vacuum("retention", args);
    expect(pinned.watermark).toBe(1);
    expect(pinned.protectedBranches.map((b) => b.id)).toEqual(["one"]);
    await client.vacuum("retention", {
      ...args,
      dryRun: false,
      confirm: true,
      digest: pinned.digest,
    });
    expect(
      (await client.scenarioGraph("retention", "one")).objects[0].properties
        .amount,
    ).toBe(1);
    await client.discardScenario("retention", "one");
    const free = await client.vacuum("retention", args);
    expect(free.watermark).toBe(h.revision);
    expect(free.protectedBranches).toEqual([]);
  });
  it("reclaims an unused copy base while a same-revision overlay remains", async () => {
    await seed("mixed");
    const copy = await client.createScenario("mixed", {
      id: "copy",
      name: "Copy",
    });
    await client.createScenario("mixed", {
      id: "overlay",
      name: "Overlay",
      strategy: "overlay",
    });
    expect(await db.list()).toContain(copy.baseGraphKey);
    await client.discardScenario("mixed", "copy");
    expect(await store.documents("base", "mixed")).toEqual([]);
    expect(await db.list()).not.toContain(copy.baseGraphKey);
    expect(
      (await client.scenarioGraph("mixed", "overlay")).objects,
    ).toHaveLength(3);
    expect(
      (await client.backup("mixed")).documents.some((d) => d.kind === "base"),
    ).toBe(true);
  });
  it("exports portable base/deltas and restores as independent copy branches", async () => {
    await seed("backup");
    await client.createScenario("backup", {
      id: "one",
      name: "One",
      strategy: "overlay",
    });
    await client.patchScenarioObject("backup", "one", "a", {
      expectedVersion: 0,
      properties: { amount: 8 },
    });
    await client.patchObject("backup", "a", { properties: { amount: 20 } });
    const archive = await client.backup("backup");
    expect(archive.documents.some((d) => d.kind === "base")).toBe(true);
    await client.restore(
      "backup",
      archive,
      (await client.snapshot("backup")).revision,
    );
    expect(
      (await client.scenarioGraph("backup", "one")).objects[0].properties
        .amount,
    ).toBe(8);
    expect((await client.scenario("backup", "one")).storage).toBe("falkordb");
    await new ScenarioService(store).initialize();
    const rows = await db
      .selectGraph(namespace)
      .query(
        "MATCH (s:BranchObject {ontology:'backup'}) RETURN count(s) AS count",
      );
    expect(rows.data).toEqual([{ count: 0 }]);
  });
});
