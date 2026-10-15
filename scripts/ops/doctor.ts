import { GraphClient } from "@graph/sdk";
const url = process.env.API_URL ?? "http://127.0.0.1:3001";
const client = new GraphClient(url, fetch, {
  token: process.env.GRAPH_API_TOKEN,
});
const health = await fetch(url + "/api/health").then((r) => r.json());
const ontologies = await client.ontologies();
const agent = await client.agentCapabilities();
const summary = await Promise.all(
  ontologies.map(async (ontology) => {
    const graph = await client.snapshot(ontology.id);
    const sources = await client.sources(ontology.id);
    return {
      id: ontology.id,
      objects: graph.objects.length,
      sources: sources.map((source) => ({
        id: source.id,
        lastSyncedAt: source.lastSyncedAt,
        checkpoint: source.checkpoint?.slice(0, 12),
      })),
    };
  }),
);
console.log(JSON.stringify({ health, agent, ontologies: summary }, null, 2));
