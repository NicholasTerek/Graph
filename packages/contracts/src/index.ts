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
  storage?: "falkordb";
  graphKey?: string;
  baseGraphKey?: string;
};
export const algorithmInput = z
  .object({
    algorithm: z.enum(["shortest-path", "pagerank", "betweenness", "degree"]),
    scenario: identifier.optional(),
    source: identifier.optional(),
    target: identifier.optional(),
    direction: z.enum(["out", "in", "both"]).default("out"),
    maxDepth: z.number().int().min(1).max(20).default(10),
    limit: z.number().int().min(1).max(100).default(20),
    samplingSize: z.number().int().min(1).max(128).default(32),
    samplingSeed: z.number().int().min(1).max(2147483647).default(42),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.algorithm === "shortest-path" && (!value.source || !value.target))
      ctx.addIssue({
        code: "custom",
        message: "Shortest path requires source and target IDs",
      });
  });
export type AlgorithmInput = z.input<typeof algorithmInput>;
export type AlgorithmResult = {
  algorithm: AlgorithmInput["algorithm"];
  engine: "falkordb";
  ontology: string;
  revision: number;
  scenario: string | null;
  scenarioVersion: number | null;
  rows: { id: string; score: number }[];
  path: { objects: string[]; relationships: string[]; hops: number } | null;
  parameters: {
    maxDepth: number;
    direction: "out" | "in" | "both";
    samplingSize: number;
    samplingSeed: number;
  };
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

export const mappingValue = z.union([
  z.object({ field: z.string().min(1).max(100) }).strict(),
  z
    .object({ value: z.union([z.string(), z.number().finite(), z.boolean()]) })
    .strict(),
]);
export const sourceSchema = z
  .object({
    id: identifier,
    name: z.string().min(1).max(100),
    connector: z.enum(["csv", "json", "github", "notion", "discord"]),
    connection: identifier.optional(),
    githubResource: z.enum(["issues", "repository"]).default("issues"),
    repository: z
      .string()
      .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)
      .optional(),
    mapping: z
      .object({
        type: identifier,
        idField: z.string().min(1),
        objectIdField: z.string().min(1).optional(),
        identityField: z.string().min(1).optional(),
        properties: z.record(identifier, mappingValue),
      })
      .strict(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (["notion", "discord"].includes(value.connector) && !value.connection)
      ctx.addIssue({
        code: "custom",
        message: "Remote sources require a server-side connection name",
      });
    if (value.connector === "github" && !value.repository)
      ctx.addIssue({
        code: "custom",
        message: "GitHub sources require a repository",
      });
  });
export type SourceConfig = z.input<typeof sourceSchema>;
export type Source = z.output<typeof sourceSchema> & {
  version: number;
  checkpoint: string | null;
  lastSyncedAt: string | null;
  managed: Record<
    string,
    {
      externalId: string;
      fields: Record<string, string | number | boolean>;
      created?: boolean;
    }
  >;
};
export type SyncResult = {
  id: string;
  sourceId: string;
  status: "preview" | "succeeded" | "failed";
  revision: number;
  added: string[];
  updated: string[];
  removed: string[];
  unchanged: number;
  checkpoint: string;
  error?: string;
  startedAt: string;
  finishedAt: string;
};
export const syncInput = z
  .object({
    content: z.string().max(3000000).optional(),
    expectedCheckpoint: z.string().length(64).optional(),
    dryRun: z.boolean().default(false),
    expectedRevision: z.number().int().nonnegative().optional(),
  })
  .strict();
export const promotionInput = z
  .object({
    expectedVersion: z.number().int().nonnegative(),
    expectedRevision: z.number().int().nonnegative(),
    objects: z.array(identifier).default([]),
    relationships: z.array(identifier).default([]),
    confirm: z.literal(true),
  })
  .strict();
export type PromotionPreview = {
  scenario: string;
  version: number;
  liveRevision: number;
  changes: {
    objects: Change<GraphObject>[];
    relationships: Change<GraphRelationship>[];
  };
  conflicts: { kind: string; id: string; field?: string }[];
};
export const propertyFilter = z
  .object({
    property: identifier,
    operator: z.enum(["eq", "ne", "gt", "gte", "lt", "lte", "contains"]),
    value: z.union([z.string(), z.number().finite(), z.boolean()]),
  })
  .strict();
export const objectQuery = z
  .object({
    type: identifier.optional(),
    filters: z.array(propertyFilter).max(10).default([]),
    limit: z.number().int().min(1).max(100).default(50),
    after: identifier.optional(),
  })
  .strict();
export type ObjectQuery = z.infer<typeof objectQuery>;
export const aggregationInput = z
  .object({
    type: identifier,
    property: identifier.optional(),
    operation: z.enum(["count", "sum", "avg", "min", "max"]),
    filters: z.array(propertyFilter).max(10).default([]),
  })
  .strict();

export type ActionInfo = {
  id: string;
  name: string;
  description: string;
  ontology: string;
  inputSchema: Record<string, unknown>;
};
export type ActionRecord = {
  id: string;
  type: string;
  ontology: string;
  version: number;
  status:
    | "proposed"
    | "approved"
    | "rejected"
    | "executing"
    | "succeeded"
    | "failed"
    | "uncertain";
  input: unknown;
  prepared: {
    title: string;
    description: string;
    target: string;
    payload: unknown;
  };
  digest: string;
  revision: number;
  scenarioId: string | null;
  scenarioVersion: number | null;
  createdBy: string;
  createdAt: string;
  reviewedBy?: string;
  reviewedAt?: string;
  reviewComment?: string;
  result?: unknown;
  error?: string;
  executionStartedAt?: string;
  executedBy?: string;
  finishedAt?: string;
};
export const actionProposal = z
  .object({
    type: identifier,
    input: z.unknown(),
    idempotencyKey: z.string().min(8).max(100),
    scenario: identifier.optional(),
  })
  .strict();
export const actionReview = z
  .object({
    expectedVersion: z.number().int().nonnegative(),
    digest: z.string().length(64),
    comment: z.string().max(1000).default(""),
  })
  .strict();
export const actionExecute = z
  .object({
    expectedVersion: z.number().int().nonnegative(),
    digest: z.string().length(64),
  })
  .strict();

export const investigationInput = z
  .object({
    question: z.string().min(1).max(4000),
    root: identifier.optional(),
    functionId: identifier.optional(),
    input: z.unknown().optional(),
    scenario: identifier.optional(),
    maxSteps: z.number().int().min(1).max(16).default(8),
  })
  .strict();
export type ToolTrace = {
  name: string;
  input: unknown;
  output: unknown;
  error?: string;
  at: string;
};
export type Investigation = {
  id: string;
  ontology: string;
  question: string;
  mode: "deterministic-tools" | "model-tools";
  status: "running" | "completed" | "failed";
  answer: string;
  traces: ToolTrace[];
  runIds: string[];
  actionIds: string[];
  createdAt: string;
  finishedAt?: string;
  error?: string;
};

export const backupPayloadSchema = z
  .object({
    format: z.literal("graph-backup-v1"),
    createdAt: z.iso.datetime(),
    ontology: ontologySchema,
    revision: z.number().int().nonnegative(),
    state: ingestionSchema,
    documents: z
      .array(
        z
          .object({
            kind: z.enum([
              "source",
              "sync",
              "history",
              "base",
              "scenario",
              "run",
              "promotion",
              "investigation",
            ]),
            id: z.string().min(1).max(200),
            value: z.unknown(),
          })
          .strict(),
      )
      .max(20000),
  })
  .strict();
export const backupSchema = backupPayloadSchema.extend({
  digest: z.string().length(64),
});
export type BackupArchive = z.infer<typeof backupSchema>;
export const restoreInput = z
  .object({
    archive: backupSchema,
    expectedRevision: z.number().int().nonnegative(),
    confirmOntology: identifier,
  })
  .strict();
