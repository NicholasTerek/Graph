import { performance } from "node:perf_hooks";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { cpus, platform } from "node:os";
import { execFileSync } from "node:child_process";
import { strict as assert } from "node:assert";
import { FalkorDB } from "falkordb";
import { GraphStore } from "@graph/core";
import { GraphClient } from "@graph/sdk";
import type { AlgorithmInput } from "@graph/contracts";
import { createApp } from "../apps/api/src/app.js";
const sizes = (process.env.ALGORITHM_SIZES ?? "1000,5000")
  .split(",")
  .map(Number);
const repeats = Number(process.env.ALGORITHM_REPEATS ?? 5);
if (
  sizes.some((n) => !Number.isInteger(n) || n < 10 || n > 10000) ||
  !Number.isInteger(repeats) ||
  repeats < 3 ||
  repeats > 30
)
  throw Error("Sizes 10–10000, repeats 3–30");
const output =
  process.env.ALGORITHM_OUTPUT ?? "artifacts/algorithm-phases/local";
await mkdir(output, { recursive: true });
const db = await FalkorDB.connect({
  socket: {
    host: process.env.FALKORDB_HOST ?? "127.0.0.1",
    port: Number(process.env.FALKORDB_PORT ?? 6379),
  },
  password: process.env.FALKORDB_PASSWORD,
});
const namespace = `algorithm_phases_${Date.now()}_${process.pid}`;
const store = new GraphStore(db, namespace),
  app = createApp(store);
type Phases = {
  projectionMs: number;
  algorithmQueryMs: number;
  guardQueryMs: number;
  cleanupMs: number;
  cleanupCalls: number;
  projectionCalls: number;
  algorithmQueries: number;
};
let active: Phases | null = null;
// Instrument service boundaries only in this disposable process. Native query
// timings include driver/loopback/decoding; they are not engine-only PROFILE times.
const native = store.nativeGraphs;
const create = native.create.bind(native),
  query = native.query.bind(native),
  remove = native.remove.bind(native);
native.create = async (...args: Parameters<typeof create>) => {
  const start = performance.now();
  try {
    return await create(...args);
  } finally {
    if (active) {
      active.projectionMs += performance.now() - start;
      active.projectionCalls++;
    }
  }
};
native.query = async (...args: Parameters<typeof query>) => {
  const start = performance.now();
  try {
    return await query(...args);
  } finally {
    if (active) {
      const algorithm = /shortestPath\(|CALL algo\.|RETURN node.id AS id/.test(
        args[2],
      );
      if (algorithm) {
        active.algorithmQueryMs += performance.now() - start;
        active.algorithmQueries++;
      } else active.guardQueryMs += performance.now() - start;
    }
  }
};
native.remove = async (...args: Parameters<typeof remove>) => {
  const start = performance.now();
  try {
    return await remove(...args);
  } finally {
    if (active) {
      active.cleanupMs += performance.now() - start;
      active.cleanupCalls++;
    }
  }
};
const rows: Record<string, unknown>[] = [];
try {
  await store.initialize();
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  const client = new GraphClient(address);
  for (const size of sizes) {
    const ontology = `records-${size}`;
    await client.register({
      id: ontology,
      name: ontology,
      description: "Algorithm phase timing fixture",
      objectTypes: [
        {
          name: "Record",
          description: "Synthetic chain node",
          properties: { score: { type: "number", required: true } },
        },
      ],
      relationshipTypes: [
        {
          name: "NEXT",
          from: "Record",
          to: "Record",
          description: "Directed successor",
        },
      ],
    });
    const provenance = {
      source: "synthetic-chain",
      externalId: "study",
      observedAt: "2026-10-15T00:00:00Z",
    };
    for (let start = 0; start < size; start += 500) {
      const end = Math.min(size, start + 500);
      await client.ingest(ontology, {
        objects: Array.from({ length: end - start }, (_, i) => ({
          id: `r-${start + i}`,
          type: "Record",
          properties: { score: start + i },
          provenance,
        })),
        relationships: Array.from({ length: end - start }, (_, i) => start + i)
          .filter((n) => n > 0)
          .map((n) => ({
            id: `e-${n}`,
            type: "NEXT",
            from: `r-${n - 1}`,
            to: `r-${n}`,
            provenance,
          })),
      });
    }
    const snapshot = await client.snapshot(ontology);
    for (const strategy of ["copy", "overlay"] as const)
      await client.createScenario(ontology, {
        id: strategy,
        name: strategy,
        strategy,
        expectedRevision: snapshot.revision,
      });
    for (const algorithm of ["shortest-path", "degree", "pagerank"] as const) {
      let expected: unknown;
      for (let trial = -1; trial < repeats; trial++) {
        const modes =
          trial % 2 === 0
            ? ["overlay", "copy", "live"]
            : ["live", "copy", "overlay"];
        for (const mode of modes) {
          const input: AlgorithmInput = {
            algorithm,
            maxDepth: 10,
            direction: "out",
            limit: 10,
            samplingSize: 100,
            samplingSeed: 42,
            ...(mode === "live" ? {} : { scenario: mode }),
            ...(algorithm === "shortest-path"
              ? { source: "r-0", target: "r-8" }
              : {}),
          };
          const phases: Phases = {
            projectionMs: 0,
            algorithmQueryMs: 0,
            guardQueryMs: 0,
            cleanupMs: 0,
            cleanupCalls: 0,
            projectionCalls: 0,
            algorithmQueries: 0,
          };
          active = phases;
          const start = performance.now();
          let result;
          try {
            result = await client.runAlgorithm(ontology, input);
          } finally {
            active = null;
          }
          const totalMs = performance.now() - start,
            answer = { path: result.path, rows: result.rows };
          if (expected === undefined) expected = answer;
          else assert.deepEqual(answer, expected);
          assert.equal(phases.projectionCalls, mode === "copy" ? 0 : 1);
          assert.equal(phases.algorithmQueries, 1);
          assert.equal(phases.cleanupCalls, mode === "copy" ? 0 : 1);
          const otherMs =
            totalMs -
            phases.projectionMs -
            phases.algorithmQueryMs -
            phases.guardQueryMs -
            phases.cleanupMs;
          assert.ok(otherMs >= 0, "Phase accounting overlaps");
          if (trial >= 0)
            rows.push({
              size,
              edges: size - 1,
              mode,
              algorithm,
              trial,
              totalMs,
              ...phases,
              otherMs,
              responseBytes: Buffer.byteLength(JSON.stringify(result)),
              answerEqual: true,
            });
        }
      }
    }
  }
  const info = await (await db.connection).sendCommand(["INFO", "server"]);
  await writeFile(
    `${output}/samples.json`,
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
          platform: platform(),
          cpu: cpus()[0]?.model,
          logicalCpus: cpus().length,
          sizes,
          repeats,
          warmupsPerCell: 1,
          concurrency: 1,
          fixture:
            "Directed chain ingested through public HTTP API in 500-record batches; unchanged branches",
          placement: "Client/API same Node process, database loopback",
          persistence: "Record actual database launch settings separately",
          timing:
            "Non-overlapping service spans; native query includes driver/network/decoding; other includes input read, temporal resolution, queue, HTTP and result handling",
          redis: info,
        },
        rows,
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({
      output,
      successfulSamples: rows.length,
      answerEquality: true,
    }),
  );
} finally {
  active = null;
  await app.close();
  await store.nativeGraphs.collect(new Set());
  await db.selectGraph(namespace).delete();
  await db.close();
}
