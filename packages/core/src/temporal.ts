import { randomUUID } from "node:crypto";
import type { GraphSnapshot, GraphObject } from "@graph/contracts";
import { recordChanges, validateUniqueState } from "./state.js";
import { PlatformError } from "./validation.js";
type Value =
  | null
  | string
  | number
  | boolean
  | Value[]
  | { [key: string]: Value };
type Row = Record<string, unknown>;
type Query = (query: string, params?: Record<string, Value>) => Promise<Row[]>;
export type HistoryContext = {
  generation: string;
  startRevision: number;
  revision: number;
  committedAt: string;
};
const native = (ontology: string, o: GraphObject) => ({
  ontology,
  id: o.id,
  type: o.type,
  record: JSON.stringify(o),
  ...Object.fromEntries(
    Object.entries(o.properties).map(([key, value]) => ["p_" + key, value]),
  ),
});
export class TemporalStorage {
  constructor(private query: Query) {}
  async vacuumCounts(ontology: string, generation: string, watermark: number) {
    const params = { ontology, generation, watermark };
    const [objects] = await this.query(
      "MATCH (v:ObjectVersion {ontology:$ontology}) WHERE v.generation<>$generation OR v.valid_to<=$watermark RETURN count(v) AS count",
      params,
    );
    const [edges] = await this.query(
      "MATCH (:Identity {ontology:$ontology})-[r:HISTORICAL_LINK]->(:Identity {ontology:$ontology}) WHERE r.generation<>$generation OR r.valid_to<=$watermark RETURN count(r) AS count",
      params,
    );
    const [commits] = await this.query(
      "MATCH (c:Commit {ontology:$ontology}) WHERE c.generation<>$generation OR c.revision<$watermark RETURN count(c) AS count",
      params,
    );
    return {
      objectVersions: Number(objects.count),
      relationshipVersions: Number(edges.count),
      commits: Number(commits.count),
    };
  }
  async vacuumBatch(
    ontology: string,
    generation: string,
    watermark: number,
    batchSize: number,
    audit: { id: string; actor: string; digest: string; at: string },
  ) {
    const [result] = await this.query(
      `MATCH (v:ObjectVersion {ontology:$ontology})-[link:VERSION_OF]->(:Identity {ontology:$ontology}) WHERE v.generation<>$generation OR v.valid_to<=$watermark
      WITH v,link LIMIT $limit DELETE link,v WITH count(*) AS removedObjects
      OPTIONAL MATCH (:Identity {ontology:$ontology})-[r:HISTORICAL_LINK]->(:Identity {ontology:$ontology}) WHERE r.generation<>$generation OR r.valid_to<=$watermark
      WITH removedObjects,r LIMIT $limit DELETE r WITH removedObjects,count(r) AS removedRelationships
      OPTIONAL MATCH (c:Commit {ontology:$ontology}) WHERE c.generation<>$generation OR c.revision<$watermark
      WITH removedObjects,removedRelationships,c LIMIT $limit DELETE c WITH removedObjects,removedRelationships,count(c) AS removedCommits
      MATCH (meta:Ontology {id:$ontology}) SET meta.historyStart=$watermark
      CREATE (:Document {ontology:$ontology,kind:'vacuum',id:$auditId,record:$audit})
      RETURN removedObjects,removedRelationships,removedCommits`,
      {
        ontology,
        generation,
        watermark,
        limit: batchSize,
        auditId: audit.id,
        audit: JSON.stringify({ ...audit, generation, watermark, batchSize }),
      },
    );
    if (!result)
      throw new PlatformError(500, "Vacuum did not produce an atomic result");
    return {
      objectVersions: Number(result.removedObjects),
      relationshipVersions: Number(result.removedRelationships),
      commits: Number(result.removedCommits),
    };
  }
  async initialize() {
    for (const cypher of [
      "CREATE INDEX FOR (i:Identity) ON (i.ontology,i.id)",
      "CREATE INDEX FOR (v:ObjectVersion) ON (v.ontology,v.generation,v.id,v.valid_from)",
      "CREATE INDEX FOR (c:Commit) ON (c.ontology,c.generation,c.revision,c.commitMs)",
    ])
      try {
        await this.query(cypher);
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !/^Attribute '.+' is already indexed$/.test(error.message)
        )
          throw error;
      }
  }
  async ensure(
    ontology: string,
    baseline?: GraphSnapshot,
  ): Promise<HistoryContext> {
    const [row] = await this.query(
      "MATCH (o:Ontology {id:$ontology}) RETURN o.historyGeneration AS generation,o.historyStart AS startRevision,coalesce(o.revision,0) AS revision,o.lastCommitTime AS committedAt",
      { ontology },
    );
    if (!row) throw new PlatformError(404, `Ontology not found: ${ontology}`);
    if (row.generation)
      return {
        generation: String(row.generation),
        startRevision: Number(row.startRevision),
        revision: Number(row.revision),
        committedAt: String(row.committedAt),
      };
    const state = baseline ?? {
      objects: (
        await this.query(
          "MATCH (o:Object {ontology:$ontology}) RETURN o.record AS record",
          { ontology },
        )
      ).map((r) => JSON.parse(String(r.record))),
      relationships: (
        await this.query(
          "MATCH (:Object {ontology:$ontology})-[r:LINK]->(:Object {ontology:$ontology}) RETURN r.record AS record",
          { ontology },
        )
      ).map((r) => JSON.parse(String(r.record))),
    };
    const context: HistoryContext = {
      generation: randomUUID(),
      startRevision: Number(row.revision),
      revision: Number(row.revision),
      committedAt: new Date().toISOString(),
    };
    const plan = this.build(
      ontology,
      context,
      { objects: [], relationships: [] },
      state,
      context.revision,
      false,
    );
    await this.query(plan.query, plan.params);
    return { ...context, committedAt: String(plan.params.historyTime) };
  }
  private build(
    ontology: string,
    context: HistoryContext,
    before: GraphSnapshot,
    after: GraphSnapshot,
    revision: number,
    reset: boolean,
  ) {
    const generation = reset ? randomUUID() : context.generation;
    const objects = reset
      ? after.objects.map((after) => ({ id: after.id, before: null, after }))
      : recordChanges(before.objects, after.objects);
    const relationships = reset
      ? after.relationships.map((after) => ({
          id: after.id,
          before: null,
          after,
        }))
      : recordChanges(before.relationships, after.relationships);
    const now = new Date().toISOString(),
      time = now > context.committedAt ? now : context.committedAt;
    return {
      query: `MATCH (v:ObjectVersion {ontology:$ontology,generation:$historyGeneration}) WHERE v.id IN $versionObjectIds AND v.valid_to IS NULL SET v.valid_to=$revision WITH count(*) AS closed
        MATCH (:Identity {ontology:$ontology})-[r:HISTORICAL_LINK]->(:Identity {ontology:$ontology}) WHERE r.generation=$historyGeneration AND r.id IN $versionRelationshipIds AND r.valid_to IS NULL SET r.valid_to=$revision WITH count(*) AS closed
        UNWIND $versionObjects AS item MERGE (identity:Identity {ontology:$ontology,id:item.id}) CREATE (v:ObjectVersion) SET v=item.native SET v.generation=$historyGeneration,v.valid_from=$revision CREATE (v)-[:VERSION_OF]->(identity) WITH count(*) AS written
        UNWIND $versionRelationships AS item MATCH (a:Identity {ontology:$ontology,id:item.from}),(b:Identity {ontology:$ontology,id:item.to}) CREATE (a)-[:HISTORICAL_LINK {id:item.id,type:item.type,record:item.record,generation:$historyGeneration,valid_from:$revision}]->(b) WITH count(*) AS written
        CREATE (:Commit {ontology:$ontology,generation:$historyGeneration,revision:$revision,committedAt:$historyTime,commitMs:$historyTimeMs}) WITH count(*) AS committed
        MATCH (meta:Ontology {id:$ontology}) SET meta.historyGeneration=$historyGeneration,meta.historyStart=$historyStart,meta.lastCommitTime=$historyTime`,
      params: {
        ontology,
        revision,
        historyGeneration: generation,
        historyStart: reset ? revision : context.startRevision,
        historyTime: time,
        historyTimeMs: Date.parse(time),
        versionObjectIds: objects.map((c) => c.id),
        versionRelationshipIds: relationships.map((c) => c.id),
        versionObjects: objects.flatMap((c) =>
          c.after ? [{ id: c.id, native: native(ontology, c.after) }] : [],
        ),
        versionRelationships: relationships.flatMap((c) =>
          c.after
            ? [
                {
                  id: c.id,
                  from: c.after.from,
                  to: c.after.to,
                  type: c.after.type,
                  record: JSON.stringify(c.after),
                },
              ]
            : [],
        ),
      },
    };
  }
  async plan(
    ontology: string,
    before: GraphSnapshot,
    after: GraphSnapshot,
    revision: number,
    reset = false,
  ) {
    return this.build(
      ontology,
      await this.ensure(ontology, before),
      before,
      after,
      revision,
      reset,
    );
  }
  async resolve(
    ontology: string,
    input: { revision?: number; at?: string },
  ): Promise<HistoryContext> {
    const context = await this.ensure(ontology);
    let revision = input.revision ?? context.revision;
    if (input.at) {
      const [commit] = await this.query(
        "MATCH (c:Commit {ontology:$ontology,generation:$generation}) WHERE c.commitMs<=$atMs RETURN c.revision AS revision,c.committedAt AS committedAt ORDER BY c.revision DESC LIMIT 1",
        {
          ontology,
          generation: context.generation,
          atMs: Date.parse(input.at),
        },
      );
      if (!commit)
        throw new PlatformError(
          410,
          "Requested time predates retained history",
        );
      revision = Number(commit.revision);
    }
    if (revision < context.startRevision)
      throw new PlatformError(
        410,
        "Requested revision predates retained history",
      );
    if (revision > context.revision)
      throw new PlatformError(409, "Requested revision has not committed");
    const [commit] = await this.query(
      "MATCH (c:Commit {ontology:$ontology,generation:$generation,revision:$revision}) RETURN c.committedAt AS committedAt",
      { ontology, generation: context.generation, revision },
    );
    if (!commit)
      throw new PlatformError(
        404,
        "Requested revision does not exist in this history generation",
      );
    return { ...context, revision, committedAt: String(commit.committedAt) };
  }
  async read(ontology: string, context: HistoryContext) {
    const params = {
      ontology,
      generation: context.generation,
      revision: context.revision,
    };
    const objects = (
      await this.query(
        "MATCH (v:ObjectVersion {ontology:$ontology,generation:$generation}) WHERE v.valid_from<=$revision AND (v.valid_to IS NULL OR v.valid_to>$revision) RETURN v.record AS record ORDER BY v.id",
        params,
      )
    ).map((r) => JSON.parse(String(r.record)));
    const relationships = (
      await this.query(
        "MATCH (:Identity {ontology:$ontology})-[r:HISTORICAL_LINK]->(:Identity {ontology:$ontology}) WHERE r.generation=$generation AND r.valid_from<=$revision AND (r.valid_to IS NULL OR r.valid_to>$revision) RETURN r.record AS record ORDER BY r.id",
        params,
      )
    ).map((r) => JSON.parse(String(r.record)));
    const state: GraphSnapshot = { objects, relationships };
    validateUniqueState(state);
    const ids = new Set(objects.map((o) => o.id));
    if (relationships.some((r) => !ids.has(r.from) || !ids.has(r.to)))
      throw new PlatformError(
        500,
        "Historical visibility contains a dangling relationship",
      );
    return {
      ...state,
      revision: context.revision,
      generation: context.generation,
      committedAt: context.committedAt,
      retainedFrom: context.startRevision,
    };
  }
  async commits(ontology: string, after = -1, limit = 100) {
    const context = await this.ensure(ontology);
    const rows = await this.query(
      "MATCH (c:Commit {ontology:$ontology,generation:$generation}) WHERE c.revision>$after AND c.revision>=$retainedFrom RETURN c.revision AS revision,c.committedAt AS committedAt ORDER BY c.revision LIMIT $limit",
      {
        ontology,
        generation: context.generation,
        after,
        limit,
        retainedFrom: context.startRevision,
      },
    );
    return {
      generation: context.generation,
      retainedFrom: context.startRevision,
      currentRevision: context.revision,
      items: rows.map((r) => ({
        revision: Number(r.revision),
        committedAt: String(r.committedAt),
      })),
    };
  }
  async traverse(
    ontology: string,
    context: HistoryContext,
    root: string,
    depth: number,
    direction: "out" | "in" | "both",
  ) {
    if (!Number.isInteger(depth) || depth < 1 || depth > 5)
      throw new PlatformError(400, "Historical traversal depth must be 1–5");
    const params = {
      ontology,
      generation: context.generation,
      revision: context.revision,
      root,
    };
    const visible =
      "v.valid_from<=$revision AND (v.valid_to IS NULL OR v.valid_to>$revision)";
    const [origin] = await this.query(
      `MATCH (v:ObjectVersion {ontology:$ontology,generation:$generation,id:$root}) WHERE ${visible} RETURN v.record AS record`,
      params,
    );
    if (!origin)
      throw new PlatformError(
        404,
        "Root is not visible at the requested revision",
      );
    const pattern =
      direction === "out"
        ? `-[:HISTORICAL_LINK*1..${depth}]->`
        : direction === "in"
          ? `<-[:HISTORICAL_LINK*1..${depth}]-`
          : `-[:HISTORICAL_LINK*1..${depth}]-`;
    const rows = await this.query(
      `MATCH p=(root:Identity {ontology:$ontology,id:$root})${pattern}(target:Identity {ontology:$ontology})
      WHERE all(r IN relationships(p) WHERE r.generation=$generation AND r.valid_from<=$revision AND (r.valid_to IS NULL OR r.valid_to>$revision))
      UNWIND nodes(p) AS identity WITH DISTINCT identity MATCH (v:ObjectVersion {ontology:$ontology,generation:$generation,id:identity.id}) WHERE ${visible} RETURN v.record AS record ORDER BY v.id`,
      params,
    );
    const objects: GraphObject[] = rows.map((r) =>
      JSON.parse(String(r.record)),
    );
    if (!objects.some((o) => o.id === root))
      objects.unshift(JSON.parse(String(origin.record)));
    const relationships = (
      await this.query(
        "MATCH (a:Identity {ontology:$ontology})-[r:HISTORICAL_LINK]->(b:Identity {ontology:$ontology}) WHERE a.id IN $ids AND b.id IN $ids AND r.generation=$generation AND r.valid_from<=$revision AND (r.valid_to IS NULL OR r.valid_to>$revision) RETURN r.record AS record ORDER BY r.id",
        { ...params, ids: objects.map((o) => o.id) },
      )
    ).map((r) => JSON.parse(String(r.record)));
    return {
      objects,
      relationships,
      root,
      depth,
      direction,
      revision: context.revision,
      generation: context.generation,
      committedAt: context.committedAt,
      retainedFrom: context.startRevision,
    };
  }
}
