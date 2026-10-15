import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { FalkorDB } from "falkordb";
import {
  GraphStore,
  JobService,
  JobFailure,
  defineFunction,
} from "@graph/core";
import { GraphClient } from "@graph/sdk";
import {
  ontologySchema,
  type JobRecord,
  type SourceSchedule,
} from "@graph/contracts";
import { z } from "zod";
import { createApp } from "../apps/api/src/app.js";
const suite = process.env.GRAPH_INTEGRATION === "1" ? describe : describe.skip;
const until = async (condition: () => Promise<boolean>) => {
  for (let i = 0; i < 100; i++) {
    if (await condition()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw Error("Condition timed out");
};
suite("durable jobs, schedules and recovery", () => {
  let db: FalkorDB,
    store: GraphStore,
    app: ReturnType<typeof createApp>,
    client: GraphClient;
  const namespace = `jobs_${Date.now()}_${process.pid}`;
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
  const seed = async (id: string) => {
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
        relationshipTypes: [],
      }),
    );
    await client.registerSource(id, {
      id: "remote",
      name: "Remote",
      connector: "github",
      repository: "NicholasTerek/Graph",
      githubResource: "repository",
      mapping: {
        type: "Record",
        idField: "id",
        properties: { name: { field: "full_name" } },
      },
    });
  };
  const worker = (
    handler: ConstructorParameters<typeof JobService>[1]["source-sync"],
  ) =>
    new JobService(
      store,
      { "source-sync": handler, investigation: handler },
      300,
    );
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
    client = new GraphClient("http://jobs.test", transport(app));
  });
  afterAll(async () => {
    await app?.close();
    if (db) {
      await db.selectGraph(namespace).delete();
      await db.close();
    }
  });
  it("persists queued work, claims once, preserves results and rejects stale cancellation", async () => {
    await seed("execute");
    let calls = 0;
    const jobs = worker(async () => {
      calls++;
      return { answer: 42 };
    });
    const job = await jobs.enqueue(
      "execute",
      { kind: "source-sync", sourceId: "remote" },
      "owner",
    );
    expect(
      (
        await new JobService(new GraphStore(db, namespace), {
          "source-sync": async () => null,
          investigation: async () => null,
        }).get("execute", job.id)
      ).status,
    ).toBe("queued");
    await Promise.all([jobs.tick(), jobs.tick()]);
    expect(calls).toBe(1);
    const result = await jobs.get("execute", job.id);
    expect(result.status).toBe("succeeded");
    expect(result.result).toEqual({ answer: 42 });
    expect(result.attempt).toBe(1);
    await expect(
      jobs.cancel("execute", job.id, 0, "owner"),
    ).rejects.toMatchObject({ statusCode: 409 });
    await jobs.stop();
  });
  it("retries only explicitly retryable work, with bounded attempts and durable backoff", async () => {
    await seed("retry");
    const jobs = worker(async () => {
      throw new JobFailure("Transient", true);
    });
    const job = await jobs.enqueue(
      "retry",
      { kind: "source-sync", sourceId: "remote", maxAttempts: 2 },
      "owner",
    );
    await jobs.tick();
    let state = await jobs.get("retry", job.id);
    expect(state.status).toBe("retrying");
    expect(Date.parse(state.notBefore)).toBeGreaterThan(Date.now());
    await store.saveDocument("job", "retry", job.id, {
      ...state,
      notBefore: "2026-01-01T00:00:00Z",
    });
    await jobs.tick();
    state = await jobs.get("retry", job.id);
    expect(state.status).toBe("failed");
    expect(state.attempt).toBe(2);
    await jobs.stop();
  });
  it("cancels queued/running jobs cooperatively and checks owner/version", async () => {
    await seed("cancel");
    const jobs = worker(
      async (_job, signal) =>
        new Promise((_, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          }),
        ),
    );
    const queued = await jobs.enqueue(
      "cancel",
      { kind: "source-sync", sourceId: "remote" },
      "owner",
    );
    await expect(
      jobs.cancel("cancel", queued.id, 0, "other"),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect((await jobs.cancel("cancel", queued.id, 0, "owner")).status).toBe(
      "cancelled",
    );
    const job = await jobs.enqueue(
      "cancel",
      { kind: "source-sync", sourceId: "remote" },
      "owner",
    );
    const tick = jobs.tick();
    await until(
      async () => (await jobs.get("cancel", job.id)).status === "running",
    );
    const running = await jobs.get("cancel", job.id);
    await jobs.cancel("cancel", job.id, running.version, "owner");
    await tick;
    expect((await jobs.get("cancel", job.id)).status).toBe("cancelled");
    await jobs.stop();
  });
  it("recovers expired source leases but interrupts investigations without silent re-execution", async () => {
    await seed("recover");
    let calls = 0;
    const jobs = worker(async () => {
      calls++;
      return true;
    });
    const source = await jobs.enqueue(
      "recover",
      { kind: "source-sync", sourceId: "remote" },
      "owner",
    );
    const agent = await jobs.enqueue(
      "recover",
      {
        kind: "investigation",
        request: { question: "Inspect records", maxSteps: 8 },
      },
      "owner",
    );
    for (const job of [source, agent])
      await store.saveDocument("job", "recover", job.id, {
        ...job,
        status: "running",
        attempt: 1,
        lease: "dead-worker",
        leaseUntil: "2026-01-01T00:00:00Z",
      });
    await jobs.tick();
    expect(calls).toBe(1);
    expect((await jobs.get("recover", source.id)).recovered).toBe(true);
    expect((await jobs.get("recover", agent.id)).status).toBe("interrupted");
    const retry = await jobs.retry(
      "recover",
      agent.id,
      (await jobs.get("recover", agent.id)).version,
      "owner",
    );
    expect(retry.id).not.toBe(agent.id);
    const retried = await jobs.get("recover", agent.id);
    expect(retried.retriedAs).toBe(retry.id);
    await expect(
      jobs.retry("recover", agent.id, retried.version, "owner"),
    ).rejects.toMatchObject({ statusCode: 409 });
    await jobs.cancel("recover", retry.id, 0, "owner");
    await jobs.stop();
  });
  it("schedules a coalesced occurrence atomically, avoids overlap and permits pausing", async () => {
    await seed("schedule");
    const jobs = worker(async () => true);
    let schedule = await jobs.schedule(
      "schedule",
      { id: "refresh", sourceId: "remote", intervalSeconds: 60 },
      "owner",
    );
    await store.saveDocument("schedule", "schedule", schedule.id, {
      ...schedule,
      nextRunAt: "2026-01-01T00:00:00Z",
    });
    await jobs.tick();
    expect((await jobs.list("schedule")).length).toBe(1);
    await jobs.tick();
    expect((await jobs.list("schedule")).length).toBe(1);
    schedule = (await jobs.schedules("schedule"))[0];
    const paused = await jobs.schedule(
      "schedule",
      {
        id: schedule.id,
        sourceId: "remote",
        intervalSeconds: 60,
        enabled: false,
        expectedVersion: schedule.version,
      },
      "owner",
    );
    expect(paused.enabled).toBe(false);
    await jobs.stop();
  });
  it("shutdown interrupts active investigations and drains before closing storage", async () => {
    await seed("shutdown");
    const jobs = worker(
      async (_job, signal) =>
        new Promise((_, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          }),
        ),
    );
    const job = await jobs.enqueue(
      "shutdown",
      { kind: "investigation", request: { question: "Inspect", maxSteps: 8 } },
      "owner",
    );
    const tick = jobs.tick();
    await until(
      async () => (await jobs.get("shutdown", job.id)).status === "running",
    );
    await jobs.stop();
    await tick;
    expect((await jobs.get("shutdown", job.id)).status).toBe("interrupted");
  });
  it("runs source refresh and deterministic investigation through public job routes", async () => {
    await seed("api");
    const live = createApp(store, {
      jobsEnabled: true,
      connectorFetch: async () =>
        Response.json({
          id: 1,
          full_name: "NicholasTerek/Graph",
          private: false,
        }),
      functions: [
        defineFunction({
          id: "count",
          name: "Count",
          description: "Count",
          ontology: "api",
          input: z.object({}),
          output: z.object({ count: z.number() }),
          execute: ({ graph }) => ({ count: graph.objects().length }),
        }),
      ],
    });
    await live.ready();
    const sdk = new GraphClient("http://jobs.test", transport(live));
    try {
      expect((await sdk.jobCapabilities()).workerEnabled).toBe(true);
      const job = await sdk.enqueueJob("api", {
        kind: "source-sync",
        sourceId: "remote",
      });
      await until(
        async () => (await sdk.job("api", job.id)).status === "succeeded",
      );
      expect((await sdk.snapshot("api")).objects).toHaveLength(1);
      const agent = await sdk.enqueueJob("api", {
        kind: "investigation",
        request: {
          question: "Count records",
          functionId: "count",
          input: {},
          maxSteps: 8,
        },
      });
      await until(async () =>
        ["succeeded", "failed"].includes(
          (await sdk.job("api", agent.id)).status,
        ),
      );
      const completed = await sdk.job("api", agent.id);
      expect(completed.status).toBe("succeeded");
      expect(completed.result).toHaveProperty("investigationId");
    } finally {
      await live.close();
    }
  });
  it("rejects an investigation queued against changed graph context before invoking tools", async () => {
    await seed("stale-job");
    const job = await client.enqueueJob("stale-job", {
      kind: "investigation",
      request: { question: "Inspect records", maxSteps: 8 },
    });
    await client.ingest("stale-job", {
      objects: [
        {
          id: "new-record",
          type: "Record",
          properties: { name: "New" },
          provenance: {
            source: "fixture",
            externalId: "new-record",
            observedAt: new Date().toISOString(),
          },
        },
      ],
      relationships: [],
    });
    const live = createApp(store, { jobsEnabled: true });
    await live.ready();
    try {
      await until(
        async () => (await client.job("stale-job", job.id)).status === "failed",
      );
      expect((await client.job("stale-job", job.id)).error).toContain(
        "Graph changed",
      );
      expect(await client.investigations("stale-job")).toHaveLength(0);
    } finally {
      await live.close();
    }
  });
  it("keeps queued jobs and schedules inert in portable backups", async () => {
    await seed("backup-jobs");
    const queued = await client.enqueueJob("backup-jobs", {
      kind: "source-sync",
      sourceId: "remote",
    });
    await client.setSourceSchedule("backup-jobs", {
      id: "refresh",
      sourceId: "remote",
      intervalSeconds: 60,
    });
    const archive = await client.backup("backup-jobs");
    const job = archive.documents.find((d) => d.kind === "job")!
      .value as JobRecord;
    const schedule = archive.documents.find((d) => d.kind === "schedule")!
      .value as SourceSchedule;
    expect(job.status).toBe("interrupted");
    expect(schedule.enabled).toBe(false);
    await client.restore(
      "backup-jobs",
      archive,
      (await client.snapshot("backup-jobs")).revision,
    );
    expect((await client.job("backup-jobs", queued.id)).status).toBe(
      "interrupted",
    );
    expect((await client.sourceSchedules("backup-jobs"))[0].enabled).toBe(
      false,
    );
  });
});
