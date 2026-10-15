import { beforeAll, afterAll, describe, it, expect, vi } from "vitest";
import { createHash } from "node:crypto";
import { FalkorDB } from "falkordb";
import { GraphStore } from "@graph/core";
import { GraphClient } from "@graph/sdk";
import { ontologySchema, type BackupArchive } from "@graph/contracts";
import { canonical } from "../packages/core/src/state.js";
import { createApp } from "../apps/api/src/app.js";
const suite = process.env.GRAPH_INTEGRATION === "1" ? describe : describe.skip;
suite("retained temporal history archives", () => {
  let db: FalkorDB,
    store: GraphStore,
    app: ReturnType<typeof createApp>,
    client: GraphClient;
  const namespace = `history_backup_${Date.now()}_${process.pid}`;
  const ontology = "archive";
  const provenance = {
    source: "fixture",
    externalId: "test",
    observedAt: "2026-10-15T00:00:00Z",
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
    await client.register(
      ontologySchema.parse({
        id: ontology,
        name: "Archive",
        objectTypes: [
          {
            name: "Record",
            properties: { name: { type: "string", required: true } },
          },
        ],
        relationshipTypes: [{ name: "NEXT", from: "Record", to: "Record" }],
      }),
    );
    await client.ingest(ontology, {
      objects: ["a", "b"].map((id) => ({
        id,
        type: "Record",
        properties: { name: id },
        provenance,
      })),
      relationships: [
        { id: "a-b", type: "NEXT", from: "a", to: "b", provenance },
      ],
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
  const resign = (archive: BackupArchive) => {
    const { digest: _, ...payload } = archive;
    return {
      ...payload,
      digest: createHash("sha256").update(canonical(payload)).digest("hex"),
    };
  };
  it("restores every retained state and edge interval under a fresh generation, including portable overlay dependencies", async () => {
    const first = await client.stateAt(ontology);
    await client.patchObject(ontology, "a", {
      properties: { name: "updated" },
    });
    const second = await client.stateAt(ontology);
    await client.deleteRelationship(ontology, "a-b");
    await client.deleteObject(ontology, "b");
    const head = await client.stateAt(ontology);
    await client.createScenario(ontology, {
      id: "overlay",
      name: "Overlay",
      strategy: "overlay",
    });
    await client.patchScenarioObject(ontology, "overlay", "a", {
      properties: { name: "branch" },
      expectedVersion: 0,
    });
    const pin = await client.createReadSnapshot(ontology);
    const archive = await client.backup(ontology, { includeHistory: true });
    expect(archive.format).toBe("graph-backup-v2");
    await client.patchObject(ontology, "a", { properties: { name: "later" } });
    const beforeRestore = (await client.snapshot(ontology)).revision;
    await client.restore(ontology, archive, beforeRestore);
    const restored = await client.stateAt(ontology);
    expect(restored.generation).not.toBe(head.generation);
    expect(restored.revision).toBeGreaterThan(beforeRestore);
    expect(restored.retainedFrom).toBe(archive.temporal!.retainedFrom);
    for (const saved of [first, second, head]) {
      const historical = await client.stateAt(ontology, {
        revision: saved.revision,
        generation: restored.generation,
      });
      expect(historical.objects).toEqual(saved.objects);
      expect(historical.relationships).toEqual(saved.relationships);
    }
    await expect(
      client.stateAt(ontology, { snapshot: pin.id }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      client.stateAt(ontology, {
        generation: head.generation,
        revision: head.revision,
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(
      (await client.scenarioGraph(ontology, "overlay")).objects[0].properties
        .name,
    ).toBe("branch");
    expect((await client.scenario(ontology, "overlay")).storage).toBe(
      "falkordb",
    );
    await client.patchObject(ontology, "a", {
      properties: { name: "after restore" },
    });
    expect(
      (await client.stateAt(ontology, { revision: restored.revision })).objects,
    ).toEqual(head.objects);
    const byTime = await client.stateAt(ontology, { at: first.committedAt });
    expect(byTime.revision).toBeGreaterThanOrEqual(first.revision);
  });
  it("rejects overlapping versions, uncovered endpoint intervals and mismatched heads without changing state", async () => {
    const archive = await client.backup(ontology, { includeHistory: true });
    const before = await client.stateAt(ontology);
    for (const corrupt of [
      (a: BackupArchive) =>
        a.temporal!.objects.push(structuredClone(a.temporal!.objects[0])),
      (a: BackupArchive) => {
        a.temporal!.relationships[0].record.to = "missing";
      },
      (a: BackupArchive) => {
        a.temporal!.objects.find(
          (v) => v.validTo === null,
        )!.record.properties.name = "false head";
      },
      (a: BackupArchive) => {
        a.temporal!.commits.reverse();
      },
    ]) {
      const modified = structuredClone(archive);
      corrupt(modified);
      await expect(
        client.restore(ontology, resign(modified), before.revision),
      ).rejects.toMatchObject({ status: 422 });
      expect(await client.stateAt(ontology)).toEqual(before);
    }
  });
  it("rolls back operational data and imported versions together after a native runtime failure", async () => {
    const archive = await client.backup(ontology, { includeHistory: true });
    await client.patchObject(ontology, "a", {
      properties: { name: "must survive failed restore" },
    });
    const before = await client.stateAt(ontology);
    const target = store as unknown as {
      rows(q: string, p?: Record<string, unknown>): Promise<unknown[]>;
    };
    const original = target.rows.bind(store);
    const injected = vi.spyOn(target, "rows").mockImplementation((q, p) =>
      original(
        q,
        p?.importObjects
          ? {
              ...p,
              importObjects: [
                ...(p.importObjects as unknown[]),
                { id: "bad", native: { invalid: { nested: true } } },
              ],
            }
          : p,
      ),
    );
    try {
      await expect(
        client.restore(ontology, archive, before.revision),
      ).rejects.toThrow();
    } finally {
      injected.mockRestore();
    }
    expect(await client.stateAt(ontology)).toEqual(before);
  });
  it("preserves the retained boundary after vacuum and supports an empty history baseline", async () => {
    await client.discardScenario(ontology, "overlay");
    const before = await client.stateAt(ontology);
    const request = {
      generation: before.generation,
      expectedRevision: before.revision,
      retainFrom: before.revision,
      batchSize: 1000,
    };
    const preview = await client.vacuum(ontology, request);
    await client.vacuum(ontology, {
      ...request,
      dryRun: false,
      confirm: true,
      digest: preview.digest,
    });
    const pruned = await client.backup(ontology, { includeHistory: true });
    await client.restore(ontology, pruned, before.revision);
    expect((await client.stateAt(ontology)).retainedFrom).toBe(before.revision);
    await expect(
      client.stateAt(ontology, { revision: before.revision - 1 }),
    ).rejects.toMatchObject({ status: 410 });
    await client.register({ ...pruned.ontology, id: "empty-history" });
    const empty = await client.backup("empty-history", {
      includeHistory: true,
    });
    await client.restore("empty-history", empty, empty.revision);
    expect(
      (await client.stateAt("empty-history", { revision: empty.revision }))
        .objects,
    ).toEqual([]);
  });
});
