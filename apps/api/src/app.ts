import { agentRoutes, internalAgentCredential } from "./agent-routes.js";
import type { ModelProvider } from "../../../packages/agent/src/index.js";
import { platformRoutes } from "./platform-routes.js";
import { Security, type SecurityOptions } from "./security.js";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import {
  jsonSchemaTransform,
  validatorCompiler,
  serializerCompiler,
  hasZodFastifySchemaValidationErrors,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import {
  identifier,
  ontologySchema,
  ingestionSchema,
  objectInput,
  relationshipInput,
  objectPatch,
  pageQuery,
  relationshipQuery,
  scenarioCreate,
  scenarioEdit,
  scenarioObjectPatch,
  functionInvocation,
} from "@graph/contracts";
import {
  GraphStore,
  PlatformError,
  ScenarioService,
  FunctionRuntime,
  type FunctionDefinition,
  type ActionDefinition,
  ActionService,
} from "@graph/core";

export function createApp(
  store: GraphStore,
  options: {
    logger?: boolean;
    serveWeb?: boolean;
    functions?: FunctionDefinition[];
    actions?: ActionDefinition[];
    modelProvider?: ModelProvider;
    security?: SecurityOptions;
    connectorFetch?: typeof fetch;
    sourceConnections?: import("@graph/core").SourceConnections;
  } = {},
) {
  const app = Fastify({
    logger: options.logger ?? false,
    bodyLimit: 4 * 1024 * 1024,
  }).withTypeProvider<ZodTypeProvider>();
  const agentCredential = internalAgentCredential();
  const security = new Security(options.security, agentCredential);
  app.addHook("onRequest", async (req) => {
    security.check(req);
  });
  const metrics = new Map<
    string,
    { count: number; errors: number; totalMs: number }
  >();
  app.addHook("onResponse", async (req, reply) => {
    const key = req.method + " " + (req.routeOptions.url ?? "unmatched");
    const metric = metrics.get(key) ?? { count: 0, errors: 0, totalMs: 0 };
    metric.count++;
    metric.errors += reply.statusCode >= 400 ? 1 : 0;
    metric.totalMs += reply.elapsedTime;
    metrics.set(key, metric);
  });
  app.addHook("preHandler", async (req) => {
    const principal = security.principal(req);
    if (
      req.method === "POST" &&
      req.url === "/api/ontologies" &&
      principal.ontologies &&
      !principal.ontologies.includes((req.body as { id: string }).id)
    )
      throw new PlatformError(403, "Credential cannot register this ontology");
  });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.register(swagger, {
    openapi: {
      components: {
        securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } },
      },
      security: [{ bearerAuth: [] }],
      info: {
        title: "Graph Operational Ontology API",
        version: "0.3.0",
        description:
          "Typed ontologies, connected objects, isolated scenarios, and deterministic domain functions. Trusted local workspace.",
      },
    },
    transform: jsonSchemaTransform,
  });
  app.register(swaggerUi, { routePrefix: "/api/docs" });
  app.addHook("onRequest", async (req, reply) => {
    reply.header("x-request-id", req.id);
  });
  app.setErrorHandler((error, request, reply) => {
    const issues =
      error instanceof z.ZodError
        ? error.issues
        : hasZodFastifySchemaValidationErrors(error)
          ? error.validation
          : undefined;
    if (issues)
      return reply.status(400).send({
        code: "VALIDATION_ERROR",
        message: "Invalid request",
        issues,
        requestId: request.id,
      });
    const status =
      error instanceof PlatformError
        ? error.statusCode
        : typeof error === "object" && error && "statusCode" in error
          ? Number(error.statusCode)
          : 500;
    const safeStatus = status >= 400 && status < 600 ? status : 500;
    if (safeStatus >= 500) request.log.error(error);
    return reply.status(safeStatus).send({
      code:
        (
          {
            401: "UNAUTHORIZED",
            403: "FORBIDDEN",
            404: "NOT_FOUND",
            409: "CONFLICT",
            422: "DOMAIN_VALIDATION_ERROR",
          } as Record<number, string>
        )[safeStatus] ?? (safeStatus >= 500 ? "INTERNAL_ERROR" : "BAD_REQUEST"),
      message:
        safeStatus < 500 && error instanceof Error
          ? error.message
          : "Graph operation failed",
      requestId: request.id,
    });
  });
  const scenarios = new ScenarioService(store);
  const functions = new FunctionRuntime(
    store,
    scenarios,
    options.functions ?? [],
  );
  const ontologyParams = z.object({ ontology: identifier });
  const recordParams = ontologyParams.extend({ id: identifier });
  const scenarioParams = ontologyParams.extend({ scenario: identifier });
  const actions = new ActionService(store, scenarios, options.actions ?? []);
  app.after(() => {
    platformRoutes(
      app,
      store,
      scenarios,
      security,
      options.connectorFetch,
      actions,
      options.sourceConnections,
      functions,
    );
    app.get("/api/metrics", { schema: { tags: ["Operations"] } }, () => ({
      uptimeSeconds: process.uptime(),
      routes: [...metrics].map(([route, m]) => ({
        route,
        ...m,
        meanMs: m.totalMs / m.count,
      })),
    }));
    agentRoutes(app, store, agentCredential.token, options.modelProvider);
    app.get("/api/openapi.json", { schema: { hide: true } }, () =>
      app.swagger(),
    );
    app.get(
      "/api/health",
      {
        schema: { tags: ["Platform"], summary: "Verify a real FalkorDB query" },
      },
      async () => {
        await store.health();
        return { status: "ok", database: "FalkorDB" };
      },
    );
    app.get(
      "/api/ontologies",
      {
        schema: {
          tags: ["Ontologies"],
          summary: "List registered ontology schemas",
        },
      },
      async (req) => {
        const principal = security.principal(req);
        return (await store.listOntologies()).filter(
          (o) => !principal.ontologies || principal.ontologies.includes(o.id),
        );
      },
    );
    app.post(
      "/api/ontologies",
      {
        schema: {
          tags: ["Ontologies"],
          summary: "Register an immutable ontology schema",
          body: ontologySchema,
        },
      },
      async (req, reply) =>
        reply.code(201).send(await store.register(req.body)),
    );
    app.get(
      "/api/ontologies/:ontology",
      {
        schema: {
          tags: ["Ontologies"],
          summary: "Read an ontology schema",
          params: ontologyParams,
        },
      },
      (req) => store.ontology(req.params.ontology),
    );
    app.get(
      "/api/ontologies/:ontology/graph",
      {
        schema: {
          tags: ["Graph"],
          summary: "Read a consistent graph view and ontology revision",
          params: ontologyParams,
        },
      },
      async (req, reply) => {
        const state = await store.state(req.params.ontology);
        reply.header("etag", `"${state.revision}"`);
        return state;
      },
    );
    app.post(
      "/api/ontologies/:ontology/ingest",
      {
        schema: {
          tags: ["Graph"],
          summary: "Validate and upsert a complete JSON batch",
          params: ontologyParams,
          body: ingestionSchema,
        },
      },
      (req) => store.ingest(req.params.ontology, req.body),
    );
    app.get(
      "/api/ontologies/:ontology/objects",
      {
        schema: {
          tags: ["Objects"],
          summary:
            "List objects with cursor pagination, type filtering, and text search",
          params: ontologyParams,
          querystring: pageQuery,
        },
      },
      (req) => store.objects(req.params.ontology, req.query),
    );
    app.get(
      "/api/ontologies/:ontology/objects/:id",
      {
        schema: {
          tags: ["Objects"],
          summary: "Read an object and its provenance",
          params: recordParams,
        },
      },
      (req) => store.object(req.params.ontology, req.params.id),
    );
    app.put(
      "/api/ontologies/:ontology/objects/:id",
      {
        schema: {
          tags: ["Objects"],
          summary: "Create or replace an entire object",
          params: recordParams,
          body: objectInput,
        },
      },
      async (req) => {
        if (req.params.id !== req.body.id)
          throw new PlatformError(400, "Path and body IDs must match");
        await store.ingest(req.params.ontology, {
          objects: [req.body],
          relationships: [],
        });
        return req.body;
      },
    );
    app.patch(
      "/api/ontologies/:ontology/objects/:id",
      {
        schema: {
          tags: ["Objects"],
          summary:
            "Merge properties with an optional expected ontology revision",
          params: recordParams,
          body: objectPatch,
        },
      },
      async (req, reply) => {
        const result = await store.patchObject(
          req.params.ontology,
          req.params.id,
          req.body,
        );
        reply.header("etag", `"${result.revision}"`);
        return result;
      },
    );
    app.delete(
      "/api/ontologies/:ontology/objects/:id",
      {
        schema: {
          tags: ["Objects"],
          summary: "Delete an unconnected object",
          params: recordParams,
        },
      },
      async (req, reply) => {
        await store.deleteObject(req.params.ontology, req.params.id);
        return reply.code(204).send();
      },
    );
    app.get(
      "/api/ontologies/:ontology/relationships",
      {
        schema: {
          tags: ["Relationships"],
          summary: "List relationships by type, endpoints, and cursor",
          params: ontologyParams,
          querystring: relationshipQuery,
        },
      },
      (req) => store.relationships(req.params.ontology, req.query),
    );
    app.get(
      "/api/ontologies/:ontology/relationships/:id",
      {
        schema: {
          tags: ["Relationships"],
          summary: "Read a relationship",
          params: recordParams,
        },
      },
      (req) => store.relationship(req.params.ontology, req.params.id),
    );
    app.put(
      "/api/ontologies/:ontology/relationships/:id",
      {
        schema: {
          tags: ["Relationships"],
          summary: "Create or replace a relationship",
          params: recordParams,
          body: relationshipInput,
        },
      },
      async (req) => {
        if (req.params.id !== req.body.id)
          throw new PlatformError(400, "Path and body IDs must match");
        await store.ingest(req.params.ontology, {
          objects: [],
          relationships: [req.body],
        });
        return req.body;
      },
    );
    app.delete(
      "/api/ontologies/:ontology/relationships/:id",
      {
        schema: {
          tags: ["Relationships"],
          summary: "Delete a relationship explicitly",
          params: recordParams,
        },
      },
      async (req, reply) => {
        await store.deleteRelationship(req.params.ontology, req.params.id);
        return reply.code(204).send();
      },
    );
    app.get(
      "/api/ontologies/:ontology/traverse",
      {
        schema: {
          tags: ["Graph"],
          summary:
            "Discover connected objects with bounded directed Cypher traversal",
          params: ontologyParams,
          querystring: z
            .object({
              root: identifier,
              depth: z.coerce.number().int().min(1).max(5).default(3),
              direction: z.enum(["out", "in", "both"]).default("both"),
            })
            .strict(),
        },
      },
      (req) =>
        store.traverse(
          req.params.ontology,
          req.query.root,
          req.query.depth,
          req.query.direction,
        ),
    );
    app.get(
      "/api/ontologies/:ontology/scenarios",
      {
        schema: {
          tags: ["Scenarios"],
          summary: "List saved hypothetical branches",
          params: ontologyParams,
        },
      },
      (req) => scenarios.list(req.params.ontology),
    );
    app.post(
      "/api/ontologies/:ontology/scenarios",
      {
        schema: {
          tags: ["Scenarios"],
          summary: "Create a scenario pinned to the current ontology revision",
          params: ontologyParams,
          body: scenarioCreate,
        },
      },
      async (req, reply) =>
        reply
          .code(201)
          .send(await scenarios.create(req.params.ontology, req.body)),
    );
    app.get(
      "/api/ontologies/:ontology/scenarios/:scenario",
      {
        schema: {
          tags: ["Scenarios"],
          summary: "Read scenario metadata and its sparse overlay",
          params: scenarioParams,
        },
      },
      (req) =>
        store.exclusive(() =>
          scenarios.get(req.params.ontology, req.params.scenario),
        ),
    );
    app.get(
      "/api/ontologies/:ontology/scenarios/:scenario/graph",
      {
        schema: {
          tags: ["Scenarios"],
          summary: "Materialize the pinned base with hypothetical changes",
          params: scenarioParams,
        },
      },
      (req) => scenarios.state(req.params.ontology, req.params.scenario),
    );
    app.patch(
      "/api/ontologies/:ontology/scenarios/:scenario",
      {
        schema: {
          tags: ["Scenarios"],
          summary: "Upsert or remove hypothetical objects and relationships",
          params: scenarioParams,
          body: scenarioEdit,
        },
      },
      (req) =>
        scenarios.edit(req.params.ontology, req.params.scenario, req.body),
    );
    app.patch(
      "/api/ontologies/:ontology/scenarios/:scenario/objects/:id",
      {
        schema: {
          tags: ["Scenarios"],
          summary: "Change hypothetical object properties with a version check",
          params: scenarioParams.extend({ id: identifier }),
          body: scenarioObjectPatch,
        },
      },
      (req) =>
        scenarios.patchObject(
          req.params.ontology,
          req.params.scenario,
          req.params.id,
          req.body,
        ),
    );
    app.get(
      "/api/ontologies/:ontology/scenarios/:scenario/diff",
      {
        schema: {
          tags: ["Scenarios"],
          summary: "Compare hypothetical state with its pinned base",
          params: scenarioParams,
        },
      },
      (req) => scenarios.diff(req.params.ontology, req.params.scenario),
    );
    app.delete(
      "/api/ontologies/:ontology/scenarios/:scenario",
      {
        schema: {
          tags: ["Scenarios"],
          summary: "Discard a scenario without changing live objects",
          params: scenarioParams,
        },
      },
      async (req, reply) => {
        await scenarios.discard(req.params.ontology, req.params.scenario);
        return reply.code(204).send();
      },
    );
    app.get(
      "/api/ontologies/:ontology/functions",
      {
        schema: {
          tags: ["Functions"],
          summary: "Discover function input and output JSON schemas",
          params: ontologyParams,
        },
      },
      async (req) => {
        await store.ontology(req.params.ontology);
        return functions.list(req.params.ontology);
      },
    );
    app.post(
      "/api/ontologies/:ontology/functions/:id/run",
      {
        schema: {
          tags: ["Functions"],
          summary: "Run a deterministic function on live or hypothetical state",
          params: recordParams,
          body: functionInvocation,
        },
      },
      (req) =>
        functions.run(
          req.params.ontology,
          req.params.id,
          req.body.input,
          req.body.scenario,
        ),
    );
    app.get(
      "/api/ontologies/:ontology/runs",
      {
        schema: {
          tags: ["Functions"],
          summary:
            "Read recorded function inputs, outputs, and revision evidence",
          params: ontologyParams,
        },
      },
      (req) => functions.history(req.params.ontology),
    );
  });
  const webRoot = resolve("apps/web/dist");
  if (options.serveWeb && existsSync(webRoot))
    app.register(fastifyStatic, { root: webRoot });
  app.setNotFoundHandler((req, reply) => {
    if (
      req.url.startsWith("/api/") ||
      !options.serveWeb ||
      !existsSync(webRoot)
    )
      return reply.code(404).send({
        code: "NOT_FOUND",
        message: "Route not found",
        requestId: req.id,
      });
    return reply.sendFile("index.html");
  });
  return app;
}
