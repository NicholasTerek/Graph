import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { GraphClient } from "@graph/sdk";
import { runHistoryWorkload } from "./lib/history-checker.js";
const integer = (name: string, fallback: number, max: number) => {
  const n = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(n) || n < 1 || n > max)
    throw Error(`${name} must be 1–${max}`);
  return n;
};
const client = new GraphClient(
  process.env.API_URL ?? "http://127.0.0.1:3001",
  fetch,
  { token: process.env.GRAPH_API_TOKEN },
);
const result = await runHistoryWorkload(client, `history-${Date.now()}`, {
  seed: integer("HISTORY_SEED", 42, 4294967295),
  rounds: integer("HISTORY_ROUNDS", 12, 500),
  writers: integer("HISTORY_WRITERS", 4, 32),
});
const output = process.env.HISTORY_OUTPUT ?? "artifacts/history/latest";
await mkdir(dirname(output), { recursive: true });
await writeFile(
  `${output}.jsonl`,
  result.entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n",
);
await writeFile(
  `${output}.json`,
  JSON.stringify(
    { metadata: result.metadata, summary: result.summary },
    null,
    2,
  ) + "\n",
);
console.log(
  JSON.stringify(
    {
      ...result.summary,
      journal: `${output}.jsonl`,
      metadata: result.metadata,
    },
    null,
    2,
  ),
);
if (!result.summary.ok) process.exitCode = 1;
