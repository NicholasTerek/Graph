import {
  algorithmInput,
  type AlgorithmInput,
  type AlgorithmResult,
} from "@graph/contracts";
import { GraphStore } from "./store.js";
import { ScenarioService } from "./scenarios.js";
import { PlatformError } from "./validation.js";
export const graphAlgorithms = [
  {
    id: "shortest-path",
    description:
      "Unweighted native shortest path, bounded to at most 20 hops. Returns one path, not scheduling criticality.",
  },
  {
    id: "pagerank",
    description:
      "Native directed PageRank over all business LINK edges. Scores measure topology, not operational risk.",
  },
  {
    id: "betweenness",
    description:
      "Native sampled betweenness centrality over business LINK edges, with explicit seed and sampling budget.",
  },
  {
    id: "degree",
    description:
      "Native indegree/outdegree counts; direction controls which counts contribute.",
  },
];
export class AlgorithmService {
  constructor(
    private store: GraphStore,
    private scenarios: ScenarioService,
  ) {}
  async run(ontology: string, input: AlgorithmInput): Promise<AlgorithmResult> {
    const args = algorithmInput.parse(input);
    return this.store.exclusive(async () => {
      let graphKey: string;
      let revision: number;
      let scenarioVersion: number | null = null;
      if (args.scenario) {
        const branch = await this.scenarios.reference(ontology, args.scenario);
        graphKey = branch.graphKey!;
        revision = branch.baseRevision;
        scenarioVersion = branch.version;
      } else {
        await this.store.ontology(ontology);
        revision = await this.store.revision(ontology);
        const state = await this.store.snapshot(ontology);
        if (state.objects.length > 10000 || state.relationships.length > 50000)
          throw new PlatformError(
            422,
            "Algorithm graph exceeds the 10k-object/50k-edge budget",
          );
        graphKey = await this.store.nativeGraphs.create(ontology, state);
      }
      const query = (q: string, params: Record<string, string | number> = {}) =>
        this.store.nativeGraphs.query(ontology, graphKey, q, params);
      try {
        const counts = await query(
          "MATCH (o:Object) WITH count(o) AS nodes OPTIONAL MATCH (:Object)-[r:LINK]->(:Object) RETURN nodes,count(r) AS edges",
        );
        if (
          Number(counts[0]?.nodes) > 10000 ||
          Number(counts[0]?.edges) > 50000
        )
          throw new PlatformError(
            422,
            "Algorithm graph exceeds the 10k-object/50k-edge budget",
          );
        const result: AlgorithmResult = {
          algorithm: args.algorithm,
          engine: "falkordb",
          ontology,
          revision,
          scenario: args.scenario ?? null,
          scenarioVersion,
          rows: [],
          path: null,
          parameters: {
            maxDepth: args.maxDepth,
            direction: args.direction,
            samplingSize: args.samplingSize,
            samplingSeed: args.samplingSeed,
          },
        };
        if (
          Number(counts[0]?.nodes) === 0 &&
          args.algorithm !== "shortest-path"
        )
          return result;
        if (args.algorithm === "shortest-path") {
          const endpoints = await query(
            "MATCH (o:Object) WHERE o.id=$source OR o.id=$target RETURN o.id AS id",
            { source: args.source!, target: args.target! },
          );
          if (
            !endpoints.some((r) => r.id === args.source) ||
            !endpoints.some((r) => r.id === args.target)
          )
            throw new PlatformError(404, "Shortest-path endpoint not found");
          if (args.source === args.target) {
            result.path = {
              objects: [args.source!],
              relationships: [],
              hops: 0,
            };
            return result;
          }
          const pattern =
            args.direction === "out"
              ? `-[:LINK*1..${args.maxDepth}]->`
              : args.direction === "in"
                ? `<-[:LINK*1..${args.maxDepth}]-`
                : `-[:LINK*1..${args.maxDepth}]-`;
          const rows = await query(
            `MATCH (a:Object {id:$source}),(b:Object {id:$target}) WITH shortestPath((a)${pattern}(b)) AS p RETURN [n IN nodes(p)|n.id] AS objects,[r IN relationships(p)|r.id] AS relationships,length(p) AS hops`,
            { source: args.source!, target: args.target! },
          );
          if (rows[0]?.hops !== null && rows[0]?.hops !== undefined)
            result.path = rows[0] as AlgorithmResult["path"];
        } else {
          const cypher =
            args.algorithm === "pagerank"
              ? "CALL algo.pageRank('Object','LINK') YIELD node,score RETURN node.id AS id,score ORDER BY score DESC,id LIMIT $limit"
              : args.algorithm === "betweenness"
                ? "CALL algo.betweenness({nodeLabels:['Object'],relationshipTypes:['LINK'],samplingSize:$samplingSize,samplingSeed:$samplingSeed}) YIELD node,score RETURN node.id AS id,score ORDER BY score DESC,id LIMIT $limit"
                : `MATCH (node:Object) RETURN node.id AS id,${args.direction === "in" ? "indegree(node,'LINK')" : args.direction === "out" ? "outdegree(node,'LINK')" : "indegree(node,'LINK')+outdegree(node,'LINK')"} AS score ORDER BY score DESC,id LIMIT $limit`;
          result.rows = (
            await query(cypher, {
              limit: args.limit,
              samplingSize: args.samplingSize,
              samplingSeed: args.samplingSeed,
            })
          ).map((r) => ({ id: String(r.id), score: Number(r.score) }));
        }
        return result;
      } finally {
        if (!args.scenario)
          await this.store.nativeGraphs.remove(ontology, graphKey);
      }
    });
  }
}
