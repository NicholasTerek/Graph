import { strict as assert } from "node:assert";
import { performance } from "node:perf_hooks";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { cpus } from "node:os";
import { FalkorDB } from "falkordb";
import { GraphStore } from "@graph/core";
import { GraphClient } from "@graph/sdk";
import { ontologySchema } from "@graph/contracts";
import { createApp } from "../apps/api/src/app.js";
const sizes = (process.env.INGEST_SIZES ?? "250,1000").split(",").map(Number),
  repeats = Number(process.env.INGEST_REPEATS ?? 3);
if (
  sizes.some((n) => !Number.isInteger(n) || n < 10 || n > 5000) ||
  !Number.isInteger(repeats) ||
  repeats < 2 ||
  repeats > 10
)
  throw Error("Sizes 10–5000; repeats 2–10");
const output = process.env.INGEST_OUTPUT ?? "artifacts/ingestion/local";
await mkdir(output, { recursive: true });
const db = await FalkorDB.connect({
    socket: {
      host: process.env.FALKORDB_HOST ?? "127.0.0.1",
      port: Number(process.env.FALKORDB_PORT ?? 6379),
    },
  }),
  connection = await db.connection;
const rows: Record<string, unknown>[] = [];
try {
  for (const size of sizes)
    for (let trial = 0; trial < repeats; trial++)
      for (const batch of trial % 2 ? [500, 50, 1] : [1, 50, 500]) {
        const namespace = `ingest_${size}_${trial}_${batch}_${process.pid}`,
          store = new GraphStore(db, namespace),
          app = createApp(store);
        try {
          await store.initialize();
          const address = await app.listen({ host: "127.0.0.1", port: 0 }),
            client = new GraphClient(address),
            ontology = "records";
          await client.register(
            ontologySchema.parse({
              id: ontology,
              name: ontology,
              objectTypes: [
                {
                  name: "Record",
                  properties: { value: { type: "number", required: true } },
                },
              ],
              relationshipTypes: [],
            }),
          );
          const latencies: number[] = [],
            provenance = {
              source: "synthetic-ingestion",
              externalId: "fixture",
              observedAt: "2026-10-15T00:00:00Z",
            },
            objects = Array.from({ length: size }, (_, n) => ({
              id: `r-${n}`,
              type: "Record",
              properties: { value: n },
              provenance,
            }));
          const cpuBefore = process.cpuUsage(),
            redisBefore = await connection.info("cpu"),
            start = performance.now();
          for (let offset = 0; offset < size; offset += batch) {
            const requestStart = performance.now();
            await client.ingest(ontology, {
              objects: objects.slice(offset, offset + batch),
              relationships: [],
            });
            latencies.push(performance.now() - requestStart);
          }
          const totalMs = performance.now() - start,
            cpu = process.cpuUsage(cpuBefore),
            redisAfter = await connection.info("cpu"),
            state = await client.snapshot(ontology),
            commits = Math.ceil(size / batch);
          assert.equal(state.revision, commits);
          assert.equal(state.objects.length, size);
          assert.equal(
            state.objects.reduce(
              (sum, o) => sum + Number(o.properties.value),
              0,
            ),
            (size * (size - 1)) / 2,
          );
          const historical = await client.stateAt(ontology, { revision: 1 });
          assert.equal(historical.objects.length, Math.min(batch, size));
          await client.ingest(ontology, {
            objects,
            relationships: [],
          });
          assert.equal((await client.snapshot(ontology)).revision, commits);
          const beforeInvalid = await client.snapshot(ontology);
          await assert.rejects(() =>
            client.ingest(ontology, {
              objects: [
                { ...objects[0], properties: { value: -1 } },
                {
                  id: "invalid",
                  type: "Record",
                  properties: { value: "invalid" },
                  provenance,
                },
              ],
              relationships: [],
            }),
          );
          assert.deepEqual(await client.snapshot(ontology), beforeInvalid);
          const count = await db.selectGraph(namespace).roQuery<{
            versions: number;
          }>("MATCH (v:ObjectVersion {ontology:'records'}) RETURN count(v) AS versions");
          assert.equal(Number(count.data?.[0]?.versions), size);
          const filename = `${size}-${batch}-${trial}.json`;
          await writeFile(
            `${output}/${filename}`,
            JSON.stringify(
              { size, batch, trial, requestLatenciesMs: latencies },
              null,
              2,
            ),
          );
          const sorted = [...latencies].sort((a, b) => a - b),
            q = (p: number) =>
              sorted[
                Math.min(sorted.length - 1, Math.floor(sorted.length * p))
              ];
          rows.push({
            size,
            batch,
            trial,
            requests: latencies.length,
            commitRevisions: commits,
            totalMs,
            rowsPerSecond: (size * 1000) / totalMs,
            p50RequestMs: q(0.5),
            p95RequestMs: q(0.95),
            p99RequestMs: q(0.99),
            nodeUserUs: cpu.user,
            nodeSystemUs: cpu.system,
            nodeRssBytes: process.memoryUsage().rss,
            redisBefore,
            redisAfter,
            graphMemoryUsage: await db.selectGraph(namespace).memoryUsage(),
            raw: filename,
            finalAnswerEqual: true,
            oneVersionPerObject: true,
            replayNoOp: true,
            invalidBatchAtomic: true,
          });
          console.log(
            JSON.stringify({ size, batch, trial, ms: totalMs, checked: true }),
          );
        } finally {
          await app.close();
          await db.selectGraph(namespace).delete();
        }
      }
  await writeFile(
    `${output}/summary.json`,
    JSON.stringify(
      {
        metadata: {
          commit: execFileSync("git", ["rev-parse", "HEAD"], {
            encoding: "utf8",
          }).trim(),
          scriptSha256: createHash("sha256")
            .update(await readFile(new URL(import.meta.url)))
            .digest("hex"),
          node: process.version,
          cpu: cpus()[0]?.model,
          logicalCpus: cpus().length,
          sizes,
          repeats,
          server: await connection.info("server"),
          persistence: await connection.info("persistence"),
          modules: await connection.sendCommand(["MODULE", "LIST"]),
          note: "All routes validate and record native object history, revisions and audit. Batch size changes transaction granularity and commit count; equal per-object version/history enablement and final answers, not identical intermediate visibility. API/client one process, DB loopback; one client, no warmup requests; reverse batch order each trial. Readback/replay/rejection checks outside measured ingestion.",
        },
        rows,
      },
      null,
      2,
    ),
  );
} finally {
  await db.close();
}
