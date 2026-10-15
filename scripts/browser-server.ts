import { platformFunctions } from "../apps/api/src/extensions.js";
import { FalkorDB } from "falkordb";
import { readFile } from "node:fs/promises";
import { GraphStore } from "@graph/core";
import { createApp } from "../apps/api/src/app.js";
const db = await FalkorDB.connect({
  socket: {
    host: process.env.FALKORDB_HOST ?? "127.0.0.1",
    port: Number(process.env.FALKORDB_PORT ?? 6379),
  },
});
const name = `browser_${Date.now()}_${process.pid}`;
const store = new GraphStore(db, name);
await store.initialize();
const app = createApp(store, { serveWeb: true, functions: platformFunctions });
app.addHook("onClose", async () => {
  await db.selectGraph(name).delete();
  await store.close();
});
for (const example of ["semiconductor", "library"]) {
  const ontology = JSON.parse(
    await readFile(`examples/${example}/ontology.json`, "utf8"),
  );
  const data = JSON.parse(
    await readFile(`examples/${example}/data.json`, "utf8"),
  );
  for (const [url, payload] of [
    ["/api/ontologies", ontology],
    [`/api/ontologies/${ontology.id}/ingest`, data],
  ] as const) {
    const result = await app.inject({ method: "POST", url, payload });
    if (result.statusCode >= 400) throw new Error(result.body);
  }
}
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    void app.close();
  });
await app.listen({ port: 3101, host: "127.0.0.1" });
