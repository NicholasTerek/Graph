import {
  explanationInput,
  type ExplanationInput,
  type Explanation,
  type FunctionRun,
  type Source,
  type Investigation,
  type GraphObject,
  type GraphRelationship,
} from "@graph/contracts";
import { GraphStore } from "./store.js";
import { ScenarioService } from "./scenarios.js";
import { FunctionRuntime } from "./functions.js";
import { PlatformError } from "./validation.js";
import { canonical } from "./state.js";
export function evidencePathQuery(depth: number, scoped: boolean) {
  if (!Number.isInteger(depth) || depth < 1 || depth > 5)
    throw new PlatformError(400, "Evidence depth must be 1–5");
  return `MATCH (root:Object {${scoped ? "ontology:$ontology," : ""}id:$root}),(target:Object ${scoped ? "{ontology:$ontology}" : ""})
    WHERE target.id IN $targets
    WITH target,shortestPath((root)-[:LINK*1..${depth}]->(target)) AS p
    WHERE p IS NOT NULL ${scoped ? "AND all(n IN nodes(p) WHERE n.ontology=$ontology)" : ""}
    RETURN target.id AS target,[n IN nodes(p)|n.record] AS objects,[r IN relationships(p)|r.record] AS relationships,length(p) AS hops ORDER BY target.id`;
}
export class ExplanationService {
  constructor(
    private store: GraphStore,
    private scenarios: ScenarioService,
    private functions: FunctionRuntime,
  ) {}
  async explain(
    ontology: string,
    input: ExplanationInput,
  ): Promise<Explanation> {
    const args = explanationInput.parse(input);
    return this.store.exclusive(async () => {
      await this.store.ontology(ontology);
      const run = args.runId
        ? await this.store.document<FunctionRun>("run", ontology, args.runId)
        : null;
      if (args.runId && !run)
        throw new PlatformError(404, "Calculation run not found");
      if (
        run &&
        args.scenario !== undefined &&
        args.scenario !== run.scenarioId
      )
        throw new PlatformError(
          409,
          "Explanation scenario differs from calculation context",
        );
      const scenario = run?.scenarioId ?? args.scenario ?? null;
      let branch: Awaited<ReturnType<ScenarioService["reference"]>> | null =
        null;
      if (scenario)
        try {
          branch = await this.scenarios.reference(ontology, scenario);
        } catch (error) {
          if (
            !(error instanceof PlatformError) ||
            ![404, 409, 410].includes(error.statusCode) ||
            !run
          )
            throw error;
        }
      const currentRevision = await this.store.revision(ontology);
      const claims = run ? this.functions.explain(run) : [];
      const targets = [
        ...new Set(
          args.targets.length
            ? args.targets
            : claims.flatMap((c) => c.recordIds),
        ),
      ]
        .filter((id) => id !== args.root)
        .slice(0, 16);
      const result: Explanation = {
        context: {
          ontology,
          revision: run?.revision ?? branch?.baseRevision ?? currentRevision,
          scenario,
          scenarioVersion: run?.scenarioVersion ?? branch?.version ?? null,
          currentRevision,
          currentScenarioVersion: branch?.version ?? null,
          stale:
            !!run &&
            (run.revision !== currentRevision ||
              (scenario !== null && run.scenarioVersion !== branch?.version)),
          scope: run?.evidence ? "calculation-readset" : "current-graph",
        },
        root: args.root,
        paths: [],
        records: [],
        relationships: [],
        contributors: [],
        claims,
        calculation: run ?? null,
        query: {
          engine: "falkordb",
          maxDepth: args.maxDepth,
          direction: "out",
          targets,
        },
        warnings: [],
      };
      let key: string | undefined;
      let temporary = false;
      const records = new Map<string, GraphObject>(),
        relationships = new Map<string, GraphRelationship>();
      try {
        if (run?.evidence) {
          if (!run.evidence.objects.some((o) => o.id === args.root))
            throw new PlatformError(
              422,
              "Root was not read by this calculation",
            );
          const ids = new Set(run.evidence.objects.map((o) => o.id));
          const edges = run.evidence.relationships.filter(
            (r) => ids.has(r.from) && ids.has(r.to),
          );
          key = await this.store.nativeGraphs.create(ontology, {
            objects: run.evidence.objects,
            relationships: edges,
          });
          result.contributors = run.evidence.contributors;
          for (const record of run.evidence.objects)
            records.set(record.id, record);
          for (const edge of edges) relationships.set(edge.id, edge);
          if (run.evidence.truncated)
            result.warnings.push(
              "Captured calculation evidence was truncated; missing paths are not proof of no relationship.",
            );
          result.warnings.push(
            "Paths use only the records and relationships read by this calculation, not every path in the ontology.",
          );
        } else if (run && result.context.stale) {
          result.context.scope = "unavailable";
          result.warnings.push(
            "This older run has no captured read set. Its output is retained, but current graph paths are not presented as historical evidence.",
          );
          return result;
        } else {
          if (run)
            result.warnings.push(
              "This older run has no captured read set; paths are from its still-matching current context.",
            );
          if (branch?.storage === "falkordb-overlay") {
            key = await this.store.nativeGraphs.create(
              ontology,
              await this.scenarios.readState(ontology, branch.id),
            );
            temporary = true;
          } else if (branch) key = branch.graphKey;
          const roots = key
            ? await this.store.nativeGraphs.query(
                ontology,
                key,
                "MATCH (o:Object {id:$root}) RETURN o.record AS record",
                { root: args.root },
              )
            : [
                {
                  record: JSON.stringify(
                    await this.store.object(ontology, args.root),
                  ),
                },
              ];
          if (!roots.length)
            throw new PlatformError(404, "Explanation root not found");
          const root = JSON.parse(String(roots[0].record));
          records.set(root.id, root);
        }
        const paths = targets.length
          ? key
            ? await this.store.nativeGraphs.query(
                ontology,
                key,
                evidencePathQuery(args.maxDepth, false),
                { root: args.root, targets },
              )
            : await this.store.evidencePaths(
                ontology,
                args.root,
                targets,
                args.maxDepth,
              )
          : [];
        for (const row of paths) {
          const objects: GraphObject[] = (row.objects as string[]).map(
            (value) => JSON.parse(value),
          );
          const edges: GraphRelationship[] = (
            row.relationships as string[]
          ).map((value) => JSON.parse(value));
          for (const record of objects) records.set(record.id, record);
          for (const edge of edges) relationships.set(edge.id, edge);
          result.paths.push({
            target: String(row.target),
            objects: objects.map((o) => o.id),
            relationships: edges.map((r) => r.id),
            hops: Number(row.hops),
          });
        }
        result.records = [...records.values()];
        result.relationships = [...relationships.values()];
        if (!run?.evidence)
          result.contributors = (
            await this.store.documents<Source>("source", ontology)
          ).flatMap((source) =>
            Object.entries(source.managed)
              .filter(([id]) => records.has(id))
              .map(([objectId, mapping]) => ({
                objectId,
                sourceId: source.id,
                externalId: mapping.externalId,
                fields: Object.keys(mapping.fields),
                checkpoint: source.checkpoint,
                observedAt: source.lastSyncedAt,
                values: mapping.fields,
                matches: Object.entries(mapping.fields).every(
                  ([field, value]) =>
                    canonical(records.get(objectId)?.properties[field]) ===
                    canonical(value),
                ),
              })),
          );
        const missing = targets.filter(
          (id) => !result.paths.some((p) => p.target === id),
        );
        if (missing.length)
          result.warnings.push(
            `No directed evidence path within ${args.maxDepth} hops: ${missing.join(", ")}.`,
          );
        if (result.context.stale)
          result.warnings.push(
            "The live revision or branch version has changed since this calculation; evidence describes the saved calculation context.",
          );
        return result;
      } finally {
        if ((run?.evidence || temporary) && key)
          await this.store.nativeGraphs.remove(ontology, key);
      }
    });
  }
}
