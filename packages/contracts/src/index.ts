import { z } from "zod";

export const identifier = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/);
export const propertyDefinition = z
  .object({
    type: z.enum(["string", "number", "boolean"]),
    required: z.boolean().default(false),
  })
  .strict();
export const objectType = z
  .object({
    name: identifier,
    description: z.string().max(1000).default(""),
    properties: z.record(identifier, propertyDefinition),
  })
  .strict();
export const relationshipType = z
  .object({
    name: identifier,
    from: identifier,
    to: identifier,
    description: z.string().max(1000).default(""),
  })
  .strict();
export const ontologySchema = z
  .object({
    id: identifier,
    name: z.string().min(1).max(100),
    description: z.string().max(2000).default(""),
    objectTypes: z.array(objectType).min(1).max(100),
    relationshipTypes: z.array(relationshipType).max(100),
  })
  .strict()
  .superRefine((value, ctx) => {
    const types = new Set(value.objectTypes.map((t) => t.name));
    if (types.size !== value.objectTypes.length)
      ctx.addIssue({ code: "custom", message: "Duplicate object type" });
    const relationships = new Set(value.relationshipTypes.map((t) => t.name));
    if (relationships.size !== value.relationshipTypes.length)
      ctx.addIssue({ code: "custom", message: "Duplicate relationship type" });
    for (const rel of value.relationshipTypes) {
      if (!types.has(rel.from) || !types.has(rel.to))
        ctx.addIssue({
          code: "custom",
          message: `Unknown endpoint type for ${rel.name}`,
        });
    }
  });
export const propertiesSchema = z.record(
  z.string(),
  z.union([z.string().max(10000), z.number().finite(), z.boolean()]),
);
export const provenanceSchema = z
  .object({
    source: z.string().min(1).max(200),
    externalId: z.string().min(1).max(200),
    observedAt: z.iso.datetime(),
  })
  .strict();
export const objectInput = z
  .object({
    id: identifier,
    type: identifier,
    properties: propertiesSchema,
    provenance: provenanceSchema,
  })
  .strict();
export const relationshipInput = z
  .object({
    id: identifier,
    type: identifier,
    from: identifier,
    to: identifier,
    provenance: provenanceSchema,
  })
  .strict();
export const ingestionSchema = z
  .object({
    objects: z.array(objectInput).max(2000),
    relationships: z.array(relationshipInput).max(5000),
  })
  .strict()
  .superRefine((value, ctx) => {
    for (const key of ["objects", "relationships"] as const) {
      if (new Set(value[key].map((x) => x.id)).size !== value[key].length)
        ctx.addIssue({ code: "custom", message: `Duplicate IDs in ${key}` });
    }
  });
export type Ontology = z.infer<typeof ontologySchema>;
export type GraphObject = z.infer<typeof objectInput>;
export type GraphRelationship = z.infer<typeof relationshipInput>;
export type Ingestion = z.infer<typeof ingestionSchema>;
export type GraphSnapshot = {
  objects: GraphObject[];
  relationships: GraphRelationship[];
};
export type Traversal = GraphSnapshot & {
  root: string;
  depth: number;
  direction: "out" | "in" | "both";
};
