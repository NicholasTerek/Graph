import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import { cpus } from "node:os";
import { FalkorDB } from "falkordb";
import { GraphStore, ScenarioService } from "@graph/core";
import { GraphClient } from "@graph/sdk";
import { ontologySchema } from "@graph/contracts";
import { createApp } from "../apps/api/src/app.js";
const sizes = (process.env.LIFECYCLE_SIZES ?? "1000,10000")
    .split(",")
    .map(Number),
  repeats = Number(process.env.LIFECYCLE_REPEATS ?? 3);
if (
  sizes.some((n) => !Number.isInteger(n) || n < 100 || n > 10000) ||
  !Number.isInteger(repeats) ||
  repeats < 2 ||
  repeats > 10
)
  throw Error("Sizes 100–10000; repeats 2–10");
const output =
  process.env.LIFECYCLE_OUTPUT ?? "artifacts/branch-lifecycle/local";
await mkdir(output, { recursive: true });
const oldCommit = "9981e20",
  oldSource = execFileSync(
    "git",
    ["show", `${oldCommit}:packages/core/src/scenarios.ts`],
    { encoding: "utf8" },
  );
const oldPath = resolve("artifacts/branch-lifecycle/legacy-scenarios.ts");
await mkdir(resolve("artifacts/branch-lifecycle"), { recursive: true });
await writeFile(
  oldPath,
  oldSource
    .replaceAll(
      '"./store.js"',
      JSON.stringify(resolve("packages/core/src/store.ts")),
    )
    .replaceAll(
      '"./validation.js"',
      JSON.stringify(resolve("packages/core/src/validation.ts")),
    ),
);
const Legacy = (await import(pathToFileURL(oldPath).href))
  .ScenarioService as typeof ScenarioService;
const db = await FalkorDB.connect({
    socket: {
      host: process.env.FALKORDB_HOST ?? "127.0.0.1",
      port: Number(process.env.FALKORDB_PORT ?? 6379),
    },
  }),
  connection = await db.connection;
const server = await connection.info("server");
const readProc = async () => {
  const cpu = await connection.info("cpu"),
    memory = await connection.info("memory"),
    node = process.cpuUsage();
  const field = (text: string, key: string) =>
    Number(text.match(new RegExp(`^${key}:([0-9.]+)`, "m"))?.[1]);
  return {
    nodeUserUs: node.user,
    nodeSystemUs: node.system,
    nodeRssBytes: process.memoryUsage().rss,
    redisRssKb: field(memory, "used_memory_rss") / 1024,
    redisPeakMemoryBytes: field(memory, "used_memory_peak"),
    redisUserUs: field(cpu, "used_cpu_user") * 1e6,
    redisSystemUs: field(cpu, "used_cpu_sys") * 1e6,
  };
};
const measure = async <T>(call: () => Promise<T>) => {
  const before = await readProc(),
    start = performance.now();
  const value = await call();
  const ms = performance.now() - start,
    after = await readProc();
  return {
    value,
    metrics: {
      ms,
      nodeUserUs: after.nodeUserUs - before.nodeUserUs,
      nodeSystemUs: after.nodeSystemUs - before.nodeSystemUs,
      nodeRssBytes: after.nodeRssBytes,
      redisRssKb: after.redisRssKb,
      redisPeakMemoryBytes: after.redisPeakMemoryBytes,
      redisUserUs: after.redisUserUs - before.redisUserUs,
      redisSystemUs: after.redisSystemUs - before.redisSystemUs,
    },
  };
};
const disk = async () => {
  if (!process.env.LIFECYCLE_RDB_PATH) return null;
  await connection.sendCommand(["SAVE"]);
  return (await stat(process.env.LIFECYCLE_RDB_PATH)).size;
};
const rows: Record<string, unknown>[] = [],
  trials: Record<string, unknown>[] = [];
try {
  if ((await db.list()).length)
    throw Error(
      "Use an empty disposable database for exclusive graph/storage accounting",
    );
  for (const size of sizes)
    for (let trial = 0; trial < repeats; trial++)
      for (const backend of trial % 2
        ? ["overlay", "copy", "json"]
        : ["json", "copy", "overlay"]) {
        const namespace = `lifecycle_${size}_${trial}_${backend}_${process.pid}`,
          store = new GraphStore(db, namespace),
          app = createApp(store),
          service =
            backend === "json" ? new Legacy(store) : new ScenarioService(store);
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
                  properties: { score: { type: "number", required: true } },
                },
              ],
              relationshipTypes: [
                { name: "NEXT", from: "Record", to: "Record" },
              ],
            }),
          );
          const provenance = {
            source: "synthetic-lifecycle",
            externalId: "fixture",
            observedAt: "2026-10-15T00:00:00Z",
          };
          const ingestStart = performance.now();
          for (let start = 0; start < size; start += 500) {
            const end = Math.min(start + 500, size);
            await client.ingest(ontology, {
              objects: Array.from({ length: end - start }, (_, i) => ({
                id: `r-${start + i}`,
                type: "Record",
                properties: { score: start + i },
                provenance,
              })),
              relationships: Array.from(
                { length: end - start },
                (_, i) => start + i,
              )
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
          const ingestHttpMs = performance.now() - ingestStart,
            baseline = await client.snapshot(ontology),
            baselineRdbBytes = await disk(),
            baselineMemory = await db.selectGraph(namespace).memoryUsage();
          const storage = async () => ({
            graphs: await Promise.all(
              (await db.list()).map(async (key) => ({
                key: key === namespace ? "main" : "native",
                memoryUsage: await db.selectGraph(key).memoryUsage(),
              })),
            ),
            baseJsonBytes: Buffer.byteLength(
              JSON.stringify(await store.documents("base", ontology)),
            ),
            scenarioJsonBytes: Buffer.byteLength(
              JSON.stringify(await store.documents("scenario", ontology)),
            ),
          });
          for (const [index, fraction] of [0.001, 0.01, 0.1].entries()) {
            const id = `branch-${index}`,
              changed = Math.max(1, Math.round(size * fraction));
            const creation = await measure(() =>
              service.create(ontology, {
                id,
                name: id,
                description: "Common branch operation",
                expectedRevision: baseline.revision,
                ...(backend === "json"
                  ? {}
                  : { strategy: backend as "copy" | "overlay" }),
              }),
            );
            const objects = baseline.objects.slice(0, changed).map((o) => ({
              ...o,
              properties: { score: -1 },
              provenance: {
                ...o.provenance,
                source: "reviewed-lifecycle-edit",
              },
            }));
            const edit = await measure(() =>
              service.edit(ontology, id, {
                objects,
                relationships: [],
                removeObjects: [],
                removeRelationships: [],
                expectedVersion: 0,
              }),
            );
            await assert.rejects(
              () =>
                service.edit(ontology, id, {
                  objects,
                  relationships: [],
                  removeObjects: [],
                  removeRelationships: [],
                  expectedVersion: 0,
                }),
              /version conflict/i,
            );
            const read = await measure(() => service.state(ontology, id));
            assert.equal(read.value.objects.length, size);
            assert.equal(read.value.relationships.length, size - 1);
            assert.equal(
              read.value.objects.filter((o) => o.properties.score === -1)
                .length,
              changed,
            );
            assert.equal(read.value.scenarioVersion, 1);
            const score = read.value.objects.reduce(
                (sum, o) => sum + Number(o.properties.score),
                0,
              ),
              expected =
                (size * (size - 1)) / 2 -
                objects.reduce(
                  (sum, o) =>
                    sum +
                    Number(
                      baseline.objects.find((b) => b.id === o.id)!.properties
                        .score,
                    ) +
                    1,
                  0,
                );
            assert.equal(score, expected);
            assert.deepEqual(await client.snapshot(ontology), baseline);
            const diff = await service.diff(ontology, id);
            assert.equal(diff.objects.length, changed);
            assert.equal(diff.relationships.length, 0);
            rows.push({
              size,
              trial,
              backend,
              branchCount: index + 1,
              firstBase: index === 0,
              fraction,
              changed,
              create: creation.metrics,
              edit: edit.metrics,
              read: read.metrics,
              readJsonBytes: Buffer.byteLength(JSON.stringify(read.value)),
              storage: await storage(),
              answerEqual: true,
              staleEditRejected: true,
              liveUnchanged: true,
            });
          }
          const retainedRdbBytes = await disk(),
            cleanup = await measure(async () => {
              for (let i = 0; i < 3; i++)
                await service.discard(ontology, `branch-${i}`);
            });
          assert.equal((await service.list(ontology)).length, 0);
          assert.equal((await db.list()).length, 1);
          assert.deepEqual(await client.snapshot(ontology), baseline);
          trials.push({
            size,
            trial,
            backend,
            ingestHttpMs,
            baselineMemory,
            baselineRdbBytes,
            retainedRdbBytes,
            rdbIncrementBytes:
              retainedRdbBytes === null || baselineRdbBytes === null
                ? null
                : retainedRdbBytes - baselineRdbBytes,
            cleanup: cleanup.metrics,
            afterCleanupRdbBytes: await disk(),
            afterCleanupStorage: await storage(),
          });
          console.log(
            JSON.stringify({
              size,
              trial,
              backend,
              branches: 3,
              checked: true,
            }),
          );
        } finally {
          await app.close();
          await store.nativeGraphs.collect(new Set());
          await db.selectGraph(namespace).delete();
        }
      }
  await writeFile(
    `${output}/samples.json`,
    JSON.stringify(
      {
        metadata: {
          productionCommit: execFileSync("git", ["rev-parse", "HEAD"], {
            encoding: "utf8",
          }).trim(),
          scriptSha256: createHash("sha256")
            .update(await readFile(new URL(import.meta.url)))
            .digest("hex"),
          legacyCommit: oldCommit,
          legacySha256: createHash("sha256").update(oldSource).digest("hex"),
          node: process.version,
          cpu: cpus()[0]?.model,
          logicalCpus: cpus().length,
          sizes,
          repeats,
          redisServer: server,
          redisPersistence: await connection.info("persistence"),
          moduleInfo: await connection.sendCommand(["MODULE", "LIST"]),
          note: "Common create/edit/state/diff/discard service calls. Seeded through real HTTP API in 500-object batches. Legacy source uses current store/validation and retains JSON; no automatic native migration. No promotion/algorithm/ownership equivalence is claimed for historical source. Node process counters and Redis INFO CPU/RSS (includes sampling commands). /proc I/O denied by host, so temporary I/O and peak dump-file bytes are unmeasured. RDB SAVE bytes measured outside operation timings on otherwise empty database; not total durable volume footprint.",
        },
        rows,
        trials,
      },
      null,
      2,
    ),
  );
} finally {
  await db.close();
}
