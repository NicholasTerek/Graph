import { strict as assert } from "node:assert";
import { GraphClient } from "@graph/sdk";
const client = new GraphClient(
  process.env.API_URL ?? "http://127.0.0.1:3001",
  fetch,
  { token: process.env.GRAPH_API_TOKEN },
);
const phase = process.argv[2];
if (phase === "prepare") {
  const job = await client.enqueueJob("semiconductor", {
    kind: "investigation",
    request: { question: "Restart persistence check", maxSteps: 8 },
    notBefore: new Date(Date.now() + 86400000).toISOString(),
  });
  console.log(JSON.stringify({ job: job.id, status: job.status }));
} else if (phase === "verify") {
  const pending = (await client.jobs("semiconductor")).filter(
    (j) =>
      j.input.kind === "investigation" &&
      j.input.request.question === "Restart persistence check" &&
      j.status === "queued",
  );
  assert.equal(
    pending.length,
    1,
    "Expected exactly one persisted restart check",
  );
  assert.equal(pending[0].attempt, 0);
  const cancelled = await client.cancelJob(
    "semiconductor",
    pending[0].id,
    pending[0].version,
  );
  assert.equal(cancelled.status, "cancelled");
  console.log(
    JSON.stringify({
      job: cancelled.id,
      recoveredQueuedWork: true,
      cancelled: true,
    }),
  );
} else
  throw Error("Usage: node --import tsx scripts/job-demo.ts prepare|verify");
