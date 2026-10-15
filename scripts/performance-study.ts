import { performance } from "node:perf_hooks";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { cpus, platform, arch, totalmem } from "node:os";
import { execFileSync } from "node:child_process";
import { FalkorDB } from "falkordb";
import { GraphStore } from "@graph/core";
import { GraphClient } from "@graph/sdk";
import { ontologySchema } from "@graph/contracts";
import { createApp } from "../apps/api/src/app.js";
const integer = (s: string, min: number, max: number) => {
  const n = Number(s);
  if (!Number.isInteger(n) || n < min || n > max)
    throw Error(`Expected integer ${min}–${max}: ${s}`);
  return n;
};
const sizes = (process.env.STUDY_SIZES ?? "250,1000")
  .split(",")
  .map((s) => integer(s, 10, 10000));
const concurrencies = (process.env.STUDY_CONCURRENCY ?? "1,8")
  .split(",")
  .map((s) => integer(s, 1, 32));
const samples = integer(process.env.STUDY_SAMPLES ?? "200", 20, 10000);
const repeats = integer(process.env.STUDY_REPEATS ?? "3", 1, 10);
const label = process.env.STUDY_LABEL ?? "local";
if (!/^[a-zA-Z0-9_-]+$/.test(label)) throw Error("Invalid STUDY_LABEL");
const directory = process.env.STUDY_OUTPUT ?? `artifacts/performance/${label}`;
await mkdir(directory, { recursive: true });
const db = await FalkorDB.connect({
  socket: {
    host: process.env.FALKORDB_HOST ?? "127.0.0.1",
    port: Number(process.env.FALKORDB_PORT ?? 6379),
  },
  password: process.env.FALKORDB_PASSWORD,
});
const graphName = `study_${Date.now()}_${process.pid}`;
const store = new GraphStore(db, graphName);
const app = createApp(store);
const quantile = (values: number[], q: number) =>
  values[Math.max(0, Math.ceil(values.length * q) - 1)];
const results: Record<string, unknown>[] = [];
try {
  await store.initialize();
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  const client = new GraphClient(address);
  const native = db.selectGraph(graphName);
  const connection = await db.connection;
  const info = async (section: string) =>
    Object.fromEntries(
      (await connection.info(section))
        .split("\n")
        .filter((l) => l.includes(":"))
        .map((l) => {
          const at = l.indexOf(":");
          return [l.slice(0, at), l.slice(at + 1).trim()];
        }),
    );
  const pick = (record: Record<string, string>, keys: string[]) =>
    Object.fromEntries(keys.map((k) => [k, record[k]]));
  for (const size of sizes) {
    const ontology = `records-${size}`;
    await client.register(
      ontologySchema.parse({
        id: ontology,
        name: "Performance fixture",
        objectTypes: [
          {
            name: "Record",
            properties: { score: { type: "number", required: true } },
          },
        ],
        relationshipTypes: [{ name: "NEXT", from: "Record", to: "Record" }],
      }),
    );
    const provenance = {
      source: "performance-study",
      externalId: "fixture",
      observedAt: "2026-10-15T00:00:00Z",
    };
    const id = (n: number) => `record-${String(n).padStart(6, "0")}`;
    const started = performance.now();
    for (let start = 0; start < size; start += 1000) {
      const objects = Array.from(
        { length: Math.min(1000, size - start) },
        (_, i) => ({
          id: id(start + i),
          type: "Record",
          properties: { score: start + i },
          provenance,
        }),
      );
      await client.ingest(ontology, {
        objects,
        relationships: objects
          .filter((o) => o.id !== id(0))
          .map((o) => {
            const i = Number(o.id.slice(7));
            return {
              id: `edge-${i}`,
              type: "NEXT",
              from: id(i - 1),
              to: o.id,
              provenance,
            };
          }),
      });
    }
    const ingestMs = performance.now() - started;
    await client.createPropertyIndex(ontology, "Record", "score");
    const filters = [
      { property: "score", operator: "gte" as const, value: size / 2 },
    ];
    const expectedCount = Math.floor(size / 2);
    const expectedSum = ((Math.ceil(size / 2) + size - 1) * expectedCount) / 2;
    const aggregate = async () => {
      const r = await client.aggregate(ontology, {
        type: "Record",
        operation: "sum",
        property: "score",
        filters,
      });
      if (r.count !== expectedCount || r.value !== expectedSum)
        throw Error(`Aggregate answer mismatch: ${JSON.stringify(r)}`);
    };
    const page = async () => {
      const r = await client.queryObjects(ontology, {
        type: "Record",
        filters,
        limit: 50,
      });
      if (
        r.items.length !== Math.min(50, expectedCount) ||
        r.items.some((o) => Number(o.properties.score) < size / 2)
      )
        throw Error("Page answer mismatch");
    };
    // PROFILE is read-only here; the text deliberately matches the filter and native aggregate shape.
    const parameters = `CYPHER ontology='${ontology}' type='Record' after='' value0=${size / 2} limit=101 `;
    const match =
      "MATCH (o:Object {ontology:$ontology}) WHERE ($type='' OR o.type=$type) AND ($after='' OR o.id>$after) AND o.`p_score` >= $value0";
    const queries = {
      referencePage:
        parameters +
        match +
        " RETURN o.record AS record ORDER BY o.id LIMIT $limit",
      nativeAggregate:
        parameters +
        match +
        " RETURN count(o) AS count,count(o.`p_score`) AS numericCount,sum(o.`p_score`) AS value",
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
    for (const [operation, call] of [
      ["aggregate", aggregate],
      ["filtered-page", page],
    ] as const) {
      for (let i = 0; i < 20; i++) await call();
      for (const concurrency of concurrencies) {
        for (let trial = 0; trial < repeats; trial++) {
          const raw: {
            sequence: number;
            elapsedMs: number;
            latencyMs: number;
            ok: boolean;
            error?: string;
          }[] = [];
          let next = 0;
          const databaseCpuBefore = await info("cpu");
          const cpuBefore = process.cpuUsage();
          const rssBefore = process.memoryUsage().rss;
          const start = performance.now();
          await Promise.all(
            Array.from({ length: concurrency }, async () => {
              while (true) {
                const sequence = next++;
                if (sequence >= samples) break;
                const at = performance.now();
                try {
                  await call();
                  raw.push({
                    sequence,
                    elapsedMs: at - start,
                    latencyMs: performance.now() - at,
                    ok: true,
                  });
                } catch (error) {
                  raw.push({
                    sequence,
                    elapsedMs: at - start,
                    latencyMs: performance.now() - at,
                    ok: false,
                    error:
                      error instanceof Error ? error.message : String(error),
                  });
                }
              }
            }),
          );
          const elapsedMs = performance.now() - start;
          const cpu = process.cpuUsage(cpuBefore);
          const databaseCpuAfter = await info("cpu");
          const databaseMemory = await info("memory");
          const latencies = raw
            .filter((r) => r.ok)
            .map((r) => r.latencyMs)
            .sort((a, b) => a - b);
          const file = `${size}-${operation}-c${concurrency}-t${trial}.json`;
          await writeFile(
            `${directory}/${file}`,
            JSON.stringify(raw.sort((a, b) => a.sequence - b.sequence)) + "\n",
          );
          const row = {
            size,
            operation,
            concurrency,
            trial,
            samples: raw.length,
            errors: raw.filter((r) => !r.ok).length,
            elapsedMs,
            operationsPerSecond: (latencies.length * 1000) / elapsedMs,
            p50Ms: quantile(latencies, 0.5),
            p95Ms: quantile(latencies, 0.95),
            p99Ms: latencies.length >= 1000 ? quantile(latencies, 0.99) : null,
            nodeCpuMs: (cpu.user + cpu.system) / 1000,
            databaseCpuMs:
              (Number(databaseCpuAfter.used_cpu_user) +
                Number(databaseCpuAfter.used_cpu_sys) -
                Number(databaseCpuBefore.used_cpu_user) -
                Number(databaseCpuBefore.used_cpu_sys)) *
              1000,
            databaseUsedMemoryBytes: Number(databaseMemory.used_memory),
            databaseRssBytes: Number(databaseMemory.used_memory_rss),
            nodeRssBefore: rssBefore,
            nodeRssAfter: process.memoryUsage().rss,
            raw: file,
          };
          results.push(row);
          console.log(JSON.stringify(row));
          if (row.errors) process.exitCode = 1;
        }
      }
    }
    const branches = [];
    for (let i = 0; i < 5; i++) {
      const start = performance.now();
      const b = await client.createScenario(ontology, {
        id: `branch-${i}`,
        name: `Branch ${i}`,
      });
      const created = performance.now();
      await client.patchScenarioObject(ontology, b.id, id(0), {
        expectedVersion: b.version,
        properties: { score: -1 },
      });
      const edited = performance.now();
      branches.push({
        trial: i,
        firstBase: i === 0,
        createMs: created - start,
        editMs: edited - created,
      });
    }
    const cleanupStart = performance.now();
    for (let i = 0; i < 5; i++)
      await client.discardScenario(ontology, `branch-${i}`);
    const cleanupMs = performance.now() - cleanupStart;
    await writeFile(
      `${directory}/${size}-branches.json`,
      JSON.stringify({ size, ingestMs, branches, cleanupMs }, null, 2) + "\n",
    );
  }
  const readLimit = async (p: string) =>
    readFile(p, "utf8")
      .then((s) => s.trim())
      .catch(() => "unavailable");
  const environment = {
    label,
    node: process.version,
    platform: platform(),
    arch: arch(),
    cpu: cpus()[0]?.model,
    visibleLogicalCpus: cpus().length,
    hostMemoryBytes: totalmem(),
    cgroupCpuMax: await readLimit("/sys/fs/cgroup/cpu.max"),
    cgroupMemoryMax: await readLimit("/sys/fs/cgroup/memory.max"),
    sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim(),
    storeBlob: execFileSync(
      "git",
      ["hash-object", "packages/core/src/store.ts"],
      { encoding: "utf8" },
    ).trim(),
    databaseInfo: pick(await info("server"), [
      "redis_version",
      "arch_bits",
      "multiplexing_api",
      "gcc_version",
    ]),
    moduleInfo: await connection.sendCommand(["MODULE", "LIST"]).then((r) =>
      (Array.isArray(r) ? r.filter(Array.isArray) : []).map((fields) => ({
        name: fields[fields.indexOf("name") + 1],
        version: fields[fields.indexOf("ver") + 1],
      })),
    ),
    persistenceInfo: pick(await info("persistence"), [
      "aof_enabled",
      "rdb_changes_since_last_save",
      "rdb_last_bgsave_status",
    ]),
    databaseMemory: pick(await info("memory"), [
      "used_memory",
      "used_memory_rss",
      "maxmemory",
    ]),
    sizes,
    concurrencies,
    samples,
    repeats,
    warmup: 20,
    loadModel:
      "closed loop; fixed request count; no think time; sequential trials; warm native range index",
    placement:
      "client and API share this Node process; database address selected by FALKORDB_HOST/PORT; localhost by default",
    note: "Node CPU/RSS includes both client and API, excludes database. No cold-cache, remote network or capacity claim. p99 withheld below 1000 successful samples per trial. Native PROFILE is separate from HTTP timings. Versions, current graph and native scenario copies all exist in the same database process.",
  };
  await writeFile(
    `${directory}/summary.json`,
    JSON.stringify({ environment, results }, null, 2) + "\n",
  );
} finally {
  await app.close();
  await store.nativeGraphs.collect(new Set());
  await db.selectGraph(graphName).delete();
  await db.close();
}
