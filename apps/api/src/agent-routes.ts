import { randomBytes } from "node:crypto";
import {
  investigationInput,
  identifier,
  type Investigation,
} from "@graph/contracts";
import { GraphClient } from "@graph/sdk";
import {
  GraphAgent,
  type ModelProvider,
} from "../../../packages/agent/src/index.js";
import { GraphStore, PlatformError } from "@graph/core";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
export const internalAgentCredential = () => ({
  name: "graph-agent",
  token: randomBytes(32).toString("hex"),
  scopes: ["read", "write"] as ("read" | "write")[],
});
export function agentRoutes(
  instance: FastifyInstance,
  store: GraphStore,
  token: string,
  provider?: ModelProvider,
) {
  const app = instance.withTypeProvider<ZodTypeProvider>();
  const params = z.object({ ontology: identifier });
  const transport: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const response = await app.inject({
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
  const client = new GraphClient("http://localhost", transport, { token });
  const agent = new GraphAgent(client, provider);
  app.get(
    "/api/ontologies/:ontology/investigations",
    { schema: { tags: ["Agent"], params } },
    async (req) => {
      await store.ontology(req.params.ontology);
      return store.documents<Investigation>(
        "investigation",
        req.params.ontology,
      );
    },
  );
  app.get(
    "/api/ontologies/:ontology/investigations/:id",
    { schema: { tags: ["Agent"], params: params.extend({ id: identifier }) } },
    async (req) => {
      const record = await store.document<Investigation>(
        "investigation",
        req.params.ontology,
        req.params.id,
      );
      if (!record) throw new PlatformError(404, "Investigation not found");
      return record;
    },
  );
  app.post(
    "/api/ontologies/:ontology/investigations",
    { schema: { tags: ["Agent"], params, body: investigationInput } },
    async (req) => {
      await store.ontology(req.params.ontology);
      const memory = (
        await store.documents<Investigation>(
          "investigation",
          req.params.ontology,
        )
      )
        .filter((r) => r.status === "completed")
        .slice(-3)
        .map((r) => r.answer);
      return agent.investigate(
        req.params.ontology,
        req.body,
        (record) =>
          store.exclusive(() =>
            store.saveDocument(
              "investigation",
              req.params.ontology,
              record.id,
              record,
            ),
          ),
        memory,
      );
    },
  );
  app.get("/api/agent/capabilities", { schema: { tags: ["Agent"] } }, () => ({
    mode: provider ? "model-tools" : "deterministic-tools",
    approvalTools: false,
    executionTools: false,
    maxToolCalls: 16,
  }));
}
