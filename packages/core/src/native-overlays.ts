import type { GraphObject, GraphSnapshot, Scenario } from "@graph/contracts";
import { recordChanges, validateUniqueState } from "./state.js";
import { PlatformError } from "./validation.js";
type Value =
  | null
  | string
  | number
  | boolean
  | Value[]
  | { [key: string]: Value };
type Query = (
  query: string,
  params?: Record<string, Value>,
) => Promise<Record<string, unknown>[]>;
const scope = (branch: Scenario) => ({
  ontology: branch.ontology,
  scenario: branch.id,
  generation: branch.historyGeneration!,
  revision: branch.baseRevision,
});
const object = (o: GraphObject) => ({
  id: o.id,
  type: o.type,
  deleted: false,
  record: JSON.stringify(o),
  ...Object.fromEntries(
    Object.entries(o.properties).map(([k, v]) => ["p_" + k, v]),
  ),
});
/** Native deltas, not serialized whole-graph overlays. Calls are coordinated by the single API writer. */
export class NativeOverlays {
  constructor(private query: Query) {}
  async initialize() {
    for (const label of ["BranchObject", "BranchRelationship"])
      try {
        await this.query(
          `CREATE INDEX FOR (n:${label}) ON (n.ontology,n.scenario,n.id)`,
        );
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !/^Attribute '.+' is already indexed$/.test(error.message)
        )
          throw error;
      }
  }
  async read(branch: Scenario): Promise<GraphSnapshot> {
    const params = scope(branch);
    const objects = (
      await this.query(
        `MATCH (s:BranchObject {ontology:$ontology,scenario:$scenario}) WITH collect(s.id) AS shadowed
      MATCH (v:ObjectVersion {ontology:$ontology,generation:$generation}) WHERE v.valid_from<=$revision AND (v.valid_to IS NULL OR v.valid_to>$revision) AND NOT v.id IN shadowed RETURN v.record AS record
      UNION ALL MATCH (s:BranchObject {ontology:$ontology,scenario:$scenario}) WHERE s.deleted=false RETURN s.record AS record`,
        params,
      )
    ).map((r) => JSON.parse(String(r.record)));
    const relationships = (
      await this.query(
        `MATCH (s:BranchRelationship {ontology:$ontology,scenario:$scenario}) WITH collect(s.id) AS shadowed
      MATCH (:Identity {ontology:$ontology})-[r:HISTORICAL_LINK]->(:Identity {ontology:$ontology}) WHERE r.generation=$generation AND r.valid_from<=$revision AND (r.valid_to IS NULL OR r.valid_to>$revision) AND NOT r.id IN shadowed RETURN r.record AS record
      UNION ALL MATCH (:Identity {ontology:$ontology})-[r:BRANCH_LINK]->(:Identity {ontology:$ontology}) WHERE r.scenario=$scenario RETURN r.record AS record`,
        params,
      )
    ).map((r) => JSON.parse(String(r.record)));
    const state: GraphSnapshot = {
      objects: objects.sort((a, b) => a.id.localeCompare(b.id)),
      relationships: relationships.sort((a, b) => a.id.localeCompare(b.id)),
    };
    validateUniqueState(state);
    const ids = new Set(objects.map((o) => o.id));
    if (relationships.some((r) => !ids.has(r.from) || !ids.has(r.to)))
      throw new PlatformError(
        500,
        "Overlay visibility contains a dangling relationship",
      );
    return state;
  }
  async publish(branch: Scenario, before: GraphSnapshot, after: GraphSnapshot) {
    const objects = recordChanges(before.objects, after.objects),
      relationships = recordChanges(before.relationships, after.relationships);
    await this.query(
      `MATCH (s:BranchObject {ontology:$ontology,scenario:$scenario}) WHERE s.id IN $objectIds DELETE s WITH count(*) AS removed
      MATCH (s:BranchRelationship {ontology:$ontology,scenario:$scenario}) WHERE s.id IN $relationshipIds DELETE s WITH count(*) AS removed
      MATCH (:Identity {ontology:$ontology})-[r:BRANCH_LINK]->(:Identity {ontology:$ontology}) WHERE r.scenario=$scenario AND r.id IN $relationshipIds DELETE r WITH count(*) AS removed
      UNWIND $objects AS item CREATE (s:BranchObject) SET s=item SET s.ontology=$ontology,s.scenario=$scenario WITH count(*) AS written
      UNWIND $relationships AS item CREATE (:BranchRelationship {ontology:$ontology,scenario:$scenario,id:item.id,deleted:item.deleted}) WITH count(*) AS written
      UNWIND $links AS item MERGE (a:Identity {ontology:$ontology,id:item.from}) MERGE (b:Identity {ontology:$ontology,id:item.to}) CREATE (a)-[:BRANCH_LINK {scenario:$scenario,id:item.id,type:item.type,record:item.record}]->(b) WITH count(*) AS written
      MERGE (d:Document {ontology:$ontology,kind:'scenario',id:$scenario}) SET d.record=$record`,
      {
        ...scope(branch),
        record: JSON.stringify(branch),
        objectIds: objects.map((c) => c.id),
        relationshipIds: relationships.map((c) => c.id),
        objects: objects.map((c) =>
          c.after ? object(c.after) : { id: c.id, deleted: true },
        ),
        relationships: relationships.map((c) => ({
          id: c.id,
          deleted: !c.after,
        })),
        links: relationships.flatMap((c) =>
          c.after ? [{ ...c.after, record: JSON.stringify(c.after) }] : [],
        ),
      },
    );
  }
  async discard(ontology: string, scenario: string) {
    await this.query(
      `MATCH (s:BranchObject {ontology:$ontology,scenario:$scenario}) DELETE s WITH count(*) AS removed
      MATCH (s:BranchRelationship {ontology:$ontology,scenario:$scenario}) DELETE s WITH count(*) AS removed
      MATCH (:Identity {ontology:$ontology})-[r:BRANCH_LINK]->(:Identity {ontology:$ontology}) WHERE r.scenario=$scenario DELETE r WITH count(*) AS removed
      MATCH (d:Document {ontology:$ontology,kind:'scenario',id:$scenario}) DELETE d`,
      { ontology, scenario },
    );
  }
  async collect(ontology: string, scenarios: string[]) {
    await this.query(
      `MATCH (s:BranchObject {ontology:$ontology}) WHERE NOT s.scenario IN $scenarios DELETE s WITH count(*) AS removed
      MATCH (s:BranchRelationship {ontology:$ontology}) WHERE NOT s.scenario IN $scenarios DELETE s WITH count(*) AS removed
      MATCH (:Identity {ontology:$ontology})-[r:BRANCH_LINK]->(:Identity {ontology:$ontology}) WHERE NOT r.scenario IN $scenarios DELETE r`,
      { ontology, scenarios },
    );
  }
}
