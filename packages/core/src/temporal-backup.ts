import { randomUUID } from "node:crypto";
import type { TemporalBackup, Ontology, GraphSnapshot } from "@graph/contracts";
import { canonical } from "./state.js";
import { PlatformError, validateObject } from "./validation.js";

export function validateTemporalBackup(
  history: TemporalBackup,
  schema: Ontology,
  state: GraphSnapshot,
  revision: number,
) {
  const fail = (message: string): never => {
    throw new PlatformError(422, `Invalid temporal backup: ${message}`);
  };
  if (history.revision !== revision || history.retainedFrom > revision)
    fail("head or retention boundary mismatch");
  const commits = new Set<number>();
  let previous = -1,
    time = -Infinity;
  for (const commit of history.commits) {
    const at = Date.parse(commit.committedAt);
    if (
      commit.revision <= previous ||
      commit.revision < history.retainedFrom ||
      commit.revision > revision ||
      at < time
    )
      fail("commit order, time or bounds");
    previous = commit.revision;
    time = at;
    commits.add(commit.revision);
  }
  if (!commits.has(history.retainedFrom) || !commits.has(revision))
    fail("missing boundary commit");
  const relaxed: Ontology = {
    ...schema,
    objectTypes: schema.objectTypes.map((t) => ({
      ...t,
      properties: Object.fromEntries(
        Object.entries(t.properties).map(([k, v]) => [
          k,
          { ...v, required: false },
        ]),
      ),
    })),
  };
  type Version = {
    record: { id: string };
    validFrom: number;
    validTo: number | null;
  };
  const index = <T extends Version>(versions: T[]) => {
    const byId = new Map<string, T[]>();
    for (const version of versions) {
      if (
        version.validFrom > revision ||
        (version.validFrom >= history.retainedFrom &&
          !commits.has(version.validFrom)) ||
        (version.validTo !== null &&
          (version.validTo <= version.validFrom ||
            version.validTo <= history.retainedFrom ||
            !commits.has(version.validTo)))
      )
        fail("invalid interval boundary");
      const list = byId.get(version.record.id) ?? [];
      list.push(version);
      byId.set(version.record.id, list);
    }
    for (const list of byId.values()) {
      list.sort((a, b) => a.validFrom - b.validFrom);
      for (let i = 1; i < list.length; i++)
        if ((list[i - 1].validTo ?? Infinity) > list[i].validFrom)
          fail("overlapping identity versions");
    }
    return byId;
  };
  const objects = index(history.objects);
  index(history.relationships);
  for (const v of history.objects) validateObject(relaxed, v.record);
  for (const edge of history.relationships) {
    const type = schema.relationshipTypes.find(
      (t) => t.name === edge.record.type,
    );
    if (!type) fail("unknown relationship type");
    for (const [id, expectedType] of [
      [edge.record.from, type!.from],
      [edge.record.to, type!.to],
    ]) {
      let covered = Math.max(edge.validFrom, history.retainedFrom);
      const end = edge.validTo ?? revision + 1;
      for (const object of objects.get(id) ?? []) {
        if ((object.validTo ?? revision + 1) <= covered) continue;
        if (object.validFrom > covered || object.record.type !== expectedType)
          break;
        covered = object.validTo ?? revision + 1;
        if (covered >= end) break;
      }
      if (covered < end) fail("dangling or mistyped relationship interval");
    }
  }
  const head = <T extends Version>(versions: T[]) =>
    versions
      .filter(
        (v) =>
          v.validFrom <= revision &&
          (v.validTo === null || v.validTo > revision),
      )
      .map((v) => v.record)
      .sort((a, b) => a.id.localeCompare(b.id));
  const sorted = <T extends { id: string }>(records: T[]) =>
    [...records].sort((a, b) => a.id.localeCompare(b.id));
  if (
    canonical(head(history.objects)) !== canonical(sorted(state.objects)) ||
    canonical(head(history.relationships)) !==
      canonical(sorted(state.relationships))
  )
    fail("history head differs from operational state");
}

export function importTemporalPlan(
  ontology: string,
  history: TemporalBackup,
  revision: number,
) {
  const generation = randomUUID();
  const at = new Date(
    Math.max(Date.now(), Date.parse(history.commits.at(-1)!.committedAt)),
  ).toISOString();
  return {
    query: `UNWIND $importObjects AS item MERGE (identity:Identity {ontology:$ontology,id:item.id}) CREATE (v:ObjectVersion) SET v=item.native CREATE (v)-[:VERSION_OF]->(identity) WITH count(*) AS imported
      UNWIND $importRelationships AS item MATCH (a:Identity {ontology:$ontology,id:item.from}),(b:Identity {ontology:$ontology,id:item.to}) CREATE (a)-[r:HISTORICAL_LINK]->(b) SET r=item.native WITH count(*) AS imported
      UNWIND $importCommits AS item CREATE (c:Commit) SET c=item WITH count(*) AS imported
      MATCH (meta:Ontology {id:$ontology}) SET meta.historyGeneration=$importGeneration,meta.historyStart=$importStart,meta.lastCommitTime=$importTime`,
    params: {
      ontology,
      importGeneration: generation,
      importStart: history.retainedFrom,
      importTime: at,
      importObjects: history.objects.map((v) => ({
        id: v.record.id,
        native: {
          ontology,
          id: v.record.id,
          type: v.record.type,
          record: JSON.stringify(v.record),
          generation,
          valid_from: v.validFrom,
          ...(v.validTo === null ? {} : { valid_to: v.validTo }),
          ...Object.fromEntries(
            Object.entries(v.record.properties).map(([k, value]) => [
              "p_" + k,
              value,
            ]),
          ),
        },
      })),
      importRelationships: history.relationships.map((v) => ({
        from: v.record.from,
        to: v.record.to,
        native: {
          id: v.record.id,
          type: v.record.type,
          record: JSON.stringify(v.record),
          generation,
          valid_from: v.validFrom,
          ...(v.validTo === null ? {} : { valid_to: v.validTo }),
        },
      })),
      importCommits: [...history.commits, { revision, committedAt: at }].map(
        (c) => ({
          ontology,
          generation,
          revision: c.revision,
          committedAt: c.committedAt,
          commitMs: Date.parse(c.committedAt),
        }),
      ),
    },
  };
}
