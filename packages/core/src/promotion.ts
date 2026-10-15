import { randomUUID } from "node:crypto";
import type {
  GraphObject,
  GraphRelationship,
  GraphSnapshot,
  GraphState,
  Scenario,
  PromotionPreview,
} from "@graph/contracts";
import { GraphStore } from "./store.js";
import { ScenarioService } from "./scenarios.js";
import { canonical, recordChanges } from "./state.js";
import { PlatformError } from "./validation.js";
export class PromotionService {
  constructor(
    private store: GraphStore,
    private scenarios: ScenarioService,
  ) {}
  private async compare(ontology: string, id: string, live: GraphState) {
    const branch = await this.scenarios.reference(ontology, id);
    const base = await this.scenarios.base(branch);
    const state = await this.scenarios.readState(ontology, id);
    const changes = {
      objects: recordChanges(base.objects, state.objects),
      relationships: recordChanges(base.relationships, state.relationships),
    };
    const conflicts: PromotionPreview["conflicts"] = [];
    for (const change of changes.objects) {
      const current = live.objects.find((o) => o.id === change.id) ?? null;
      if (
        canonical(current) === canonical(change.before) ||
        canonical(current) === canonical(change.after)
      )
        continue;
      if (
        change.before &&
        change.after &&
        current &&
        current.type === change.before.type &&
        change.after.type === change.before.type
      ) {
        const keys = [
          ...new Set([
            ...Object.keys(change.before.properties),
            ...Object.keys(change.after.properties),
          ]),
        ];
        for (const key of keys)
          if (
            canonical(change.before.properties[key]) !==
              canonical(change.after.properties[key]) &&
            canonical(current.properties[key]) !==
              canonical(change.before.properties[key]) &&
            canonical(current.properties[key]) !==
              canonical(change.after.properties[key])
          )
            conflicts.push({ kind: "object", id: change.id, field: key });
      } else conflicts.push({ kind: "object", id: change.id });
    }
    for (const change of changes.relationships) {
      const current =
        live.relationships.find((r) => r.id === change.id) ?? null;
      if (
        canonical(current) !== canonical(change.before) &&
        canonical(current) !== canonical(change.after)
      )
        conflicts.push({ kind: "relationship", id: change.id });
    }
    return {
      branch,
      preview: {
        scenario: id,
        version: branch.version,
        liveRevision: live.revision,
        changes,
        conflicts,
      },
    };
  }
  async review(ontology: string, id: string) {
    return this.store.exclusive(async () => {
      const live = {
        ...(await this.store.snapshot(ontology)),
        revision: await this.store.revision(ontology),
      };
      return (await this.compare(ontology, id, live)).preview;
    });
  }
  async promote(
    ontology: string,
    id: string,
    input: {
      expectedVersion: number;
      expectedRevision: number;
      objects: string[];
      relationships: string[];
      confirm: true;
    },
    actor: string,
  ) {
    if (!input.objects.length && !input.relationships.length)
      throw new PlatformError(
        400,
        "Select at least one object or relationship change",
      );
    return this.store.transact(
      ontology,
      input.expectedRevision,
      async (live) => {
        const { branch, preview } = await this.compare(ontology, id, live);
        if (branch.version !== input.expectedVersion)
          throw new PlatformError(409, "Scenario changed after review");
        for (const [kind, ids] of [
          ["objects", input.objects],
          ["relationships", input.relationships],
        ] as const)
          if (ids.some((id) => !preview.changes[kind].some((c) => c.id === id)))
            throw new PlatformError(
              400,
              "Selection contains an unchanged or unknown record",
            );
        const selected = preview.conflicts.filter((c) =>
          (c.kind === "object" ? input.objects : input.relationships).includes(
            c.id,
          ),
        );
        if (selected.length)
          throw new PlatformError(
            409,
            `Promotion conflicts: ${selected.map((c) => c.id + (c.field ? "." + c.field : "")).join(", ")}`,
          );
        const objects = new Map(live.objects.map((o) => [o.id, o]));
        const relationships = new Map(live.relationships.map((r) => [r.id, r]));
        for (const change of preview.changes.objects.filter((c) =>
          input.objects.includes(c.id),
        )) {
          if (!change.after) {
            objects.delete(change.id);
            continue;
          }
          const current = objects.get(change.id);
          let object = structuredClone(change.after);
          if (
            current &&
            change.before &&
            current.type === change.before.type &&
            change.after.type === change.before.type
          ) {
            object = { ...current, properties: { ...current.properties } };
            for (const key of new Set([
              ...Object.keys(change.before.properties),
              ...Object.keys(change.after.properties),
            ]))
              if (
                canonical(change.before.properties[key]) !==
                canonical(change.after.properties[key])
              ) {
                if (Object.hasOwn(change.after.properties, key))
                  object.properties[key] = change.after.properties[key];
                else delete object.properties[key];
              }
          }
          object.provenance = {
            source: `promotion:${id}`,
            externalId: change.id,
            observedAt: new Date().toISOString(),
          };
          objects.set(change.id, object);
        }
        for (const change of preview.changes.relationships.filter((c) =>
          input.relationships.includes(c.id),
        )) {
          if (change.after)
            relationships.set(change.id, {
              ...change.after,
              provenance: {
                source: `promotion:${id}`,
                externalId: change.id,
                observedAt: new Date().toISOString(),
              },
            });
          else relationships.delete(change.id);
        }
        const result = {
          id: `promotion-${randomUUID()}`,
          scenario: id,
          actor,
          baseRevision: branch.baseRevision,
          previousRevision: live.revision,
          objects: input.objects,
          relationships: input.relationships,
          promotedAt: new Date().toISOString(),
        };
        return {
          state: {
            objects: [...objects.values()],
            relationships: [...relationships.values()],
          },
          documents: [
            { kind: "promotion", id: result.id, value: result },
            {
              kind: "scenario",
              id,
              value: {
                ...branch,
                version: branch.version + 1,
                updatedAt: result.promotedAt,
              },
            },
          ],
          result,
        };
      },
    );
  }
}
