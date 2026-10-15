import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { FalkorDB } from "falkordb";
import { GraphStore, SourceService } from "@graph/core";
import { GraphClient } from "@graph/sdk";
import { ontologySchema, type SourceConfig } from "@graph/contracts";
import { createApp } from "../apps/api/src/app.js";
const suite = process.env.GRAPH_INTEGRATION === "1" ? describe : describe.skip;
suite("source-owned native relationship mappings", () => {
  let db: FalkorDB,
    store: GraphStore,
    app: ReturnType<typeof createApp>,
    client: GraphClient;
  const namespace = `source_links_${Date.now()}_${process.pid}`;
  const provenance = {
    source: "fixture",
    externalId: "fixture",
    observedAt: "2026-10-15T00:00:00Z",
  };
  const config = (id: string): SourceConfig => ({
    id,
    name: id,
    connector: "json",
    mapping: {
      type: "Part",
      idField: "id",
      objectIdField: "id",
      properties: { name: { field: "name" } },
      relationships: [
        {
          id: "supplier",
          type: "SUPPLIED_BY",
          target: { objectId: { field: "supplier" } },
        },
      ],
    },
  });
  const row = (id: string, supplier = "north") => ({ id, name: id, supplier });
  const seed = async (id: string) => {
    await client.register(
      ontologySchema.parse({
        id,
        name: id,
        objectTypes: ["Part", "Supplier"].map((name) => ({
          name,
          properties: { name: { type: "string", required: true } },
        })),
        relationshipTypes: [
          { name: "SUPPLIED_BY", from: "Part", to: "Supplier" },
        ],
      }),
    );
    await client.ingest(id, {
      objects: ["north", "south"].map((id) => ({
        id,
        type: "Supplier",
        properties: { name: id },
        provenance,
      })),
      relationships: [],
    });
  };
  const sync = (
    ontology: string,
    id: string,
    records: unknown[],
    dryRun = false,
  ) =>
    client.syncSource(ontology, id, {
      content: JSON.stringify(records),
      dryRun,
    });
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
    client = new GraphClient("http://links.test", async (url, init) => {
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
  it("previews and commits mapped objects, native edges, history and checkpoint together", async () => {
    await seed("preview");
    await client.registerSource("preview", config("parts"));
    const before = await client.snapshot("preview");
    const content = JSON.stringify([row("a"), row("b", "south")]);
    const preview = await client.syncSource("preview", "parts", {
      content,
      dryRun: true,
    });
    expect(preview.relationships?.added).toHaveLength(2);
    expect(await client.snapshot("preview")).toEqual(before);
    await expect(
      client.syncSource("preview", "parts", {
        content,
        expectedCheckpoint: "0".repeat(64),
      }),
    ).rejects.toMatchObject({ status: 409 });
    const result = await client.syncSource("preview", "parts", {
      content,
      expectedCheckpoint: preview.checkpoint,
      expectedRevision: before.revision,
    });
    const native = await db
      .selectGraph(namespace)
      .query(
        "MATCH (a:Object {ontology:'preview'})-[r:LINK]->(b:Object {ontology:'preview'}) RETURN a.id AS source,b.id AS target ORDER BY source",
      );
    expect(native.data).toEqual([
      { source: "a", target: "north" },
      { source: "b", target: "south" },
    ]);
    expect(
      (await client.stateAt("preview", { revision: before.revision }))
        .relationships,
    ).toEqual([]);
    expect(
      (await client.stateAt("preview", { revision: result.revision }))
        .relationships,
    ).toHaveLength(2);
    expect((await client.sources("preview"))[0].checkpoint).toBe(
      preview.checkpoint,
    );
    expect(
      (
        await client.runAlgorithm("preview", {
          algorithm: "shortest-path",
          source: "a",
          target: "north",
        })
      ).path?.objects,
    ).toEqual(["a", "north"]);
    const replay = await client.syncSource("preview", "parts", { content });
    expect(replay.revision).toBe(result.revision);
    expect(replay.relationships?.unchanged).toBe(2);
    expect(
      (await client.registerSource("preview", config("parts"))).version,
    ).toBeGreaterThan(0);
  });
  it("changes target endpoints under a stable edge ID with old visibility preserved", async () => {
    await seed("retarget");
    await client.registerSource("retarget", config("parts"));
    const first = await sync("retarget", "parts", [row("a")]);
    const updated = await sync("retarget", "parts", [row("a", "south")]);
    expect(updated.relationships?.updated).toEqual(first.relationships?.added);
    expect(
      (await client.stateAt("retarget", { revision: first.revision }))
        .relationships[0].to,
    ).toBe("north");
    expect((await client.snapshot("retarget")).relationships[0].to).toBe(
      "south",
    );
  });
  it("removes source-owned links before deleting their missing source objects", async () => {
    await seed("delete");
    await client.registerSource("delete", config("parts"));
    await sync("delete", "parts", [row("a")]);
    const removed = await sync("delete", "parts", []);
    expect(removed.removed).toEqual(["a"]);
    expect(removed.relationships?.removed).toHaveLength(1);
    expect((await client.snapshot("delete")).relationships).toEqual([]);
    expect((await client.object("delete", "north")).type).toBe("Supplier");
  });
  it("protects manual relationship edits and deletions instead of overwriting or resurrecting", async () => {
    await seed("manual");
    await client.registerSource("manual", config("parts"));
    await sync("manual", "parts", [row("a")]);
    const edge = (await client.snapshot("manual")).relationships[0];
    await client.putRelationship("manual", {
      ...edge,
      provenance: { ...edge.provenance, source: "manual-edit" },
    });
    await expect(sync("manual", "parts", [row("a")])).rejects.toMatchObject({
      status: 409,
    });
    await client.putRelationship("manual", edge);
    await client.deleteRelationship("manual", edge.id);
    const before = await client.snapshot("manual");
    await expect(sync("manual", "parts", [row("a")])).rejects.toMatchObject({
      status: 409,
    });
    await expect(sync("manual", "parts", [])).rejects.toMatchObject({
      status: 409,
    });
    expect(await client.snapshot("manual")).toEqual(before);
  });
  it("rejects invalid endpoints in preview without applying any objects or checkpoint", async () => {
    await seed("invalid");
    await client.registerSource("invalid", config("parts"));
    const before = await client.snapshot("invalid");
    await expect(
      sync("invalid", "parts", [row("a", "missing")], true),
    ).rejects.toMatchObject({ status: 422 });
    await expect(
      sync("invalid", "parts", [row("a", "bad id")]),
    ).rejects.toMatchObject({ status: 422 });
    expect(await client.snapshot("invalid")).toEqual(before);
    expect((await client.sources("invalid"))[0].checkpoint).toBeNull();
    const bad = config("wrong");
    bad.mapping.relationships![0].direction = "in";
    await expect(client.registerSource("invalid", bad)).rejects.toMatchObject({
      status: 422,
    });
    const duplicate = config("duplicate");
    duplicate.mapping.relationships!.push(duplicate.mapping.relationships![0]);
    await expect(
      client.registerSource("invalid", duplicate),
    ).rejects.toMatchObject({ status: 422 });
  });
  it("resolves shared identity targets across sources and incoming relationship mappings", async () => {
    await seed("shared");
    await client.registerSource("shared", {
      id: "suppliers",
      name: "Suppliers",
      connector: "json",
      mapping: {
        type: "Supplier",
        idField: "id",
        identityField: "key",
        properties: { name: { field: "name" } },
      },
    });
    await sync("shared", "suppliers", [
      { id: "supplier-row", key: " Meridian ", name: "Meridian" },
    ]);
    const parts = config("parts");
    parts.mapping.relationships![0].target = {
      type: "Supplier",
      identity: { field: "supplier" },
    };
    await client.registerSource("shared", parts);
    await sync("shared", "parts", [row("a", "MERIDIAN")]);
    const state = await client.snapshot("shared");
    const supplier = state.objects.find(
      (o) => o.properties.name === "Meridian",
    )!;
    expect(state.relationships[0].to).toBe(supplier.id);
    await client.registerSource("shared", {
      id: "incoming",
      name: "Incoming",
      connector: "json",
      mapping: {
        type: "Supplier",
        idField: "id",
        objectIdField: "id",
        properties: { name: { field: "name" } },
        relationships: [
          {
            id: "part",
            type: "SUPPLIED_BY",
            direction: "in",
            target: { objectId: { value: "a" } },
          },
        ],
      },
    });
    await sync("shared", "incoming", [{ id: "another", name: "Another" }]);
    expect(
      (await client.snapshot("shared")).relationships.some(
        (r) => r.from === "a" && r.to === "another",
      ),
    ).toBe(true);
  });
  it("treats an optional cleared reference as an edge-only snapshot change", async () => {
    await seed("optional");
    const source = config("parts");
    source.mapping.relationships![0].optional = true;
    await client.registerSource("optional", source);
    const first = await sync("optional", "parts", [row("a")]);
    const cleared = await sync("optional", "parts", [{ id: "a", name: "a" }]);
    expect(cleared.updated).toEqual([]);
    expect(cleared.removed).toEqual([]);
    expect(cleared.relationships?.removed).toHaveLength(1);
    expect(cleared.revision).toBe(first.revision + 1);
    expect((await client.object("optional", "a")).properties.name).toBe("a");
  });
  it("retains remote references when a scalar reference or whole row loses visibility", async () => {
    await seed("remote");
    let phase = "full";
    const source = config("notes");
    source.connector = "notion";
    source.connection = "notes";
    source.mapping.properties = { name: { field: "property:Name" } };
    source.mapping.relationships![0].optional = true;
    source.mapping.relationships![0].target = {
      objectId: { field: "property:Supplier" },
    };
    await client.registerSource("remote", source);
    const remote = new SourceService(
      store,
      async () =>
        Response.json({
          has_more: false,
          next_cursor: null,
          results:
            phase === "absent"
              ? []
              : [
                  {
                    object: "page",
                    id: "page-a",
                    url: "https://notion.so/page-a",
                    last_edited_time: "2026-10-15T00:00:00Z",
                    properties: {
                      Name: {
                        type: "title",
                        title: [{ plain_text: "Remote part" }],
                      },
                      Supplier: {
                        type: "rich_text",
                        rich_text:
                          phase === "full" ? [{ plain_text: "north" }] : [],
                      },
                    },
                  },
                ],
        }),
      {
        notes: {
          connector: "notion",
          resource: "0123456789abcdef0123456789abcdef",
          token: "fixture-token",
          ontologies: ["remote"],
        },
      },
    );
    await remote.sync("remote", "notes", { dryRun: false });
    const before = await client.snapshot("remote");
    phase = "empty-ref";
    await remote.sync("remote", "notes", { dryRun: false });
    expect(await client.snapshot("remote")).toEqual(before);
    phase = "absent";
    await remote.sync("remote", "notes", { dryRun: false });
    expect(await client.snapshot("remote")).toEqual(before);
  });
  it("rejects wrong endpoint types in preview and caps generated relationships atomically", async () => {
    await seed("bounded");
    await client.registerSource("bounded", config("parts"));
    const before = await client.snapshot("bounded");
    await expect(
      sync("bounded", "parts", [row("a"), row("b", "a")], true),
    ).rejects.toMatchObject({ status: 422 });
    expect(await client.snapshot("bounded")).toEqual(before);
    const source = config("many");
    source.mapping.relationships = Array.from({ length: 10 }, (_, i) => ({
      id: `mapping-${i}`,
      type: "SUPPLIED_BY",
      target: { objectId: { value: "north" } },
    }));
    await client.registerSource("bounded", source);
    await expect(
      sync(
        "bounded",
        "many",
        Array.from({ length: 501 }, (_, i) => row(`part-${i}`)),
      ),
    ).rejects.toMatchObject({ status: 422 });
    expect(await client.snapshot("bounded")).toEqual(before);
  });
  it("preserves unrelated manual links and blocks deletion that would leave dangling edges", async () => {
    await seed("linked");
    await client.registerSource("linked", config("parts"));
    await sync("linked", "parts", [row("a")]);
    await client.putRelationship("linked", {
      id: "manual-edge",
      type: "SUPPLIED_BY",
      from: "a",
      to: "south",
      provenance,
    });
    const before = await client.snapshot("linked");
    await expect(sync("linked", "parts", [])).rejects.toMatchObject({
      status: 409,
    });
    expect(await client.snapshot("linked")).toEqual(before);
  });
});
