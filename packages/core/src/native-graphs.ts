import { createHash, randomUUID } from "node:crypto";
import type { FalkorDB } from "falkordb";
import type { GraphSnapshot, GraphObject } from "@graph/contracts";
import { recordChanges } from "./state.js";
import { PlatformError } from "./validation.js";
type Value =
  | string
  | number
  | boolean
  | null
  | Value[]
  | { [key: string]: Value };
export type NativeBase = {
  storage: "falkordb";
  graphKey: string;
  revision: number;
};
export class NativeGraphs {
  private prefix: string;
  constructor(
    private db: FalkorDB,
    namespace: string,
  ) {
    this.prefix = `graph-native-${createHash("sha256").update(namespace).digest("hex").slice(0, 20)}-`;
  }
  private scope(ontology: string) {
    return (
      this.prefix +
      createHash("sha256").update(ontology).digest("hex").slice(0, 20) +
      "-"
    );
  }
  private check(ontology: string, key: string) {
    if (!key.startsWith(this.scope(ontology)) || !/^[a-z0-9-]+$/.test(key))
      throw new PlatformError(500, "Invalid native graph reference");
  }
  async query(
    ontology: string,
    key: string,
    query: string,
    params: Record<string, Value> = {},
  ) {
    this.check(ontology, key);
    const result = await this.db
      .selectGraph(key)
      .roQuery<Record<string, unknown>>(query, { params, TIMEOUT: 3000 });
    return result.data ?? [];
  }
  async create(ontology: string, state: GraphSnapshot) {
    const key = this.scope(ontology) + randomUUID();
    try {
      await this.db
        .selectGraph(key)
        .query("CREATE INDEX FOR (o:Object) ON (o.id)");
      await this.update(
        ontology,
        key,
        { objects: [], relationships: [] },
        state,
      );
      return key;
    } catch (error) {
      await this.remove(ontology, key).catch(() => {});
      throw error;
    }
  }
  async copy(ontology: string, source: string) {
    this.check(ontology, source);
    const key = this.scope(ontology) + randomUUID();
    try {
      await this.db.selectGraph(source).copy(key);
      return key;
    } catch (error) {
      await this.remove(ontology, key).catch(() => {});
      throw error;
    }
  }
  async snapshot(ontology: string, key: string): Promise<GraphSnapshot> {
    const objects = await this.query(
      ontology,
      key,
      "MATCH (o:Object) RETURN o.record AS record ORDER BY o.id",
    );
    const relationships = await this.query(
      ontology,
      key,
      "MATCH (:Object)-[r:LINK]->(:Object) RETURN r.record AS record ORDER BY r.id",
    );
    return {
      objects: objects.map((r) => JSON.parse(String(r.record))),
      relationships: relationships.map((r) => JSON.parse(String(r.record))),
    };
  }
  private native(o: GraphObject) {
    return {
      id: o.id,
      type: o.type,
      record: JSON.stringify(o),
      ...Object.fromEntries(
        Object.entries(o.properties).map(([k, v]) => ["p_" + k, v]),
      ),
    };
  }
  async update(
    ontology: string,
    key: string,
    before: GraphSnapshot,
    after: GraphSnapshot,
  ) {
    this.check(ontology, key);
    const objects = recordChanges(before.objects, after.objects);
    const relationships = recordChanges(
      before.relationships,
      after.relationships,
    );
    await this.db.selectGraph(key).query(
      `MATCH (:Object)-[r:LINK]->(:Object) WHERE r.id IN $removeRelationships DELETE r WITH count(*) AS n
       MATCH (o:Object) WHERE o.id IN $removeObjects DELETE o WITH count(*) AS n
       UNWIND $objects AS item MERGE (o:Object {id:item.id}) SET o=item.native WITH count(*) AS n
       UNWIND $relationships AS item MATCH (a:Object {id:item.from}),(b:Object {id:item.to}) CREATE (a)-[:LINK {id:item.id,type:item.type,record:item.record}]->(b)`,
      {
        params: {
          removeRelationships: relationships
            .filter((c) => c.before)
            .map((c) => c.id),
          removeObjects: objects.filter((c) => !c.after).map((c) => c.id),
          objects: objects.flatMap((c) =>
            c.after ? [{ id: c.id, native: this.native(c.after) }] : [],
          ),
          relationships: relationships.flatMap((c) =>
            c.after ? [{ ...c.after, record: JSON.stringify(c.after) }] : [],
          ),
        },
        TIMEOUT: 3000,
      },
    );
  }
  async remove(ontology: string, key: string) {
    this.check(ontology, key);
    if ((await this.db.list()).includes(key))
      await this.db.selectGraph(key).delete();
  }
  async collect(references: Set<string>) {
    const deleted: string[] = [];
    for (const key of await this.db.list())
      if (key.startsWith(this.prefix) && !references.has(key)) {
        await this.db.selectGraph(key).delete();
        deleted.push(key);
      }
    return deleted;
  }
  async inventory(ontology: string, references: Set<string>) {
    const keys = (await this.db.list())
      .filter((key) => key.startsWith(this.scope(ontology)))
      .sort();
    return keys.map((key) => ({ key, retained: references.has(key) }));
  }
}
