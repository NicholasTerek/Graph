import { beforeAll, afterAll, describe, it, expect, vi } from "vitest";
import { FalkorDB } from "falkordb";
import { GraphStore } from "@graph/core";
import { GraphClient } from "@graph/sdk";
import type { GraphSnapshot } from "@graph/contracts";
import { createApp } from "../apps/api/src/app.js";
import { exampleExtensions } from "../examples/server.js";
import {
  seedResolution,
  replayResolutionSources,
  resolutionFixtureFetch,
} from "../examples/entity-resolution/fixtures.js";
import { resolutionOntology as ontology } from "../examples/entity-resolution/model.js";
import type { ResolutionResult } from "../examples/entity-resolution/functions.js";
import {
  prepareResolution,
  prepareResolutionUndo,
  promoteResolution,
  type ResolutionReview,
} from "../examples/entity-resolution/workflow.js";
const suite = process.env.GRAPH_INTEGRATION === "1" ? describe : describe.skip;
suite("bounded reviewed supplier resolution", () => {
  let db: FalkorDB,
    store: GraphStore,
    app: ReturnType<typeof createApp>,
    client: GraphClient,
    review: ResolutionReview,
    aliases: string[],
    before: GraphSnapshot & { revision: number };
  const namespace = `resolution_${Date.now()}_${process.pid}`;
  const candidates = () =>
    client.runFunction<ResolutionResult>(ontology, "supplier-candidates", {});
  const assertNoDangling = (state: GraphSnapshot) => {
    const ids = new Set(state.objects.map((o) => o.id));
    expect(
      state.relationships.every((r) => ids.has(r.from) && ids.has(r.to)),
    ).toBe(true);
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
    app = createApp(store, {
      extensions: exampleExtensions(),
      connectorFetch: resolutionFixtureFetch,
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
    await seedResolution(client);
  });
  afterAll(async () => {
    await app?.close();
    if (db) {
      await store.nativeGraphs.collect(new Set());
      await db.selectGraph(namespace).delete();
      await db.close();
    }
  });
  it("scores three messy source spellings and rejects a plausible tied non-match", async () => {
    const run = await candidates(),
      matched = run.output.aliases.filter((a) => a.status === "matched");
    expect(matched.map((a) => a.sourceId).sort()).toEqual([
      "supplier-csv",
      "supplier-github",
      "supplier-json",
    ]);
    expect(matched.every((a) => a.canonicalId === "canonical-packaging")).toBe(
      true,
    );
    expect(matched.map((a) => a.candidates[0].score).sort()).toEqual([
      0.75, 1, 1,
    ]);
    const ambiguous = run.output.aliases.find(
      (a) => a.id === "supplier-ambiguous",
    )!;
    expect(ambiguous.status).toBe("ambiguous");
    expect(ambiguous.candidates.map((c) => c.canonicalId)).toEqual([
      "canonical-logistics",
      "canonical-packaging",
    ]);
    expect(ambiguous.candidates.every((c) => c.score === 2 / 3)).toBe(true);
    const native = await db
      .selectGraph(namespace)
      .roQuery<{
        count: number;
      }>("MATCH (:Object {ontology:'supplier-resolution'})-[r:LINK]->() WHERE r.type IN ['COMPONENT_REF','PRODUCT_REF','ISSUE_REF','LOCATION_REF'] RETURN count(r) AS count");
    expect(native.data?.[0].count).toBe(18);
    aliases = matched.map((a) => a.id);
    before = await client.snapshot(ontology);
  });
  it("keeps the ambiguity out of a prepared merge and leaves live data unchanged before review", async () => {
    await expect(
      prepareResolution(client, ["supplier-ambiguous"], "canonical-packaging"),
    ).rejects.toThrow("Ambiguous");
    review = await prepareResolution(client, aliases, "canonical-packaging");
    expect(await client.snapshot(ontology)).toEqual(before);
    await expect(promoteResolution(client, review, false)).rejects.toThrow(
      "confirmation",
    );
    expect(
      (
        await client.scenarioGraph(ontology, review.scenarioId)
      ).relationships.filter((r) => r.type === "RESOLVES_TO"),
    ).toHaveLength(3);
  });
  it("rolls back failed native promotion and publishes one atomic reviewed reference rewrite", async () => {
    const target = store as unknown as {
        rows(q: string, p?: Record<string, unknown>): Promise<unknown[]>;
      },
      original = target.rows.bind(store);
    const failure = vi
      .spyOn(target, "rows")
      .mockImplementation((q, p) =>
        original(
          q,
          p?.versionObjects && q.includes("UNWIND $versionObjects")
            ? {
                ...p,
                versionObjects: [
                  ...(p.versionObjects as unknown[]),
                  { id: "invalid", native: { bad: { nested: true } } },
                ],
              }
            : p,
        ),
      );
    try {
      await expect(
        promoteResolution(client, review, true),
      ).rejects.toMatchObject({ status: 500 });
    } finally {
      failure.mockRestore();
    }
    expect(await client.snapshot(ontology)).toEqual(before);
    const results = await Promise.allSettled([
      promoteResolution(client, review, true),
      promoteResolution(client, review, true),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.find((r) => r.status === "rejected")).toMatchObject({
      reason: { status: 409 },
    });
    const state = await client.snapshot(ontology);
    assertNoDangling(state);
    expect(
      state.relationships.filter(
        (r) => r.type === "ORDERED_FROM" && r.to === "canonical-packaging",
      ),
    ).toHaveLength(3);
    for (const id of aliases)
      expect(state.objects.find((o) => o.id === id)).toEqual(
        before.objects.find((o) => o.id === id),
      );
    expect(
      (await candidates()).output.aliases.filter(
        (a) => a.status === "resolved",
      ),
    ).toHaveLength(3);
    await replayResolutionSources(client);
    expect((await client.snapshot(ontology)).revision).toBe(state.revision);
  });
  it("retains portable reversal metadata through a full-history backup and restore", async () => {
    const archive = await client.backup(ontology, { includeHistory: true });
    await client.patchObject(ontology, "order-0", {
      properties: { name: "Temporary drill" },
    });
    await client.restore(
      ontology,
      archive,
      (await client.snapshot(ontology)).revision,
    );
    const undo = await prepareResolutionUndo(client, review.resolutionId);
    expect(
      undo.preview.changes.relationships.filter(
        (c) => c.before?.type === "ORDERED_FROM",
      ),
    ).toHaveLength(3);
    await client.discardScenario(ontology, undo.scenarioId);
  });
  it("refuses reversal over references changed after the merge", async () => {
    const state = await client.snapshot(ontology),
      edge = state.relationships.find(
        (r) => r.type === "ORDERED_FROM" && r.to === "canonical-packaging",
      )!;
    const rewrite = async (id: string, to: string) => {
      const branch = await client.createScenario(ontology, {
        id,
        name: id,
        expectedRevision: (await client.snapshot(ontology)).revision,
      });
      await client.editScenario(ontology, id, {
        expectedVersion: branch.version,
        relationships: [{ ...edge, to }],
      });
      const preview = await client.reviewScenario(ontology, id);
      await client.promoteScenario(ontology, id, {
        expectedVersion: preview.version,
        expectedRevision: preview.liveRevision,
        objects: [],
        relationships: [edge.id],
        confirm: true,
      });
    };
    await rewrite("new-reference", "canonical-logistics");
    await expect(
      prepareResolutionUndo(client, review.resolutionId),
    ).rejects.toThrow("overwrite newer work");
    await rewrite("restore-reference", "canonical-packaging");
  });
  it("requires fresh reversal review, preserves aliases/source replay and keeps merge audit history", async () => {
    const stale = await prepareResolutionUndo(client, review.resolutionId);
    await client.patchObject(ontology, "order-0", {
      properties: { name: "Newer order label" },
    });
    await expect(promoteResolution(client, stale, true)).rejects.toMatchObject({
      status: 409,
    });
    const undo = await prepareResolutionUndo(client, review.resolutionId);
    await promoteResolution(client, undo, true);
    const state = await client.snapshot(ontology);
    assertNoDangling(state);
    expect(state.relationships.filter((r) => r.type === "RESOLVES_TO")).toEqual(
      [],
    );
    expect(
      state.relationships
        .filter((r) => r.type === "ORDERED_FROM")
        .map((r) => [r.id, r.to]),
    ).toEqual(
      before.relationships
        .filter((r) => r.type === "ORDERED_FROM")
        .map((r) => [r.id, r.to]),
    );
    expect(
      state.objects.find((o) => o.id === review.resolutionId)!.properties
        .status,
    ).toBe("reverted");
    expect(state.objects.find((o) => o.id === "order-0")!.properties.name).toBe(
      "Newer order label",
    );
    expect(state.relationships.filter((r) => r.type === "MEMBER")).toHaveLength(
      3,
    );
    await replayResolutionSources(client);
    expect((await client.snapshot(ontology)).revision).toBe(state.revision);
  });
});
