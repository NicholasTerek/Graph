import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { FalkorDB } from "falkordb";
import { GraphStore, defineFunction, type FunctionContext } from "@graph/core";
import { GraphClient } from "@graph/sdk";
import { ontologySchema } from "@graph/contracts";
import { z } from "zod";
import { createApp } from "../apps/api/src/app.js";
import { dependencyFixture } from "../scripts/lib/dependency-fixture.js";
const suite = process.env.GRAPH_INTEGRATION === "1" ? describe : describe.skip;
suite("bounded consistent function inputs", () => {
  let db: FalkorDB,
    store: GraphStore,
    app: ReturnType<typeof createApp>,
    client: GraphClient;
  const namespace = `scope_${Date.now()}_${process.pid}`;
  const input = z.object({
    root: z.string(),
    direction: z.enum(["out", "in", "both"]),
    depth: z.number().int().min(1).max(5),
  });
  const output = z.object({ ids: z.array(z.string()), total: z.number() });
  const execute = ({ graph }: FunctionContext, args: z.infer<typeof input>) => {
    const seen = new Set([args.root]);
    let frontier = [args.root];
    for (let level = 0; level < args.depth; level++) {
      const next: string[] = [];
      for (const id of frontier)
        for (const direction of args.direction === "both"
          ? (["out", "in"] as const)
          : [args.direction])
          for (const object of graph.related(id, "DEPENDS_ON", direction))
            if (!seen.has(object.id)) {
              seen.add(object.id);
              next.push(object.id);
            }
      frontier = next;
    }
    return {
      ids: [...seen].sort(),
      total: [...seen].reduce(
        (sum, id) => sum + Number(graph.object(id).properties.durationDays),
        0,
      ),
    };
  };
  const schema = (id: string) =>
    ontologySchema.parse({
      id,
      name: id,
      objectTypes: [
        {
          name: "Task",
          properties: {
            name: { type: "string", required: true },
            durationDays: { type: "number", required: true },
          },
        },
      ],
      relationshipTypes: [{ name: "DEPENDS_ON", from: "Task", to: "Task" }],
    });
  beforeAll(async () => {
    db = await FalkorDB.connect({
      socket: {
        host: "127.0.0.1",
        port: Number(process.env.FALKORDB_PORT ?? 6379),
      },
    });
    store = new GraphStore(db, namespace);
    await store.initialize();
    app = createApp(store, {
      functions: ["chain", "bounded", "hub", "budget"].flatMap((shape) =>
        [false, true].map((scoped) =>
          defineFunction({
            id: scoped ? "scoped" : "full",
            ontology: `scope-${shape}`,
            name: "Dependency total",
            description: "Equivalent captured dependency calculation",
            input,
            output,
            execute,
            ...(scoped ? { scope: (args: z.infer<typeof input>) => args } : {}),
          }),
        ),
      ),
    });
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
      await store.nativeGraphs.collect(new Set());
      await db.selectGraph(namespace).delete();
      await db.close();
    }
  });
  for (const shape of ["chain", "bounded", "hub"] as const)
    it(`preserves ${shape} outputs across live, historical, copy and overlay reads`, async () => {
      const id = `scope-${shape}`,
        fixture = dependencyFixture(10, shape);
      await client.register(schema(id));
      await client.ingest(id, fixture);
      const args = {
        root: shape === "hub" ? "task-0" : "task-9",
        direction: shape === "hub" ? ("in" as const) : ("out" as const),
        depth: 2,
      };
      const pin = await client.createReadSnapshot(id);
      const baseline = await client.runFunction(id, "full", args);
      expect((baseline.output as { ids: string[] }).ids).toHaveLength(
        shape === "chain" ? 3 : shape === "bounded" ? 7 : 10,
      );
      const live = await client.runFunction(id, "scoped", args);
      expect(live.output).toEqual(baseline.output);
      expect(live.inputScope?.objects).toBe(
        (baseline.output as { ids: string[] }).ids.length,
      );
      for (const strategy of ["copy", "overlay"] as const) {
        await client.createScenario(id, {
          id: strategy,
          name: strategy,
          strategy,
        });
        await client.patchScenarioObject(id, strategy, args.root, {
          expectedVersion: 0,
          properties: { durationDays: 99 },
        });
        const scoped = await client.runFunction(id, "scoped", args, strategy);
        expect(scoped.output).toEqual(
          (await client.runFunction(id, "full", args, strategy)).output,
        );
        expect(scoped.scenarioVersion).toBe(1);
        expect(scoped.inputScope?.materialization).toBe(
          strategy === "copy" ? "native-slice" : "overlay-full-read",
        );
      }
      await client.patchObject(id, args.root, {
        properties: { durationDays: 55 },
      });
      const historical = await client.runFunction(
        id,
        "scoped",
        args,
        undefined,
        { snapshot: pin.id },
      );
      expect(historical.output).toEqual(baseline.output);
      expect(historical.history?.revision).toBe(pin.revision);
      expect(live.evidence?.objects).toEqual(baseline.evidence?.objects);
      await client.releaseReadSnapshot(id, pin.id);
    });
  it("fails oversized dependency slices explicitly instead of calculating a partial answer", async () => {
    const id = "scope-budget",
      fixture = dependencyFixture(2001, "hub");
    await client.register(schema(id));
    for (let start = 0; start < fixture.objects.length; start += 1000) {
      const objects = fixture.objects.slice(start, start + 1000),
        ids = new Set(objects.map((o) => o.id));
      await client.ingest(id, {
        objects,
        relationships: fixture.relationships.filter((r) => ids.has(r.from)),
      });
    }
    const args = { root: "task-0", direction: "in" as const, depth: 1 };
    await expect(client.runFunction(id, "scoped", args)).rejects.toMatchObject({
      status: 422,
    });
    const pin = await client.createReadSnapshot(id);
    await expect(
      client.runFunction(id, "scoped", args, undefined, { snapshot: pin.id }),
    ).rejects.toMatchObject({ status: 422 });
    for (const strategy of ["copy", "overlay"] as const) {
      await client.createScenario(id, {
        id: strategy,
        name: strategy,
        strategy,
      });
      await expect(
        client.runFunction(id, "scoped", args, strategy),
      ).rejects.toMatchObject({ status: 422 });
    }
    await client.releaseReadSnapshot(id, pin.id);
  });
});
