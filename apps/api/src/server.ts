import { CompatibleModelProvider } from "../../../packages/agent/src/index.js";
import { githubRecoveryAction } from "../../../examples/semiconductor/actions/github.js";
import { credentialSchema } from "./security.js";
import { platformFunctions } from "./extensions.js";
import { FalkorDB } from "falkordb";
import { GraphStore, ScenarioService, connectionsSchema } from "@graph/core";
import { createApp } from "./app.js";

const db = await FalkorDB.connect({
  socket: {
    host: process.env.FALKORDB_HOST ?? "127.0.0.1",
    port: Number(process.env.FALKORDB_PORT ?? 6379),
    connectTimeout: 5000,
  },
  password: process.env.FALKORDB_PASSWORD,
});
const store = new GraphStore(db, process.env.GRAPH_NAME ?? "graph");
await store.initialize();
await store.backfillNativeProperties();
await new ScenarioService(store).initialize();
const app = createApp(store, {
  logger: true,
  serveWeb: true,
  functions: platformFunctions,
  sourceConnections: connectionsSchema.parse(
    JSON.parse(process.env.GRAPH_SOURCE_CONNECTIONS || "{}"),
  ),
  modelProvider:
    process.env.GRAPH_AGENT_BASE_URL && process.env.GRAPH_AGENT_MODEL
      ? new CompatibleModelProvider({
          baseUrl: process.env.GRAPH_AGENT_BASE_URL,
          model: process.env.GRAPH_AGENT_MODEL,
          apiKey: process.env.GRAPH_AGENT_API_KEY,
        })
      : undefined,
  actions: [
    githubRecoveryAction({
      repository: process.env.GRAPH_ACTION_REPOSITORY,
      token: process.env.GITHUB_TOKEN,
    }),
  ],
  security: {
    tokens: JSON.parse(process.env.GRAPH_API_TOKENS ?? "[]").map(
      (value: unknown) => credentialSchema.parse(value),
    ),
    allowedHosts: process.env.GRAPH_ALLOWED_HOSTS?.split(","),
    allowedOrigins: process.env.GRAPH_ALLOWED_ORIGINS?.split(","),
  },
});
app.addHook("onClose", () => store.close());
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    void app.close();
  });
await app.listen({
  port: Number(process.env.PORT ?? 3001),
  host: process.env.HOST ?? "127.0.0.1",
});
