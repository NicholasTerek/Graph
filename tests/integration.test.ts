import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { FalkorDB } from "falkordb";
import { GraphStore } from "@graph/core";
import { createApp } from "../apps/api/src/app.js";
import { ontologySchema, ingestionSchema } from "@graph/contracts";
const suite = process.env.GRAPH_INTEGRATION === "1" ? describe : describe.skip;
suite("FalkorDB platform integration", () => {
  let store: GraphStore;
  let app: ReturnType<typeof createApp>;
  let db: FalkorDB;
  const graphName = `test_${Date.now()}_${process.pid}`;
  const ontology = ontologySchema.parse(
    JSON.parse(readFileSync("examples/library/ontology.json", "utf8")),
  );
  const data = ingestionSchema.parse(
    JSON.parse(readFileSync("examples/library/data.json", "utf8")),
  );
  beforeAll(async () => {
    db = await FalkorDB.connect({
      socket: {
        host: process.env.FALKORDB_HOST ?? "127.0.0.1",
        port: Number(process.env.FALKORDB_PORT ?? 6379),
      },
    });
    store = new GraphStore(db, graphName);
    await store.initialize();
    await store.initialize();
    app = createApp(store);
    await app.ready();
  });
  afterAll(async () => {
    await app?.close();
    if (db) {
      await db.selectGraph(graphName).delete();
      await db.close();
    }
  });
  it("reports a real graph connection", async () =>
    expect((await app.inject("/api/health")).json()).toEqual({
      status: "ok",
      database: "FalkorDB",
    }));
  it("registers, persists, and introspects arbitrary ontologies", async () => {
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/ontologies",
          payload: ontology,
        })
      ).statusCode,
    ).toBe(201);
    expect((await app.inject("/api/ontologies")).json()).toEqual([ontology]);
    expect((await store.ontology(ontology.id)).name).toBe("City Library");
  });
  it("rejects incompatible schema replacement", async () =>
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/ontologies",
          payload: { ...ontology, name: "Changed" },
        })
      ).statusCode,
    ).toBe(409));
  it("ingests and replays records without duplicates", async () => {
    for (let i = 0; i < 2; i++)
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/api/ontologies/library/ingest",
            payload: data,
          })
        ).json(),
      ).toEqual({ objects: 2, relationships: 1 });
    expect((await store.snapshot("library")).objects).toHaveLength(2);
    expect((await store.snapshot("library")).relationships).toHaveLength(1);
  });
  it("traverses stored edges with direction and bounded depth", async () => {
    const outgoing = await app.inject(
      "/api/ontologies/library/traverse?root=book-1&direction=out&depth=1",
    );
    expect(outgoing.statusCode).toBe(200);
    expect(outgoing.json().objects).toHaveLength(2);
    expect(outgoing.json().relationships).toEqual(data.relationships);
    expect(
      (await store.traverse("library", "book-1", 1, "in")).objects,
    ).toHaveLength(1);
    expect(
      (await store.traverse("library", "author-1", 1, "in")).objects,
    ).toHaveLength(2);
    expect(
      (
        await app.inject(
          "/api/ontologies/library/traverse?root=book-1&depth=20",
        )
      ).statusCode,
    ).toBe(400);
  });
  it("validates the entire ingestion before writing", async () => {
    const candidate = { ...data.objects[0], id: "should-not-exist" };
    const response = await app.inject({
      method: "POST",
      url: "/api/ontologies/library/ingest",
      payload: {
        objects: [candidate],
        relationships: [{ ...data.relationships[0], id: "bad", to: "missing" }],
      },
    });
    expect(response.statusCode).toBe(422);
    await expect(store.object("library", candidate.id)).rejects.toThrow(
      "not found",
    );
  });
  it("keeps ontology IDs isolated", async () => {
    await store.register({ ...ontology, id: "other" });
    await store.ingest("other", data);
    await store.ingest("other", {
      objects: [
        {
          ...data.objects[0],
          properties: { name: "Other book", status: "lost" },
        },
      ],
      relationships: [],
    });
    expect((await store.object("library", "book-1")).properties.name).toBe(
      "The Connected City",
    );
    expect(
      (await store.traverse("library", "book-1", 3, "both")).objects,
    ).toHaveLength(2);
  });
  it("round-trips quotes and Cypher-looking text as data", async () => {
    const name = "A quote ' and $param MATCH (n) DELETE n";
    await store.ingest("library", {
      objects: [
        { ...data.objects[0], properties: { name, status: "available" } },
      ],
      relationships: [],
    });
    expect((await store.object("library", "book-1")).properties.name).toBe(
      name,
    );
  });
  it("serializes conflicting writes in one API process", async () => {
    const results = await Promise.allSettled([
      store.register({ ...ontology, id: "race", name: "First" }),
      store.register({ ...ontology, id: "race", name: "Second" }),
    ]);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "rejected"]);
  });
  it("provides object replacement and controlled deletion", async () => {
    const changed = {
      ...data.objects[0],
      properties: { name: "Revised book", status: "borrowed" },
    };
    expect(
      (
        await app.inject({
          method: "PUT",
          url: "/api/ontologies/library/objects/book-1",
          payload: changed,
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (await app.inject("/api/ontologies/library/objects/book-1")).json(),
    ).toEqual(changed);
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: "/api/ontologies/library/objects/book-1",
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: "/api/ontologies/library/relationships/written-1",
        })
      ).statusCode,
    ).toBe(204);
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: "/api/ontologies/library/objects/book-1",
        })
      ).statusCode,
    ).toBe(204);
    expect(
      (await app.inject("/api/ontologies/library/objects/book-1")).statusCode,
    ).toBe(404);
  });
  it("persists both example domains using only public API routes", async () => {
    const schema = JSON.parse(
      readFileSync("examples/semiconductor/ontology.json", "utf8"),
    );
    const seed = JSON.parse(
      readFileSync("examples/semiconductor/data.json", "utf8"),
    );
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/ontologies",
          payload: schema,
        })
      ).statusCode,
    ).toBe(201);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/ontologies/semiconductor/ingest",
          payload: seed,
        })
      ).statusCode,
    ).toBe(200);
    const traversal = (
      await app.inject(
        "/api/ontologies/semiconductor/traverse?root=aquila-x900&direction=out&depth=3",
      )
    ).json();
    expect(traversal.objects.map((o: { id: string }) => o.id)).toEqual(
      expect.arrayContaining([
        "northstar",
        "gpu-142",
        "customer-orbit",
        "graphics-team",
      ]),
    );
  });
});
