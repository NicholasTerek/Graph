import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import {
  identifier,
  ontologySchema,
  ingestionSchema,
  objectInput,
  relationshipInput,
} from "@graph/contracts";
import { GraphStore, PlatformError } from "@graph/core";

export function createApp(
  store: GraphStore,
  options: { logger?: boolean; serveWeb?: boolean } = {},
) {
  const app = Fastify({
    logger: options.logger ?? false,
    bodyLimit: 4 * 1024 * 1024,
  });
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof z.ZodError)
      return reply
        .status(400)
        .send({ message: "Invalid request", issues: error.issues });
    if (error instanceof PlatformError)
      return reply.status(error.statusCode).send({ message: error.message });
    request.log.error(error);
    const status =
      typeof error === "object" && error && "statusCode" in error
        ? Number(error.statusCode)
        : 500;
    return reply
      .status(status >= 400 && status < 500 ? status : 500)
      .send({
        message:
          status >= 400 && status < 500 && error instanceof Error
            ? error.message
            : "Graph operation failed",
      });
  });
  const params = (value: unknown) =>
    z.object({ ontology: identifier, id: identifier.optional() }).parse(value);
  app.get("/api/health", async () => {
    await store.health();
    return { status: "ok", database: "FalkorDB" };
  });
  app.get("/api/ontologies", () => store.listOntologies());
  app.post("/api/ontologies", async (req, reply) => {
    const result = await store.register(ontologySchema.parse(req.body));
    return reply.code(201).send(result);
  });
  app.get("/api/ontologies/:ontology", (req) =>
    store.ontology(params(req.params).ontology),
  );
  app.get("/api/ontologies/:ontology/graph", (req) =>
    store.snapshot(params(req.params).ontology),
  );
  app.post("/api/ontologies/:ontology/ingest", (req) =>
    store.ingest(params(req.params).ontology, ingestionSchema.parse(req.body)),
  );
  app.get("/api/ontologies/:ontology/objects/:id", (req) => {
    const { ontology, id } = params(req.params);
    return store.object(ontology, id!);
  });
  app.put("/api/ontologies/:ontology/objects/:id", async (req) => {
    const { ontology, id } = params(req.params);
    const object = objectInput.parse(req.body);
    if (object.id !== id)
      throw new PlatformError(400, "Path and body IDs must match");
    await store.ingest(ontology, { objects: [object], relationships: [] });
    return object;
  });
  app.put("/api/ontologies/:ontology/relationships/:id", async (req) => {
    const { ontology, id } = params(req.params);
    const relationship = relationshipInput.parse(req.body);
    if (relationship.id !== id)
      throw new PlatformError(400, "Path and body IDs must match");
    await store.ingest(ontology, {
      objects: [],
      relationships: [relationship],
    });
    return relationship;
  });
  app.delete("/api/ontologies/:ontology/objects/:id", async (req, reply) => {
    const { ontology, id } = params(req.params);
    await store.deleteObject(ontology, id!);
    return reply.code(204).send();
  });
  app.delete(
    "/api/ontologies/:ontology/relationships/:id",
    async (req, reply) => {
      const { ontology, id } = params(req.params);
      await store.deleteRelationship(ontology, id!);
      return reply.code(204).send();
    },
  );
  app.get("/api/ontologies/:ontology/traverse", (req) => {
    const query = z
      .object({
        root: identifier,
        depth: z.coerce.number().int().min(1).max(5).default(3),
        direction: z.enum(["out", "in", "both"]).default("both"),
      })
      .parse(req.query);
    return store.traverse(
      params(req.params).ontology,
      query.root,
      query.depth,
      query.direction,
    );
  });
  const webRoot = resolve("apps/web/dist");
  if (options.serveWeb && existsSync(webRoot)) {
    app.register(fastifyStatic, { root: webRoot });
    app.setNotFoundHandler((req, reply) =>
      req.url.startsWith("/api/")
        ? reply.code(404).send({ message: "API route not found" })
        : reply.sendFile("index.html"),
    );
  }
  return app;
}
