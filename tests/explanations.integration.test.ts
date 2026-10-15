import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { FalkorDB } from "falkordb";
import { GraphStore } from "@graph/core";
import { GraphClient } from "@graph/sdk";
import type { FunctionRun } from "@graph/contracts";
import { createApp } from "../apps/api/src/app.js";
import { platformFunctions } from "../apps/api/src/extensions.js";
import { semiconductorSources } from "../examples/semiconductor/sources.js";
const suite = process.env.GRAPH_INTEGRATION === "1" ? describe : describe.skip;
suite("captured calculation explanations", () => {
  let db: FalkorDB,
    store: GraphStore,
    app: ReturnType<typeof createApp>,
    client: GraphClient,
    run: FunctionRun;
  const name = `evidence_${Date.now()}_${process.pid}`;
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
  beforeAll(async () => {
    db = await FalkorDB.connect({
      socket: {
        host: process.env.FALKORDB_HOST ?? "127.0.0.1",
        port: Number(process.env.FALKORDB_PORT ?? 6379),
      },
    });
    store = new GraphStore(db, name);
    await store.initialize();
    app = createApp(store, { functions: platformFunctions });
    await app.ready();
    client = new GraphClient("http://localhost", transport(app));
    for (const example of ["semiconductor", "library"]) {
      await client.register(
        JSON.parse(readFileSync(`examples/${example}/ontology.json`, "utf8")),
      );
      await client.ingest(
        example,
        JSON.parse(readFileSync(`examples/${example}/data.json`, "utf8")),
      );
    }
    await client.registerSource("semiconductor", semiconductorSources[0]);
    await client.syncSource("semiconductor", semiconductorSources[0].id, {
      dryRun: false,
      content: readFileSync(
        "examples/semiconductor/data/sources/suppliers.csv",
        "utf8",
      ),
    });
    run = await client.runFunction("semiconductor", "launch-readiness", {
      productId: "aquila-x900",
    });
  });
  afterAll(async () => {
    if (app) await app.close();
    if (db) {
      await store.nativeGraphs.collect(new Set());
      await db.selectGraph(name).delete();
      await db.close();
    }
  });
  it("captures actual read records, edge identities and source checkpoints with rule claims", async () => {
    expect(run.evidence?.objects.map((o) => o.id)).toContain("aquila-x900");
    expect(run.evidence?.relationships.length).toBeGreaterThan(0);
    const explanation = await client.explain("semiconductor", {
      root: "aquila-x900",
      targets: ["meridian", "northstar"],
      runId: run.id,
    });
    expect(explanation.context).toMatchObject({
      revision: run.revision,
      stale: false,
      scope: "calculation-readset",
    });
    expect(explanation.query.engine).toBe("falkordb");
    expect(explanation.paths.map((p) => p.target)).toEqual([
      "meridian",
      "northstar",
    ]);
    for (const path of explanation.paths) {
      expect(path.objects[0]).toBe("aquila-x900");
      expect(path.relationships).toHaveLength(path.hops);
      expect(path.objects.at(-1)).toBe(path.target);
    }
    expect(
      explanation.claims.find((c) => c.id === "recommendation"),
    ).toMatchObject({ kind: "calculated", ruleId: "launch.rank.v1" });
    expect(explanation.claims.some((c) => c.kind === "assumption")).toBe(true);
    expect(
      explanation.contributors.find((c) => c.objectId === "meridian"),
    ).toMatchObject({
      sourceId: "packaging-feed",
      matches: true,
      values: { leadDays: 7 },
    });
    expect(
      explanation.contributors.find((c) => c.objectId === "meridian")
        ?.checkpoint,
    ).toMatch(/^[a-f0-9]{64}$/);
  });
  it("keeps original evidence after live updates and exposes the changed context", async () => {
    await client.patchObject("semiconductor", "meridian", {
      properties: { leadDays: 14 },
    });
    const old = await client.explain("semiconductor", {
      root: "aquila-x900",
      targets: ["meridian"],
      runId: run.id,
    });
    expect(old.context.stale).toBe(true);
    expect(
      old.records.find((o) => o.id === "meridian")!.properties.leadDays,
    ).toBe(7);
    expect(old.claims).toEqual(run.explanation);
    const current = await client.explain("semiconductor", {
      root: "aquila-x900",
      targets: ["meridian"],
    });
    expect(current.context.scope).toBe("current-graph");
    expect(
      current.records.find((o) => o.id === "meridian")!.properties.leadDays,
    ).toBe(14);
    expect(
      current.contributors.find((c) => c.objectId === "meridian")?.matches,
    ).toBe(false);
    await client.patchObject("semiconductor", "meridian", {
      properties: { leadDays: 7 },
    });
  });
  it("preserves scenario evidence after further edits or branch deletion", async () => {
    const branch = await client.createScenario("semiconductor", {
      id: "why-branch",
      name: "Explain a hypothetical plan",
    });
    await client.patchScenarioObject("semiconductor", branch.id, "meridian", {
      properties: { leadDays: 14 },
      expectedVersion: 0,
    });
    const calculation = await client.runFunction(
      "semiconductor",
      "launch-readiness",
      { productId: "aquila-x900" },
      branch.id,
    );
    await client.patchScenarioObject("semiconductor", branch.id, "meridian", {
      properties: { leadDays: 20 },
      expectedVersion: 1,
    });
    const explanation = await client.explain("semiconductor", {
      root: "aquila-x900",
      targets: ["meridian"],
      runId: calculation.id,
    });
    expect(explanation.context).toMatchObject({
      scenarioVersion: 1,
      currentScenarioVersion: 2,
      stale: true,
    });
    expect(
      explanation.records.find((o) => o.id === "meridian")!.properties.leadDays,
    ).toBe(14);
    expect(
      explanation.contributors.find((c) => c.objectId === "meridian")?.matches,
    ).toBe(false);
    await client.discardScenario("semiconductor", branch.id);
    expect(
      (
        await client.explain("semiconductor", {
          root: "aquila-x900",
          runId: calculation.id,
        })
      ).context.stale,
    ).toBe(true);
  });
  it("handles missing paths and legacy runs without inventing historical evidence", async () => {
    const missing = await client.explain("semiconductor", {
      root: "aquila-x900",
      targets: ["does-not-exist"],
      maxDepth: 1,
    });
    expect(missing.paths).toEqual([]);
    expect(missing.warnings.join(" ")).toContain("No directed evidence path");
    const { evidence, explanation, ...legacy } = run;
    await store.saveDocument("run", "semiconductor", "legacy-run", {
      ...legacy,
      id: "legacy-run",
    });
    await client.patchObject("semiconductor", "meridian", {
      properties: { leadDays: 8 },
    });
    const stale = await client.explain("semiconductor", {
      root: "aquila-x900",
      runId: "legacy-run",
    });
    expect(stale.context.scope).toBe("unavailable");
    expect(stale.paths).toEqual([]);
    expect(stale.records).toEqual([]);
    expect(stale.calculation?.id).toBe("legacy-run");
    await client.patchObject("semiconductor", "meridian", {
      properties: { leadDays: 7 },
    });
    await expect(
      client.explain("semiconductor", {
        root: "does-not-exist",
        runId: run.id,
      }),
    ).rejects.toMatchObject({ status: 422 });
    await expect(
      client.explain("semiconductor", {
        root: "aquila-x900",
        runId: run.id,
        scenario: "different",
      }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      client.explain("semiconductor", { root: "aquila-x900", maxDepth: 10 }),
    ).rejects.toMatchObject({ status: 400 });
  });
  it("allows read-only explanation access and denies cross-ontology run references", async () => {
    const token = "explanation-reader-token-12345";
    const secured = createApp(store, {
      functions: platformFunctions,
      security: {
        tokens: [
          {
            name: "reader",
            token,
            scopes: ["read"],
            ontologies: ["semiconductor"],
          },
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
          await reader.explain("semiconductor", {
            root: "aquila-x900",
            runId: run.id,
          })
        ).calculation?.id,
      ).toBe(run.id);
      await expect(
        reader.explain("library", { root: "aquila-x900", runId: run.id }),
      ).rejects.toMatchObject({ status: 403 });
      await expect(
        client.explain("library", { root: "aquila-x900", runId: run.id }),
      ).rejects.toMatchObject({ status: 404 });
    } finally {
      await secured.close();
    }
  });
});
