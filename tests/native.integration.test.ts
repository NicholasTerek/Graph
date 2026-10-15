import { beforeAll, afterAll, describe, it, expect, vi } from "vitest";
import { FalkorDB } from "falkordb";
import { GraphStore, ScenarioService } from "@graph/core";
import { ontologySchema, type Scenario } from "@graph/contracts";
import { GraphClient } from "@graph/sdk";
import { createApp } from "../apps/api/src/app.js";
import { GraphAgent } from "../packages/agent/src/index.js";
const suite = process.env.GRAPH_INTEGRATION === "1" ? describe : describe.skip;
suite("native graphs and algorithm tools", () => {
  let db: FalkorDB,
    store: GraphStore,
    app: ReturnType<typeof createApp>,
    client: GraphClient;
  const namespace = `native_${Date.now()}_${process.pid}`;
  const transport =
    (target: ReturnType<typeof createApp>): typeof fetch =>
    async (url, init) => {
      const response = await target.inject({
        method: (init?.method ?? "GET") as "GET",
        url: new URL(String(url)).pathname,
        headers: init?.headers as Record<string, string>,
        payload: init?.body as string | undefined,
      });
      return new Response(response.statusCode === 204 ? null : response.body, {
        status: response.statusCode,
      });
    };
  const provenance = {
    source: "test",
    externalId: "test",
    observedAt: "2026-10-15T00:00:00Z",
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
    client = new GraphClient("http://localhost", transport(app));
    for (const id of ["network", "other"]) {
      await client.register(
        ontologySchema.parse({
          id,
          name: id,
          objectTypes: [
            {
              name: "Record",
              properties: { name: { type: "string", required: true } },
            },
          ],
          relationshipTypes: [
            { name: "DEPENDS_ON", from: "Record", to: "Record" },
          ],
        }),
      );
      await client.ingest(id, {
        objects: ["a", "b", "c", "d"].map((id) => ({
          id,
          type: "Record",
          properties: { name: id },
          provenance,
        })),
        relationships: (id === "network"
          ? [
              ["a", "b"],
              ["b", "c"],
              ["c", "d"],
              ["a", "c"],
            ]
          : [["d", "a"]]
        ).map(([from, to]) => ({
          id: `${from}-${to}`,
          from,
          to,
          type: "DEPENDS_ON",
          provenance,
        })),
      });
    }
  });
  afterAll(async () => {
    if (app) await app.close();
    if (db) {
      await store.nativeGraphs.collect(new Set());
      await db.selectGraph(namespace).delete();
      await db.close();
    }
  });
  it("runs bounded native algorithms on the requested ontology only", async () => {
    expect((await client.algorithms("network")).map((x) => x.id)).toEqual([
      "shortest-path",
      "pagerank",
      "betweenness",
      "degree",
    ]);
    const path = await client.runAlgorithm("network", {
      algorithm: "shortest-path",
      source: "a",
      target: "d",
    });
    expect(path.path).toEqual({
      objects: ["a", "c", "d"],
      relationships: ["a-c", "c-d"],
      hops: 2,
    });
    expect(
      (
        await client.runAlgorithm("network", {
          algorithm: "shortest-path",
          source: "a",
          target: "d",
          maxDepth: 1,
        })
      ).path,
    ).toBeNull();
    expect(
      (
        await client.runAlgorithm("network", {
          algorithm: "shortest-path",
          source: "a",
          target: "a",
        })
      ).path?.hops,
    ).toBe(0);
    expect(
      (
        await client.runAlgorithm("network", {
          algorithm: "shortest-path",
          source: "d",
          target: "a",
          direction: "in",
        })
      ).path?.hops,
    ).toBe(2);
    await expect(
      client.runAlgorithm("network", {
        algorithm: "shortest-path",
        source: "a",
        target: "d",
        direction: "both",
      }),
    ).rejects.toMatchObject({ status: 400 });
    const rank = await client.runAlgorithm("network", {
      algorithm: "pagerank",
      limit: 100,
    });
    expect(rank.engine).toBe("falkordb");
    expect(rank.rows[0].id).toBe("d");
    expect(rank.rows.reduce((a, r) => a + r.score, 0)).toBeCloseTo(1, 5);
    expect(
      (await client.runAlgorithm("other", { algorithm: "pagerank" })).rows[0]
        .id,
    ).toBe("a");
    const between = await client.runAlgorithm("network", {
      algorithm: "betweenness",
      samplingSize: 128,
    });
    expect(between.rows[0].id).toBe("c");
    expect(between.rows[0].score).toBeGreaterThan(0);
    expect(
      (
        await client.runAlgorithm("network", {
          algorithm: "betweenness",
          samplingSize: 128,
        })
      ).rows,
    ).toEqual(between.rows);
    expect(
      (
        await client.runAlgorithm("network", {
          algorithm: "degree",
          direction: "both",
        })
      ).rows[0],
    ).toEqual({ id: "c", score: 3 });
    await expect(
      client.runAlgorithm("network", {
        algorithm: "shortest-path",
        source: "missing",
        target: "d",
      }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      client.runAlgorithm("network", { algorithm: "shortest-path" }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      client.runAlgorithm("network", { algorithm: "degree", limit: 1000 }),
    ).rejects.toMatchObject({ status: 400 });
  });
  it("supports empty native branches and returns empty rankings without metadata nodes", async () => {
    await client.register(
      ontologySchema.parse({
        id: "empty",
        name: "Empty",
        objectTypes: [
          {
            name: "Record",
            properties: { name: { type: "string", required: true } },
          },
        ],
        relationshipTypes: [],
      }),
    );
    const branch = await client.createScenario("empty", {
      id: "empty-branch",
      name: "Empty branch",
    });
    expect((await client.scenarioGraph("empty", branch.id)).objects).toEqual(
      [],
    );
    for (const algorithm of ["pagerank", "betweenness", "degree"] as const)
      expect(
        (await client.runAlgorithm("empty", { algorithm, scenario: branch.id }))
          .rows,
      ).toEqual([]);
    await client.discardScenario("empty", branch.id);
    expect(await db.list()).not.toContain(branch.graphKey);
  });
  it("stores real branch nodes/edges and queries changed topology without changing live or sibling state", async () => {
    const a = await client.createScenario("network", {
      id: "branch-a",
      name: "First",
    });
    const b = await client.createScenario("network", {
      id: "branch-b",
      name: "Second",
    });
    expect(a.storage).toBe("falkordb");
    expect(a.baseGraphKey).toBe(b.baseGraphKey);
    expect(a.graphKey).not.toBe(b.graphKey);
    const base = await store.document<Record<string, unknown>>(
      "base",
      "network",
      String(a.baseRevision),
    );
    expect(base?.storage).toBe("falkordb");
    expect(base).not.toHaveProperty("objects");
    const raw = await store.document<Scenario>("scenario", "network", a.id);
    expect(raw?.overlay.objects).toEqual([]);
    const changed = await client.editScenario("network", a.id, {
      expectedVersion: 0,
      removeRelationships: ["a-c"],
    });
    expect(changed.graphKey).not.toBe(a.graphKey);
    const native = await store.nativeGraphs.query(
      "network",
      changed.graphKey!,
      "MATCH (a:Object)-[r:LINK]->(b:Object) RETURN a.id AS source,r.id AS edge,b.id AS target ORDER BY edge",
    );
    expect(native).toHaveLength(3);
    expect(native.some((r) => r.edge === "a-c")).toBe(false);
    for (const [scenario, hops] of [
      [a.id, 3],
      [b.id, 2],
      [undefined, 2],
    ] as const)
      expect(
        (
          await client.runAlgorithm("network", {
            algorithm: "shortest-path",
            scenario,
            source: "a",
            target: "d",
          })
        ).path?.hops,
      ).toBe(hops);
    const preview = await client.reviewScenario("network", a.id);
    await client.promoteScenario("network", a.id, {
      expectedVersion: 1,
      expectedRevision: preview.liveRevision,
      objects: [],
      relationships: ["a-c"],
      confirm: true,
    });
    expect(
      (
        await client.runAlgorithm("network", {
          algorithm: "shortest-path",
          source: "a",
          target: "d",
        })
      ).path?.hops,
    ).toBe(3);
  });
  it("leaves the published branch intact when an edit fails before pointer publication", async () => {
    const before = await client.scenario("network", "branch-b");
    const failure = vi
      .spyOn(store, "saveDocument")
      .mockRejectedValueOnce(new Error("Simulated metadata failure"));
    await expect(
      client.patchScenarioObject("network", before.id, "a", {
        properties: { name: "unpublished" },
        expectedVersion: before.version,
      }),
    ).rejects.toMatchObject({ status: 500 });
    failure.mockRestore();
    expect((await client.scenario("network", before.id)).graphKey).toBe(
      before.graphKey,
    );
    expect(
      (await client.scenarioGraph("network", before.id)).objects.find(
        (o) => o.id === "a",
      )!.properties.name,
    ).toBe("a");
    expect(
      (await new ScenarioService(store).initialize()).length,
    ).toBeGreaterThan(0);
  });
  it("recovers a committed pointer after a lost acknowledgment and prunes the abandoned graph", async () => {
    const before = await client.scenario("network", "branch-b");
    const original = store.saveDocument.bind(store);
    const failure = vi
      .spyOn(store, "saveDocument")
      .mockImplementationOnce(async (...args) => {
        await original(...args);
        throw new Error("Lost response after metadata commit");
      });
    await expect(
      client.patchScenarioObject("network", before.id, "a", {
        properties: { name: "committed" },
        expectedVersion: before.version,
      }),
    ).rejects.toMatchObject({ status: 500 });
    failure.mockRestore();
    const restarted = new ScenarioService(new GraphStore(db, namespace));
    expect((await restarted.initialize()).length).toBeGreaterThan(0);
    const state = await restarted.state("network", before.id);
    expect(state.scenarioVersion).toBe(before.version + 1);
    expect(state.objects.find((o) => o.id === "a")!.properties.name).toBe(
      "committed",
    );
  });
  it("exports portable branches, restores them and migrates old JSON bases without changing versions", async () => {
    const before = await client.scenarioGraph("network", "branch-b");
    const archive = await client.backup("network");
    expect(JSON.stringify(archive)).not.toContain("graphKey");
    await client.patchScenarioObject("network", "branch-b", "a", {
      properties: { name: "later" },
      expectedVersion: before.scenarioVersion,
    });
    const revision = (await client.snapshot("network")).revision;
    await client.restore("network", archive, revision);
    const restored = await client.scenarioGraph("network", "branch-b");
    expect(restored).toEqual(before);
    const raw = await store.document<Scenario>(
      "scenario",
      "network",
      "branch-b",
    );
    expect(raw?.storage).toBe("falkordb");
    expect(
      (
        await client.runAlgorithm("network", {
          algorithm: "shortest-path",
          scenario: "branch-b",
          source: "a",
          target: "d",
        })
      ).path?.hops,
    ).toBe(2);
  });
  it("permits algorithm tools to read-only credentials and rejects cross-ontology access", async () => {
    const token = "read-native-algorithms-test-token";
    const secured = createApp(store, {
      security: {
        tokens: [
          { name: "reader", token, scopes: ["read"], ontologies: ["network"] },
        ],
      },
    });
    await secured.ready();
    const reader = new GraphClient("http://localhost", transport(secured), {
      token,
    });
    try {
      expect(
        (
          await reader.runAlgorithm("network", {
            algorithm: "pagerank",
            scenario: "branch-b",
          })
        ).rows.length,
      ).toBe(4);
      await expect(
        reader.runAlgorithm("other", { algorithm: "pagerank" }),
      ).rejects.toMatchObject({ status: 403 });
      await expect(
        reader.patchScenarioObject("network", "branch-b", "a", {
          properties: { name: "bad" },
          expectedVersion: 0,
        }),
      ).rejects.toMatchObject({ status: 403 });
      let calls = 0;
      const agent = new GraphAgent(reader, {
        complete: async (_messages, tools) => {
          expect(tools.some((t) => t.function.name === "graph_algorithm")).toBe(
            true,
          );
          if (calls++ === 0)
            return {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "rank",
                  type: "function",
                  function: {
                    name: "graph_algorithm",
                    arguments: JSON.stringify({
                      algorithm: "pagerank",
                      scenario: "branch-b",
                    }),
                  },
                },
              ],
            };
          return { role: "assistant", content: "Topology inspected" };
        },
      });
      const result = await agent.investigate(
        "network",
        { question: "Rank dependencies", maxSteps: 3 },
        async () => {},
      );
      expect(result.traces[0].name).toBe("graph_algorithm");
      expect(result.traces[0].error).toBeUndefined();
      expect(result.status).toBe("completed");
      expect(result.error).toBeUndefined();
    } finally {
      await secured.close();
    }
  });
  it("removes native scenario keys on discard without deleting live state", async () => {
    const branch = await client.scenario("network", "branch-b");
    await client.discardScenario("network", branch.id);
    expect(await db.list()).not.toContain(branch.graphKey);
    expect((await client.snapshot("network")).objects).toHaveLength(4);
    expect(
      (await client.scenarioGraph("network", "branch-a")).objects,
    ).toHaveLength(4);
  });
});
