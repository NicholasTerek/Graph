import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createHash } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  open,
  readFile,
  writeFile,
} from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { tmpdir, cpus } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { FalkorDB } from "falkordb";
import { GraphStore } from "@graph/core";
if (!process.env.REDIS_SERVER || !process.env.FALKORDB_MODULE)
  throw Error(
    "Set REDIS_SERVER and FALKORDB_MODULE to compatible local binaries; this script launches its own disposable database",
  );
const output = process.env.COPY_FILE_OUTPUT ?? "artifacts/copy-files/local",
  port = Number(process.env.COPY_FILE_PORT ?? 6389),
  sizes = [1000, 10000],
  repeats = 3;
await mkdir(output, { recursive: true });
const directory = await mkdtemp(join(tmpdir(), "graph-copy-files-"));
const server = spawn(
  process.env.REDIS_SERVER,
  [
    "--loadmodule",
    process.env.FALKORDB_MODULE,
    "--port",
    String(port),
    "--bind",
    "127.0.0.1",
    "--save",
    "",
    "--appendonly",
    "no",
    "--dir",
    directory,
  ],
  { stdio: ["ignore", "pipe", "pipe"] },
);
let buffer = "",
  log = "",
  active: {
    source: string;
    opened?: Promise<{ path: string; fd: FileHandle; openMs: number }>;
  } | null = null;
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const ready = new Promise<void>((resolve, reject) => {
  const timer = setTimeout(
    () => reject(Error("Disposable Redis startup timed out")),
    10000,
  );
  server.once("error", reject);
  server.once("exit", () => {
    clearTimeout(timer);
    reject(Error("Disposable Redis exited before ready"));
  });
  server.stdout.on("data", (chunk) => {
    buffer += String(chunk);
    log += String(chunk);
    if (buffer.includes("Ready to accept connections")) {
      clearTimeout(timer);
      resolve();
    }
    const lines = buffer.split("\n");
    buffer = lines.pop()!;
    for (const line of lines) {
      const match =
        /dump graph: ([a-z0-9-]+) to: (\/tmp\/[a-f0-9-]+\.dump)/.exec(line);
      if (match && active?.source === match[1]) {
        const path = match[2],
          started = performance.now();
        assert.equal(active.opened, undefined);
        active.opened = (async () => {
          for (let attempt = 0; attempt < 1000; attempt++) {
            try {
              return {
                path,
                fd: await open(path, "r"),
                openMs: performance.now() - started,
              };
            } catch (e) {
              if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
              await pause(1);
            }
          }
          throw Error(
            "Missed native dump file; no zero-byte measurement is inferred",
          );
        })();
      }
    }
  });
  server.stderr.on("data", (chunk) => (log += String(chunk)));
});
let db: FalkorDB | undefined;
const rows: Record<string, unknown>[] = [];
try {
  await ready;
  db = await FalkorDB.connect({ socket: { host: "127.0.0.1", port } });
  const store = new GraphStore(db, `copy_files_${process.pid}`),
    native = store.nativeGraphs,
    ontology = "records";
  for (const size of sizes) {
    const id = (n: number) => String(n).padStart(6, "0"),
      provenance = {
        source: "synthetic-copy-microbenchmark",
        externalId: "fixture",
        observedAt: "2026-10-15T00:00:00Z",
      };
    const state = {
      objects: Array.from({ length: size }, (_, n) => ({
        id: `r${id(n)}`,
        type: "Record",
        properties: { value: n },
        provenance,
      })),
      relationships: Array.from({ length: size - 1 }, (_, n) => ({
        id: `e${id(n)}`,
        type: "NEXT",
        from: `r${id(n)}`,
        to: `r${id(n + 1)}`,
        provenance,
      })),
    };
    const source = await native.create(ontology, state);
    for (let trial = -1; trial < repeats; trial++) {
      const observation: {
        source: string;
        opened?: Promise<{ path: string; fd: FileHandle; openMs: number }>;
      } = { source };
      active = observation;
      const start = performance.now(),
        copy = await native.copy(ontology, source),
        copyMs = performance.now() - start;
      for (let n = 0; n < 1000 && !observation.opened; n++) await pause(1);
      assert.ok(
        observation.opened,
        "No dump event observed for the owned source graph",
      );
      const observed = await observation.opened;
      try {
        const stats = await observed.fd.stat();
        assert.ok(stats.size > 0);
        let pathDeleted = false;
        for (let n = 0; n < 1000; n++) {
          try {
            await access(observed.path);
          } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
            pathDeleted = true;
            break;
          }
          await pause(1);
        }
        assert.equal(pathDeleted, true);
        assert.deepEqual(await native.snapshot(ontology, copy), state);
        if (trial >= 0)
          rows.push({
            size,
            edges: size - 1,
            trial,
            copyMs,
            dumpBytes: stats.size,
            allocatedBytes: stats.blocks * 512,
            openAfterLogMs: observed.openMs,
            pathDeletedAfterCopy: pathDeleted,
            cloneEqual: true,
          });
      } finally {
        await observed.fd.close();
        active = null;
        await native.remove(ontology, copy);
      }
    }
    await native.remove(ontology, source);
  }
  assert.equal((await db.list()).length, 0);
  const connection = await db.connection;
  await writeFile(
    `${output}/samples.json`,
    JSON.stringify(
      {
        metadata: {
          node: process.version,
          cpu: cpus()[0]?.model,
          logicalCpus: cpus().length,
          scriptSha256: createHash("sha256")
            .update(await readFile(new URL(import.meta.url)))
            .digest("hex"),
          server: await connection.info("server"),
          persistence: await connection.info("persistence"),
          modules: await connection.sendCommand(["MODULE", "LIST"]),
          sizes,
          repeats,
          warmupsPerSize: 1,
          note: "Native-copy microbenchmark, direct synthetic business-graph setup, no API/history ingestion. Observe only dump paths logged for the owned source key; keep one read FD open to stat after module unlink. Actual logical file length and allocated blocks, not kernel physical read/write counters or device throughput. Retaining FD extends block lifetime until close. AOF/automatic RDB disabled; three sequential warm-copy samples per size.",
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
      samples: rows.length,
      equalCopies: true,
      allDumpPathsRemoved: true,
    }),
  );
} catch (error) {
  await writeFile(`${output}/failure-server.log`, log);
  throw error;
} finally {
  await db?.close();
  if (server.exitCode === null && server.signalCode === null) {
    server.kill("SIGTERM");
    await once(server, "exit");
  }
}
