import type {
  GraphObject,
  GraphRelationship,
  GraphSnapshot,
  GraphState,
  Ontology,
  Overlay,
  Scenario,
  ScenarioDiff,
  Change,
} from "@graph/contracts";
import { createHash } from "node:crypto";
import { GraphStore } from "./store.js";
import { PlatformError, validateIngestion } from "./validation.js";

export function applyOverlay(
  base: GraphSnapshot,
  overlay: Overlay,
): GraphSnapshot {
  const objects = new Map(base.objects.map((o) => [o.id, o]));
  const relationships = new Map(base.relationships.map((r) => [r.id, r]));
  for (const id of overlay.removeRelationships) relationships.delete(id);
  for (const id of overlay.removeObjects) objects.delete(id);
  for (const object of overlay.objects) objects.set(object.id, object);
  for (const relationship of overlay.relationships)
    relationships.set(relationship.id, relationship);
  return structuredClone({
    objects: [...objects.values()].sort((a, b) => a.id.localeCompare(b.id)),
    relationships: [...relationships.values()].sort((a, b) =>
      a.id.localeCompare(b.id),
    ),
  });
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => JSON.stringify(k) + ":" + canonical(v))
      .join(",")}}`;
  return JSON.stringify(value);
}
function changes<T extends { id: string }>(
  before: T[],
  after: T[],
): Change<T>[] {
  const a = new Map(before.map((x) => [x.id, x]));
  const b = new Map(after.map((x) => [x.id, x]));
  return [...new Set([...a.keys(), ...b.keys()])].sort().flatMap((id) => {
    const left = a.get(id) ?? null;
    const right = b.get(id) ?? null;
    return canonical(left) === canonical(right)
      ? []
      : [
          {
            id,
            kind:
              left === null
                ? ("added" as const)
                : right === null
                  ? ("removed" as const)
                  : ("modified" as const),
            before: left,
            after: right,
          },
        ];
  });
}
export class ScenarioService {
  constructor(private store: GraphStore) {}
  async list(ontology: string) {
    await this.store.ontology(ontology);
    return this.store.documents<Scenario>("scenario", ontology);
  }
  async base(scenario: Scenario): Promise<GraphState> {
    if (scenario.storage === "falkordb-overlay") {
      const context = await this.overlayContext(scenario);
      return this.store.temporal.read(scenario.ontology, context);
    }
    const value = await this.store.document<
      GraphState | import("./native-graphs.js").NativeBase
    >("base", scenario.ontology, String(scenario.baseRevision));
    if (!value)
      throw new PlatformError(500, "Scenario base state is unavailable");
    return "storage" in value
      ? {
          ...(await this.store.nativeGraphs.snapshot(
            scenario.ontology,
            value.graphKey,
          )),
          revision: value.revision,
        }
      : value;
  }
  async reference(ontology: string, id: string): Promise<Scenario> {
    await this.store.ontology(ontology);
    const value = await this.store.document<Scenario>("scenario", ontology, id);
    if (!value) throw new PlatformError(404, `Scenario not found: ${id}`);
    if (value.storage === "falkordb-overlay") {
      await this.overlayContext(value);
      return value;
    }
    if (value.storage === "falkordb") {
      if (!value.graphKey || !value.baseGraphKey)
        throw new PlatformError(500, "Incomplete native scenario metadata");
      return value;
    }
    const base = await this.base(value);
    const state = applyOverlay(base, value.overlay);
    const schema = await this.store.ontology(ontology);
    validateIngestion(schema, { objects: [], relationships: [] }, base);
    validateIngestion(schema, { objects: [], relationships: [] }, state);
    let savedBase = await this.store.document<
      import("./native-graphs.js").NativeBase
    >("base", ontology, String(value.baseRevision));
    if (savedBase?.storage !== "falkordb") {
      savedBase = {
        storage: "falkordb",
        graphKey: await this.store.nativeGraphs.create(ontology, base),
        revision: value.baseRevision,
      };
      await this.store.saveDocument(
        "base",
        ontology,
        String(value.baseRevision),
        savedBase,
      );
    }
    const key = await this.store.nativeGraphs.copy(
      ontology,
      savedBase.graphKey,
    );
    await this.store.nativeGraphs.update(ontology, key, base, state);
    const migrated: Scenario = {
      ...value,
      storage: "falkordb",
      graphKey: key,
      baseGraphKey: savedBase.graphKey,
      overlay: emptyOverlay(),
    };
    await this.store.saveDocument("scenario", ontology, id, migrated);
    return migrated;
  }
  private async overlayContext(branch: Scenario) {
    const current = await this.store.temporal.ensure(branch.ontology);
    if (current.generation !== branch.historyGeneration)
      throw new PlatformError(
        409,
        "Overlay history generation changed; restore a portable branch backup",
      );
    return this.store.temporal.resolve(branch.ontology, {
      revision: branch.baseRevision,
    });
  }
  private effective(branch: Scenario) {
    return branch.storage === "falkordb-overlay"
      ? this.store.nativeOverlays.read(branch)
      : this.store.nativeGraphs.snapshot(branch.ontology, branch.graphKey!);
  }
  async readState(ontology: string, id: string) {
    const scenario = await this.reference(ontology, id);
    return {
      ...(await this.effective(scenario)),
      revision: scenario.baseRevision,
      scenarioVersion: scenario.version,
    };
  }
  async get(ontology: string, id: string): Promise<Scenario> {
    const scenario = await this.reference(ontology, id);
    const base = await this.base(scenario);
    const state = await this.effective(scenario);
    return { ...scenario, overlay: toOverlay(base, state) };
  }
  async create(
    ontology: string,
    input: {
      id: string;
      name: string;
      description: string;
      expectedRevision?: number;
      strategy?: "copy" | "overlay";
    },
  ): Promise<Scenario> {
    return this.store.exclusive(async () => {
      await this.store.ontology(ontology);
      if (await this.store.document("scenario", ontology, input.id))
        throw new PlatformError(409, `Scenario already exists: ${input.id}`);
      const revision = await this.store.revision(ontology);
      if (
        input.expectedRevision !== undefined &&
        input.expectedRevision !== revision
      )
        throw new PlatformError(
          409,
          `Revision conflict: expected ${input.expectedRevision}, current ${revision}`,
        );
      if (input.strategy === "overlay") {
        const context = await this.store.temporal.resolve(ontology, {
          revision,
        });
        const now = new Date().toISOString();
        const branch: Scenario = {
          id: input.id,
          name: input.name,
          description: input.description,
          ontology,
          baseRevision: revision,
          historyGeneration: context.generation,
          storage: "falkordb-overlay",
          strategy: "overlay",
          version: 0,
          createdAt: now,
          updatedAt: now,
          overlay: emptyOverlay(),
        };
        // Creation writes only metadata. The persisted branch is itself a non-expiring base pin.
        await this.store.saveDocument("scenario", ontology, input.id, branch);
        return branch;
      }
      let base = await this.store.document<
        import("./native-graphs.js").NativeBase | GraphState
      >("base", ontology, String(revision));
      if (!base || !("storage" in base)) {
        const state = base ?? (await this.store.snapshot(ontology));
        base = {
          storage: "falkordb",
          graphKey: await this.store.nativeGraphs.create(ontology, state),
          revision,
        };
        await this.store.saveDocument("base", ontology, String(revision), base);
      }
      const key = await this.store.nativeGraphs.copy(ontology, base.graphKey);
      const now = new Date().toISOString();
      const scenario: Scenario = {
        id: input.id,
        name: input.name,
        description: input.description,
        ontology,
        baseRevision: revision,
        version: 0,
        createdAt: now,
        updatedAt: now,
        storage: "falkordb",
        graphKey: key,
        baseGraphKey: base.graphKey,
        overlay: emptyOverlay(),
      };
      await this.store.saveDocument(
        "scenario",
        ontology,
        scenario.id,
        scenario,
      );
      return scenario;
    });
  }
  async state(ontology: string, id: string) {
    return this.store.exclusive(() => this.readState(ontology, id));
  }
  private async saveEdit(
    scenario: Scenario,
    ontology: Ontology,
    edit: Overlay,
    expectedVersion: number,
  ) {
    if (scenario.version !== expectedVersion)
      throw new PlatformError(
        409,
        `Scenario version conflict: expected ${expectedVersion}, current ${scenario.version}`,
      );
    for (const [records, removals] of [
      [edit.objects, edit.removeObjects],
      [edit.relationships, edit.removeRelationships],
    ] as const) {
      if (
        new Set(records.map((r) => r.id)).size !== records.length ||
        new Set(removals).size !== removals.length
      )
        throw new PlatformError(400, "Duplicate IDs in scenario edit");
      if (records.some((r) => removals.includes(r.id)))
        throw new PlatformError(
          400,
          "Cannot upsert and remove the same ID in one edit",
        );
    }
    const before = await this.effective(scenario);
    const state = applyOverlay(before, edit);
    validateIngestion(ontology, { objects: [], relationships: [] }, state);
    if (scenario.storage === "falkordb-overlay") {
      const result = {
        ...scenario,
        version: scenario.version + 1,
        updatedAt: new Date().toISOString(),
        overlay: emptyOverlay(),
      };
      await this.store.nativeOverlays.publish(result, before, state);
      return result;
    }
    const key = await this.store.nativeGraphs.copy(
      scenario.ontology,
      scenario.graphKey!,
    );
    await this.store.nativeGraphs.update(scenario.ontology, key, before, state);
    const result: Scenario = {
      ...scenario,
      graphKey: key,
      overlay: emptyOverlay(),
      version: scenario.version + 1,
      updatedAt: new Date().toISOString(),
    };
    await this.store.saveDocument(
      "scenario",
      scenario.ontology,
      scenario.id,
      result,
    );
    await this.store.nativeGraphs
      .remove(scenario.ontology, scenario.graphKey!)
      .catch(() => {});
    return result;
  }
  async edit(
    ontology: string,
    id: string,
    edit: Overlay & { expectedVersion: number },
  ) {
    return this.store.exclusive(async () =>
      this.saveEdit(
        await this.reference(ontology, id),
        await this.store.ontology(ontology),
        edit,
        edit.expectedVersion,
      ),
    );
  }
  async patchObject(
    ontology: string,
    id: string,
    objectId: string,
    patch: { properties: GraphObject["properties"]; expectedVersion: number },
  ) {
    return this.store.exclusive(async () => {
      const scenario = await this.reference(ontology, id);
      const current = (await this.effective(scenario)).objects.find(
        (o) => o.id === objectId,
      );
      if (!current)
        throw new PlatformError(
          404,
          `Object not found in scenario: ${objectId}`,
        );
      const object = {
        ...current,
        properties: { ...current.properties, ...patch.properties },
        provenance: {
          source: `scenario:${id}`,
          externalId: objectId,
          observedAt: new Date().toISOString(),
        },
      };
      return this.saveEdit(
        scenario,
        await this.store.ontology(ontology),
        { ...emptyOverlay(), objects: [object] },
        patch.expectedVersion,
      );
    });
  }
  async diff(ontology: string, id: string): Promise<ScenarioDiff> {
    return this.store.exclusive(async () => {
      const scenario = await this.reference(ontology, id);
      const base = await this.base(scenario);
      const state = await this.effective(scenario);
      const liveRevision = await this.store.revision(ontology);
      return {
        scenario: id,
        baseRevision: scenario.baseRevision,
        liveRevision,
        stale: liveRevision !== scenario.baseRevision,
        version: scenario.version,
        objects: changes(base.objects, state.objects),
        relationships: changes(base.relationships, state.relationships),
      };
    });
  }
  async discard(ontology: string, id: string) {
    return this.store.exclusive(async () => {
      const stored = await this.store.document<Scenario>(
        "scenario",
        ontology,
        id,
      );
      const scenario =
        stored?.storage === "falkordb-overlay"
          ? stored
          : await this.reference(ontology, id);
      if (scenario.storage === "falkordb-overlay")
        await this.store.nativeOverlays.discard(ontology, id);
      else await this.store.removeDocument("scenario", ontology, id);
      if (
        !(await this.list(ontology)).some(
          (s) =>
            s.storage !== "falkordb-overlay" &&
            s.baseRevision === scenario.baseRevision,
        )
      )
        await this.store.removeDocument(
          "base",
          ontology,
          String(scenario.baseRevision),
        );
      await this.collect();
    });
  }
  async collect() {
    const references = new Set<string>();
    for (const ontology of await this.store.listOntologies()) {
      for (const base of await this.store.documents<
        import("./native-graphs.js").NativeBase
      >("base", ontology.id))
        if (base.storage === "falkordb") references.add(base.graphKey);
      const branches = await this.list(ontology.id);
      await this.store.nativeOverlays.collect(
        ontology.id,
        branches
          .filter((b) => b.storage === "falkordb-overlay")
          .map((b) => b.id),
      );
      for (const branch of branches) {
        if (branch.graphKey) references.add(branch.graphKey);
        if (branch.baseGraphKey) references.add(branch.baseGraphKey);
      }
    }
    return this.store.nativeGraphs.collect(references);
  }
  async retainGraphs(
    ontology: string,
    input: { dryRun: boolean; digest?: string; confirmOntology?: string },
  ) {
    return this.store.exclusive(async () => {
      await this.store.ontology(ontology);
      const references = new Set<string>();
      for (const base of await this.store.documents<
        import("./native-graphs.js").NativeBase
      >("base", ontology))
        if (base.storage === "falkordb") references.add(base.graphKey);
      for (const branch of await this.list(ontology)) {
        if (branch.graphKey) references.add(branch.graphKey);
        if (branch.baseGraphKey) references.add(branch.baseGraphKey);
      }
      const graphs = await this.store.nativeGraphs.inventory(
        ontology,
        references,
      );
      const digest = createHash("sha256")
        .update(
          canonical({ ontology, graphs, references: [...references].sort() }),
        )
        .digest("hex");
      const orphans = graphs.filter((g) => !g.retained);
      if (!input.dryRun) {
        if (input.digest !== digest || input.confirmOntology !== ontology)
          throw new PlatformError(
            409,
            "Review the current native graph inventory and confirm this ontology",
          );
        for (const orphan of orphans)
          await this.store.nativeGraphs.remove(ontology, orphan.key);
      }
      return {
        ontology,
        digest,
        dryRun: input.dryRun,
        graphs,
        orphanCount: orphans.length,
        deleted: input.dryRun ? [] : orphans.map((g) => g.key),
      };
    });
  }
  async initialize() {
    return this.store.exclusive(async () => {
      for (const ontology of await this.store.listOntologies())
        for (const scenario of await this.list(ontology.id))
          await this.reference(ontology.id, scenario.id);
      return this.collect();
    });
  }
}
const emptyOverlay = (): Overlay => ({
  objects: [],
  relationships: [],
  removeObjects: [],
  removeRelationships: [],
});
function toOverlay(base: GraphSnapshot, state: GraphSnapshot): Overlay {
  const objects = changes(base.objects, state.objects),
    relationships = changes(base.relationships, state.relationships);
  return {
    objects: objects.flatMap((c) => (c.after ? [c.after] : [])),
    relationships: relationships.flatMap((c) => (c.after ? [c.after] : [])),
    removeObjects: objects.filter((c) => !c.after).map((c) => c.id),
    removeRelationships: relationships.filter((c) => !c.after).map((c) => c.id),
  };
}
