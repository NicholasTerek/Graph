import { performance } from "node:perf_hooks";
import { GraphClient } from "@graph/sdk";
import { ontologySchema } from "@graph/contracts";
const client = new GraphClient(
  process.env.API_URL ?? "http://127.0.0.1:3001",
  fetch,
  { token: process.env.GRAPH_API_TOKEN },
);
const id = `bench-${Date.now()}`;
const count = Number(process.env.BENCH_OBJECTS ?? 1000);
if (!Number.isInteger(count) || count < 10 || count > 2000)
  throw new Error("BENCH_OBJECTS must be 10–2000");
await client.register(
  ontologySchema.parse({
    id,
    name: "Disposable benchmark",
    objectTypes: [
      {
        name: "Record",
        properties: {
          name: { type: "string", required: true },
          score: { type: "number", required: true },
        },
      },
    ],
    relationshipTypes: [{ name: "NEXT", from: "Record", to: "Record" }],
  }),
);
const provenance = (id: string) => ({
  source: "benchmark",
  externalId: id,
  observedAt: new Date().toISOString(),
});
const objects = Array.from({ length: count }, (_, i) => ({
  id: "record-" + String(i).padStart(5, "0"),
  type: "Record",
  properties: { name: "Record " + i, score: i },
  provenance: provenance(String(i)),
}));
const relationships = objects.slice(1).map((o, i) => ({
  id: "edge-" + i,
  type: "NEXT",
  from: objects[i].id,
  to: o.id,
  provenance: provenance(String(i)),
}));
const start = performance.now();
await client.ingest(id, { objects, relationships });
const ingestMs = performance.now() - start;
await client.createPropertyIndex(id, "Record", "score");
async function sample(operation: () => Promise<unknown>) {
  const samples: number[] = [];
  for (let i = 0; i < 25; i++) {
    const start = performance.now();
    await operation();
    samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  return {
    samples: samples.length,
    p50Ms: samples[Math.floor(samples.length * 0.5)],
    p95Ms: samples[Math.floor(samples.length * 0.95)],
  };
}
console.log(
  JSON.stringify(
    {
      ontology: id,
      objects: count,
      relationships: relationships.length,
      ingestMs,
      filteredPage: await sample(() =>
        client.queryObjects(id, {
          type: "Record",
          filters: [{ property: "score", operator: "gte", value: count / 2 }],
          limit: 50,
        }),
      ),
      traverseDepth5: await sample(() =>
        client.traverse(id, objects[0].id, 5, "out"),
      ),
      note: "HTTP timings on this machine, not a comparative database benchmark. The disposable ontology remains for inspection.",
    },
    null,
    2,
  ),
);
