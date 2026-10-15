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

export const objectPatch = z
  .object({
    properties: propertiesSchema,
    provenance: provenanceSchema.optional(),
    expectedRevision: z.number().int().nonnegative().optional(),
  })
  .strict();
export const pageQuery = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(50),
    after: identifier.optional(),
    type: identifier.optional(),
    q: z.string().max(200).optional(),
  })
  .strict();
export const relationshipQuery = pageQuery
  .omit({ q: true })
  .extend({ from: identifier.optional(), to: identifier.optional() });
export type Page<T> = { items: T[]; nextCursor: string | null; limit: number };
export type GraphState = GraphSnapshot & { revision: number };
export const scenarioCreate = z
  .object({
    id: identifier,
    name: z.string().min(1).max(100),
    description: z.string().max(1000).default(""),
    expectedRevision: z.number().int().nonnegative().optional(),
  })
  .strict();
export const overlaySchema = z
  .object({
    objects: z.array(objectInput).max(2000).default([]),
    relationships: z.array(relationshipInput).max(5000).default([]),
    removeObjects: z.array(identifier).max(2000).default([]),
    removeRelationships: z.array(identifier).max(5000).default([]),
  })
  .strict();
export const scenarioEdit = overlaySchema.extend({
  expectedVersion: z.number().int().nonnegative(),
});
export const scenarioObjectPatch = z
  .object({
    properties: propertiesSchema,
    expectedVersion: z.number().int().nonnegative(),
  })
  .strict();
export type Overlay = z.infer<typeof overlaySchema>;
export type Scenario = Omit<
  z.infer<typeof scenarioCreate>,
  "expectedRevision"
> & {
  ontology: string;
  baseRevision: number;
  version: number;
  createdAt: string;
  updatedAt: string;
  overlay: Overlay;
};
export type Change<T> = {
  id: string;
  kind: "added" | "removed" | "modified";
  before: T | null;
  after: T | null;
};
export type ScenarioDiff = {
  scenario: string;
  baseRevision: number;
  liveRevision: number;
  stale: boolean;
  version: number;
  objects: Change<GraphObject>[];
  relationships: Change<GraphRelationship>[];
};
export type FunctionInfo = {
  id: string;
  name: string;
  description: string;
  ontology: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
};
export type FunctionRun = {
  id: string;
  functionId: string;
  ontology: string;
  revision: number;
  scenarioId: string | null;
  scenarioVersion: number | null;
  executedAt: string;
  input: unknown;
  output: unknown;
};
export const functionInvocation = z
  .object({ input: z.unknown(), scenario: identifier.optional() })
  .strict();
