import { performance } from "node:perf_hooks";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { cpus, platform } from "node:os";
import { execFileSync } from "node:child_process";
import { FalkorDB } from "falkordb";
import { GraphStore, defineFunction } from "@graph/core";
import { GraphClient } from "@graph/sdk";
import { ontologySchema } from "@graph/contracts";
import { z } from "zod";
import { createApp } from "../apps/api/src/app.js";
const sizes = (process.env.BRANCH_SIZES ?? "1000,5000").split(",").map(Number);
const trials = Number(process.env.BRANCH_TRIALS ?? 5);
if (
  sizes.some((n) => !Number.isInteger(n) || n < 10 || n > 10000) ||
  !Number.isInteger(trials) ||
  trials < 2 ||
  trials > 20
)
  throw Error("BRANCH_SIZES: integers 10–10000; BRANCH_TRIALS: 2–20");
const output = process.env.BRANCH_OUTPUT ?? "artifacts/branches/local";
await mkdir(output, { recursive: true });
const db = await FalkorDB.connect({
  socket: {
    host: process.env.FALKORDB_HOST ?? "127.0.0.1",
    port: Number(process.env.FALKORDB_PORT ?? 6379),
  },
  password: process.env.FALKORDB_PASSWORD,
});
const namespace = `branches_${Date.now()}_${process.pid}`;
const store = new GraphStore(db, namespace);
const strategies = ["copy", "overlay"] as const;
const oid = (size: number, strategy: string) => `records-${size}-${strategy}`;
const functions = sizes.flatMap((size) =>
  strategies.map((strategy) =>
    defineFunction({
      id: "total",
      name: "Sum scores",
      description: "Full-view branch evaluation",
      ontology: oid(size, strategy),
      input: z.object({}),
      output: z.object({ total: z.number() }),
      execute: ({ graph }) => ({
        total: graph
          .objects("Record")
          .reduce((sum, o) => sum + Number(o.properties.score), 0),
      }),
    }),
  ),
);
const app = createApp(store, { functions });
const rows: Record<string, unknown>[] = [];
const timed = async <T>(call: () => Promise<T>) => {
  const start = performance.now();
  const value = await call();
  return { value, ms: performance.now() - start };
};
try {
  await store.initialize();
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  const client = new GraphClient(address);
  const connection = await db.connection;
  const native = db.selectGraph(namespace);
  for (const size of sizes) {
    // Reverse order at the second size to expose rather than assume a fixed-order advantage.
    const order =
      sizes.indexOf(size) % 2 ? [...strategies].reverse() : strategies;
    for (const strategy of order) {
      const ontology = oid(size, strategy);
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
          relationshipTypes: [{ name: "NEXT", from: "Record", to: "Record" }],
        }),
      );
      const provenance = {
        source: "branch-study",
        externalId: "fixture",
        observedAt: "2026-10-15T00:00:00Z",
      };
      const id = (i: number) => `record-${String(i).padStart(6, "0")}`;
      const ingestStart = performance.now();
      for (let start = 0; start < size; start += 1000) {
        const objects = Array.from(
          { length: Math.min(1000, size - start) },
          (_, n) => ({
            id: id(start + n),
            type: "Record",
            properties: { score: start + n },
            provenance,
          }),
        );
        await client.ingest(ontology, {
          objects,
          relationships: objects
            .filter((o) => o.id !== id(0))
            .map((o) => {
              const n = Number(o.id.slice(7));
              return {
                id: `edge-${n}`,
                type: "NEXT",
                from: id(n - 1),
                to: o.id,
                provenance,
              };
            }),
        });
      }
      const ingestMs = performance.now() - ingestStart;
      const baseline = await client.snapshot(ontology);
      const expectedTotal = (size * (size - 1)) / 2 - 1;
      for (let trial = 0; trial < trials; trial++) {
        const branchId = `branch-${trial}`;
        const creation = await timed(() =>
          client.createScenario(ontology, {
            id: branchId,
            name: branchId,
            strategy,
            expectedRevision: baseline.revision,
          }),
        );
        const edit = await timed(() =>
          client.patchScenarioObject(ontology, branchId, id(0), {
            expectedVersion: 0,
            properties: { score: -1 },
          }),
        );
        const read = await timed(() =>
          client.scenarioGraph(ontology, branchId),
        );
        if (
          read.value.objects.length !== size ||
          read.value.objects[0].properties.score !== -1 ||
          read.value.relationships.length !== size - 1
        )
          throw Error("Branch answer mismatch");
        const evaluation = await timed(() =>
          client.runFunction<{ total: number }>(
            ontology,
            "total",
            {},
            branchId,
          ),
        );
        if (evaluation.value.output.total !== expectedTotal)
          throw Error("Calculation answer mismatch");
        const algorithm = await timed(() =>
          client.runAlgorithm(ontology, {
            algorithm: "shortest-path",
            scenario: branchId,
            source: id(0),
            target: id(5),
            maxDepth: 5,
          }),
        );
        if (algorithm.value.path?.objects.length !== 6)
          throw Error("Path answer mismatch");
        const metadata = await store.document<{ graphKey?: string }>(
          "scenario",
          ontology,
          branchId,
        );
        const counts = await native.query<{ count: number }>(
          "MATCH (s:BranchObject {ontology:$ontology,scenario:$scenario}) RETURN count(s) AS count",
          { params: { ontology, scenario: branchId } },
        );
        const row = {
          size,
          strategy,
          trial,
          firstBase: trial === 0,
          ingestMs,
          baseRevision: baseline.revision,
          createMs: creation.ms,
          editMs: edit.ms,
          readMs: read.ms,
          evaluateMs: evaluation.ms,
          algorithmMs: algorithm.ms,
          overlayObjectRecords: Number(counts.data?.[0]?.count),
          workingGraphMemory: metadata?.graphKey
            ? await db.selectGraph(metadata.graphKey).memoryUsage()
            : null,
          mainGraphMemory: await native.memoryUsage(),
          nodeRssBytes: process.memoryUsage().rss,
        };
        rows.push(row);
        console.log(
          JSON.stringify({
            size,
            strategy,
            trial,
            createMs: creation.ms,
            editMs: edit.ms,
            evaluateMs: evaluation.ms,
            algorithmMs: algorithm.ms,
          }),
        );
      }
      const selected = `branch-${trials - 1}`;
      const review = await client.reviewScenario(ontology, selected);
      const promotion = await timed(() =>
        client.promoteScenario(ontology, selected, {
          expectedVersion: review.version,
          expectedRevision: review.liveRevision,
          objects: [id(0)],
          relationships: [],
          confirm: true,
        }),
      );
      if ((await client.object(ontology, id(0))).properties.score !== -1)
        throw Error("Promotion answer mismatch");
      const cleanup = await timed(async () => {
        for (let i = 0; i < trials; i++)
          await client.discardScenario(ontology, `branch-${i}`);
      });
      await writeFile(
        `${output}/${size}-${strategy}.json`,
        JSON.stringify(
          {
            size,
            strategy,
            trials: rows.filter(
              (r) => r.size === size && r.strategy === strategy,
            ),
            promotionMs: promotion.ms,
            cleanupMs: cleanup.ms,
          },
          null,
          2,
        ) + "\n",
      );
    }
  }
  const limit = async (path: string) =>
    readFile(path, "utf8")
      .then((s) => s.trim())
      .catch(() => "unavailable");
  const moduleInfo = await connection.sendCommand(["MODULE", "LIST"]);
  await writeFile(
    `${output}/environment.json`,
    JSON.stringify(
      {
        node: process.version,
        platform: platform(),
        cpu: cpus()[0]?.model,
        visibleCpus: cpus().length,
        cpuQuota: await limit("/sys/fs/cgroup/cpu.max"),
        memoryLimit: await limit("/sys/fs/cgroup/memory.max"),
        moduleInfo,
        redisServer: await connection.info("server"),
        redisPersistence: await connection.info("persistence"),
        sizes,
        trials,
        sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], {
          encoding: "utf8",
        }).trim(),
        sourceTree: execFileSync("git", ["rev-parse", "HEAD^{tree}"], {
          encoding: "utf8",
        }).trim(),
        note: "Real HTTP client/API in one Node process; local database separate process by default. Sequential trials; first and sibling creation distinguished. Full API ingestion and history enabled. A single changed object, chain topology and five-hop path. Algorithm timings include overlay projection. Main graph memory is cumulative across ontologies; copy working memory excludes shared base. Memory estimates are not exclusive storage or disk bytes. Five samples are descriptive, not percentiles or capacity results.",
      },
      null,
      2,
    ) + "\n",
  );
} finally {
  await app.close();
  await store.nativeGraphs.collect(new Set());
  await db.selectGraph(namespace).delete();
  await db.close();
}
