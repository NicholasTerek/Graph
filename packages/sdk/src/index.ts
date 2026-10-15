import type {
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
  constructor(
    private baseUrl = "",
    private request: typeof fetch = (...args) => fetch(...args),
  ) {}
  private async call<T>(
    path: string,
    method = "GET",
    body?: unknown,
  ): Promise<T> {
    const response = await this.request(`${this.baseUrl}/api${path}`, {
      method,
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
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
  ) {
    return this.call<FunctionRun & { output: T }>(
      `${this.path(ontology)}/functions/${encodeURIComponent(id)}/run`,
      "POST",
      { input, scenario },
    );
  }
  runs(ontology: string) {
    return this.call<FunctionRun[]>(`${this.path(ontology)}/runs`);
  }
}
