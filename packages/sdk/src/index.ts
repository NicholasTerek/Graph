import type {
  Ontology,
  GraphSnapshot,
  Ingestion,
  Traversal,
  GraphObject,
  GraphRelationship,
} from "@graph/contracts";

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
      throw new Error(error.message ?? `Request failed (${response.status})`);
    }
    if (response.status === 204) return undefined as T;
    return response.json() as Promise<T>;
  }
  ontologies() {
    return this.call<Ontology[]>("/ontologies");
  }
  register(ontology: Ontology) {
    return this.call<Ontology>("/ontologies", "POST", ontology);
  }
  snapshot(ontology: string) {
    return this.call<GraphSnapshot>(
      `/ontologies/${encodeURIComponent(ontology)}/graph`,
    );
  }
  ingest(ontology: string, input: Ingestion) {
    return this.call<{ objects: number; relationships: number }>(
      `/ontologies/${encodeURIComponent(ontology)}/ingest`,
      "POST",
      input,
    );
  }
  putObject(ontology: string, object: GraphObject) {
    return this.call<GraphObject>(
      `/ontologies/${encodeURIComponent(ontology)}/objects/${encodeURIComponent(object.id)}`,
      "PUT",
      object,
    );
  }
  putRelationship(ontology: string, relationship: GraphRelationship) {
    return this.call<GraphRelationship>(
      `/ontologies/${encodeURIComponent(ontology)}/relationships/${encodeURIComponent(relationship.id)}`,
      "PUT",
      relationship,
    );
  }
  traverse(
    ontology: string,
    root: string,
    depth = 3,
    direction: Traversal["direction"] = "both",
  ) {
    return this.call<Traversal>(
      `/ontologies/${encodeURIComponent(ontology)}/traverse?root=${encodeURIComponent(root)}&depth=${depth}&direction=${direction}`,
    );
  }
}
