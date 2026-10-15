import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  restoreInput,
  actionProposal,
  actionReview,
  actionExecute,
  identifier,
  sourceSchema,
  syncInput,
  promotionInput,
  objectQuery,
  aggregationInput,
  algorithmInput,
  explanationInput,
  historicalInput,
  historicalTraversalInput,
  snapshotInput,
  vacuumInput,
} from "@graph/contracts";
import {
  GraphStore,
  PlatformError,
  SourceService,
  ScenarioService,
  PromotionService,
  BackupService,
  ActionService,
  AlgorithmService,
  graphAlgorithms,
  ExplanationService,
  FunctionRuntime,
  SnapshotService,
  VacuumService,
} from "@graph/core";
import type { Security } from "./security.js";
export function platformRoutes(
  instance: FastifyInstance,
  store: GraphStore,
  scenarios: ScenarioService,
  security: Security,
  request?: typeof fetch,
  actions?: ActionService,
  connections?: import("@graph/core").SourceConnections,
  functions?: FunctionRuntime,
) {
  const app = instance.withTypeProvider<ZodTypeProvider>();
  const sources = new SourceService(store, request, connections);
  const promotion = new PromotionService(store, scenarios);
  const backup = new BackupService(store);
  const algorithms = new AlgorithmService(store, scenarios);
  const snapshots = new SnapshotService(store);
  app.get(
    "/api/ontologies/:ontology/history",
    {
      schema: { params: z.object({ ontology: identifier }), tags: ["History"] },
    },
    (req) => snapshots.status(req.params.ontology),
  );
  const vacuum = new VacuumService(store);
  app.post(
    "/api/ontologies/:ontology/vacuum",
    {
      schema: {
        params: z.object({ ontology: identifier }),
        body: vacuumInput,
        tags: ["History"],
      },
    },
    (req) =>
      vacuum.run(req.params.ontology, req.body, security.principal(req).name),
  );
  const ontologyOnly = z.object({ ontology: identifier });
  app.post(
    "/api/ontologies/:ontology/state/at/traverse",
    {
      schema: {
        params: ontologyOnly,
        body: historicalTraversalInput,
        tags: ["History"],
      },
    },
    (req) =>
      snapshots.traverse(
        req.params.ontology,
        req.body,
        security.principal(req).name,
      ),
  );
  app.post(
    "/api/ontologies/:ontology/state/at",
    {
      schema: {
        params: ontologyOnly,
        body: historicalInput,
        tags: ["History"],
      },
    },
    (req) =>
      snapshots.state(
        req.params.ontology,
        req.body,
        security.principal(req).name,
      ),
  );
  app.get(
    "/api/ontologies/:ontology/commits",
    {
      schema: {
        params: ontologyOnly,
        querystring: z
          .object({
            after: z.coerce.number().int().min(-1).default(-1),
            limit: z.coerce.number().int().min(1).max(100).default(100),
          })
          .strict(),
        tags: ["History"],
      },
    },
    (req) =>
      store.exclusive(() =>
        store.temporal.commits(
          req.params.ontology,
          req.query.after,
          req.query.limit,
        ),
      ),
  );
  app.post(
    "/api/ontologies/:ontology/snapshots",
    {
      schema: { params: ontologyOnly, body: snapshotInput, tags: ["History"] },
    },
    (req) =>
      snapshots.create(
        req.params.ontology,
        req.body,
        security.principal(req).name,
      ),
  );
  app.delete(
    "/api/ontologies/:ontology/snapshots/:id",
    {
      schema: {
        params: ontologyOnly.extend({ id: identifier }),
        tags: ["History"],
      },
    },
    async (req, reply) => {
      await snapshots.release(
        req.params.ontology,
        req.params.id,
        security.principal(req).name,
      );
      return reply.code(204).send();
    },
  );
  if (functions) {
    const explanations = new ExplanationService(store, scenarios, functions);
    app.post(
      "/api/ontologies/:ontology/explain",
      {
        schema: {
          params: z.object({ ontology: identifier }),
          body: explanationInput,
          tags: ["Evidence"],
        },
      },
      (req) => explanations.explain(req.params.ontology, req.body),
    );
  }
  app.get(
    "/api/ontologies/:ontology/algorithms",
    {
      schema: {
        params: z.object({ ontology: identifier }),
        tags: ["Algorithms"],
      },
    },
    async (req) => {
      await store.ontology(req.params.ontology);
      return graphAlgorithms;
    },
  );
  app.post(
    "/api/ontologies/:ontology/algorithms/run",
    {
      schema: {
        params: z.object({ ontology: identifier }),
        body: algorithmInput,
        tags: ["Algorithms"],
      },
    },
    (req) => algorithms.run(req.params.ontology, req.body),
  );
  const params = z.object({ ontology: identifier });
  const record = params.extend({ id: identifier });
  app.get(
    "/api/ontologies/:ontology/sources",
    { schema: { tags: ["Sources"], params } },
    (req) => sources.list(req.params.ontology),
  );
  app.get(
    "/api/ontologies/:ontology/sources/status",
    { schema: { tags: ["Sources"], params } },
    (req) => sources.statuses(req.params.ontology),
  );
  app.post(
    "/api/ontologies/:ontology/sources",
    { schema: { tags: ["Sources"], params, body: sourceSchema } },
    (req) => sources.register(req.params.ontology, req.body),
  );
  app.post(
    "/api/ontologies/:ontology/sources/:id/sync",
    { schema: { tags: ["Sources"], params: record, body: syncInput } },
    (req) => sources.sync(req.params.ontology, req.params.id, req.body),
  );
  app.get(
    "/api/ontologies/:ontology/sources/:id/runs",
    { schema: { tags: ["Sources"], params: record } },
    (req) => sources.history(req.params.ontology, req.params.id),
  );
  app.get(
    "/api/ontologies/:ontology/objects/:id/history",
    { schema: { tags: ["Objects"], params: record } },
    (req) => store.history(req.params.ontology, req.params.id),
  );
  app.post(
    "/api/ontologies/:ontology/objects/query",
    { schema: { tags: ["Objects"], params, body: objectQuery } },
    (req) => store.queryObjects(req.params.ontology, req.body),
  );
  app.post(
    "/api/ontologies/:ontology/aggregate",
    { schema: { tags: ["Objects"], params, body: aggregationInput } },
    (req) =>
      store.exclusive(() => store.aggregate(req.params.ontology, req.body)),
  );
  app.post(
    "/api/ontologies/:ontology/indexes",
    {
      schema: {
        tags: ["Objects"],
        params,
        body: z.object({ type: identifier, property: identifier }).strict(),
      },
    },
    (req) =>
      store.createPropertyIndex(
        req.params.ontology,
        req.body.type,
        req.body.property,
      ),
  );
  app.get(
    "/api/ontologies/:ontology/scenarios/:id/review",
    { schema: { tags: ["Scenarios"], params: record } },
    (req) => promotion.review(req.params.ontology, req.params.id),
  );
  app.post(
    "/api/ontologies/:ontology/scenarios/:id/promote",
    { schema: { tags: ["Scenarios"], params: record, body: promotionInput } },
    (req) =>
      promotion.promote(
        req.params.ontology,
        req.params.id,
        req.body,
        security.principal(req).name,
      ),
  );
  if (actions) {
    app.get(
      "/api/ontologies/:ontology/action-types",
      { schema: { tags: ["Actions"], params } },
      (req) => actions.list(req.params.ontology),
    );
    app.get(
      "/api/ontologies/:ontology/actions",
      { schema: { tags: ["Actions"], params } },
      (req) => actions.records(req.params.ontology),
    );
    app.post(
      "/api/ontologies/:ontology/actions",
      { schema: { tags: ["Actions"], params, body: actionProposal } },
      (req) =>
        actions.propose(
          req.params.ontology,
          req.body,
          security.principal(req).name,
        ),
    );
    app.get(
      "/api/ontologies/:ontology/actions/:id",
      { schema: { tags: ["Actions"], params: record } },
      (req) => actions.get(req.params.ontology, req.params.id),
    );
    for (const decision of ["approve", "reject"])
      app.post(
        `/api/ontologies/:ontology/actions/:id/${decision}`,
        { schema: { tags: ["Actions"], params: record, body: actionReview } },
        (req) =>
          actions.review(
            req.params.ontology,
            req.params.id,
            req.body,
            decision === "approve",
            security.principal(req).name,
          ),
      );
    app.post(
      "/api/ontologies/:ontology/actions/:id/revoke",
      {
        schema: {
          tags: ["Actions"],
          params: record,
          body: actionReview.omit({ expiresInSeconds: true }),
        },
      },
      (req) =>
        actions.revoke(
          req.params.ontology,
          req.params.id,
          req.body,
          security.principal(req).name,
        ),
    );
    app.post(
      "/api/ontologies/:ontology/actions/:id/execute",
      { schema: { tags: ["Actions"], params: record, body: actionExecute } },
      (req) =>
        actions.execute(
          req.params.ontology,
          req.params.id,
          req.body,
          security.principal(req).name,
        ),
    );
    app.post(
      "/api/ontologies/:ontology/actions/:id/reconcile",
      {
        schema: {
          tags: ["Actions"],
          params: record,
          body: z.object({}).strict(),
        },
      },
      (req) => actions.reconcile(req.params.ontology, req.params.id),
    );
  }

  app.post(
    "/api/ontologies/:ontology/native-graphs/collect",
    {
      schema: {
        tags: ["Operations"],
        params,
        body: z
          .object({
            dryRun: z.boolean().default(true),
            digest: z.string().length(64).optional(),
            confirmOntology: identifier.optional(),
          })
          .strict(),
      },
    },
    (req) => scenarios.retainGraphs(req.params.ontology, req.body),
  );
  app.get(
    "/api/ontologies/:ontology/backup",
    { schema: { tags: ["Operations"], params } },
    (req) => backup.export(req.params.ontology),
  );
  app.post(
    "/api/ontologies/:ontology/restore",
    { schema: { tags: ["Operations"], params, body: restoreInput } },
    (req) =>
      backup.restore(
        req.params.ontology,
        req.body,
        security.principal(req).name,
      ),
  );
  app.get(
    "/api/ontologies/:ontology/runs/:id",
    { schema: { tags: ["Functions"], params: record } },
    async (req) => {
      const run = await store.document(
        "run",
        req.params.ontology,
        req.params.id,
      );
      if (!run) throw new PlatformError(404, "Function run not found");
      return run;
    },
  );
  app.get(
    "/api/ontologies/:ontology/objects/:id/provenance",
    { schema: { tags: ["Objects"], params: record } },
    async (req) => ({
      current: (await store.object(req.params.ontology, req.params.id))
        .provenance,
      contributors: (await sources.list(req.params.ontology))
        .filter((source) => source.managed[req.params.id])
        .map((source) => ({
          source: source.id,
          externalId: source.managed[req.params.id].externalId,
          fields: Object.keys(source.managed[req.params.id].fields),
          lastSyncedAt: source.lastSyncedAt,
        })),
      history: await store.history(req.params.ontology, req.params.id),
    }),
  );
}
