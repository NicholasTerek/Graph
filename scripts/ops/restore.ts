import { readFile } from "node:fs/promises";
import { GraphClient } from "@graph/sdk";
import { backupSchema } from "@graph/contracts";
const [ontology, path, confirmation] = process.argv.slice(2);
if (!ontology || !path || confirmation !== `--confirm=${ontology}`)
  throw new Error(
    "Usage: pnpm restore ONTOLOGY BACKUP.json --confirm=ONTOLOGY",
  );
const client = new GraphClient(
  process.env.API_URL ?? "http://127.0.0.1:3001",
  fetch,
  { token: process.env.GRAPH_API_TOKEN },
);
const archive = backupSchema.parse(JSON.parse(await readFile(path, "utf8")));
const state = await client.snapshot(ontology);
console.log(await client.restore(ontology, archive, state.revision));
