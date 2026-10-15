import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { cpus } from "node:os";
import { strict as assert } from "node:assert";
import ts from "typescript";
import { z } from "zod";
import { FalkorDB } from "falkordb";
import { GraphStore, PlatformError } from "@graph/core";
import { GraphClient } from "@graph/sdk";
import { identifier, objectPatch, ontologySchema } from "@graph/contracts";
import { createApp } from "../apps/api/src/app.js";
const baselineCommit = "724128bd40c4b53a0b614cc4fd341932edefb1a0";
const source = execFileSync(
  "git",
  ["show", `${baselineCommit}:packages/core/src/store.ts`],
  { encoding: "utf8" },
);
const start = source.indexOf("  async patchObject("),
  implementation = source.slice(
    start,
    source.indexOf("\n  async objects(", start),
  );
const Legacy = new Function(
  "PlatformError",
  ts.transpile("class Legacy {" + implementation + "};", {
    target: ts.ScriptTarget.ES2022,
  }) + "return Legacy;",
)(PlatformError) as { prototype: { patchObject: GraphStore["patchObject"] } };
const samples = Number(process.env.PATCH_STUDY_SAMPLES ?? 80),
  repeats = Number(process.env.PATCH_STUDY_REPEATS ?? 3);
if (
  !Number.isInteger(samples) ||
  samples < 10 ||
  samples > 500 ||
  !Number.isInteger(repeats) ||
  repeats < 1 ||
  repeats > 5
)
  throw Error("Invalid patch-study bounds");
const directory = process.env.PATCH_STUDY_OUTPUT ?? "artifacts/local-patch";
await mkdir(directory, { recursive: true });
const db = await FalkorDB.connect({
  socket: {
    host: "127.0.0.1",
    port: Number(process.env.FALKORDB_PORT ?? 6379),
  },
});
const namespace = `patch_study_${Date.now()}_${process.pid}`,
  store = new GraphStore(db, namespace),
  app = createApp(store);
app.patch(
  "/api/study/full/:ontology/:id",
  {
    schema: {
      params: z.object({ ontology: identifier, id: identifier }),
      body: objectPatch,
    },
  },
  async (req, reply) => {
    const result = await Legacy.prototype.patchObject.call(
      store,
      req.params.ontology,
      req.params.id,
      req.body,
    );
    reply.header("etag", `"${result.revision}"`);
    return result;
  },
);
const summaries: unknown[] = [];
try {
  await store.initialize();
  const base = await app.listen({ host: "127.0.0.1", port: 0 }),
    client = new GraphClient(base),
    connection = await db.connection;
  const info = async (section: string) =>
    Object.fromEntries(
      (await connection.info(section))
        .split("\n")
        .filter((l) => l.includes(":"))
        .map((l) => {
          const i = l.indexOf(":");
          return [l.slice(0, i), l.slice(i + 1).trim()];
        }),
    );
  for (const size of [1000, 5000]) {
    const ontology = `cells-${size}`;
    await client.register(
      ontologySchema.parse({
        id: ontology,
        name: ontology,
        objectTypes: [
          {
            name: "Cell",
            properties: { score: { type: "number", required: true } },
          },
        ],
        relationshipTypes: [],
      }),
    );
    const provenance = {
      source: "synthetic-patch-study",
      externalId: "fixture",
      observedAt: "2026-10-15T00:00:00Z",
    };
    for (let offset = 0; offset < size; offset += 1000)
      await client.ingest(ontology, {
        objects: Array.from(
          { length: Math.min(1000, size - offset) },
          (_, i) => ({
            id: `cell-${offset + i}`,
            type: "Cell",
            properties: { score: offset + i },
            provenance,
          }),
        ),
        relationships: [],
      });
    let revision = (await client.snapshot(ontology)).revision,
      value = 0;
    const baselineRevision = revision,
      baseSum = (size * (size - 1)) / 2;
    const patch = async (mode: string) => {
      const next = value + 1,
        input = { expectedRevision: revision, properties: { score: next } };
      const r = await fetch(
        `${base}/api/${mode === "full" ? "study/full" : "ontologies"}/${ontology}/${mode === "full" ? "cell-0" : "objects/cell-0"}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input),
        },
      );
      if (!r.ok) throw Error(`Patch failed ${r.status}: ${await r.text()}`);
      const result = (await r.json()) as Awaited<
        ReturnType<GraphClient["patchObject"]>
      >;
      assert.equal(result.revision, revision + 1);
      assert.equal(result.object.properties.score, next);
      assert.equal(result.revision, baselineRevision + next);
      revision = result.revision;
      value = next;
    };
    for (const readers of [0, 8])
      for (let trial = 0; trial < repeats; trial++)
        for (const mode of trial % 2 ? ["local", "full"] : ["full", "local"]) {
          for (let i = 0; i < 10; i++) await patch(mode);
          const writes: number[] = [],
            reads: number[] = [],
            databaseCpuBefore = await info("cpu"),
            cpu = process.cpuUsage(),
            rssBefore = process.memoryUsage().rss,
            at = performance.now();
          let stopped = false,
            readError: unknown;
          const workers = Array.from({ length: readers }, async () => {
            while (!stopped) {
              const lower = value,
                t = performance.now();
              try {
                const r = await client.aggregate(ontology, {
                  type: "Cell",
                  property: "score",
                  operation: "sum",
                  filters: [],
                });
                assert.equal(r.count, size);
                assert.ok(
                  r.value !== null &&
                    r.value - baseSum >= lower &&
                    r.value - baseSum <= value + 1,
                  "Aggregate outside the possible committed writer interval",
                );
                reads.push(performance.now() - t);
              } catch (e) {
                readError = e;
                stopped = true;
              }
            }
          });
          try {
            for (let i = 0; i < samples && !readError; i++) {
              const t = performance.now();
              await patch(mode);
              writes.push(performance.now() - t);
            }
          } finally {
            stopped = true;
            await Promise.all(workers);
          }
          if (readError) throw readError;
          const elapsedMs = performance.now() - at,
            used = process.cpuUsage(cpu),
            databaseCpuAfter = await info("cpu"),
            memory = await info("memory");
          const stats = (values: number[]) => {
            const sorted = [...values].sort((a, b) => a - b);
            const q = (p: number) =>
              sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)] ?? null;
            return {
              count: values.length,
              p50Ms: q(0.5),
              p95Ms: q(0.95),
              p99Ms: q(0.99),
            };
          };
          const file = `${size}-${mode}-readers${readers}-t${trial}.csv`;
          await writeFile(
            `${directory}/${file}`,
            "operation,latencyMs\n" +
              [
                ...writes.map((ms) => `patch,${ms.toFixed(6)}`),
                ...reads.map((ms) => `aggregate,${ms.toFixed(6)}`),
              ].join("\n") +
              "\n",
          );
          const result = {
            size,
            mode,
            readers,
            trial,
            elapsedMs,
            writer: stats(writes),
            reader: stats(reads),
            writesPerSecond: (writes.length * 1000) / elapsedMs,
            readsPerSecond: (reads.length * 1000) / elapsedMs,
            errors: 0,
            cpuMs: (used.user + used.system) / 1000,
            databaseCpuSeconds:
              Number(databaseCpuAfter.used_cpu_user) +
              Number(databaseCpuAfter.used_cpu_sys) -
              Number(databaseCpuBefore.used_cpu_user) -
              Number(databaseCpuBefore.used_cpu_sys),
            rssBefore,
            rssAfter: process.memoryUsage().rss,
            databaseUsedMemory: Number(memory.used_memory),
            file,
          };
          summaries.push(result);
          console.log(JSON.stringify(result));
        }
    const final = await client.stateAt(ontology);
    assert.equal(final.revision, baselineRevision + value);
    assert.equal(
      final.objects.find((o) => o.id === "cell-0")!.properties.score,
      value,
    );
    assert.equal(final.objects.length, size);
  }
} finally {
  await writeFile(
    `${directory}/summary.json`,
    JSON.stringify(
      {
        node: process.version,
        cpu: cpus()[0]?.model,
        baselineCommit,
        baselineSha256: createHash("sha256")
          .update(implementation)
          .digest("hex"),
        workload:
          "Real loopback HTTP; identical Zod validation, scalar updates, guarded revisions, atomic native history and response shape; ten warmups; fixed successful write counts, sequential writer with zero/eight closed-loop aggregate readers; alternating implementation order; history retained throughout each fixture",
        summaries,
      },
      null,
      2,
    ) + "\n",
  );
  await app.close();
  await db.selectGraph(namespace).delete();
  await db.close();
}
