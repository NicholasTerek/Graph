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
    strategy: z.enum(["copy", "overlay"]).optional(),
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
  storage?: "falkordb" | "falkordb-overlay";
  historyGeneration?: string;
  graphKey?: string;
  baseGraphKey?: string;
};
export const algorithmInput = z
  .object({
    algorithm: z.enum(["shortest-path", "pagerank", "betweenness", "degree"]),
    scenario: identifier.optional(),
    revision: z.number().int().nonnegative().optional(),
    generation: z.uuid().optional(),
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
    if (value.scenario && (value.revision !== undefined || value.generation))
      ctx.addIssue({
        code: "custom",
        message: "Select a scenario or a historical revision, not both",
      });
    if (value.algorithm === "shortest-path" && value.direction === "both")
      ctx.addIssue({
        code: "custom",
        message: "FalkorDB shortestPath supports only out or in direction",
      });
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
  generation?: string;
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
  explanation?: ExplanationClaim[];
  history?: { generation: string; revision: number; committedAt: string };
  evidence?: {
    objects: GraphObject[];
    relationships: GraphRelationship[];
    contributors: EvidenceContributor[];
    capturedAt: string;
    truncated: boolean;
  };
};
export type EvidenceContributor = {
  objectId: string;
  sourceId: string;
  externalId: string;
  fields: string[];
  checkpoint: string | null;
  observedAt: string | null;
  matches: boolean;
  values: Record<string, string | number | boolean>;
};
export type ExplanationClaim = {
  id: string;
  kind: "calculated" | "assumption" | "constraint";
  text: string;
  recordIds: string[];
  ruleId?: string;
  passed?: boolean;
};
export const explanationInput = z
  .object({
    root: identifier,
    targets: z.array(identifier).max(16).default([]),
    runId: identifier.optional(),
    scenario: identifier.optional(),
    maxDepth: z.number().int().min(1).max(5).default(4),
  })
  .strict();
export type ExplanationInput = z.input<typeof explanationInput>;
export type Explanation = {
  context: {
    ontology: string;
    revision: number;
    scenario: string | null;
    scenarioVersion: number | null;
    currentRevision: number;
    currentScenarioVersion: number | null;
    stale: boolean;
    scope: "calculation-readset" | "current-graph" | "unavailable";
  };
  root: string;
  paths: {
    target: string;
    objects: string[];
    relationships: string[];
    hops: number;
  }[];
  records: GraphObject[];
  relationships: GraphRelationship[];
  contributors: EvidenceContributor[];
  claims: ExplanationClaim[];
  calculation: FunctionRun | null;
  query: {
    engine: "falkordb";
    maxDepth: number;
    direction: "out";
    targets: string[];
  };
  warnings: string[];
};
export const historicalInput = z
  .object({
    revision: z.number().int().nonnegative().optional(),
    at: z.iso.datetime().optional(),
    snapshot: identifier.optional(),
    generation: z.uuid().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      [value.revision, value.at, value.snapshot].filter((v) => v !== undefined)
        .length > 1
    )
      ctx.addIssue({
        code: "custom",
        message: "Select exactly one of revision, at or snapshot",
      });
  });
export const snapshotInput = historicalInput.safeExtend({
  ttlSeconds: z.number().int().min(1).max(3600).default(300),
});
export const historicalTraversalInput = historicalInput.safeExtend({
  root: identifier,
  depth: z.number().int().min(1).max(5).default(3),
  direction: z.enum(["out", "in", "both"]).default("both"),
});
export type HistoricalTraversalInput = z.input<typeof historicalTraversalInput>;
export type HistoricalTraversal = HistoricalState & {
  root: string;
  depth: number;
  direction: "out" | "in" | "both";
};
export type HistoricalInput = z.input<typeof historicalInput>;
export type HistoricalState = GraphState & {
  generation: string;
  committedAt: string;
  retainedFrom: number;
  snapshot?: string;
};
export type ReadSnapshot = {
  id: string;
  ontology: string;
  owner: string;
  generation: string;
  revision: number;
  committedAt: string;
  createdAt: string;
  expiresAt: string;
};
export type CommitList = {
  generation: string;
  retainedFrom: number;
  currentRevision: number;
  items: { revision: number; committedAt: string }[];
};
export const vacuumInput = z
  .object({
    generation: z.uuid(),
    expectedRevision: z.number().int().nonnegative(),
    retainFrom: z.number().int().nonnegative(),
    batchSize: z.number().int().min(1).max(1000).default(100),
    dryRun: z.boolean().default(true),
    digest: z.string().length(64).optional(),
    confirm: z.boolean().default(false),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (!value.dryRun && (!value.digest || !value.confirm))
      ctx.addIssue({
        code: "custom",
        message:
          "Vacuum apply requires the preview digest and explicit confirmation",
      });
  });
export type VacuumInput = z.input<typeof vacuumInput>;
export type VacuumPlan = {
  ontology: string;
  generation: string;
  revision: number;
  retainedFrom: number;
  requestedFrom: number;
  watermark: number;
  batchSize: number;
  protectedSnapshots: {
    id: string;
    owner: string;
    revision: number;
    expiresAt: string;
  }[];
  protectedBranches: { id: string; revision: number }[];
  eligible: {
    objectVersions: number;
    relationshipVersions: number;
    commits: number;
  };
  digest: string;
  applied: boolean;
  removed?: {
    objectVersions: number;
    relationshipVersions: number;
    commits: number;
  };
};
export type HistoryStatus = {
  generation: string;
  revision: number;
  retainedFrom: number;
  committedAt: string;
  activeSnapshots: number;
  oldestPinnedRevision: number | null;
};
export const functionInvocation = z
  .object({
    input: z.unknown(),
    scenario: identifier.optional(),
    history: historicalInput.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.scenario && value.history)
      ctx.addIssue({
        code: "custom",
        message: "Select scenario or history context, not both",
      });
  });

export const mappingValue = z.union([
  z.object({ field: z.string().min(1).max(100) }).strict(),
  z
    .object({ value: z.union([z.string(), z.number().finite(), z.boolean()]) })
    .strict(),
]);
export const sourceRelationshipMapping = z
  .object({
    id: identifier,
    type: identifier,
    direction: z.enum(["out", "in"]).optional(),
    optional: z.boolean().optional(),
    target: z.union([
      z.object({ objectId: mappingValue }).strict(),
      z.object({ type: identifier, identity: mappingValue }).strict(),
    ]),
  })
  .strict();
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
        relationships: z.array(sourceRelationshipMapping).max(10).optional(),
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
  managedRelationships?: Record<
    string,
    { externalId: string; relationship: GraphRelationship; created: boolean }
  >;
  managed: Record<
    string,
    {
      externalId: string;
      fields: Record<string, string | number | boolean>;
      created?: boolean;
    }
  >;
};
export type SourceStatus = {
  sourceId: string;
  connector: Source["connector"];
  connectionState: "upload" | "public" | "configured" | "unavailable";
  connectivity: "not_probed";
  lastSuccessfulSync: string | null;
  lastAttempt: {
    status: SyncResult["status"];
    at: string;
    error?: string;
  } | null;
  guidance: string[];
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
  relationships?: {
    added: string[];
    updated: string[];
    removed: string[];
    unchanged: number;
  };
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
    | "revoked"
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
  approvalExpiresAt?: string;
  revokedBy?: string;
  revokedAt?: string;
  revocationComment?: string;
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
    expiresInSeconds: z.number().int().min(30).max(86400).default(3600),
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
              "job",
              "schedule",
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

export const jobCreate = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("source-sync"),
      sourceId: identifier,
      maxAttempts: z.number().int().min(1).max(5).default(3),
      notBefore: z.iso.datetime().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("investigation"),
      request: investigationInput,
      notBefore: z.iso.datetime().optional(),
    })
    .strict(),
]);
export type JobRequest = z.input<typeof jobCreate>;
export type JobRecord = {
  id: string;
  ontology: string;
  owner: string;
  version: number;
  input: z.output<typeof jobCreate>;
  status:
    | "queued"
    | "running"
    | "retrying"
    | "cancelled"
    | "succeeded"
    | "failed"
    | "interrupted";
  attempt: number;
  maxAttempts: number;
  createdAt: string;
  updatedAt: string;
  notBefore: string;
  lease?: string;
  leaseUntil?: string;
  cancellationRequestedAt?: string;
  result?: unknown;
  error?: string;
  recovered?: boolean;
  scheduleId?: string;
  queuedRevision?: number;
  queuedScenarioVersion?: number | null;
};
export const scheduleInput = z
  .object({
    id: identifier,
    sourceId: identifier,
    intervalSeconds: z.number().int().min(60).max(604800),
    enabled: z.boolean().default(true),
    expectedVersion: z.number().int().nonnegative().optional(),
  })
  .strict();
export type SourceSchedule = {
  id: string;
  ontology: string;
  sourceId: string;
  owner: string;
  intervalSeconds: number;
  enabled: boolean;
  version: number;
  nextRunAt: string;
  updatedAt: string;
};

export const jobRecordSchema = z
  .object({
    id: identifier,
    ontology: identifier,
    owner: z.string().min(1).max(200),
    version: z.number().int().nonnegative(),
    input: jobCreate,
    status: z.enum([
      "queued",
      "running",
      "retrying",
      "cancelled",
      "succeeded",
      "failed",
      "interrupted",
    ]),
    attempt: z.number().int().nonnegative(),
    maxAttempts: z.number().int().min(1).max(5),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    notBefore: z.iso.datetime(),
  })
  .passthrough();
export const sourceScheduleSchema = z
  .object({
    id: identifier,
    ontology: identifier,
    sourceId: identifier,
    owner: z.string().min(1).max(200),
    intervalSeconds: z.number().int().min(60).max(604800),
    enabled: z.boolean(),
    version: z.number().int().nonnegative(),
    nextRunAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .passthrough();
