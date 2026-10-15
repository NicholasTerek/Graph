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
  async get(ontology: string, id: string): Promise<Scenario> {
    await this.store.ontology(ontology);
    const value = await this.store.document<Scenario>("scenario", ontology, id);
    if (!value) throw new PlatformError(404, `Scenario not found: ${id}`);
    return value;
  }
  private async base(scenario: Scenario): Promise<GraphState> {
    const value = await this.store.document<GraphState>(
      "base",
      scenario.ontology,
      String(scenario.baseRevision),
    );
    if (!value)
      throw new PlatformError(500, "Scenario base state is unavailable");
    return value;
  }
  async create(
    ontology: string,
    input: {
      id: string;
      name: string;
      description: string;
      expectedRevision?: number;
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
      if (!(await this.store.document("base", ontology, String(revision)))) {
        const snapshot = await this.store.snapshot(ontology);
        await this.store.saveDocument("base", ontology, String(revision), {
          ...snapshot,
          revision,
        });
      }
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
        overlay: {
          objects: [],
          relationships: [],
          removeObjects: [],
          removeRelationships: [],
        },
      };
      await this.store.saveDocument("scenario", ontology, input.id, scenario);
      return scenario;
    });
  }
  async state(
    ontology: string,
    id: string,
  ): Promise<GraphState & { scenarioVersion: number }> {
    return this.store.exclusive(async () => {
      const scenario = await this.get(ontology, id);
      const base = await this.base(scenario);
      return {
        ...applyOverlay(base, scenario.overlay),
        revision: scenario.baseRevision,
        scenarioVersion: scenario.version,
      };
    });
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
    const objects = new Map(scenario.overlay.objects.map((o) => [o.id, o]));
    const relationships = new Map(
      scenario.overlay.relationships.map((r) => [r.id, r]),
    );
    const removeObjects = new Set(scenario.overlay.removeObjects);
    const removeRelationships = new Set(scenario.overlay.removeRelationships);
    for (const id of edit.removeObjects) {
      objects.delete(id);
      removeObjects.add(id);
    }
    for (const id of edit.removeRelationships) {
      relationships.delete(id);
      removeRelationships.add(id);
    }
    for (const object of edit.objects) {
      objects.set(object.id, object);
      removeObjects.delete(object.id);
    }
    for (const rel of edit.relationships) {
      relationships.set(rel.id, rel);
      removeRelationships.delete(rel.id);
    }
    const overlay = {
      objects: [...objects.values()],
      relationships: [...relationships.values()],
      removeObjects: [...removeObjects],
      removeRelationships: [...removeRelationships],
    };
    const state = applyOverlay(await this.base(scenario), overlay);
    validateIngestion(ontology, { objects: [], relationships: [] }, state);
    const result = {
      ...scenario,
      overlay,
      version: scenario.version + 1,
      updatedAt: new Date().toISOString(),
    };
    await this.store.saveDocument(
      "scenario",
      scenario.ontology,
      scenario.id,
      result,
    );
    return result;
  }
  async edit(
    ontology: string,
    id: string,
    edit: Overlay & { expectedVersion: number },
  ) {
    return this.store.exclusive(async () =>
      this.saveEdit(
        await this.get(ontology, id),
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
      const scenario = await this.get(ontology, id);
      const state = applyOverlay(await this.base(scenario), scenario.overlay);
      const current = state.objects.find((o) => o.id === objectId);
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
        {
          objects: [object],
          relationships: [],
          removeObjects: [],
          removeRelationships: [],
        },
        patch.expectedVersion,
      );
    });
  }
  async diff(ontology: string, id: string): Promise<ScenarioDiff> {
    return this.store.exclusive(async () => {
      const scenario = await this.get(ontology, id);
      const base = await this.base(scenario);
      const state = applyOverlay(base, scenario.overlay);
      const liveRevision = await this.store.revision(ontology);
      return {
        scenario: id,
        baseRevision: scenario.baseRevision,
        liveRevision,
        stale: liveRevision !== scenario.baseRevision,
        version: scenario.version,
        objects: changes<GraphObject>(base.objects, state.objects),
        relationships: changes<GraphRelationship>(
          base.relationships,
          state.relationships,
        ),
      };
    });
  }
  async discard(ontology: string, id: string) {
    return this.store.exclusive(async () => {
      const scenario = await this.get(ontology, id);
      await this.store.removeDocument("scenario", ontology, id);
      const others = await this.store.documents<Scenario>("scenario", ontology);
      if (!others.some((s) => s.baseRevision === scenario.baseRevision))
        await this.store.removeDocument(
          "base",
          ontology,
          String(scenario.baseRevision),
        );
    });
  }
}
