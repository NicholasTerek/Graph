import type { GraphClient } from "@graph/sdk";
import type { GraphRelationship, PromotionPreview } from "@graph/contracts";
import type { ResolutionResult } from "./functions.js";
import { resolutionOntology } from "./constants.js";
export type ResolutionReview = {
  scenarioId: string;
  resolutionId: string;
  aliases: string[];
  preview: PromotionPreview;
  operation: "resolve" | "revert";
};
const stamp = (id: string) => ({
  source: "synthetic-reviewed-resolution",
  externalId: id,
  observedAt: new Date().toISOString(),
});
const sameReference = (
  a: GraphRelationship | undefined,
  b: GraphRelationship,
) => a?.id === b.id && a.type === b.type && a.from === b.from && a.to === b.to;
async function rejectManagedReferences(
  client: GraphClient,
  relationships: GraphRelationship[],
) {
  const managed = new Set(
    (await client.sources(resolutionOntology)).flatMap((source) =>
      Object.keys(source.managedRelationships ?? {}),
    ),
  );
  if (relationships.some((r) => managed.has(r.id)))
    throw Error(
      "This demo cannot rewrite source-managed references; source evidence remains unchanged",
    );
}
export async function prepareResolution(
  client: GraphClient,
  aliases: string[],
  canonicalId: string,
): Promise<ResolutionReview> {
  if (
    !aliases.length ||
    aliases.length > 20 ||
    new Set(aliases).size !== aliases.length
  )
    throw Error("Select 1–20 distinct reviewed aliases");
  const run = await client.runFunction<ResolutionResult>(
    resolutionOntology,
    "supplier-candidates",
    {},
  );
  if (
    aliases.some(
      (id) =>
        !run.output.aliases.some(
          (a) =>
            a.id === id &&
            a.status === "matched" &&
            a.canonicalId === canonicalId,
        ),
    )
  )
    throw Error(
      "Ambiguous, insufficient, already resolved or differently matched aliases cannot be applied",
    );
  const state = await client.snapshot(resolutionOntology);
  if (state.revision !== run.revision)
    throw Error("Graph changed after scoring; review candidates again");
  const references = state.relationships.filter(
    (r) => r.type === "ORDERED_FROM" && aliases.includes(r.to),
  );
  await rejectManagedReferences(client, references);
  const suffix = globalThis.crypto.randomUUID().slice(0, 8),
    scenarioId = `resolve-${suffix}`,
    resolutionId = `resolution-${suffix}`,
    provenance = stamp(resolutionId);
  const branch = await client.createScenario(resolutionOntology, {
    id: scenarioId,
    name: "Reviewed supplier identity",
    description:
      "Synthetic bounded shared-neighbor review; preserve this branch for reversal",
    expectedRevision: run.revision,
  });
  await client.editScenario(resolutionOntology, scenarioId, {
    expectedVersion: branch.version,
    objects: [
      {
        id: resolutionId,
        type: "Resolution",
        properties: {
          name: "Reviewed Meridian aliases",
          status: "applied",
          branchId: scenarioId,
          canonicalId,
        },
        provenance,
      },
    ],
    relationships: [
      ...aliases.flatMap((id, i) => [
        {
          id: `identity-${suffix}-${i}`,
          type: "RESOLVES_TO",
          from: id,
          to: canonicalId,
          provenance,
        },
        {
          id: `member-${suffix}-${i}`,
          type: "MEMBER",
          from: resolutionId,
          to: id,
          provenance,
        },
      ]),
      {
        id: `target-${suffix}`,
        type: "TARGET",
        from: resolutionId,
        to: canonicalId,
        provenance,
      },
      ...references.map((r) => ({ ...r, to: canonicalId, provenance })),
    ],
  });
  return {
    scenarioId,
    resolutionId,
    aliases,
    preview: await client.reviewScenario(resolutionOntology, scenarioId),
    operation: "resolve",
  };
}
export async function promoteResolution(
  client: GraphClient,
  review: ResolutionReview,
  confirmed: boolean,
) {
  if (!confirmed) throw Error("Explicit review confirmation is required");
  return client.promoteScenario(resolutionOntology, review.scenarioId, {
    expectedVersion: review.preview.version,
    expectedRevision: review.preview.liveRevision,
    objects: review.preview.changes.objects.map((c) => c.id),
    relationships: review.preview.changes.relationships.map((c) => c.id),
    confirm: true,
  });
}
export async function prepareResolutionUndo(
  client: GraphClient,
  resolutionId: string,
): Promise<ResolutionReview> {
  const state = await client.snapshot(resolutionOntology),
    record = state.objects.find(
      (o) => o.id === resolutionId && o.type === "Resolution",
    );
  if (!record || record.properties.status !== "applied")
    throw Error("Resolution is missing or already reverted");
  const original = await client.scenarioDiff(
    resolutionOntology,
    String(record.properties.branchId),
  );
  const references = original.relationships.filter(
    (c) => c.before && c.after && c.after.type === "ORDERED_FROM",
  );
  const links = original.relationships.filter(
    (c) => !c.before && c.after?.type === "RESOLVES_TO",
  );
  const current = new Map(state.relationships.map((r) => [r.id, r]));
  if (
    [...references, ...links].some(
      (c) => !sameReference(current.get(c.id), c.after!),
    )
  )
    throw Error(
      "Resolved references changed; automatic reversal would overwrite newer work",
    );
  await rejectManagedReferences(
    client,
    references.map((c) => c.after!),
  );
  const scenarioId = `undo-${globalThis.crypto.randomUUID().slice(0, 8)}`;
  const branch = await client.createScenario(resolutionOntology, {
    id: scenarioId,
    name: "Revert reviewed identity",
    expectedRevision: state.revision,
  });
  await client.editScenario(resolutionOntology, scenarioId, {
    expectedVersion: branch.version,
    objects: [
      {
        ...record,
        properties: { ...record.properties, status: "reverted" },
        provenance: stamp(resolutionId),
      },
    ],
    relationships: references.map((c) => c.before!),
    removeRelationships: links.map((c) => c.id),
  });
  return {
    scenarioId,
    resolutionId,
    aliases: links.map((c) => c.after!.from),
    preview: await client.reviewScenario(resolutionOntology, scenarioId),
    operation: "revert",
  };
}
