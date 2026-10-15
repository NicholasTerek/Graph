import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { jobCreate, scheduleInput, identifier } from "@graph/contracts";
import {
  GraphStore,
  JobService,
  JobFailure,
  SourceService,
  type SourceConnections,
} from "@graph/core";
import type { Security } from "./security.js";
import type { agentRoutes } from "./agent-routes.js";
export function jobRoutes(
  instance: FastifyInstance,
  store: GraphStore,
  security: Security,
  investigate: ReturnType<typeof agentRoutes>,
  options: {
    enabled?: boolean;
    connectorFetch?: typeof fetch;
    sourceConnections?: SourceConnections;
  } = {},
) {
  const app = instance.withTypeProvider<ZodTypeProvider>();
  const jobs = new JobService(store, {
    "source-sync": async (job, signal) => {
      if (job.input.kind !== "source-sync")
        throw new JobFailure("Invalid job input");
      const request: typeof fetch = (url, init) =>
        (options.connectorFetch ?? fetch)(url, {
          ...init,
          signal: init?.signal
            ? AbortSignal.any([signal, init.signal])
            : signal,
        });
      const sources = new SourceService(
        store,
        request,
        options.sourceConnections,
      );
      try {
        return await sources.sync(job.ontology, job.input.sourceId, {
          dryRun: false,
          expectedRevision: await store.revision(job.ontology),
          signal,
        });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Source job failed";
        throw new JobFailure(
          message,
          /read failed \((429|5\d\d)\)|check connection and retry/.test(
            message,
          ),
        );
      }
    },
    investigation: async (job, signal) => {
      if (job.input.kind !== "investigation")
        throw new JobFailure("Invalid job input");
      if (
        job.queuedRevision !== undefined &&
        (await store.revision(job.ontology)) !== job.queuedRevision
      )
        throw new JobFailure(
          "Graph changed since this investigation was queued; review and retry as a new job",
        );
      if (job.input.request.scenario) {
        const branch = await store.document<{ version: number }>(
          "scenario",
          job.ontology,
          job.input.request.scenario,
        );
        if (branch?.version !== job.queuedScenarioVersion)
          throw new JobFailure(
            "Scenario changed since this investigation was queued; review and retry as a new job",
          );
      }
      const result = await investigate(job.ontology, job.input.request, signal);
      if (result.status !== "completed")
        throw new JobFailure(result.error ?? "Investigation failed", false, {
          investigationId: result.id,
        });
      return { investigationId: result.id };
    },
  });
  const params = z.object({ ontology: identifier }),
    record = params.extend({ id: identifier });
  const precondition = z
    .object({ expectedVersion: z.number().int().nonnegative() })
    .strict();
  app.get("/api/jobs/capabilities", { schema: { tags: ["Jobs"] } }, () => ({
    workerEnabled: !!options.enabled,
    delivery: "single-writer-leases",
    sourceRetries: true,
    investigationAutoRetry: false,
  }));
  app.get(
    "/api/ontologies/:ontology/jobs",
    { schema: { tags: ["Jobs"], params } },
    (req) => jobs.list(req.params.ontology),
  );
  app.get(
    "/api/ontologies/:ontology/jobs/:id",
    { schema: { tags: ["Jobs"], params: record } },
    (req) => jobs.get(req.params.ontology, req.params.id),
  );
  app.post(
    "/api/ontologies/:ontology/jobs",
    { schema: { tags: ["Jobs"], params, body: jobCreate } },
    async (req, reply) =>
      reply
        .code(202)
        .send(
          await jobs.enqueue(
            req.params.ontology,
            req.body,
            security.principal(req).name,
          ),
        ),
  );
  for (const operation of ["cancel", "retry"] as const)
    app.post(
      `/api/ontologies/:ontology/jobs/:id/${operation}`,
      { schema: { tags: ["Jobs"], params: record, body: precondition } },
      (req) => {
        const principal = security.principal(req);
        return jobs[operation](
          req.params.ontology,
          req.params.id,
          req.body.expectedVersion,
          principal.name,
          principal.scopes.includes("admin"),
        );
      },
    );
  app.get(
    "/api/ontologies/:ontology/schedules",
    { schema: { tags: ["Jobs"], params } },
    (req) => jobs.schedules(req.params.ontology),
  );
  app.post(
    "/api/ontologies/:ontology/schedules",
    { schema: { tags: ["Jobs"], params, body: scheduleInput } },
    (req) => {
      const principal = security.principal(req);
      return jobs.schedule(
        req.params.ontology,
        req.body,
        principal.name,
        principal.scopes.includes("admin"),
      );
    },
  );
  app.addHook("preHandler", async (req) => {
    if (req.method === "POST" && /\/restore$/.test(req.url)) await jobs.stop();
  });
  app.addHook("onResponse", async (req) => {
    if (options.enabled && req.method === "POST" && /\/restore$/.test(req.url))
      jobs.start();
  });
  app.addHook("onReady", async () => {
    if (options.enabled) jobs.start();
  });
  app.addHook("onClose", async () => {
    await jobs.stop();
  });
  return jobs;
}
