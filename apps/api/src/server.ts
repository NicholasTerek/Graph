import { FalkorDB } from "falkordb";
import { GraphStore } from "@graph/core";
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
const app = createApp(store, { logger: true, serveWeb: true });
app.addHook("onClose", () => store.close());
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    void app.close();
  });
await app.listen({
  port: Number(process.env.PORT ?? 3001),
  host: process.env.HOST ?? "127.0.0.1",
});
