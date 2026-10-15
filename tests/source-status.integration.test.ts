import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { FalkorDB } from "falkordb";
import { GraphStore } from "@graph/core";
import { GraphClient } from "@graph/sdk";
import { ontologySchema, type SourceConfig } from "@graph/contracts";
import { createApp } from "../apps/api/src/app.js";
const suite = process.env.GRAPH_INTEGRATION === "1" ? describe : describe.skip;
suite("redacted source connection status", () => {
  let db: FalkorDB,
    store: GraphStore,
    app: ReturnType<typeof createApp>,
    secured: ReturnType<typeof createApp>,
    client: GraphClient;
  let providerStatus = 401,
    calls = 0;
  const namespace = `source_status_${Date.now()}_${process.pid}`;
  const credential = "read-only-fixture-token-123456789";
  const transport =
    (target: ReturnType<typeof createApp>): typeof fetch =>
    async (url, init) => {
      const u = new URL(String(url));
      const r = await target.inject({
        method: (init?.method ?? "GET") as "GET",
        url: u.pathname + u.search,
        headers: init?.headers as Record<string, string>,
        payload: init?.body as string | undefined,
      });
      return new Response(r.statusCode === 204 ? null : r.body, {
        status: r.statusCode,
      });
    };
  const source = (
    id: string,
    connector: SourceConfig["connector"],
    connection?: string,
  ): SourceConfig => ({
    id,
    name: id,
    connector,
    connection,
    ...(connector === "github" ? { repository: "NicholasTerek/Graph" } : {}),
    mapping: {
      type: "Note",
      idField: "id",
      properties: { name: { field: "name" } },
    },
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
    const options = {
      sourceConnections: {
        notes: {
          connector: "notion" as const,
          token: "hidden-provider-secret",
          resource: "0123456789abcdef0123456789abcdef",
          ontologies: ["enabled"],
        },
      },
      connectorFetch: (async () => {
        calls++;
        return providerStatus === 200
          ? Response.json({ has_more: false, next_cursor: null, results: [] })
          : Response.json(
              { error: "hidden-provider-secret" },
              { status: providerStatus },
            );
      }) as typeof fetch,
    };
    app = createApp(store, options);
    await app.ready();
    client = new GraphClient("http://status.test", transport(app));
    for (const id of ["enabled", "restricted"])
      await client.register(
        ontologySchema.parse({
          id,
          name: id,
          objectTypes: [
            {
              name: "Note",
              properties: { name: { type: "string", required: true } },
            },
          ],
          relationshipTypes: [],
        }),
      );
    for (const config of [
      source("upload", "csv"),
      source("public", "github"),
      source("configured", "notion", "notes"),
      source("missing", "discord", "chat"),
      source("wrong-kind", "discord", "notes"),
    ])
      await client.registerSource("enabled", config);
    await client.registerSource(
      "restricted",
      source("denied", "notion", "notes"),
    );
    secured = createApp(store, {
      ...options,
      security: {
        tokens: [
          {
            name: "reader",
            token: credential,
            scopes: ["read"],
            ontologies: ["enabled"],
          },
        ],
      },
    });
    await secured.ready();
  });
  afterAll(async () => {
    await app?.close();
    await secured?.close();
    if (db) {
      await db.selectGraph(namespace).delete();
      await db.close();
    }
  });
  it("reports configuration without network probes or credentials and respects resource allowlists", async () => {
    const before = calls;
    const statuses = await client.sourceStatuses("enabled");
    expect(
      Object.fromEntries(statuses.map((s) => [s.sourceId, s.connectionState])),
    ).toEqual({
      upload: "upload",
      public: "public",
      configured: "configured",
      missing: "unavailable",
      "wrong-kind": "unavailable",
    });
    expect(
      statuses.every(
        (s) => s.connectivity === "not_probed" && s.lastSuccessfulSync === null,
      ),
    ).toBe(true);
    expect(JSON.stringify(statuses)).not.toContain("hidden-provider-secret");
    expect(JSON.stringify(statuses)).not.toContain(
      "0123456789abcdef0123456789abcdef",
    );
    expect((await client.sourceStatuses("restricted"))[0].connectionState).toBe(
      "unavailable",
    );
    expect(calls).toBe(before);
  });
  it("separates last success from a later failure and gives access/rate-limit guidance", async () => {
    await expect(
      client.syncSource("enabled", "configured", { dryRun: true }),
    ).rejects.toMatchObject({ status: 422 });
    let status = (await client.sourceStatuses("enabled")).find(
      (s) => s.sourceId === "configured",
    )!;
    expect(status.lastAttempt?.status).toBe("failed");
    expect(status.guidance.join()).toContain("rejected access");
    expect(status.lastSuccessfulSync).toBeNull();
    providerStatus = 429;
    await expect(
      client.syncSource("enabled", "configured"),
    ).rejects.toMatchObject({ status: 422 });
    status = (await client.sourceStatuses("enabled")).find(
      (s) => s.sourceId === "configured",
    )!;
    expect(status.guidance.join()).toContain("rate-limited");
    providerStatus = 200;
    await client.syncSource("enabled", "configured");
    status = (await client.sourceStatuses("enabled")).find(
      (s) => s.sourceId === "configured",
    )!;
    const succeededAt = status.lastSuccessfulSync;
    expect(succeededAt).not.toBeNull();
    expect(status.lastAttempt?.status).toBe("succeeded");
    providerStatus = 403;
    await expect(
      client.syncSource("enabled", "configured"),
    ).rejects.toMatchObject({ status: 422 });
    const before = calls;
    status = (await client.sourceStatuses("enabled")).find(
      (s) => s.sourceId === "configured",
    )!;
    expect(status.lastSuccessfulSync).toBe(succeededAt);
    expect(status.lastAttempt?.status).toBe("failed");
    expect(calls).toBe(before);
    expect(JSON.stringify(status)).not.toContain("hidden-provider-secret");
  });
  it("allows read-scoped status access but rejects anonymous and cross-ontology reads", async () => {
    const reader = new GraphClient("http://status.test", transport(secured), {
      token: credential,
    });
    expect((await reader.sourceStatuses("enabled")).length).toBe(5);
    await expect(reader.sourceStatuses("restricted")).rejects.toMatchObject({
      status: 403,
    });
    await expect(
      new GraphClient("http://status.test", transport(secured)).sourceStatuses(
        "enabled",
      ),
    ).rejects.toMatchObject({ status: 401 });
  });
});
