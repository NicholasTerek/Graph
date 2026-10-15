import type {
  BackupArchive,
  JobRequest,
  JobRecord,
  SourceSchedule,
  Investigation,
  ActionRecord,
  ActionInfo,
  SourceConfig,
  SourceStatus,
  Source,
  SyncResult,
  PromotionPreview,
  ObjectQuery,
  AlgorithmInput,
  AlgorithmResult,
  ExplanationInput,
  Explanation,
  HistoricalInput,
  HistoricalState,
  HistoricalTraversal,
  HistoricalTraversalInput,
  ReadSnapshot,
  CommitList,
  VacuumInput,
  VacuumPlan,
  HistoryStatus,
  Ontology,
  GraphState,
  Ingestion,
  Traversal,
  GraphObject,
  GraphRelationship,
  Page,
  Scenario,
  Overlay,
  ScenarioDiff,
  FunctionInfo,
  FunctionRun,
} from "@graph/contracts";
export class GraphApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public requestId?: string,
    public issues?: unknown,
  ) {
    super(message);
    this.name = "GraphApiError";
  }
}
export class GraphClient {
  collectNativeGraphs(
    ontology: string,
    input: { dryRun?: boolean; digest?: string; confirmOntology?: string } = {},
  ) {
    return this.call<{
      ontology: string;
      digest: string;
      dryRun: boolean;
      graphs: { key: string; retained: boolean }[];
      orphanCount: number;
      deleted: string[];
    }>(`${this.path(ontology)}/native-graphs/collect`, "POST", input);
  }
  historyStatus(ontology: string) {
    return this.call<HistoryStatus>(`${this.path(ontology)}/history`);
  }
  vacuum(ontology: string, input: VacuumInput) {
    return this.call<VacuumPlan>(
      `${this.path(ontology)}/vacuum`,
      "POST",
      input,
    );
  }
  traverseAt(ontology: string, input: HistoricalTraversalInput) {
    return this.call<HistoricalTraversal>(
      `${this.path(ontology)}/state/at/traverse`,
      "POST",
      input,
    );
  }
  stateAt(ontology: string, input: HistoricalInput = {}) {
    return this.call<HistoricalState>(
      `${this.path(ontology)}/state/at`,
      "POST",
      input,
    );
  }
  commits(ontology: string, after = -1, limit = 100) {
    return this.call<CommitList>(
      `${this.path(ontology)}/commits?${this.query({ after, limit })}`,
    );
  }
  createReadSnapshot(
    ontology: string,
    input: HistoricalInput & { ttlSeconds?: number } = {},
  ) {
    return this.call<ReadSnapshot>(
      `${this.path(ontology)}/snapshots`,
      "POST",
      input,
    );
  }
  releaseReadSnapshot(ontology: string, id: string) {
    return this.call<void>(
      `${this.path(ontology)}/snapshots/${encodeURIComponent(id)}`,
      "DELETE",
    );
  }
  explain(ontology: string, input: ExplanationInput) {
    return this.call<Explanation>(
      `${this.path(ontology)}/explain`,
      "POST",
      input,
    );
  }
  algorithms(ontology: string) {
    return this.call<{ id: string; description: string }[]>(
      `${this.path(ontology)}/algorithms`,
    );
  }
  runAlgorithm(ontology: string, input: AlgorithmInput) {
    return this.call<AlgorithmResult>(
      `${this.path(ontology)}/algorithms/run`,
      "POST",
      input,
    );
  }
  constructor(
    private baseUrl = "",
    private request: typeof fetch = (...args) => fetch(...args),
    private options: { token?: string | (() => string | undefined) } = {},
  ) {}
  private async call<T>(
    path: string,
    method = "GET",
    body?: unknown,
  ): Promise<T> {
    const token =
      typeof this.options.token === "function"
        ? this.options.token()
        : this.options.token;
    const response = await this.request.call(
      globalThis,
      `${this.baseUrl}/api${path}`,
      {
        method,
        headers: {
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      },
    );
    if (!response.ok) {
      const error = await response
        .json()
        .catch(() => ({ message: response.statusText }));
      throw new GraphApiError(
        response.status,
        error.code ?? "REQUEST_FAILED",
        error.message ?? `Request failed (${response.status})`,
        error.requestId,
        error.issues,
      );
    }
    return response.status === 204
      ? (undefined as T)
      : (response.json() as Promise<T>);
  }
  private path(ontology: string) {
    return `/ontologies/${encodeURIComponent(ontology)}`;
  }
  private query(values: Record<string, string | number | undefined>) {
    return new URLSearchParams(
      Object.entries(values)
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => [key, String(value)]),
    ).toString();
  }
  ontologies() {
    return this.call<Ontology[]>("/ontologies");
  }
  ontology(id: string) {
    return this.call<Ontology>(this.path(id));
  }
  register(ontology: Ontology) {
    return this.call<Ontology>("/ontologies", "POST", ontology);
  }
  snapshot(ontology: string) {
    return this.call<GraphState>(`${this.path(ontology)}/graph`);
  }
  ingest(ontology: string, input: Ingestion) {
    return this.call<{ objects: number; relationships: number }>(
      `${this.path(ontology)}/ingest`,
      "POST",
      input,
    );
  }
  objects(
    ontology: string,
    query: { limit?: number; after?: string; type?: string; q?: string } = {},
  ) {
    return this.call<Page<GraphObject>>(
      `${this.path(ontology)}/objects?${this.query(query)}`,
    );
  }
  object(ontology: string, id: string) {
    return this.call<GraphObject>(
      `${this.path(ontology)}/objects/${encodeURIComponent(id)}`,
    );
  }
  putObject(ontology: string, object: GraphObject) {
    return this.call<GraphObject>(
      `${this.path(ontology)}/objects/${encodeURIComponent(object.id)}`,
      "PUT",
      object,
    );
  }
  patchObject(
    ontology: string,
    id: string,
    patch: {
      properties: GraphObject["properties"];
      provenance?: GraphObject["provenance"];
      expectedRevision?: number;
    },
  ) {
    return this.call<{ object: GraphObject; revision: number }>(
      `${this.path(ontology)}/objects/${encodeURIComponent(id)}`,
      "PATCH",
      patch,
    );
  }
  deleteObject(ontology: string, id: string) {
    return this.call<void>(
      `${this.path(ontology)}/objects/${encodeURIComponent(id)}`,
      "DELETE",
    );
  }
  relationships(
    ontology: string,
    query: {
      limit?: number;
      after?: string;
      type?: string;
      from?: string;
      to?: string;
    } = {},
  ) {
    return this.call<Page<GraphRelationship>>(
      `${this.path(ontology)}/relationships?${this.query(query)}`,
    );
  }
  relationship(ontology: string, id: string) {
    return this.call<GraphRelationship>(
      `${this.path(ontology)}/relationships/${encodeURIComponent(id)}`,
    );
  }
  putRelationship(ontology: string, relationship: GraphRelationship) {
    return this.call<GraphRelationship>(
      `${this.path(ontology)}/relationships/${encodeURIComponent(relationship.id)}`,
      "PUT",
      relationship,
    );
  }
  deleteRelationship(ontology: string, id: string) {
    return this.call<void>(
      `${this.path(ontology)}/relationships/${encodeURIComponent(id)}`,
      "DELETE",
    );
  }
  traverse(
    ontology: string,
    root: string,
    depth = 3,
    direction: Traversal["direction"] = "both",
  ) {
    return this.call<Traversal>(
      `${this.path(ontology)}/traverse?${this.query({ root, depth, direction })}`,
    );
  }
  scenarios(ontology: string) {
    return this.call<Scenario[]>(`${this.path(ontology)}/scenarios`);
  }
  createScenario(
    ontology: string,
    input: {
      id: string;
      name: string;
      description?: string;
      expectedRevision?: number;
      strategy?: "copy" | "overlay";
    },
  ) {
    return this.call<Scenario>(
      `${this.path(ontology)}/scenarios`,
      "POST",
      input,
    );
  }
  scenario(ontology: string, id: string) {
    return this.call<Scenario>(
      `${this.path(ontology)}/scenarios/${encodeURIComponent(id)}`,
    );
  }
  scenarioGraph(ontology: string, id: string) {
    return this.call<GraphState & { scenarioVersion: number }>(
      `${this.path(ontology)}/scenarios/${encodeURIComponent(id)}/graph`,
    );
  }
  editScenario(
    ontology: string,
    id: string,
    edit: Partial<Overlay> & { expectedVersion: number },
  ) {
    return this.call<Scenario>(
      `${this.path(ontology)}/scenarios/${encodeURIComponent(id)}`,
      "PATCH",
      edit,
    );
  }
  patchScenarioObject(
    ontology: string,
    id: string,
    objectId: string,
    patch: { properties: GraphObject["properties"]; expectedVersion: number },
  ) {
    return this.call<Scenario>(
      `${this.path(ontology)}/scenarios/${encodeURIComponent(id)}/objects/${encodeURIComponent(objectId)}`,
      "PATCH",
      patch,
    );
  }
  scenarioDiff(ontology: string, id: string) {
    return this.call<ScenarioDiff>(
      `${this.path(ontology)}/scenarios/${encodeURIComponent(id)}/diff`,
    );
  }
  discardScenario(ontology: string, id: string) {
    return this.call<void>(
      `${this.path(ontology)}/scenarios/${encodeURIComponent(id)}`,
      "DELETE",
    );
  }
  functions(ontology: string) {
    return this.call<FunctionInfo[]>(`${this.path(ontology)}/functions`);
  }
  runFunction<T = unknown>(
    ontology: string,
    id: string,
    input: unknown,
    scenario?: string,
    history?: HistoricalInput,
  ) {
    return this.call<FunctionRun & { output: T }>(
      `${this.path(ontology)}/functions/${encodeURIComponent(id)}/run`,
      "POST",
      { input, scenario, history },
    );
  }
  runs(ontology: string) {
    return this.call<FunctionRun[]>(`${this.path(ontology)}/runs`);
  }
  jobCapabilities() {
    return this.call<{
      workerEnabled: boolean;
      delivery: string;
      sourceRetries: boolean;
      investigationAutoRetry: boolean;
    }>("/jobs/capabilities");
  }
  jobs(ontology: string) {
    return this.call<JobRecord[]>(`${this.path(ontology)}/jobs`);
  }
  job(ontology: string, id: string) {
    return this.call<JobRecord>(
      `${this.path(ontology)}/jobs/${encodeURIComponent(id)}`,
    );
  }
  enqueueJob(ontology: string, input: JobRequest) {
    return this.call<JobRecord>(`${this.path(ontology)}/jobs`, "POST", input);
  }
  cancelJob(ontology: string, id: string, expectedVersion: number) {
    return this.call<JobRecord>(
      `${this.path(ontology)}/jobs/${encodeURIComponent(id)}/cancel`,
      "POST",
      { expectedVersion },
    );
  }
  retryJob(ontology: string, id: string, expectedVersion: number) {
    return this.call<JobRecord>(
      `${this.path(ontology)}/jobs/${encodeURIComponent(id)}/retry`,
      "POST",
      { expectedVersion },
    );
  }
  sourceSchedules(ontology: string) {
    return this.call<SourceSchedule[]>(`${this.path(ontology)}/schedules`);
  }
  setSourceSchedule(
    ontology: string,
    input: {
      id: string;
      sourceId: string;
      intervalSeconds: number;
      enabled?: boolean;
      expectedVersion?: number;
    },
  ) {
    return this.call<SourceSchedule>(
      `${this.path(ontology)}/schedules`,
      "POST",
      input,
    );
  }
  sourceStatuses(ontology: string) {
    return this.call<SourceStatus[]>(`${this.path(ontology)}/sources/status`);
  }
  sources(ontology: string) {
    return this.call<Source[]>(`${this.path(ontology)}/sources`);
  }
  registerSource(ontology: string, input: SourceConfig) {
    return this.call<Source>(`${this.path(ontology)}/sources`, "POST", input);
  }
  syncSource(
    ontology: string,
    id: string,
    input: {
      content?: string;
      expectedCheckpoint?: string;
      dryRun?: boolean;
      expectedRevision?: number;
    } = {},
  ) {
    return this.call<SyncResult>(
      `${this.path(ontology)}/sources/${encodeURIComponent(id)}/sync`,
      "POST",
      input,
    );
  }
  sourceRuns(ontology: string, id: string) {
    return this.call<SyncResult[]>(
      `${this.path(ontology)}/sources/${encodeURIComponent(id)}/runs`,
    );
  }
  objectHistory(ontology: string, id: string) {
    return this.call<unknown[]>(
      `${this.path(ontology)}/objects/${encodeURIComponent(id)}/history`,
    );
  }
  queryObjects(ontology: string, input: Partial<ObjectQuery> = {}) {
    return this.call<Page<GraphObject>>(
      `${this.path(ontology)}/objects/query`,
      "POST",
      input,
    );
  }
  aggregate(
    ontology: string,
    input: {
      type: string;
      operation: "count" | "sum" | "avg" | "min" | "max";
      property?: string;
      filters?: ObjectQuery["filters"];
    },
  ) {
    return this.call<{ count: number; value: number | null }>(
      `${this.path(ontology)}/aggregate`,
      "POST",
      input,
    );
  }
  reviewScenario(ontology: string, id: string) {
    return this.call<PromotionPreview>(
      `${this.path(ontology)}/scenarios/${encodeURIComponent(id)}/review`,
    );
  }
  promoteScenario(
    ontology: string,
    id: string,
    input: {
      expectedVersion: number;
      expectedRevision: number;
      objects: string[];
      relationships: string[];
      confirm: true;
    },
  ) {
    return this.call<{
      revision: number;
      result: { id: string; actor: string };
    }>(
      `${this.path(ontology)}/scenarios/${encodeURIComponent(id)}/promote`,
      "POST",
      input,
    );
  }

  actionTypes(ontology: string) {
    return this.call<ActionInfo[]>(`${this.path(ontology)}/action-types`);
  }
  actions(ontology: string) {
    return this.call<ActionRecord[]>(`${this.path(ontology)}/actions`);
  }
  action(ontology: string, id: string) {
    return this.call<ActionRecord>(
      `${this.path(ontology)}/actions/${encodeURIComponent(id)}`,
    );
  }
  proposeAction(
    ontology: string,
    input: {
      type: string;
      input: unknown;
      idempotencyKey: string;
      scenario?: string;
    },
  ) {
    return this.call<ActionRecord>(
      `${this.path(ontology)}/actions`,
      "POST",
      input,
    );
  }
  reviewAction(
    ontology: string,
    id: string,
    input: {
      expectedVersion: number;
      digest: string;
      comment?: string;
      expiresInSeconds?: number;
    },
    approve = true,
  ) {
    return this.call<ActionRecord>(
      `${this.path(ontology)}/actions/${encodeURIComponent(id)}/${approve ? "approve" : "reject"}`,
      "POST",
      input,
    );
  }
  executeAction(
    ontology: string,
    id: string,
    input: { expectedVersion: number; digest: string },
  ) {
    return this.call<ActionRecord>(
      `${this.path(ontology)}/actions/${encodeURIComponent(id)}/execute`,
      "POST",
      input,
    );
  }
  revokeAction(
    ontology: string,
    id: string,
    input: { expectedVersion: number; digest: string; comment?: string },
  ) {
    return this.call<ActionRecord>(
      `${this.path(ontology)}/actions/${encodeURIComponent(id)}/revoke`,
      "POST",
      input,
    );
  }
  reconcileAction(ontology: string, id: string) {
    return this.call<ActionRecord>(
      `${this.path(ontology)}/actions/${encodeURIComponent(id)}/reconcile`,
      "POST",
      {},
    );
  }

  investigate(
    ontology: string,
    input: {
      question: string;
      root?: string;
      functionId?: string;
      input?: unknown;
      scenario?: string;
      maxSteps?: number;
    },
  ) {
    return this.call<Investigation>(
      `${this.path(ontology)}/investigations`,
      "POST",
      input,
    );
  }
  investigations(ontology: string) {
    return this.call<Investigation[]>(`${this.path(ontology)}/investigations`);
  }

  backup(ontology: string, options: { includeHistory?: boolean } = {}) {
    return this.call<BackupArchive>(
      `${this.path(ontology)}/backup${options.includeHistory ? "?includeHistory=true" : ""}`,
    );
  }
  restore(ontology: string, archive: BackupArchive, expectedRevision: number) {
    return this.call<{ revision: number; result: { id: string } }>(
      `${this.path(ontology)}/restore`,
      "POST",
      { archive, expectedRevision, confirmOntology: ontology },
    );
  }
  agentCapabilities() {
    return this.call<{
      mode: string;
      approvalTools: boolean;
      executionTools: boolean;
    }>("/agent/capabilities");
  }
  functionRun(ontology: string, id: string) {
    return this.call<FunctionRun>(
      `${this.path(ontology)}/runs/${encodeURIComponent(id)}`,
    );
  }
  createPropertyIndex(ontology: string, type: string, property: string) {
    return this.call<{ indexed: boolean }>(
      `${this.path(ontology)}/indexes`,
      "POST",
      { type, property },
    );
  }
}
