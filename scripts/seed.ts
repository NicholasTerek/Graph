import { readFile } from "node:fs/promises";
import { GraphClient } from "@graph/sdk";
import { ontologySchema, ingestionSchema } from "@graph/contracts";
const client = new GraphClient(process.env.API_URL ?? "http://127.0.0.1:3001");
for (const example of ["semiconductor", "library"]) {
  const ontology = ontologySchema.parse(
    JSON.parse(await readFile(`examples/${example}/ontology.json`, "utf8")),
  );
  const data = ingestionSchema.parse(
    JSON.parse(await readFile(`examples/${example}/data.json`, "utf8")),
  );
  await client.register(ontology);
  const result = await client.ingest(ontology.id, data);
  console.log(
    `${ontology.name}: ${result.objects} objects, ${result.relationships} relationships`,
  );
}
