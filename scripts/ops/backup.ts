import { writeFile } from "node:fs/promises";
import { GraphClient } from "@graph/sdk";
const [ontology, path] = process.argv.slice(2);
if (!ontology || !path)
  throw new Error("Usage: pnpm backup ONTOLOGY OUTPUT.json");
const client = new GraphClient(
  process.env.API_URL ?? "http://127.0.0.1:3001",
  fetch,
  { token: process.env.GRAPH_API_TOKEN },
);
const archive = await client.backup(ontology);
await writeFile(path, JSON.stringify(archive, null, 2));
console.log(
  `Saved ${archive.state.objects.length} objects; checksum ${archive.digest}`,
);
