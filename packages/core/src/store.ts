import { canonical, recordChanges, validateUniqueState } from "./state.js";
import { FalkorDB } from "falkordb";
import { NativeOverlays } from "./native-overlays.js";
import { NativeGraphs } from "./native-graphs.js";
import { evidencePathQuery } from "./explanations.js";
import { TemporalStorage } from "./temporal.js";
import type {
  Ontology,
  GraphObject,
  GraphRelationship,
  GraphSnapshot,
  Ingestion,
  Traversal,
  GraphState,
  Page,
  ObjectQuery,
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
  readonly nativeGraphs: NativeGraphs;
  readonly nativeOverlays: NativeOverlays;
  readonly temporal: TemporalStorage;
  private graph;
  private pending: Promise<unknown> = Promise.resolve();
  constructor(
    private db: FalkorDB,
    name: string,
  ) {
    this.graph = db.selectGraph(name);
    this.nativeGraphs = new NativeGraphs(db, name);
    this.nativeOverlays = new NativeOverlays((query, params) =>
      this.rows(query, params),
    );
    this.temporal = new TemporalStorage((query, params) =>
      this.rows(query, params),
    );
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
    await this.temporal.initialize();
    await this.nativeOverlays.initialize();
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

  async backfillNativeProperties() {
    const rows = await this.rows(
      "MATCH (o:Object) WHERE o.search IS NULL RETURN o.record AS record, o.ontology AS ontology",
    );
    if (rows.length)
      await this.rows(
        "UNWIND $items AS item MATCH (o:Object {ontology:item.ontology,id:item.id}) SET o=item.native",
        {
          items: rows.map((row) => {
            const object = JSON.parse(String(row.record));
            return {
              ontology: String(row.ontology),
              id: object.id,
              native: {
                ...this.native(object),
                ontology: String(row.ontology),
              },
            };
          }),
        },
      );
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
        if (String(rows[0].schema) !== JSON.stringify(ontology)) {
          const before = await this.snapshot(ontology.id);
          const revision = (await this.revision(ontology.id)) + 1;
          const history = await this.temporal.plan(
            ontology.id,
            before,
            before,
            revision,
          );
          await this.rows(
            `MATCH (o:Ontology {id:$id}) SET o.schema=$schema,o.revision=$revision WITH count(*) AS changed ${history.query}`,
            {
              ...history.params,
              id: ontology.id,
              schema: JSON.stringify(ontology),
            },
          );
        }
        return ontology;
      }
      await this.rows(
        "CREATE (:Ontology {id: $id, schema: $schema, revision: 0})",
        {
          id: ontology.id,
          schema: JSON.stringify(ontology),
        },
      );
      await this.temporal.ensure(ontology.id, {
        objects: [],
        relationships: [],
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
    return this.write(() => this.ingestUnlocked(id, input));
  }

  private async ingestUnlocked(id: string, input: Ingestion) {
    const schema = await this.ontology(id);
    const before = await this.snapshot(id);
    validateIngestion(schema, before, input);
    const objects = new Map(before.objects.map((o) => [o.id, o]));
    const relationships = new Map(before.relationships.map((r) => [r.id, r]));
    for (const object of input.objects) objects.set(object.id, object);
    for (const relationship of input.relationships)
      relationships.set(relationship.id, relationship);
    await this.commitState(id, before, {
      objects: [...objects.values()],
      relationships: [...relationships.values()],
    });
    return {
      objects: input.objects.length,
      relationships: input.relationships.length,
    };
  }

  async transact<T>(
    ontology: string,
    expectedRevision: number | undefined,
    operation: (
      state: GraphState,
      schema: Ontology,
    ) =>
      | Promise<{
          state: GraphSnapshot;
          documents?: DocumentWrite[];
          removeDocuments?: DocumentKey[];
          revisionFloor?: number;
          result: T;
        }>
      | {
          state: GraphSnapshot;
          documents?: DocumentWrite[];
          removeDocuments?: DocumentKey[];
          revisionFloor?: number;
          result: T;
        },
  ) {
    return this.write(async () => {
      const revision = await this.revision(ontology);
      if (expectedRevision !== undefined && expectedRevision !== revision)
        throw new PlatformError(
          409,
          `Revision conflict: expected ${expectedRevision}, current ${revision}`,
        );
      const before = await this.snapshot(ontology);
      const schema = await this.ontology(ontology);
      const plan = await operation(
        { ...structuredClone(before), revision },
        schema,
      );
      validateUniqueState(plan.state);
      validateIngestion(schema, { objects: [], relationships: [] }, plan.state);
      const nextRevision = await this.commitState(
        ontology,
        before,
        plan.state,
        plan.documents,
        plan.removeDocuments,
        plan.revisionFloor,
      );
      return { revision: nextRevision, result: plan.result };
    });
  }

  private native(object: GraphObject) {
    return {
      ontology: "",
      id: object.id,
      type: object.type,
      record: JSON.stringify(object),
      search: [object.id, object.type, ...Object.values(object.properties)]
        .join(" ")
        .toLowerCase(),
      ...Object.fromEntries(
        Object.entries(object.properties).map(([key, value]) => [
          "p_" + key,
          value,
        ]),
      ),
    };
  }

  private async commitState(
    ontology: string,
    before: GraphSnapshot,
    after: GraphSnapshot,
    documents: DocumentWrite[] = [],
    removeDocuments: DocumentKey[] = [],
    revisionFloor?: number,
  ) {
    const objects = recordChanges(before.objects, after.objects);
    const relationships = recordChanges(
      before.relationships,
      after.relationships,
    );
    const revision = await this.revision(ontology);
    const next =
      Math.max(revision, revisionFloor ?? revision) +
      (objects.length || relationships.length ? 1 : 0);
    const now = new Date().toISOString();
    const history = [
      ...objects.map((change) => ({ kind: "object", change })),
      ...relationships.map((change) => ({ kind: "relationship", change })),
    ].map(({ kind, change }) => ({
      kind: "history",
      id: `${next}-${kind}-${change.id}`,
      value: {
        recordId: change.id,
        kind,
        revision: next,
        operation: change.kind,
        before: change.before,
        after: change.after,
        recordedAt: now,
      },
    }));
    const saved = [...history, ...documents].map((d) => ({
      kind: d.kind,
      id: d.id,
      record: JSON.stringify(d.value),
    }));
    const upsertObjects = objects.flatMap((change) =>
      change.after
        ? [
            {
              id: change.id,
              native: { ...this.native(change.after), ontology },
            },
          ]
        : [],
    );
    const upsertRelationships = relationships.flatMap((change) =>
      change.after
        ? [{ ...change.after, record: JSON.stringify(change.after) }]
        : [],
    );
    const removeRelationships = relationships
      .filter((change) => change.before)
      .map((change) => change.id);
    const removeObjects = objects
      .filter((change) => !change.after)
      .map((change) => change.id);
    if (
      !objects.length &&
      !relationships.length &&
      !saved.length &&
      !removeDocuments.length &&
      revisionFloor === undefined
    )
      return revision;
    const versioned =
      objects.length || relationships.length || revisionFloor !== undefined
        ? await this.temporal.plan(
            ontology,
            before,
            after,
            next,
            revisionFloor !== undefined,
          )
        : null;
    await this.rows(
      `MATCH (:Object {ontology:$ontology})-[r:LINK]->(:Object {ontology:$ontology}) WHERE r.id IN $removeRelationships DELETE r WITH count(*) AS removed
      MATCH (o:Object {ontology:$ontology}) WHERE o.id IN $removeObjects DELETE o WITH count(*) AS removed
      UNWIND $objects AS item MERGE (o:Object {ontology:$ontology,id:item.id}) SET o = item.native WITH count(*) AS written
      UNWIND $relationships AS item MATCH (a:Object {ontology:$ontology,id:item.from}),(b:Object {ontology:$ontology,id:item.to}) CREATE (a)-[:LINK {id:item.id,type:item.type,record:item.record}]->(b) WITH count(*) AS written
      MATCH (d:Document {ontology:$ontology}) WHERE any(item IN $removeDocuments WHERE item.kind=d.kind AND item.id=d.id) DELETE d WITH count(*) AS removed
      UNWIND $documents AS item MERGE (d:Document {ontology:$ontology,kind:item.kind,id:item.id}) SET d.record=item.record WITH count(*) AS written
      ${versioned ? versioned.query + " WITH count(*) AS versioned" : ""}
      MATCH (meta:Ontology {id:$ontology}) SET meta.revision=$revision`,
      {
        ...versioned?.params,
        ontology,
        removeRelationships,
        removeObjects,
        objects: upsertObjects,
        relationships: upsertRelationships,
        documents: saved,
        removeDocuments,
        revision: next,
      },
    );
    return next;
  }

  async history(ontology: string, id: string, kind = "object") {
    await this.ontology(ontology);
    return (await this.documents<RecordHistory>("history", ontology))
      .filter((h) => h.recordId === id && h.kind === kind)
      .sort((a, b) => a.revision - b.revision);
  }
  async evidencePaths(
    ontology: string,
    root: string,
    targets: string[],
    maxDepth: number,
  ) {
    return this.rows(evidencePathQuery(maxDepth, true), {
      ontology,
      root,
      targets,
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
    await this.transact(ontology, undefined, (state) => {
      if (!state.objects.some((o) => o.id === id))
        throw new PlatformError(404, `Object not found: ${id}`);
      if (state.relationships.some((r) => r.from === id || r.to === id))
        throw new PlatformError(
          409,
          "Remove relationships before deleting this object",
        );
      return {
        state: {
          objects: state.objects.filter((o) => o.id !== id),
          relationships: state.relationships,
        },
        result: undefined,
      };
    });
  }
  async deleteRelationship(ontology: string, id: string) {
    await this.transact(ontology, undefined, (state) => {
      if (!state.relationships.some((r) => r.id === id))
        throw new PlatformError(404, `Relationship not found: ${id}`);
      return {
        state: {
          objects: state.objects,
          relationships: state.relationships.filter((r) => r.id !== id),
        },
        result: undefined,
      };
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

  private objectPredicates(
    schema: Ontology,
    input: Pick<ObjectQuery, "type" | "after" | "filters">,
  ) {
    const params: Record<string, QueryValue> = {
      ontology: schema.id,
      type: input.type ?? "",
      after: input.after ?? "",
    };
    const predicates = [
      "($type='' OR o.type=$type)",
      "($after='' OR o.id>$after)",
    ];
    for (const [index, filter] of input.filters.entries()) {
      if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(filter.property))
        throw new PlatformError(400, "Invalid property name");
      const definitions = schema.objectTypes
        .filter((t) => !input.type || t.name === input.type)
        .map((t) => t.properties[filter.property])
        .filter(Boolean);
      if (!definitions.length)
        throw new PlatformError(422, `Unknown property ${filter.property}`);
      if (definitions.some((d) => d.type !== typeof filter.value))
        throw new PlatformError(
          422,
          `Filter value has the wrong type for ${filter.property}`,
        );
      const property = "o.`p_" + filter.property + "`";
      const key = "value" + index;
      params[key] = filter.value;
      const operators = {
        eq: "=",
        ne: "<>",
        gt: ">",
        gte: ">=",
        lt: "<",
        lte: "<=",
      };
      if (filter.operator === "contains") {
        if (typeof filter.value !== "string")
          throw new PlatformError(422, "contains requires a string");
        predicates.push(`toLower(${property}) CONTAINS toLower($${key})`);
      } else {
        if (
          !["eq", "ne"].includes(filter.operator) &&
          typeof filter.value !== "number"
        )
          throw new PlatformError(422, "Range predicates require numbers");
        predicates.push(`${property} ${operators[filter.operator]} $${key}`);
      }
    }
    return { params, predicates };
  }

  async queryObjects(ontology: string, input: ObjectQuery) {
    const schema = await this.ontology(ontology);
    const { params, predicates } = this.objectPredicates(schema, input);
    const rows = await this.rows(
      `MATCH (o:Object {ontology:$ontology}) WHERE ${predicates.join(" AND ")} RETURN o.record AS record ORDER BY o.id LIMIT $limit`,
      { ...params, limit: input.limit + 1 },
    );
    const items: GraphObject[] = rows.map((row) =>
      JSON.parse(String(row.record)),
    );
    return {
      items: items.slice(0, input.limit),
      nextCursor: items.length > input.limit ? items[input.limit - 1].id : null,
      limit: input.limit,
    };
  }
  async aggregate(
    ontology: string,
    input: {
      type: string;
      property?: string;
      operation: "count" | "sum" | "avg" | "min" | "max";
      filters: ObjectQuery["filters"];
    },
  ) {
    const schema = await this.ontology(ontology);
    const type = schema.objectTypes.find((t) => t.name === input.type);
    if (!type) throw new PlatformError(422, "Unknown object type");
    if (
      input.operation !== "count" &&
      (!input.property || type.properties[input.property]?.type !== "number")
    )
      throw new PlatformError(
        422,
        "Numeric aggregation requires a numeric property",
      );
    const { params, predicates } = this.objectPredicates(schema, input);
    if (!["count", "sum", "avg", "min", "max"].includes(input.operation))
      throw new PlatformError(400, "Unknown aggregation operation");
    const expression =
      input.operation === "count"
        ? "count(o)"
        : `${input.operation}(o.\`p_${input.property}\`)`;
    const numericCount =
      input.operation === "count"
        ? "count(o)"
        : `count(o.\`p_${input.property}\`)`;
    const [row] = await this.rows(
      `MATCH (o:Object {ontology:$ontology}) WHERE ${predicates.join(" AND ")} RETURN count(o) AS count, ${numericCount} AS numericCount, ${expression} AS value`,
      params,
    );
    return {
      operation: input.operation,
      property: input.property ?? null,
      count: Number(row.count),
      value:
        input.operation !== "count" && Number(row.numericCount) === 0
          ? null
          : Number(row.value),
    };
  }

  async createPropertyIndex(ontology: string, type: string, property: string) {
    const schema = await this.ontology(ontology);
    if (!schema.objectTypes.find((t) => t.name === type)?.properties[property])
      throw new PlatformError(422, "Unknown type/property");
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(property))
      throw new PlatformError(400, "Invalid property");
    try {
      await this.graph.query(
        "CREATE INDEX FOR (o:Object) ON (o.`p_" + property + "`)",
      );
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !error.message.includes("already indexed")
      )
        throw error;
    }
    return { ontology, type, property, indexed: true };
  }

  async relationship(ontology: string, id: string): Promise<GraphRelationship> {
    const [row] = await this.rows(
      "MATCH (:Object {ontology:$ontology})-[r:LINK {id:$id}]->(:Object {ontology:$ontology}) RETURN r.record AS record",
      { ontology, id },
    );
    if (!row) throw new PlatformError(404, `Relationship not found: ${id}`);
    return JSON.parse(String(row.record));
  }

  async documentEntries(
    kind: string,
    ontology: string,
  ): Promise<{ id: string; value: unknown }[]> {
    return (
      await this.rows(
        "MATCH (d:Document {kind:$kind,ontology:$ontology}) RETURN d.id AS id,d.record AS record ORDER BY d.id",
        { kind, ontology },
      )
    ).map((r) => ({ id: String(r.id), value: JSON.parse(String(r.record)) }));
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

export type DocumentWrite = { kind: string; id: string; value: unknown };
export type DocumentKey = { kind: string; id: string };
export type RecordHistory = {
  recordId: string;
  kind: string;
  revision: number;
  operation: string;
  before: GraphObject | GraphRelationship | null;
  after: GraphObject | GraphRelationship | null;
  recordedAt: string;
};
