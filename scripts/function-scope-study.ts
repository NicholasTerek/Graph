import { mkdir, readFile, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { cpus, platform, arch } from "node:os";
import { strict as assert } from "node:assert";
import { FalkorDB } from "falkordb";
import { GraphStore } from "@graph/core";
import { GraphClient } from "@graph/sdk";
import { createApp } from "../apps/api/src/app.js";
import { launchReadiness } from "../examples/semiconductor/functions/launch-readiness.js";
const durationMs = Number(process.env.SCOPE_STUDY_DURATION_MS ?? 2000),
  repeats = Number(process.env.SCOPE_STUDY_REPEATS ?? 3);
if (
  !Number.isInteger(durationMs) ||
  durationMs < 500 ||
  durationMs > 30000 ||
  !Number.isInteger(repeats) ||
  repeats < 1 ||
  repeats > 5
)
  throw Error("Invalid scope study duration/repeats");
const directory = process.env.SCOPE_STUDY_OUTPUT ?? "artifacts/function-scope";
await mkdir(directory, { recursive: true });
const db = await FalkorDB.connect({
  socket: {
    host: process.env.FALKORDB_HOST ?? "127.0.0.1",
    port: Number(process.env.FALKORDB_PORT ?? 6379),
  },
});
const namespace = `scope_study_${Date.now()}_${process.pid}`,
  store = new GraphStore(db, namespace);
const app = createApp(store, {
  functions: [
    launchReadiness,
    { ...launchReadiness, id: "full-launch", scope: undefined },
  ],
});
const summaries: unknown[] = [];
try {
  await store.initialize();
  const base = await app.listen({ host: "127.0.0.1", port: 0 }),
    client = new GraphClient(base),
    native = db.selectGraph(namespace);
  const connection = await db.connection;
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
  const schema = JSON.parse(
      await readFile("examples/semiconductor/ontology.json", "utf8"),
    ),
    data = JSON.parse(
      await readFile("examples/semiconductor/data.json", "utf8"),
    );
  await client.register(schema);
  await client.ingest("semiconductor", data);
  let previousSize = data.objects.length;
  const args = { productId: "aquila-x900" };
  const call = (mode: string) =>
    client.runFunction(
      "semiconductor",
      mode === "full" ? "full-launch" : "launch-readiness",
      args,
    );
  const clearRuns = () =>
    native.query(
      "MATCH (d:Document {ontology:'semiconductor',kind:'run'}) DELETE d",
    );
  for (const size of [1000, 5000]) {
    const at = performance.now();
    for (let start = previousSize; start < size; start += 1000)
      await client.ingest("semiconductor", {
        objects: Array.from(
          { length: Math.min(1000, size - start) },
          (_, i) => ({
            id: `unrelated-${start + i}`,
            type: "Team",
            properties: {
              name: `Unrelated team ${start + i}`,
              status: "active",
            },
            provenance: {
              source: "synthetic-scope-study",
              externalId: String(start + i),
              observedAt: "2026-10-15T00:00:00Z",
            },
          }),
        ),
        relationships: [],
      });
    previousSize = size;
    const incrementalIngestMs = performance.now() - at;
    const full = await call("full"),
      scoped = await call("scoped");
    assert.deepEqual(scoped.output, full.output);
    assert.deepEqual(scoped.evidence?.objects, full.evidence?.objects);
    assert.deepEqual(
      scoped.evidence?.relationships,
      full.evidence?.relationships,
    );
    const fullState = await client.snapshot("semiconductor"),
      inputBytes = Buffer.byteLength(JSON.stringify(fullState));
    const subset = await client.traverse(
      "semiconductor",
      "aquila-x900",
      5,
      "out",
    );
    const scopedInputBytes = Buffer.byteLength(
      JSON.stringify({
        objects: subset.objects,
        relationships: subset.relationships,
      }),
    );
    const context = await store.temporal.ensure("semiconductor");
    const queries = {
      dependencySlice:
        "CYPHER ontology='semiconductor' root='aquila-x900' MATCH p=(root:Object {ontology:$ontology,id:$root})-[:LINK*1..5]->(target:Object {ontology:$ontology}) UNWIND nodes(p) AS n WITH DISTINCT n RETURN n.record AS record ORDER BY n.id LIMIT 2001",
      historicalRoot: `CYPHER ontology='semiconductor' generation='${context.generation}' root='aquila-x900' revision=${context.revision} MATCH (v:ObjectVersion {ontology:$ontology,generation:$generation,id:$root}) WHERE v.valid_from<=$revision AND (v.valid_to IS NULL OR v.valid_to>$revision) RETURN v.record AS record`,
      historicalVisibility: `CYPHER ontology='semiconductor' generation='${context.generation}' revision=${context.revision} MATCH (v:ObjectVersion {ontology:$ontology,generation:$generation}) WHERE v.valid_from<=$revision AND (v.valid_to IS NULL OR v.valid_to>$revision) RETURN count(v) AS visible`,
    };
    const plans: Record<string, unknown> = {};
    for (const [name, query] of Object.entries(queries))
      plans[name] = {
        query,
        explain: await native.explain(query),
        profile: await native.profile(query),
      };
    await writeFile(
      `${directory}/${size}-plans.json`,
      JSON.stringify(plans, null, 2) + "\n",
    );
    await clearRuns();
    for (const concurrency of [1, 8, 32])
      for (let trial = 0; trial < repeats; trial++)
        for (const mode of trial % 2
          ? ["scoped", "full"]
          : ["full", "scoped"]) {
          for (let warm = 0; warm < 10; warm++) await call(mode);
          await clearRuns();
          const raw: {
            latencyMs: number;
            startedMs: number;
            ok: boolean;
            bytes?: number;
            error?: string;
          }[] = [];
          const cpu = process.cpuUsage(),
            databaseCpuBefore = await info("cpu"),
            rssBefore = process.memoryUsage().rss,
            start = performance.now();
          await Promise.all(
            Array.from({ length: concurrency }, async () => {
              while (performance.now() - start < durationMs) {
                const started = performance.now();
                try {
                  const run = await call(mode);
                  assert.deepEqual(run.output, full.output);
                  raw.push({
                    latencyMs: performance.now() - started,
                    startedMs: started - start,
                    ok: true,
                    bytes: Buffer.byteLength(JSON.stringify(run)),
                  });
                } catch (e) {
                  raw.push({
                    latencyMs: performance.now() - started,
                    startedMs: started - start,
                    ok: false,
                    error: (e as Error).message,
                  });
                }
              }
            }),
          );
          const elapsedMs = performance.now() - start,
            used = process.cpuUsage(cpu),
            databaseCpuAfter = await info("cpu"),
            memory = await info("memory");
          const latencies = raw
              .filter((r) => r.ok)
              .map((r) => r.latencyMs)
              .sort((a, b) => a - b),
            quantile = (q: number) =>
              latencies[Math.max(0, Math.ceil(q * latencies.length) - 1)] ??
              null;
          const file = `${size}-${mode}-c${concurrency}-t${trial}.csv`;
          await writeFile(
            `${directory}/${file}`,
            "startedMs,latencyMs,ok,bytes,error\n" +
              raw
                .map((r) =>
                  [
                    r.startedMs.toFixed(6),
                    r.latencyMs.toFixed(6),
                    r.ok ? 1 : 0,
                    r.bytes ?? 0,
                    '"' + (r.error ?? "").replaceAll('"', '""') + '"',
                  ].join(","),
                )
                .join("\n") +
              "\n",
          );
          const summary = {
            size,
            mode,
            concurrency,
            trial,
            requestedDurationMs: durationMs,
            elapsedMs,
            requests: raw.length,
            errors: raw.filter((r) => !r.ok).length,
            p50Ms: quantile(0.5),
            p95Ms: quantile(0.95),
            p99Ms: quantile(0.99),
            completedPerSecond: (raw.length * 1000) / elapsedMs,
            cpuMs: (used.user + used.system) / 1000,
            rssBefore,
            rssAfter: process.memoryUsage().rss,
            databaseCpuSeconds:
              Number(databaseCpuAfter.used_cpu_user) +
              Number(databaseCpuAfter.used_cpu_sys) -
              Number(databaseCpuBefore.used_cpu_user) -
              Number(databaseCpuBefore.used_cpu_sys),
            databaseUsedMemory: Number(memory.used_memory),
            inputObjects: mode === "full" ? size : subset.objects.length,
            logicalInputJsonBytes:
              mode === "full" ? inputBytes : scopedInputBytes,
            incrementalIngestMs,
            file,
          };
          summaries.push(summary);
          console.log(JSON.stringify(summary));
          await clearRuns();
          if (summary.errors)
            throw Error(
              "Scope study recorded request failures; inspect raw samples",
            );
        }
  }
} finally {
  await writeFile(
    `${directory}/summary.json`,
    JSON.stringify(
      {
        node: process.version,
        cpu: cpus()[0]?.model,
        platform: platform(),
        arch: arch(),
        persistence:
          "Use a disposable database; record its configuration with the results",
        placement:
          "API and closed-loop client in one Node process on loopback; FalkorDB separate local process",
        workload:
          "fixed-duration closed-loop function reads, including persisted calculation/evidence; ten warmups; alternating implementation order; runs removed between trials outside measurements",
        summaries,
      },
      null,
      2,
    ) + "\n",
  );
  await app.close();
  await store.nativeGraphs.collect(new Set());
  await db.selectGraph(namespace).delete();
  await db.close();
}
