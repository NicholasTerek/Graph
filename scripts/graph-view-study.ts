import { GraphView } from "@graph/core";
import { dependencyFixture } from "./lib/dependency-fixture.js";
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { cpus, platform, arch } from "node:os";
import ts from "typescript";
const baselineCommit = "d55146ca48707554dfe7426188af88e7e29915bd";
const source = execFileSync(
  "git",
  ["show", `${baselineCommit}:packages/core/src/functions.ts`],
  { encoding: "utf8" },
);
const implementation = source.slice(
  source.indexOf("export class GraphView"),
  source.indexOf("export type FunctionContext"),
);
// Run the committed predecessor, including clone and evidence accounting costs.
const Scanning = new Function(
  "PlatformError",
  ts.transpile(
    implementation.replace("export class GraphView", "class ScanningGraphView"),
    { target: ts.ScriptTarget.ES2022 },
  ) + ";return ScanningGraphView;",
)(Error) as typeof GraphView;
const trials: unknown[] = [];
for (const count of [1000, 5000])
  for (const shape of ["chain", "bounded", "hub"] as const) {
    const graph = dependencyFixture(count, shape);
    const evaluate = (View: typeof GraphView) => {
      const view = new View(graph);
      let answer = 0;
      for (const object of graph.objects)
        for (const target of view.related(object.id, "DEPENDS_ON"))
          answer += Number(target.properties.durationDays);
      return { answer, evidence: view.evidence() };
    };
    assert.deepEqual(evaluate(GraphView), evaluate(Scanning));
    evaluate(GraphView);
    evaluate(Scanning);
    for (let trial = 0; trial < 5; trial++)
      for (const name of trial % 2
        ? ["indexed", "scanning"]
        : ["scanning", "indexed"]) {
        const cpu = process.cpuUsage(),
          start = performance.now();
        const result = evaluate(name === "indexed" ? GraphView : Scanning);
        const elapsedMs = performance.now() - start,
          used = process.cpuUsage(cpu);
        trials.push({
          count,
          shape,
          edges: graph.relationships.length,
          trial,
          implementation: name,
          elapsedMs,
          cpuMs: (used.user + used.system) / 1000,
          rssBytes: process.memoryUsage().rss,
          answer: result.answer,
        });
      }
  }
const evidence = {
  generatedAt: new Date().toISOString(),
  node: process.version,
  platform: platform(),
  arch: arch(),
  cpu: cpus()[0]?.model,
  baselineCommit,
  baselineSha256: createHash("sha256").update(implementation).digest("hex"),
  workload:
    "Single-process captured view construction + one outgoing-neighbor pass across every task + evidence capture; one warmup per implementation; alternating order; five descriptive trials; no DB/HTTP",
  trials,
};
await mkdir("docs/evidence", { recursive: true });
await writeFile(
  "docs/evidence/graph-view-study.json",
  JSON.stringify(evidence, null, 2) + "\n",
);
console.log(JSON.stringify(evidence));
