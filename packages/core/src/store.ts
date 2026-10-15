import { FalkorDB } from "falkordb";
import type {
  Ontology,
  GraphObject,
  GraphRelationship,
  GraphSnapshot,
  Ingestion,
  Traversal,
} from "@graph/contracts";
import { PlatformError, validateIngestion } from "./validation.js";

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

  private write<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pending.then(operation);
    this.pending = result.catch(() => undefined);
    return result;
  }

  async initialize() {
    for (const query of [
      "CREATE INDEX FOR (n:Ontology) ON (n.id)",
      "CREATE INDEX FOR (n:Object) ON (n.ontology, n.id)",
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
        if (String(rows[0].schema) !== JSON.stringify(ontology))
          throw new PlatformError(
            409,
            "Ontology already exists with a different schema; schema migrations are not supported yet",
          );
        return ontology;
      }
      await this.rows("CREATE (:Ontology {id: $id, schema: $schema})", {
        id: ontology.id,
        schema: JSON.stringify(ontology),
      });
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
    return this.write(async () => {
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
          RETURN count(r) AS relationships`,
          { ontology: id, objects, relationships },
        );
      } else if (objects.length) {
        await this.rows(
          "UNWIND $objects AS item MERGE (o:Object {ontology: $ontology, id: item.id}) SET o.type = item.type, o.record = item.record",
          { ontology: id, objects },
        );
      } else if (relationships.length) {
        await this.rows(
          `UNWIND $relationships AS item
          MATCH (a:Object {ontology: $ontology, id: item.from}), (b:Object {ontology: $ontology, id: item.to})
          MERGE (a)-[r:LINK {id: item.id}]->(b) SET r.type = item.type, r.record = item.record`,
          { ontology: id, relationships },
        );
      }
      return { objects: objects.length, relationships: relationships.length };
    });
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
        "MATCH (o:Object {ontology: $ontology, id: $id}) DELETE o",
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
        "MATCH (:Object {ontology: $ontology})-[r:LINK {id: $id}]->() DELETE r",
        { ontology, id },
      );
    });
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
