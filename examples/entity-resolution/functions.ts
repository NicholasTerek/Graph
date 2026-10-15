import { defineFunction } from "@graph/core";
import { z } from "zod";
import { resolutionOntology } from "./model.js";
const evidence = z.object({
  id: z.string(),
  name: z.string(),
  type: z.string(),
});
export const resolutionResult = z.object({
  ruleId: z.literal("resolution.shared-neighbors.v1"),
  threshold: z.number(),
  aliases: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      sourceId: z.string(),
      externalId: z.string(),
      status: z.enum(["matched", "ambiguous", "insufficient", "resolved"]),
      canonicalId: z.string().nullable(),
      candidates: z.array(
        z.object({
          canonicalId: z.string(),
          name: z.string(),
          score: z.number(),
          unionCount: z.number(),
          shared: z.array(evidence),
        }),
      ),
    }),
  ),
});
export type ResolutionResult = z.infer<typeof resolutionResult>;
export const supplierCandidates = defineFunction({
  id: "supplier-candidates",
  ontology: resolutionOntology,
  name: "Shared-neighbor candidates",
  description:
    "Bounded synthetic identity evidence; requires reviewed promotion.",
  input: z.object({}).strict(),
  output: resolutionResult,
  execute: ({ graph }) => {
    const suppliers = graph.objects("Supplier"),
      canonicals = suppliers.filter((o) => o.properties.kind === "canonical");
    if (suppliers.length > 20 || canonicals.length > 5)
      throw Error(
        "This synthetic resolution demo supports at most 20 suppliers and 5 canonical candidates",
      );
    const neighbors = (id: string) =>
      new Map(
        ["COMPONENT_REF", "PRODUCT_REF", "ISSUE_REF", "LOCATION_REF"]
          .flatMap((type) => graph.related(id, type))
          .map((o) => [
            o.id,
            { id: o.id, name: String(o.properties.name), type: o.type },
          ]),
      );
    const canonicalNeighbors = new Map(
      canonicals.map((c) => [c.id, neighbors(c.id)]),
    );
    const aliases = suppliers
      .filter((o) => o.properties.kind === "alias")
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((alias) => {
        const observed = neighbors(alias.id),
          resolved = graph.related(alias.id, "RESOLVES_TO");
        const candidates = canonicals
          .map((c) => {
            const other = canonicalNeighbors.get(c.id)!;
            const shared = [...observed.values()]
                .filter((o) => other.has(o.id))
                .sort((a, b) => a.id.localeCompare(b.id)),
              unionCount = new Set([...observed.keys(), ...other.keys()]).size;
            return {
              canonicalId: c.id,
              name: String(c.properties.name),
              score: unionCount ? shared.length / unionCount : 0,
              unionCount,
              shared,
            };
          })
          .sort(
            (a, b) =>
              b.score - a.score || a.canonicalId.localeCompare(b.canonicalId),
          );
        const best = candidates[0],
          tied =
            best?.score > 0 &&
            candidates.filter((c) => Math.abs(c.score - best.score) < 1e-9)
              .length > 1;
        const status =
          resolved.length > 1
            ? ("ambiguous" as const)
            : resolved.length === 1
              ? ("resolved" as const)
              : tied
                ? ("ambiguous" as const)
                : best && best.score >= 0.75 && best.shared.length >= 2
                  ? ("matched" as const)
                  : ("insufficient" as const);
        return {
          id: alias.id,
          name: String(alias.properties.name),
          sourceId: alias.provenance.source,
          externalId: alias.provenance.externalId,
          status,
          canonicalId:
            status === "resolved"
              ? resolved[0].id
              : status === "matched"
                ? best.canonicalId
                : null,
          candidates,
        };
      });
    return {
      ruleId: "resolution.shared-neighbors.v1" as const,
      threshold: 0.75,
      aliases,
    };
  },
  explain: (output) =>
    output.aliases.map((alias) => ({
      id: alias.id,
      kind: "calculated" as const,
      ruleId: "resolution.shared-neighbors.v1",
      text: `${alias.name}: ${alias.status}. Score is shared-neighbor Jaccard overlap, not identity probability.`,
      recordIds: [
        alias.id,
        ...alias.candidates.flatMap((c) => [
          c.canonicalId,
          ...c.shared.map((o) => o.id),
        ]),
      ],
    })),
});
