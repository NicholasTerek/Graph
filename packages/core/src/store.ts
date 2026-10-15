import { FalkorDB } from "falkordb";
import type {
  Ontology,
  GraphObject,
  GraphRelationship,
  GraphSnapshot,
  Ingestion,
  Traversal,
  GraphState,
  Page,
} from "@graph/contracts";
import {
  PlatformError,
  validateIngestion,
  isAdditiveSchema,
} from "./validation.js";

type Row = Record<string, unknown>;
type QueryValue =
  | null
  | string
  | number
  | boolean
  | QueryValue[]
  | { [key: string]: QueryValue };

export class GraphStore {
  private graph;
  private pending: Promise<unknown> = Promise.resolve();
  constructor(
    private db: FalkorDB,
    name: string,
  ) {
    this.graph = db.selectGraph(name);
  }

  private async rows(
    query: string,
    params: Record<string, QueryValue> = {},
  ): Promise<Row[]> {
    const result = await this.graph.query(query, { params, TIMEOUT: 3000 });
    return (result.data ?? []) as Row[];
  }

  exclusive<T>(operation: () => Promise<T>): Promise<T> {
    return this.write(operation);
  }

  private write<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pending.then(operation);
    this.pending = result.catch(() => undefined);
    return result;
  }

  async initialize() {
    for (const query of [
      "CREATE INDEX FOR (n:Ontology) ON (n.id)",
      "CREATE INDEX FOR (n:Object) ON (n.ontology, n.id)",
      "CREATE INDEX FOR (n:Document) ON (n.ontology, n.kind, n.id)",
    ]) {
      try {
        await this.graph.query(query);
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !/^Attribute '.+' is already indexed$/.test(error.message)
        )
          throw error;
      }
    }
  }

  async health() {
    await this.rows("RETURN 1 AS ok");
  }
  async close() {
    await this.db.close();
  }
  async listOntologies(): Promise<Ontology[]> {
    return (
      await this.rows(
        "MATCH (o:Ontology) RETURN o.schema AS schema ORDER BY o.id",
      )
    ).map((r) => JSON.parse(String(r.schema)));
  }
  async ontology(id: string): Promise<Ontology> {
    const [row] = await this.rows(
      "MATCH (o:Ontology {id: $id}) RETURN o.schema AS schema",
      { id },
    );
    if (!row) throw new PlatformError(404, `Ontology not found: ${id}`);
    return JSON.parse(String(row.schema));
  }
  async register(ontology: Ontology) {
    return this.write(async () => {
      const rows = await this.rows(
        "MATCH (o:Ontology {id: $id}) RETURN o.schema AS schema",
        { id: ontology.id },
      );
      if (rows.length) {
        if (
          String(rows[0].schema) !== JSON.stringify(ontology) &&
          !isAdditiveSchema(JSON.parse(String(rows[0].schema)), ontology)
        )
          throw new PlatformError(
            409,
            "Ontology already exists with a different schema; schema migrations are not supported yet",
          );
        if (String(rows[0].schema) !== JSON.stringify(ontology))
          await this.rows(
            "MATCH (o:Ontology {id:$id}) SET o.schema=$schema, o.revision=coalesce(o.revision,0)+1",
            { id: ontology.id, schema: JSON.stringify(ontology) },
          );
        return ontology;
      }
      await this.rows(
        "CREATE (:Ontology {id: $id, schema: $schema, revision: 0})",
        {
          id: ontology.id,
          schema: JSON.stringify(ontology),
        },
      );
      return ontology;
    });
  }

  async snapshot(ontology: string): Promise<GraphSnapshot> {
    await this.ontology(ontology);
    const objects = await this.rows(
      "MATCH (o:Object {ontology: $ontology}) RETURN o.record AS record ORDER BY o.id",
      { ontology },
    );
    const relationships = await this.rows(
      "MATCH (:Object {ontology: $ontology})-[r:LINK]->(:Object {ontology: $ontology}) RETURN r.record AS record ORDER BY r.id",
      { ontology },
    );
    return {
      objects: objects.map((r) => JSON.parse(String(r.record))),
      relationships: relationships.map((r) => JSON.parse(String(r.record))),
    };
  }

  async ingest(id: string, input: Ingestion) {
    return this.write(() => this.ingestUnlocked(id, input));
  }

  private async ingestUnlocked(id: string, input: Ingestion) {
    const ontology = await this.ontology(id);
    const current = await this.snapshot(id);
    validateIngestion(ontology, current, input);
    const objects = input.objects.map((object) => ({
      id: object.id,
      type: object.type,
      record: JSON.stringify(object),
    }));
    const relationships = input.relationships.map((rel) => ({
      id: rel.id,
      type: rel.type,
      from: rel.from,
      to: rel.to,
      record: JSON.stringify(rel),
    }));
    if (objects.length && relationships.length) {
      await this.rows(
        `UNWIND $objects AS item
          MERGE (o:Object {ontology: $ontology, id: item.id}) SET o.type = item.type, o.record = item.record
          WITH count(o) AS written
          UNWIND $relationships AS item
          MATCH (a:Object {ontology: $ontology, id: item.from}), (b:Object {ontology: $ontology, id: item.to})
          MERGE (a)-[r:LINK {id: item.id}]->(b) SET r.type = item.type, r.record = item.record
          WITH count(r) AS written MATCH (meta:Ontology {id: $ontology}) SET meta.revision = coalesce(meta.revision, 0) + 1`,
        { ontology: id, objects, relationships },
      );
    } else if (objects.length) {
      await this.rows(
        "UNWIND $objects AS item MERGE (o:Object {ontology: $ontology, id: item.id}) SET o.type = item.type, o.record = item.record WITH count(o) AS written MATCH (meta:Ontology {id: $ontology}) SET meta.revision = coalesce(meta.revision, 0) + 1",
        { ontology: id, objects },
      );
    } else if (relationships.length) {
      await this.rows(
        `UNWIND $relationships AS item
          MATCH (a:Object {ontology: $ontology, id: item.from}), (b:Object {ontology: $ontology, id: item.to})
          MERGE (a)-[r:LINK {id: item.id}]->(b) SET r.type = item.type, r.record = item.record WITH count(r) AS written MATCH (meta:Ontology {id: $ontology}) SET meta.revision = coalesce(meta.revision, 0) + 1`,
        { ontology: id, relationships },
      );
    }
    return { objects: objects.length, relationships: relationships.length };
  }

  async object(ontology: string, id: string): Promise<GraphObject> {
    await this.ontology(ontology);
    const [row] = await this.rows(
      "MATCH (o:Object {ontology: $ontology, id: $id}) RETURN o.record AS record",
      { ontology, id },
    );
    if (!row) throw new PlatformError(404, `Object not found: ${id}`);
    return JSON.parse(String(row.record));
  }

  async deleteObject(ontology: string, id: string) {
    return this.write(async () => {
      await this.object(ontology, id);
      const [row] = await this.rows(
        "MATCH (o:Object {ontology: $ontology, id: $id}) OPTIONAL MATCH (o)-[r:LINK]-() RETURN count(r) AS links",
        { ontology, id },
      );
      if (Number(row.links) > 0)
        throw new PlatformError(
          409,
          "Remove relationships before deleting this object",
        );
      await this.rows(
        "MATCH (o:Object {ontology: $ontology, id: $id}) DELETE o WITH count(*) AS deleted MATCH (meta:Ontology {id: $ontology}) SET meta.revision = coalesce(meta.revision, 0) + 1",
        { ontology, id },
      );
    });
  }

  async deleteRelationship(ontology: string, id: string) {
    return this.write(async () => {
      await this.ontology(ontology);
      const rows = await this.rows(
        "MATCH (:Object {ontology: $ontology})-[r:LINK {id: $id}]->() RETURN r.id AS id",
        { ontology, id },
      );
      if (!rows.length)
        throw new PlatformError(404, `Relationship not found: ${id}`);
      await this.rows(
        "MATCH (:Object {ontology: $ontology})-[r:LINK {id: $id}]->() DELETE r WITH count(*) AS deleted MATCH (meta:Ontology {id: $ontology}) SET meta.revision = coalesce(meta.revision, 0) + 1",
        { ontology, id },
      );
    });
  }

  async revision(ontology: string): Promise<number> {
    const [row] = await this.rows(
      "MATCH (o:Ontology {id: $ontology}) RETURN coalesce(o.revision, 0) AS revision",
      { ontology },
    );
    if (!row) throw new PlatformError(404, `Ontology not found: ${ontology}`);
    return Number(row.revision);
  }

  async state(ontology: string): Promise<GraphState> {
    return this.write(async () => ({
      ...(await this.snapshot(ontology)),
      revision: await this.revision(ontology),
    }));
  }

  async patchObject(
    ontology: string,
    id: string,
    patch: {
      properties: GraphObject["properties"];
      provenance?: GraphObject["provenance"];
      expectedRevision?: number;
    },
  ) {
    return this.write(async () => {
      const revision = await this.revision(ontology);
      if (
        patch.expectedRevision !== undefined &&
        revision !== patch.expectedRevision
      )
        throw new PlatformError(
          409,
          `Revision conflict: expected ${patch.expectedRevision}, current ${revision}`,
        );
      const current = await this.object(ontology, id);
      const object = {
        ...current,
        properties: { ...current.properties, ...patch.properties },
        provenance: patch.provenance ?? current.provenance,
      };
      await this.ingestUnlocked(ontology, {
        objects: [object],
        relationships: [],
      });
      return { object, revision: await this.revision(ontology) };
    });
  }

  async objects(
    ontology: string,
    query: { limit: number; after?: string; type?: string; q?: string },
  ): Promise<Page<GraphObject>> {
    await this.ontology(ontology);
    const rows = await this.rows(
      `MATCH (o:Object {ontology: $ontology})
      WHERE ($after = '' OR o.id > $after) AND ($type = '' OR o.type = $type)
      RETURN o.record AS record ORDER BY o.id ${query.q ? "" : "LIMIT $limit"}`,
      {
        ontology,
        after: query.after ?? "",
        type: query.type ?? "",
        limit: query.limit + 1,
      },
    );
    const objects: GraphObject[] = rows.map((r) =>
      JSON.parse(String(r.record)),
    );
    const filtered = query.q
      ? objects.filter((o) =>
          [o.id, o.type, ...Object.values(o.properties)]
            .join(" ")
            .toLowerCase()
            .includes(query.q!.toLowerCase()),
        )
      : objects;
    return {
      items: filtered.slice(0, query.limit),
      nextCursor:
        filtered.length > query.limit ? filtered[query.limit - 1].id : null,
      limit: query.limit,
    };
  }

  async relationships(
    ontology: string,
    query: {
      limit: number;
      after?: string;
      type?: string;
      from?: string;
      to?: string;
    },
  ): Promise<Page<GraphRelationship>> {
    await this.ontology(ontology);
    const rows = await this.rows(
      `MATCH (a:Object {ontology:$ontology})-[r:LINK]->(b:Object {ontology:$ontology})
      WHERE ($after = '' OR r.id > $after) AND ($type = '' OR r.type = $type) AND ($from = '' OR a.id = $from) AND ($to = '' OR b.id = $to)
      RETURN r.record AS record ORDER BY r.id LIMIT $limit`,
      {
        ontology,
        after: query.after ?? "",
        type: query.type ?? "",
        from: query.from ?? "",
        to: query.to ?? "",
        limit: query.limit + 1,
      },
    );
    const items: GraphRelationship[] = rows.map((r) =>
      JSON.parse(String(r.record)),
    );
    return {
      items: items.slice(0, query.limit),
      nextCursor: items.length > query.limit ? items[query.limit - 1].id : null,
      limit: query.limit,
    };
  }

  async relationship(ontology: string, id: string): Promise<GraphRelationship> {
    const [row] = await this.rows(
      "MATCH (:Object {ontology:$ontology})-[r:LINK {id:$id}]->(:Object {ontology:$ontology}) RETURN r.record AS record",
      { ontology, id },
    );
    if (!row) throw new PlatformError(404, `Relationship not found: ${id}`);
    return JSON.parse(String(row.record));
  }

  async document<T>(
    kind: string,
    ontology: string,
    id: string,
  ): Promise<T | null> {
    const [row] = await this.rows(
      "MATCH (d:Document {kind:$kind,ontology:$ontology,id:$id}) RETURN d.record AS record",
      { kind, ontology, id },
    );
    return row ? JSON.parse(String(row.record)) : null;
  }

  async documents<T>(kind: string, ontology: string): Promise<T[]> {
    return (
      await this.rows(
        "MATCH (d:Document {kind:$kind,ontology:$ontology}) RETURN d.record AS record ORDER BY d.id",
        { kind, ontology },
      )
    ).map((r) => JSON.parse(String(r.record)));
  }

  async saveDocument(
    kind: string,
    ontology: string,
    id: string,
    value: unknown,
  ) {
    await this.rows(
      "MERGE (d:Document {kind:$kind,ontology:$ontology,id:$id}) SET d.record=$record",
      { kind, ontology, id, record: JSON.stringify(value) },
    );
  }

  async removeDocument(kind: string, ontology: string, id: string) {
    await this.rows(
      "MATCH (d:Document {kind:$kind,ontology:$ontology,id:$id}) DELETE d",
      { kind, ontology, id },
    );
  }

  async traverse(
    ontology: string,
    root: string,
    depth: number,
    direction: Traversal["direction"],
  ): Promise<Traversal> {
    const origin = await this.object(ontology, root);
    if (!Number.isInteger(depth) || depth < 1 || depth > 5)
      throw new PlatformError(400, "Depth must be an integer from 1 to 5");
    const pattern =
      direction === "out"
        ? `-[:LINK*1..${depth}]->`
        : direction === "in"
          ? `<-[:LINK*1..${depth}]-`
          : `-[:LINK*1..${depth}]-`;
    const rows = await this.rows(
      `MATCH p=(root:Object {ontology: $ontology, id: $root})${pattern}(target:Object {ontology: $ontology})
      UNWIND nodes(p) AS n WITH DISTINCT n RETURN n.record AS record ORDER BY n.id`,
      { ontology, root },
    );
    const objects: GraphObject[] = rows.map((r) =>
      JSON.parse(String(r.record)),
    );
    if (!objects.some((o) => o.id === root)) objects.unshift(origin);
    const ids = objects.map((o) => o.id);
    const relRows = await this.rows(
      `MATCH (a:Object {ontology: $ontology})-[r:LINK]->(b:Object {ontology: $ontology})
      WHERE a.id IN $ids AND b.id IN $ids RETURN r.record AS record ORDER BY r.id`,
      { ontology, ids },
    );
    const relationships: GraphRelationship[] = relRows.map((r) =>
      JSON.parse(String(r.record)),
    );
    return { objects, relationships, root, depth, direction };
  }
}
