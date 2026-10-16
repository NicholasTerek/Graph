import { strict as assert } from "node:assert";
import { fork } from "node:child_process";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { FalkorDB } from "falkordb";
import { GraphStore, ScenarioService } from "@graph/core";
import { GraphClient } from "@graph/sdk";
import { ontologySchema } from "@graph/contracts";
import { createApp } from "../apps/api/src/app.js";
const [mode, namespace, boundary] = process.argv.slice(2);
const db = await FalkorDB.connect({
  socket: {
    host: process.env.FALKORDB_HOST ?? "127.0.0.1",
    port: Number(process.env.FALKORDB_PORT ?? 6379),
  },
});
if (mode === "worker") {
  const store = new GraphStore(db, namespace),
    scenarios = new ScenarioService(store);
  await store.initialize();
  await scenarios.initialize();
  const crash = () => {
    process.send?.({ kind: "crash-boundary", boundary });
    process.kill(process.pid, "SIGKILL");
  };
  const copy = store.nativeGraphs.copy.bind(store.nativeGraphs);
  store.nativeGraphs.copy = async (...args) => {
    if (boundary === "before-copy") crash();
    return copy(...args);
  };
  const save = store.saveDocument.bind(store);
  store.saveDocument = async (...args) => {
    const record = args[3] as { version?: number };
    if (
      args[0] === "scenario" &&
      args[2] === "branch" &&
      record.version === 1
    ) {
      if (boundary === "after-candidate") crash();
      await save(...args);
      if (boundary === "after-publication") crash();
      return;
    }
    return save(...args);
  };
  const app = createApp(store);
  app.addHook("onResponse", async (request) => {
    if (boundary === "after-response" && request.method === "PATCH") crash();
  });
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  process.send?.({ kind: "ready", address });
} else {
  const output = process.env.CRASH_OUTPUT ?? "artifacts/branch-crash/local",
    size = Number(process.env.CRASH_SIZE ?? 1000),
    repeats = Number(process.env.CRASH_REPEATS ?? 3);
  if (
    !Number.isInteger(size) ||
    size < 10 ||
    size > 10000 ||
    !Number.isInteger(repeats) ||
    repeats < 2 ||
    repeats > 10
  )
    throw Error("Size 10–10000, repeats 2–10");
  await mkdir(output, { recursive: true });
  const rows: Record<string, unknown>[] = [];
  try {
    for (let trial = 0; trial < repeats; trial++)
      for (const point of [
        "before-copy",
        "after-candidate",
        "after-publication",
        "after-response",
      ]) {
        const name = `crash_${trial}_${point.replaceAll("-", "_")}_${process.pid}`,
          store = new GraphStore(db, name),
          scenarios = new ScenarioService(store),
          ontology = "records";
        let child: ReturnType<typeof fork> | undefined;
        try {
          await store.initialize();
          await store.register(
            ontologySchema.parse({
              id: ontology,
              name: ontology,
              objectTypes: [
                {
                  name: "Record",
                  properties: { value: { type: "number", required: true } },
                },
              ],
              relationshipTypes: [
                { name: "NEXT", from: "Record", to: "Record" },
              ],
            }),
          );
          const provenance = {
            source: "synthetic-crash",
            externalId: "fixture",
            observedAt: "2026-10-15T00:00:00Z",
          };
          for (let start = 0; start < size; start += 500) {
            const end = Math.min(size, start + 500);
            await store.ingest(ontology, {
              objects: Array.from({ length: end - start }, (_, n) => ({
                id: `r-${start + n}`,
                type: "Record",
                properties: { value: start + n },
                provenance,
              })),
              relationships: Array.from(
                { length: end - start },
                (_, n) => start + n,
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
          const baseline = await store.snapshot(ontology);
          await scenarios.create(ontology, {
            id: "branch",
            name: "branch",
            description: "Crash candidate",
            expectedRevision: await store.revision(ontology),
          });
          const initialKeys = new Set(await db.list());
          let reached = false;
          const childStart = performance.now();
          child = fork(
            fileURLToPath(import.meta.url),
            ["worker", name, point],
            {
              execArgv: ["--import", "tsx"],
              stdio: ["ignore", "pipe", "pipe", "ipc"],
            },
          );
          let stderr = "";
          child.stderr?.on("data", (b) => (stderr += String(b)));
          const exit = once(child, "exit");
          const address = await new Promise<string>((resolve, reject) => {
            const timer = setTimeout(
              () => reject(Error("Worker startup timed out")),
              30000,
            );
            child!.on("message", (m) => {
              const message = m as { kind: string; address?: string };
              if (message.kind === "crash-boundary") reached = true;
              if (message.kind === "ready") {
                clearTimeout(timer);
                resolve(message.address!);
              }
            });
            child!.once("error", (e) => {
              clearTimeout(timer);
              reject(e);
            });
            child!.once("exit", () => {
              clearTimeout(timer);
              reject(Error(`Worker exited before ready: ${stderr}`));
            });
          });
          const startupMs = performance.now() - childStart,
            client = new GraphClient(address),
            requestStart = performance.now();
          let outcome = "acknowledged",
            requestError: string | null = null;
          try {
            await client.patchScenarioObject(ontology, "branch", "r-0", {
              properties: { value: -1 },
              expectedVersion: 0,
            });
          } catch (e) {
            outcome = "unknown";
            requestError = (e as Error).name;
          }
          const requestMs = performance.now() - requestStart;
          const [, signal] = await exit;
          assert.equal(signal, "SIGKILL");
          assert.equal(reached, true);
          const beforeRecoveryKeys = await db.list(),
            recoveryStart = performance.now(),
            recovered = new GraphStore(db, name),
            recoveredScenarios = new ScenarioService(recovered);
          await recovered.initialize();
          await recoveredScenarios.initialize();
          const recoveryMs = performance.now() - recoveryStart,
            afterRecoveryKeys = await db.list();
          const result = await recoveredScenarios.state(ontology, "branch"),
            expectedVersion =
              point === "before-copy" || point === "after-candidate" ? 0 : 1;
          assert.equal(result.scenarioVersion, expectedVersion);
          assert.equal(
            result.objects.find((o) => o.id === "r-0")!.properties.value,
            expectedVersion === 0 ? 0 : -1,
          );
          assert.equal(result.objects.length, size);
          assert.equal(result.relationships.length, size - 1);
          assert.deepEqual(await recovered.snapshot(ontology), baseline);
          assert.equal(afterRecoveryKeys.length, initialKeys.size);
          if (point === "after-candidate")
            assert.equal(beforeRecoveryKeys.length, initialKeys.size + 1);
          if (point === "after-publication")
            assert.equal(beforeRecoveryKeys.length, initialKeys.size + 1);
          if (point === "after-response")
            assert.equal(beforeRecoveryKeys.length, initialKeys.size);
          if (outcome === "acknowledged") assert.equal(expectedVersion, 1);
          rows.push({
            trial,
            boundary: point,
            size,
            signal,
            outcome,
            requestError,
            startupMs,
            requestMs,
            recoveryMs,
            graphsBefore: initialKeys.size,
            graphsAfterCrash: beforeRecoveryKeys.length,
            graphsAfterRecovery: afterRecoveryKeys.length,
            orphansCollected:
              beforeRecoveryKeys.length - afterRecoveryKeys.length,
            visibleVersion: result.scenarioVersion,
            liveUnchanged: true,
            completeBranch: true,
          });
          console.log(JSON.stringify(rows.at(-1)));
        } finally {
          if (child && child.exitCode === null && child.signalCode === null) {
            child.kill("SIGKILL");
            await once(child, "exit");
          }
          await store.nativeGraphs.collect(new Set());
          await db.selectGraph(name).delete();
        }
      }
    await writeFile(
      `${output}/samples.json`,
      JSON.stringify(
        {
          metadata: {
            node: process.version,
            size,
            repeats,
            scriptSha256: createHash("sha256")
              .update(await readFile(new URL(import.meta.url)))
              .digest("hex"),
            redisServer: await (await db.connection).info("server"),
            redisPersistence: await (await db.connection).info("persistence"),
            note: "Real API-process SIGKILL at four instrumented boundaries. Database stays running; startup index/collection time is measured separately from worker process startup. This does not test a database crash, power loss, partial GRAPH.COPY, network partitions or distributed coordination. after-response means Fastify onResponse reached, not guaranteed remote acknowledgment; observed client outcome retained.",
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
}
