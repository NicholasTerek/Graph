import { performance } from "node:perf_hooks";
import { GraphApiError, GraphClient } from "@graph/sdk";
import { ontologySchema, type GraphState } from "@graph/contracts";

export type Observation = {
  revision: number;
  generation?: string;
  objects: GraphState["objects"];
  relationships: GraphState["relationships"];
};
export type HistoryEntry = {
  id: number;
  actor: string;
  kind: string;
  start: number;
  end: number;
  input: Record<string, unknown>;
  status: "ok" | "error";
  outcome?: "success" | "conflict" | "failed" | "unknown";
  code?: number;
  error?: string;
  output?: unknown;
};
const canonical = (s: Observation) =>
  JSON.stringify({
    objects: [...s.objects].sort((a, b) => a.id.localeCompare(b.id)),
    relationships: [...s.relationships].sort((a, b) =>
      a.id.localeCompare(b.id),
    ),
  });
const value = (s: Observation, id: string) =>
  Number(s.objects.find((o) => o.id === id)?.properties.value);

/** A bounded workload-specific checker, not a general linearizability proof. */
export function checkHistory(entries: HistoryEntry[]) {
  const violations: string[] = [];
  const fail = (entry: HistoryEntry, message: string) =>
    violations.push(`#${entry.id} ${entry.kind}: ${message}`);
  const live = entries.filter(
    (e) => e.status === "ok" && ["read", "final"].includes(e.kind),
  );
  const versions = new Map<string, string>();
  const pins = new Map<string, string>();
  const writes = entries.filter(
    (e) => e.status === "ok" && ["cas", "promote"].includes(e.kind),
  );
  const seen = new Set<number>();
  for (const e of entries) {
    if (e.status === "error") {
      if (
        e.code !== 409 ||
        !["cas", "promote", "branch", "edit"].includes(e.kind)
      )
        fail(e, `unexpected error ${e.code}: ${e.error}`);
      continue;
    }
    if (["read", "final", "pinned", "branchRead"].includes(e.kind)) {
      const s = e.output as Observation;
      const ids = new Set(s.objects.map((o) => o.id));
      if (s.relationships.some((r) => !ids.has(r.from) || !ids.has(r.to)))
        fail(e, "dangling relationship");
      if (value(s, "left") !== value(s, "right"))
        fail(e, "atomic pair is skewed");
      if (e.kind === "pinned") {
        const key = String(e.input.snapshot);
        const signature = `${s.generation}:${s.revision}:${canonical(s)}`;
        if (pins.has(key) && pins.get(key) !== signature)
          fail(e, "snapshot changed between reads");
        pins.set(key, signature);
      }
      if (
        e.kind === "branchRead" &&
        value(s, "counter") !== e.input.expectedCounter
      )
        fail(e, "branch lost its isolated value");
    }
    if (["cas", "promote"].includes(e.kind)) {
      const revision = (e.output as { revision: number }).revision;
      if (revision !== Number(e.input.expectedRevision) + 1)
        fail(e, "successful write did not advance its expected revision once");
      if (seen.has(revision))
        fail(e, "two successful guarded writes claimed the same revision");
      seen.add(revision);
    }
    if (e.kind === "calculate") {
      const result = e.output as
        | {
            revision?: number;
            output?: { left: number; right: number; total: number };
          }
        | undefined;
      const output = result?.output;
      if (
        !output ||
        !Number.isFinite(result?.revision) ||
        ![output.left, output.right, output.total].every(Number.isFinite)
      )
        fail(e, "malformed pair calculation");
      else if (
        output.left !== output.right ||
        output.total !== output.left + output.right
      )
        fail(e, "calculation pair is skewed or its total is incorrect");
    }
    if (e.kind === "sync") {
      const result = e.output as
        | { status?: string; revision?: number; checkpoint?: string }
        | undefined;
      if (
        result?.status !== "succeeded" ||
        !Number.isFinite(result.revision) ||
        !/^[a-f0-9]{64}$/.test(result.checkpoint ?? "")
      )
        fail(e, "source sync did not publish a successful checkpoint");
    }
  }
  for (const e of live) {
    const s = e.output as Observation;
    const key = `${s.generation}:${s.revision}`;
    const signature = canonical(s);
    if (versions.has(key) && versions.get(key) !== signature)
      fail(e, "one revision returned different states");
    versions.set(key, signature);
    for (const prior of live) {
      if (
        prior.end < e.start &&
        (prior.output as Observation).revision > s.revision
      )
        fail(e, "live read went backwards after a completed read");
    }
    for (const prior of writes) {
      if (
        prior.end < e.start &&
        (prior.output as { revision: number }).revision > s.revision
      )
        fail(e, "live read predates a completed write");
    }
  }
  const final = entries.find((e) => e.kind === "final" && e.status === "ok");
  if (!final) violations.push("No final observation; history is incomplete");
  else if (value(final.output as Observation, "counter") !== writes.length)
    fail(
      final,
      `lost update: counter differs from ${writes.length} successful increments`,
    );
  return {
    ok: violations.length === 0,
    operations: entries.length,
    successfulIncrements: writes.length,
    expectedConflicts: entries.filter(
      (e) => e.status === "error" && e.code === 409,
    ).length,
    liveReads: live.length,
    pinnedReads: entries.filter((e) => e.kind === "pinned").length,
    violations,
    unknownOutcomes: entries.filter((e) => e.outcome === "unknown").length,
  };
}

/** Bounded deletion reducer; preserves one exact diagnostic, not a replay guarantee. */
export function reduceHistory(entries: HistoryEntry[], maxChecks = 100) {
  const signature = (message: string) => message.replace(/^#\d+ [^:]+: /, "");
  const target = checkHistory(entries).violations[0];
  if (!target)
    return { target: null, checks: 0, entries: [], exhausted: false };
  const diagnostic = signature(target);
  let current = [...entries],
    checks = 0;
  for (
    let width = Math.max(1, Math.floor(current.length / 2));
    width >= 1 && checks < maxChecks;
    width = Math.floor(width / 2)
  ) {
    for (let index = 0; index < current.length && checks < maxChecks; ) {
      const candidate = [
        ...current.slice(0, index),
        ...current.slice(index + width),
      ];
      checks++;
      if (
        checkHistory(candidate).violations.some(
          (v) => signature(v) === diagnostic,
        )
      )
        current = candidate;
      else index += width;
    }
  }
  return {
    target: diagnostic,
    checks,
    entries: current,
    exhausted: checks >= maxChecks,
  };
}

export async function runHistoryWorkload(
  client: GraphClient,
  ontology: string,
  options: {
    seed: number;
    rounds: number;
    writers: number;
    functionId?: string;
  },
) {
  const { seed, rounds, writers } = options;
  if ((await client.ontologies()).some((o) => o.id === ontology))
    throw Error("History workloads require a new disposable ontology");
  let random = seed >>> 0;
  const rng = () => {
    random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
    return random;
  };
  // Seed selects delays/workload inputs. The OS and database still select the actual interleaving.
  const pause = () =>
    new Promise<void>((resolve) => setTimeout(resolve, rng() % 7));
  const entries: HistoryEntry[] = [];
  let next = 0;
  const observe = async <T>(
    actor: string,
    kind: string,
    input: Record<string, unknown>,
    call: () => Promise<T>,
  ): Promise<T | undefined> => {
    const entry: HistoryEntry = {
      id: next++,
      actor,
      kind,
      start: performance.now(),
      end: 0,
      input,
      status: "ok",
      outcome: "success",
    };
    entries.push(entry);
    try {
      const result = await call();
      entry.output = result;
      return result;
    } catch (error) {
      entry.status = "error";
      entry.code = error instanceof GraphApiError ? error.status : 0;
      entry.outcome =
        entry.code === 409
          ? "conflict"
          : entry.code === 0 || entry.code >= 500
            ? "unknown"
            : "failed";
      entry.error = error instanceof Error ? error.message : String(error);
      return undefined;
    } finally {
      entry.end = performance.now();
    }
  };
  const read = (actor: string) =>
    observe(actor, "read", {}, () => client.stateAt(ontology));
  const provenance = {
    source: "history-check",
    externalId: "seed",
    observedAt: "2026-10-15T00:00:00Z",
  };
  const object = (id: string, n: number) => ({
    id,
    type: "Cell",
    properties: { value: n },
    provenance,
  });
  await client.register(
    ontologySchema.parse({
      id: ontology,
      name: "Disposable concurrency history",
      objectTypes: [
        {
          name: "Cell",
          properties: { value: { type: "number", required: true } },
        },
      ],
      relationshipTypes: [{ name: "PAIR", from: "Cell", to: "Cell" }],
    }),
  );
  await client.ingest(ontology, {
    objects: [object("counter", 0), object("left", 0), object("right", 0)],
    relationships: [
      { id: "pair", type: "PAIR", from: "left", to: "right", provenance },
    ],
  });
  await client.registerSource(ontology, {
    id: "history-feed",
    name: "Synthetic changing CSV",
    connector: "csv",
    mapping: {
      type: "Cell",
      idField: "id",
      objectIdField: "id",
      properties: { value: { field: "value" } },
    },
  });
  await client.syncSource(ontology, "history-feed", {
    content: "id,value\nfeed-sample,0\n",
  });
  const snapshot = await client.createReadSnapshot(ontology, {
    ttlSeconds: 3600,
  });
  const branches: string[] = [];
  try {
    await Promise.all([
      ...Array.from({ length: writers }, (_, i) =>
        (async () => {
          const actor = `writer-${i}`;
          for (let step = 0; step < rounds; step++) {
            const state = await read(actor);
            if (!state) return;
            await pause();
            await observe(
              actor,
              "cas",
              {
                expectedRevision: state.revision,
                from: value(state, "counter"),
                object: "counter",
              },
              () =>
                client.patchObject(ontology, "counter", {
                  expectedRevision: state.revision,
                  properties: { value: value(state, "counter") + 1 },
                }),
            );
          }
        })(),
      ),
      (async () => {
        for (let i = 1; i <= Math.ceil(rounds / 2); i++) {
          await pause();
          const content = `id,value\nfeed-sample,${i}\n`;
          await observe(
            "source-writer",
            "sync",
            { sourceId: "history-feed", content },
            () => client.syncSource(ontology, "history-feed", { content }),
          );
        }
      })(),
      (async () => {
        if (!options.functionId) return;
        for (let i = 0; i < rounds; i++) {
          await pause();
          await observe(
            "calculator",
            "calculate",
            { functionId: options.functionId },
            () => client.runFunction(ontology, options.functionId!, {}),
          );
        }
      })(),
      (async () => {
        for (let i = 1; i <= rounds; i++) {
          await pause();
          await observe("pair-writer", "pair", { value: i }, () =>
            client.ingest(ontology, {
              objects: [object("left", i), object("right", i)],
              relationships: [],
            }),
          );
        }
      })(),
      (async () => {
        for (let i = 0; i < rounds * 2; i++) {
          await pause();
          await read("reader");
        }
      })(),
      (async () => {
        for (let i = 0; i < rounds; i++) {
          await pause();
          await observe(
            "pinned-reader",
            "pinned",
            { snapshot: snapshot.id },
            () => client.stateAt(ontology, { snapshot: snapshot.id }),
          );
        }
      })(),
      (async () => {
        for (let i = 0; i < Math.max(2, Math.ceil(rounds / 3)); i++) {
          const state = await read("scenario-agent");
          if (!state) return;
          const id = `branch-${i}`;
          const strategy = i % 2 ? ("copy" as const) : ("overlay" as const);
          const branch = await observe(
            "scenario-agent",
            "branch",
            { scenario: id, expectedRevision: state.revision, strategy },
            () =>
              client.createScenario(ontology, {
                id,
                name: id,
                expectedRevision: state.revision,
                strategy,
              }),
          );
          if (!branch) continue;
          branches.push(id);
          const edited = await observe(
            "scenario-agent",
            "edit",
            {
              scenario: id,
              object: "counter",
              expectedVersion: branch.version,
            },
            () =>
              client.patchScenarioObject(ontology, id, "counter", {
                expectedVersion: branch.version,
                properties: { value: value(state, "counter") + 1 },
              }),
          );
          if (!edited) continue;
          await pause();
          await observe(
            "scenario-agent",
            "branchRead",
            { scenario: id, expectedCounter: value(state, "counter") + 1 },
            () => client.scenarioGraph(ontology, id),
          );
          await observe(
            "scenario-agent",
            "promote",
            {
              scenario: id,
              expectedVersion: edited.version,
              expectedRevision: state.revision,
              from: value(state, "counter"),
            },
            () =>
              client.promoteScenario(ontology, id, {
                expectedVersion: edited.version,
                expectedRevision: state.revision,
                objects: ["counter"],
                relationships: [],
                confirm: true,
              }),
          );
        }
      })(),
    ]);
    // An uncontended promotion exercises the success path even when the racing agent always conflicts.
    const state = await read("final-agent");
    if (state) {
      const branch = await observe(
        "final-agent",
        "branch",
        {
          scenario: "final-branch",
          expectedRevision: state.revision,
          strategy: "overlay",
        },
        () =>
          client.createScenario(ontology, {
            id: "final-branch",
            name: "Final branch",
            expectedRevision: state.revision,
            strategy: "overlay",
          }),
      );
      if (branch) {
        branches.push(branch.id);
        const edited = await observe(
          "final-agent",
          "edit",
          {
            scenario: branch.id,
            object: "counter",
            expectedVersion: branch.version,
          },
          () =>
            client.patchScenarioObject(ontology, branch.id, "counter", {
              expectedVersion: branch.version,
              properties: { value: value(state, "counter") + 1 },
            }),
        );
        if (edited)
          await observe(
            "final-agent",
            "promote",
            {
              scenario: branch.id,
              expectedVersion: edited.version,
              expectedRevision: state.revision,
              from: value(state, "counter"),
            },
            () =>
              client.promoteScenario(ontology, branch.id, {
                expectedVersion: edited.version,
                expectedRevision: state.revision,
                objects: ["counter"],
                relationships: [],
                confirm: true,
              }),
          );
      }
    }
    await observe("final-reader", "final", {}, () => client.stateAt(ontology));
  } finally {
    await observe("cleanup", "release", { snapshot: snapshot.id }, () =>
      client.releaseReadSnapshot(ontology, snapshot.id),
    );
    for (const id of branches)
      await observe("cleanup", "discard", { scenario: id }, () =>
        client.discardScenario(ontology, id),
      );
  }
  return {
    metadata: {
      seed,
      rounds,
      writers,
      ontology,
      functionId: options.functionId ?? null,
      model: "one API writer; SDK callers; no injected process/network faults",
    },
    entries: entries.sort((a, b) => a.id - b.id),
    summary: checkHistory(entries),
  };
}
