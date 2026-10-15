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
        const signature = `${s.revision}:${canonical(s)}`;
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
  };
}

export async function runHistoryWorkload(
  client: GraphClient,
  ontology: string,
  options: { seed: number; rounds: number; writers: number },
) {
  const { seed, rounds, writers } = options;
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
    };
    entries.push(entry);
    try {
      const result = await call();
      entry.output = result;
      return result;
    } catch (error) {
      entry.status = "error";
      entry.code = error instanceof GraphApiError ? error.status : 0;
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
          const branch = await observe(
            "scenario-agent",
            "branch",
            { expectedRevision: state.revision },
            () =>
              client.createScenario(ontology, {
                id,
                name: id,
                expectedRevision: state.revision,
              }),
          );
          if (!branch) continue;
          branches.push(id);
          const edited = await observe(
            "scenario-agent",
            "edit",
            { expectedVersion: branch.version },
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
            { expectedCounter: value(state, "counter") + 1 },
            () => client.scenarioGraph(ontology, id),
          );
          await observe(
            "scenario-agent",
            "promote",
            { expectedRevision: state.revision, from: value(state, "counter") },
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
      const branch = await client.createScenario(ontology, {
        id: "final-branch",
        name: "Final branch",
        expectedRevision: state.revision,
      });
      branches.push(branch.id);
      const edited = await client.patchScenarioObject(
        ontology,
        branch.id,
        "counter",
        {
          expectedVersion: branch.version,
          properties: { value: value(state, "counter") + 1 },
        },
      );
      await observe(
        "final-agent",
        "promote",
        { expectedRevision: state.revision, from: value(state, "counter") },
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
    await observe("final-reader", "final", {}, () => client.stateAt(ontology));
    return {
      metadata: {
        seed,
        rounds,
        writers,
        ontology,
        model:
          "one API writer; SDK clients; no injected process/network faults",
      },
      entries: entries.sort((a, b) => a.id - b.id),
      summary: checkHistory(entries),
    };
  } finally {
    await client.releaseReadSnapshot(ontology, snapshot.id);
    for (const id of branches) await client.discardScenario(ontology, id);
  }
}
