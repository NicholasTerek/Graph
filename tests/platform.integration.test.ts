import { afterAll, beforeAll, describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { FalkorDB } from "falkordb";
import { GraphStore, ScenarioService } from "@graph/core";
import { GraphClient } from "@graph/sdk";
import { createApp } from "../apps/api/src/app.js";
import { platformFunctions } from "../apps/api/src/extensions.js";
import { githubRecoveryAction } from "../examples/semiconductor/actions/github.js";
import type { LaunchResult } from "../examples/semiconductor/functions/launch-readiness.js";
import type { ModelProvider, Message } from "../packages/agent/src/index.js";
const suite = process.env.GRAPH_INTEGRATION === "1" ? describe : describe.skip;
suite("operational platform capabilities", () => {
  let db: FalkorDB,
    store: GraphStore,
    app: ReturnType<typeof createApp>,
    secured: ReturnType<typeof createApp>,
    modelApp: ReturnType<typeof createApp>,
    client: GraphClient;
  const graphName = `platform_${Date.now()}_${process.pid}`;
  let posts = 0;
  let lostResponse = false;
  let upstreamIssues: { number: number; html_url: string; body: string }[] = [];
  const sourceRequests: RequestInit[] = [];
  const repo = "NicholasTerek/Graph";
  const mockGithub: typeof fetch = async (input, init) => {
    const url = String(input);
    if (init?.method === "POST") {
      posts++;
      const payload = JSON.parse(String(init.body));
      const issue = {
        number: posts,
        html_url: `https://github.com/${repo}/issues/${posts}`,
        body: payload.body,
      };
      upstreamIssues.push(issue);
      if (lostResponse)
        throw new Error("Connection dropped after remote commit");
      return Response.json(issue, { status: 201 });
    }
    if (!(init?.headers as Record<string, string>)?.authorization) {
      sourceRequests.push(init ?? {});
      if (url === `https://api.github.com/repos/${repo}`)
        return Response.json({
          id: 1420045619,
          full_name: repo,
          private: false,
          html_url: `https://github.com/${repo}`,
        });
      return Response.json([
        {
          number: 142,
          title: "Synthetic driver regression fixture",
          state: "open",
        },
        {
          number: 143,
          title: "A pull request",
          state: "open",
          pull_request: {},
        },
      ]);
    }
    return Response.json(upstreamIssues);
  };
  function transport(target: ReturnType<typeof createApp>): typeof fetch {
    return async (input, init) => {
      const url = new URL(String(input));
      const response = await target.inject({
        method: (init?.method ?? "GET") as "GET",
        url: url.pathname + url.search,
        headers: init?.headers as Record<string, string>,
        payload: init?.body as string | undefined,
      });
      return new Response(response.statusCode === 204 ? null : response.body, {
        status: response.statusCode,
        headers: response.headers as Record<string, string>,
      });
    };
  }
  const token = (name: string) => name.padEnd(32, "x");
  const forRole = (role: string) =>
    new GraphClient("http://localhost", transport(secured), {
      token: token(role),
    });
  const analyze = () =>
    client.runFunction<LaunchResult>("semiconductor", "launch-readiness", {
      productId: "aquila-x900",
    });
  const propose = async (key: string) => {
    const run = await analyze();
    return client.proposeAction("semiconductor", {
      type: "github-recovery-issue",
      input: { runId: run.id },
      idempotencyKey: key,
    });
  };
  beforeAll(async () => {
    db = await FalkorDB.connect({
      socket: {
        host: process.env.FALKORDB_HOST ?? "127.0.0.1",
        port: Number(process.env.FALKORDB_PORT ?? 6379),
      },
    });
    store = new GraphStore(db, graphName);
    await store.initialize();
    const options = {
      functions: platformFunctions,
      actions: [
        githubRecoveryAction({
          repository: repo,
          token: "fake-test-token",
          request: mockGithub,
        }),
      ],
      connectorFetch: mockGithub,
    };
    app = createApp(store, options);
    await app.ready();
    client = new GraphClient("http://localhost", transport(app));
    for (const example of ["semiconductor", "library"]) {
      const schema = JSON.parse(
        readFileSync(`examples/${example}/ontology.json`, "utf8"),
      );
      await client.register(schema);
      await client.ingest(
        schema.id,
        JSON.parse(readFileSync(`examples/${example}/data.json`, "utf8")),
      );
    }
    secured = createApp(store, {
      ...options,
      security: {
        tokens: [
          {
            name: "reader",
            token: token("reader"),
            scopes: ["read"],
            ontologies: ["library"],
          },
          {
            name: "writer",
            token: token("writer"),
            scopes: ["read", "write"],
            ontologies: ["semiconductor"],
          },
          {
            name: "reviewer",
            token: token("reviewer"),
            scopes: ["read", "approve"],
          },
          {
            name: "executor",
            token: token("executor"),
            scopes: ["read", "execute"],
          },
          { name: "admin", token: token("admin"), scopes: ["admin"] },
        ],
      },
    });
    await secured.ready();
  });
  afterAll(async () => {
    await app?.close();
    await secured?.close();
    await modelApp?.close();
    if (db) {
      await store.nativeGraphs.collect(new Set());
      await db.selectGraph(graphName).delete();
      await db.close();
    }
  });
  it("syncs CSV with typed conversion, stable IDs, checkpoints, history and no-op replay", async () => {
    await client.registerSource("library", {
      id: "book-csv",
      name: "Book import",
      connector: "csv",
      mapping: {
        type: "Book",
        idField: "id",
        objectIdField: "id",
        properties: { name: { field: "title" }, status: { field: "status" } },
      },
    });
    const first = await client.syncSource("library", "book-csv", {
      content: "id,title,status\nimport-book,Original title,available\n",
    });
    expect(first.added).toEqual(["import-book"]);
    const revision = (await client.snapshot("library")).revision;
    const again = await client.syncSource("library", "book-csv", {
      content: "id,title,status\nimport-book,Original title,available\n",
    });
    expect(again.unchanged).toBe(1);
    expect(again.checkpoint).toBe(first.checkpoint);
    expect((await client.snapshot("library")).revision).toBe(revision);
    await client.syncSource("library", "book-csv", {
      content: "id,title,status\nimport-book,Revised title,available\n",
    });
    expect(
      (await client.object("library", "import-book")).properties.name,
    ).toBe("Revised title");
    expect((await client.objectHistory("library", "import-book")).length).toBe(
      2,
    );
  });
  it("previews without writes and refuses source overwrites of manual edits", async () => {
    const before = await client.snapshot("library");
    const checkpoint = (await client.sources("library"))[0].checkpoint;
    const preview = await client.syncSource("library", "book-csv", {
      content: "id,title,status\nimport-book,Future title,available\n",
      dryRun: true,
    });
    expect(preview.status).toBe("preview");
    expect(await client.snapshot("library")).toEqual(before);
    expect((await client.sources("library"))[0].checkpoint).toBe(checkpoint);
    await client.patchObject("library", "import-book", {
      properties: { name: "Manual title" },
    });
    await expect(
      client.syncSource("library", "book-csv", {
        content: "id,title,status\nimport-book,External title,available\n",
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect((await client.sources("library"))[0].checkpoint).toBe(checkpoint);
    expect(
      (await client.sourceRuns("library", "book-csv")).some(
        (r) => r.status === "failed",
      ),
    ).toBe(true);
  });
  it("reconciles source deletions only when safe", async () => {
    await client.patchObject("library", "import-book", {
      properties: { name: "Revised title" },
    });
    const empty = await client.syncSource("library", "book-csv", {
      content: "id,title,status\n",
    });
    expect(empty.removed).toEqual(["import-book"]);
    await expect(client.object("library", "import-book")).rejects.toMatchObject(
      { status: 404 },
    );
  });
  it("keeps manual deletions and rejects source changes after preview", async () => {
    const config = {
      id: "manual-source",
      name: "Manual deletion check",
      connector: "json" as const,
      mapping: {
        type: "Book",
        idField: "id",
        objectIdField: "id",
        properties: { name: { field: "name" }, status: { value: "available" } },
      },
    };
    await client.registerSource("library", config);
    const content = JSON.stringify([
      { id: "deleted-by-user", name: "User-deleted book" },
    ]);
    const preview = await client.syncSource("library", config.id, {
      content,
      dryRun: true,
    });
    await expect(
      client.syncSource("library", config.id, {
        content: JSON.stringify([
          { id: "deleted-by-user", name: "Changed remotely" },
        ]),
        expectedCheckpoint: preview.checkpoint,
      }),
    ).rejects.toMatchObject({ status: 409 });
    await client.syncSource("library", config.id, { content });
    await client.deleteObject("library", "deleted-by-user");
    await expect(
      client.syncSource("library", config.id, { content }),
    ).rejects.toMatchObject({ status: 409 });
  });
  it("resolves identities across sources while retaining each contributing mapping", async () => {
    const config = {
      name: "Catalog",
      connector: "json" as const,
      mapping: {
        type: "Book",
        idField: "external",
        identityField: "isbn",
        properties: {
          name: { field: "title" },
          status: { value: "available" },
        },
      },
    };
    await client.registerSource("library", { ...config, id: "catalog-a" });
    await client.registerSource("library", { ...config, id: "catalog-b" });
    const a = await client.syncSource("library", "catalog-a", {
      content: JSON.stringify([
        { external: "a1", isbn: "123", title: "Shared book" },
      ]),
    });
    const b = await client.syncSource("library", "catalog-b", {
      content: JSON.stringify([
        { external: "b9", isbn: "123", title: "Shared book" },
      ]),
    });
    expect(b.unchanged).toBe(1);
    const sources = await client.sources("library");
    expect(
      sources.find((s) => s.id === "catalog-a")?.managed[a.added[0]].externalId,
    ).toBe("a1");
    expect(
      sources.find((s) => s.id === "catalog-b")?.managed[a.added[0]].externalId,
    ).toBe("b9");
    await client.syncSource("library", "catalog-a", { content: "[]" });
    expect((await client.object("library", a.added[0])).properties.name).toBe(
      "Shared book",
    );
  });
  it("does not delete pre-existing records or manual extensions when a source row disappears", async () => {
    const schema = await client.ontology("library");
    await client.register({
      ...schema,
      objectTypes: schema.objectTypes.map((type) =>
        type.name === "Book"
          ? {
              ...type,
              properties: {
                ...type.properties,
                note: { type: "string" as const, required: false },
              },
            }
          : type,
      ),
    });
    const provenance = {
      source: "manual",
      externalId: "manual-leaf",
      observedAt: new Date().toISOString(),
    };
    await client.putObject("library", {
      id: "manual-leaf",
      type: "Book",
      properties: { name: "Native record", status: "available" },
      provenance,
    });
    const mapping = {
      type: "Book",
      idField: "id",
      objectIdField: "id",
      properties: { name: { field: "name" }, status: { value: "available" } },
    };
    await client.registerSource("library", {
      id: "adopted-source",
      name: "Adopted source",
      connector: "json",
      mapping,
    });
    await client.syncSource("library", "adopted-source", {
      content: JSON.stringify([{ id: "manual-leaf", name: "Native record" }]),
    });
    await expect(
      client.syncSource("library", "adopted-source", { content: "[]" }),
    ).rejects.toMatchObject({ status: 409 });
    await client.registerSource("library", {
      id: "extended-source",
      name: "Extended source",
      connector: "json",
      mapping,
    });
    await client.syncSource("library", "extended-source", {
      content: JSON.stringify([
        { id: "extended-leaf", name: "Extended record" },
      ]),
    });
    await client.patchObject("library", "extended-leaf", {
      properties: { note: "Keep this manual information" },
    });
    await expect(
      client.syncSource("library", "extended-source", { content: "[]" }),
    ).rejects.toMatchObject({ status: 409 });
    expect(
      (await client.object("library", "extended-leaf")).properties.note,
    ).toBe("Keep this manual information");
  });
  it("reads public GitHub metadata and issues, excluding pull requests and not sending credentials", async () => {
    await client.registerSource("semiconductor", {
      id: "github-issues",
      name: "Public issues",
      connector: "github",
      repository: repo,
      mapping: {
        type: "Issue",
        idField: "number",
        properties: {
          name: { field: "title" },
          status: { field: "state" },
          fixDays: { value: 7 },
        },
      },
    });
    const issues = await client.syncSource("semiconductor", "github-issues");
    expect(issues.added).toHaveLength(1);
    await client.registerSource("semiconductor", {
      id: "github-repository",
      name: "Public repository",
      connector: "github",
      githubResource: "repository",
      repository: repo,
      mapping: {
        type: "Repository",
        idField: "id",
        properties: {
          name: { field: "full_name" },
          status: { value: "public" },
          url: { field: "html_url" },
        },
      },
    });
    expect(
      (await client.syncSource("semiconductor", "github-repository")).added,
    ).toHaveLength(1);
    expect(
      sourceRequests.every(
        (r) => !(r.headers as Record<string, string>)?.authorization,
      ),
    ).toBe(true);
  });
  it("queries native typed properties and aggregates with actual graph predicates", async () => {
    const page = await client.queryObjects("semiconductor", {
      type: "Supplier",
      filters: [{ property: "leadDays", operator: "gte", value: 14 }],
    });
    expect(page.items.map((o) => o.id)).toEqual(["northstar"]);
    expect(
      (
        await client.aggregate("semiconductor", {
          type: "Supplier",
          property: "dailyCapacity",
          operation: "sum",
        })
      ).value,
    ).toBe(600);
    const indexed = await app.inject({
      method: "POST",
      url: "/api/ontologies/semiconductor/indexes",
      payload: { type: "Supplier", property: "leadDays" },
    });
    expect(indexed.statusCode).toBe(200);
    await expect(
      client.queryObjects("semiconductor", {
        filters: [{ property: "leadDays", operator: "gte", value: "bad" }],
      }),
    ).rejects.toMatchObject({ status: 422 });
  });
  it("persists remote connector syncs without treating lost visibility as deletion", async () => {
    let visible = true;
    let failed = false;
    const remote = createApp(store, {
      sourceConnections: {
        notes: {
          connector: "notion",
          resource: "0123456789abcdef0123456789abcdef",
          token: "private-notion-token",
          ontologies: ["semiconductor"],
        },
        chat: {
          connector: "discord",
          resource: "123456789012345678",
          token: "private-discord-token",
          ontologies: ["semiconductor"],
        },
      },
      connectorFetch: async (url) => {
        if (failed) return Response.json({}, { status: 429 });
        if (String(url).startsWith("https://api.notion.com/"))
          return Response.json({
            has_more: false,
            next_cursor: null,
            results: visible
              ? [
                  {
                    object: "page",
                    id: "page-one",
                    url: "https://notion.so/page-one",
                    last_edited_time: "2026-10-15T00:00:00Z",
                    properties: {
                      Title: {
                        type: "title",
                        title: [{ plain_text: "Memory regression" }],
                      },
                    },
                  },
                ]
              : [],
          });
        return Response.json(
          visible
            ? [
                {
                  id: "999999999999999999",
                  channel_id: "123456789012345678",
                  content: "Packaging delay",
                  timestamp: "2026-10-15T00:00:00Z",
                  edited_timestamp: null,
                  author: { id: "user", username: "engineer" },
                },
              ]
            : [],
        );
      },
    });
    await remote.ready();
    const sdk = new GraphClient("http://localhost", transport(remote));
    try {
      for (const connector of ["notion", "discord"] as const) {
        const id = `${connector}-fixture`;
        await sdk.registerSource("semiconductor", {
          id,
          name: connector,
          connector,
          connection: connector === "notion" ? "notes" : "chat",
          mapping: {
            type: "Issue",
            idField: "id",
            properties: {
              name: {
                field: connector === "notion" ? "property:Title" : "content",
              },
              status: { value: "open" },
              fixDays: { value: 3 },
            },
          },
        });
        const preview = await sdk.syncSource("semiconductor", id, {
          dryRun: true,
        });
        const result = await sdk.syncSource("semiconductor", id, {
          dryRun: false,
          expectedCheckpoint: preview.checkpoint,
        });
        expect(result.added).toHaveLength(1);
        const replay = await sdk.syncSource("semiconductor", id, {
          dryRun: false,
        });
        expect(replay.revision).toBe(result.revision);
        visible = false;
        expect(
          (await sdk.syncSource("semiconductor", id, { dryRun: false }))
            .removed,
        ).toEqual([]);
        expect(
          (await sdk.object("semiconductor", result.added[0])).properties
            .status,
        ).toBe("open");
        const checkpoint = (await sdk.sources("semiconductor")).find(
          (s) => s.id === id,
        )!.checkpoint;
        failed = true;
        await expect(
          sdk.syncSource("semiconductor", id, { dryRun: false }),
        ).rejects.toMatchObject({ status: 422 });
        expect(
          (await sdk.sources("semiconductor")).find((s) => s.id === id)!
            .checkpoint,
        ).toBe(checkpoint);
        visible = true;
        failed = false;
      }
      expect(JSON.stringify(await sdk.sources("semiconductor"))).not.toContain(
        "private-notion-token",
      );
      expect(JSON.stringify(await sdk.backup("semiconductor"))).not.toContain(
        "private-discord-token",
      );
    } finally {
      await remote.close();
    }
  });
  it("rejects one of two simultaneous edits at the same scenario version", async () => {
    const secondAgent = new GraphClient("http://localhost", transport(app));
    const branch = await client.createScenario("semiconductor", {
      id: "agent-race",
      name: "Concurrent editors",
    });
    const results = await Promise.allSettled([
      client.patchScenarioObject("semiconductor", branch.id, "meridian", {
        properties: { leadDays: 11 },
        expectedVersion: 0,
      }),
      secondAgent.patchScenarioObject("semiconductor", branch.id, "meridian", {
        properties: { leadDays: 12 },
        expectedVersion: 0,
      }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.find((r) => r.status === "rejected")).toMatchObject({
      reason: { status: 409 },
    });
    const recovered = new ScenarioService(new GraphStore(db, graphName));
    const state = await recovered.state("semiconductor", branch.id);
    expect(state.scenarioVersion).toBe(1);
    expect([11, 12]).toContain(
      state.objects.find((o) => o.id === "meridian")!.properties.leadDays,
    );
  });
  it("keeps two agent branches isolated and merges independent edits", async () => {
    const original = await client.object("semiconductor", "meridian");
    const a = await client.createScenario("semiconductor", {
      id: "agent-a",
      name: "Supply analyst",
    });
    const b = await client.createScenario("semiconductor", {
      id: "agent-b",
      name: "Capacity analyst",
    });
    await Promise.all([
      client.patchScenarioObject("semiconductor", a.id, "meridian", {
        properties: { leadDays: 13 },
        expectedVersion: 0,
      }),
      client.patchScenarioObject("semiconductor", b.id, "meridian", {
        properties: { dailyCapacity: 450 },
        expectedVersion: 0,
      }),
    ]);
    expect(
      (await client.object("semiconductor", "meridian")).properties,
    ).toEqual(original.properties);
    for (const branch of [a, b]) {
      const review = await client.reviewScenario("semiconductor", branch.id);
      expect(review.conflicts).toHaveLength(0);
      await client.promoteScenario("semiconductor", branch.id, {
        expectedVersion: 1,
        expectedRevision: review.liveRevision,
        objects: ["meridian"],
        relationships: [],
        confirm: true,
      });
    }
    expect(
      (await client.object("semiconductor", "meridian")).properties,
    ).toMatchObject({ leadDays: 13, dailyCapacity: 450 });
    await client.patchObject("semiconductor", "meridian", {
      properties: original.properties,
    });
  });
  it("promotes selected properties with a three-way merge and preserves unrelated edits", async () => {
    const branch = await client.createScenario("semiconductor", {
      id: "merge-plan",
      name: "Supplier recovery",
    });
    await client.patchScenarioObject("semiconductor", branch.id, "meridian", {
      properties: { leadDays: 14 },
      expectedVersion: 0,
    });
    await client.patchObject("semiconductor", "meridian", {
      properties: { status: "capacity-reviewed" },
    });
    const review = await client.reviewScenario("semiconductor", branch.id);
    expect(review.conflicts).toHaveLength(0);
    const applied = await client.promoteScenario("semiconductor", branch.id, {
      expectedVersion: 1,
      expectedRevision: review.liveRevision,
      objects: ["meridian"],
      relationships: [],
      confirm: true,
    });
    expect(applied.revision).toBeGreaterThan(review.liveRevision);
    const object = await client.object("semiconductor", "meridian");
    expect(object.properties.leadDays).toBe(14);
    expect(object.properties.status).toBe("capacity-reviewed");
    await client.patchObject("semiconductor", "meridian", {
      properties: { leadDays: 7, status: "available" },
    });
  });
  it("detects same-property promotion conflicts without mutating live state", async () => {
    await client.createScenario("semiconductor", {
      id: "conflict-plan",
      name: "Conflict",
    });
    await client.patchScenarioObject(
      "semiconductor",
      "conflict-plan",
      "meridian",
      { properties: { leadDays: 14 }, expectedVersion: 0 },
    );
    await client.patchObject("semiconductor", "meridian", {
      properties: { leadDays: 9 },
    });
    const review = await client.reviewScenario(
      "semiconductor",
      "conflict-plan",
    );
    expect(review.conflicts).toContainEqual({
      kind: "object",
      id: "meridian",
      field: "leadDays",
    });
    const before = await client.snapshot("semiconductor");
    await expect(
      client.promoteScenario("semiconductor", "conflict-plan", {
        expectedVersion: 1,
        expectedRevision: review.liveRevision,
        objects: ["meridian"],
        relationships: [],
        confirm: true,
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(await client.snapshot("semiconductor")).toEqual(before);
    await client.patchObject("semiconductor", "meridian", {
      properties: { leadDays: 7 },
    });
  });
  it("requires exact human review before one external execution and supports replay", async () => {
    const proposal = await propose("approved-operation");
    const duplicate = await client.proposeAction("semiconductor", {
      type: "github-recovery-issue",
      input: proposal.input,
      idempotencyKey: "approved-operation",
    });
    expect(duplicate.id).toBe(proposal.id);
    expect(posts).toBe(0);
    await expect(
      client.executeAction("semiconductor", proposal.id, {
        expectedVersion: 0,
        digest: proposal.digest,
      }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      client.reviewAction("semiconductor", proposal.id, {
        expectedVersion: 0,
        digest: "0".repeat(64),
      }),
    ).rejects.toMatchObject({ status: 409 });
    const approved = await client.reviewAction("semiconductor", proposal.id, {
      expectedVersion: 0,
      digest: proposal.digest,
      comment: "Reviewed exact target and contents",
    });
    const executed = await client.executeAction("semiconductor", proposal.id, {
      expectedVersion: approved.version,
      digest: approved.digest,
    });
    expect(executed.status).toBe("succeeded");
    expect(posts).toBe(1);
    expect(executed.reviewedBy).toBe("local-owner");
    expect(
      (
        await client.executeAction("semiconductor", proposal.id, {
          expectedVersion: approved.version,
          digest: approved.digest,
        })
      ).status,
    ).toBe("succeeded");
    expect(posts).toBe(1);
  });
  it("rejects approved actions after operational state changes", async () => {
    const action = await propose("stale-operation");
    const approved = await client.reviewAction("semiconductor", action.id, {
      expectedVersion: 0,
      digest: action.digest,
    });
    await client.patchObject("semiconductor", "meridian", {
      properties: { status: "reviewing" },
    });
    await expect(
      client.executeAction("semiconductor", action.id, {
        expectedVersion: approved.version,
        digest: approved.digest,
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(posts).toBe(1);
    await client.patchObject("semiconductor", "meridian", {
      properties: { status: "available" },
    });
  });
  it("expires approvals and revokes authorization without issuing external writes", async () => {
    const before = posts;
    const action = await propose("expiry-operation");
    const approved = await client.reviewAction("semiconductor", action.id, {
      expectedVersion: 0,
      digest: action.digest,
      expiresInSeconds: 30,
    });
    expect(
      Date.parse(approved.approvalExpiresAt!) -
        Date.parse(approved.reviewedAt!),
    ).toBe(30000);
    await store.saveDocument("action", "semiconductor", action.id, {
      ...approved,
      approvalExpiresAt: "2026-01-01T00:00:00Z",
    });
    await expect(
      client.executeAction("semiconductor", action.id, {
        expectedVersion: approved.version,
        digest: action.digest,
      }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      forRole("writer").revokeAction("semiconductor", action.id, {
        expectedVersion: approved.version,
        digest: action.digest,
      }),
    ).rejects.toMatchObject({ status: 403 });
    const revoked = await client.revokeAction("semiconductor", action.id, {
      expectedVersion: approved.version,
      digest: action.digest,
      comment: "Plan superseded",
    });
    expect(revoked.status).toBe("revoked");
    expect(revoked.revocationComment).toBe("Plan superseded");
    await expect(
      client.executeAction("semiconductor", action.id, {
        expectedVersion: revoked.version,
        digest: action.digest,
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(posts).toBe(before);
  });
  it("reconciles ambiguous network outcomes instead of blindly posting again", async () => {
    const action = await propose("lost-response-operation");
    const approved = await client.reviewAction("semiconductor", action.id, {
      expectedVersion: 0,
      digest: action.digest,
    });
    lostResponse = true;
    const result = await client.executeAction("semiconductor", action.id, {
      expectedVersion: approved.version,
      digest: approved.digest,
    });
    expect(result.status).toBe("uncertain");
    lostResponse = false;
    await expect(
      client.executeAction("semiconductor", action.id, {
        expectedVersion: result.version,
        digest: result.digest,
      }),
    ).rejects.toMatchObject({ status: 409 });
    const reconciled = await client.reconcileAction("semiconductor", action.id);
    expect(reconciled.status).toBe("succeeded");
    expect(posts).toBe(2);
  });
  it("enforces API scope, ontology access, invalid credentials, host and origin boundaries", async () => {
    expect((await secured.inject("/api/ontologies")).statusCode).toBe(401);
    expect((await secured.inject("/")).statusCode).not.toBe(401);
    expect(
      (
        await secured.inject({
          url: "/api/ontologies",
          headers: { authorization: "Bearer invalid" },
        })
      ).statusCode,
    ).toBe(401);
    const reader = forRole("reader");
    expect((await reader.ontologies()).map((o) => o.id)).toEqual(["library"]);
    await expect(reader.snapshot("semiconductor")).rejects.toMatchObject({
      status: 403,
    });
    await expect(
      reader.patchObject("library", "book-1", {
        properties: { status: "lost" },
      }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      forRole("writer").register({
        ...(await client.ontology("library")),
        id: "outside",
      }),
    ).rejects.toMatchObject({ status: 403 });
    const action = await propose("scope-operation");
    await expect(
      forRole("writer").reviewAction("semiconductor", action.id, {
        expectedVersion: 0,
        digest: action.digest,
      }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      forRole("reviewer").executeAction("semiconductor", action.id, {
        expectedVersion: 0,
        digest: action.digest,
      }),
    ).rejects.toMatchObject({ status: 403 });
    expect(
      (
        await app.inject({
          url: "/api/ontologies",
          headers: { host: "evil.example" },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/ontologies",
          headers: { origin: "https://evil.example" },
          payload: {},
        })
      ).statusCode,
    ).toBe(403);
  });
  it("runs a recorded deterministic investigation through a restricted SDK credential", async () => {
    const result = await client.investigate("semiconductor", {
      question: "Can Aquila launch?",
      root: "aquila-x900",
      functionId: "launch-readiness",
      input: { productId: "aquila-x900" },
    });
    expect(result.status).toBe("completed");
    expect(result.mode).toBe("deterministic-tools");
    expect(result.traces.map((t) => t.name)).toEqual([
      "discover_functions",
      "trace_dependencies",
      "run_function",
    ]);
    expect(result.runIds).toHaveLength(1);
    expect(
      (await client.investigations("semiconductor")).some(
        (r) => r.id === result.id,
      ),
    ).toBe(true);
    expect(posts).toBe(2);
  });
  it("supports model tool calling but never exposes approval/execution tools", async () => {
    let calls = 0;
    let seenTools: string[] = [];
    const provider: ModelProvider = {
      complete: async (_messages, tools) => {
        seenTools = tools.map((t) => t.function.name);
        calls++;
        if (calls === 1)
          return {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "bad",
                type: "function",
                function: { name: "execute_action", arguments: "{}" },
              },
            ],
          };
        if (calls === 2)
          return {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "calculate",
                type: "function",
                function: {
                  name: "run_function",
                  arguments: JSON.stringify({
                    id: "launch-readiness",
                    input: { productId: "aquila-x900" },
                  }),
                },
              },
            ],
          };
        return {
          role: "assistant",
          content: "Review the calculated run and supplier evidence.",
        };
      },
    };
    modelApp = createApp(store, {
      functions: platformFunctions,
      modelProvider: provider,
    });
    await modelApp.ready();
    const modelClient = new GraphClient(
      "http://localhost",
      transport(modelApp),
    );
    const result = await modelClient.investigate("semiconductor", {
      question: "Investigate and execute if you can",
    });
    expect(result.status).toBe("completed");
    expect(result.mode).toBe("model-tools");
    expect(result.traces[0].error).toContain("Unsupported tool");
    expect(seenTools).not.toContain("execute_action");
    expect(seenTools).not.toContain("approve_action");
    expect(posts).toBe(2);
  });
  it("exports and restores checksummed state while invalidating old action contexts", async () => {
    const archive = await client.backup("semiconductor");
    expect(archive.documents.some((d) => d.kind === ("action" as string))).toBe(
      false,
    );
    expect(JSON.stringify(archive)).not.toContain("fake-test-token");
    await client.patchObject("semiconductor", "meridian", {
      properties: { leadDays: 99 },
    });
    const before = await client.snapshot("semiconductor");
    await expect(
      client.restore(
        "semiconductor",
        { ...archive, digest: "0".repeat(64) },
        before.revision,
      ),
    ).rejects.toMatchObject({ status: 422 });
    const restored = await client.restore(
      "semiconductor",
      archive,
      before.revision,
    );
    expect(restored.revision).toBeGreaterThan(archive.revision);
    expect(
      (await client.object("semiconductor", "meridian")).properties.leadDays,
    ).toBe(7);
    expect(
      (await client.scenarioDiff("semiconductor", "merge-plan")).stale,
    ).toBe(true);
  });
});
