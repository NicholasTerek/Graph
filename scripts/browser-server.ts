import { exampleExtensions } from "../examples/server.js";
import { FalkorDB } from "falkordb";
import { readFile } from "node:fs/promises";
import { GraphStore } from "@graph/core";
import { GraphClient } from "@graph/sdk";
import {
  seedResolution,
  resolutionFixtureFetch,
} from "../examples/entity-resolution/fixtures.js";
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
const app = createApp(store, {
  serveWeb: true,
  extensions: exampleExtensions(),
  connectorFetch: resolutionFixtureFetch,
});
app.addHook("onClose", async () => {
  await store.nativeGraphs.collect(new Set());
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
const { semiconductorSources } = await import(
  "../examples/semiconductor/sources.js"
);
for (const source of semiconductorSources) {
  const response = await app.inject({
    method: "POST",
    url: "/api/ontologies/semiconductor/sources",
    payload: source,
  });
  if (response.statusCode >= 400) throw new Error(response.body);
}
await seedResolution(
  new GraphClient("http://fixtures", async (url, init) => {
    const u = new URL(String(url));
    const response = await app.inject({
      method: (init?.method ?? "GET") as "GET",
      url: u.pathname + u.search,
      headers: init?.headers as Record<string, string>,
      payload: init?.body as string,
    });
    return new Response(response.statusCode === 204 ? null : response.body, {
      status: response.statusCode,
    });
  }),
);
await app.listen({ port: 3101, host: "127.0.0.1" });
