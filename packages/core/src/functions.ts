import { randomUUID } from "node:crypto";
import { z } from "zod";
import type {
  GraphObject,
  GraphSnapshot,
  FunctionInfo,
  FunctionRun,
  GraphRelationship,
  ExplanationClaim,
  Source,
  HistoricalInput,
} from "@graph/contracts";
import { GraphStore } from "./store.js";
import { ScenarioService } from "./scenarios.js";
import { PlatformError } from "./validation.js";
import { canonical } from "./state.js";
import { SnapshotService } from "./snapshots.js";
import {
  dependencyScopeSchema,
  type DependencyScope,
} from "./dependency-slice.js";

export class GraphView {
  private graph: GraphSnapshot;
  private byId = new Map<string, GraphObject>();
  private byType = new Map<string, GraphObject[]>();
  private outgoing = new Map<string, Map<string, GraphRelationship[]>>();
  private incoming = new Map<string, Map<string, GraphRelationship[]>>();
  private readObjects = new Map<string, GraphObject>();
  private readRelationships = new Map<string, GraphRelationship>();
  constructor(graph: GraphSnapshot) {
    this.graph = structuredClone(graph);
    for (const object of this.graph.objects) {
      this.byId.set(object.id, object);
      const objects = this.byType.get(object.type) ?? [];
      objects.push(object);
      this.byType.set(object.type, objects);
    }
    for (const edge of this.graph.relationships) {
      for (const [index, id] of [
        [this.outgoing, edge.from],
        [this.incoming, edge.to],
      ] as const) {
        const types = index.get(id) ?? new Map<string, GraphRelationship[]>();
        const edges = types.get(edge.type) ?? [];
        edges.push(edge);
        types.set(edge.type, edges);
        index.set(id, types);
      }
    }
  }
  object(id: string): GraphObject {
    const object = this.byId.get(id);
    if (!object)
      throw new PlatformError(422, `Required object not found: ${id}`);
    this.readObjects.set(object.id, object);
    return structuredClone(object);
  }
  related(
    id: string,
    type: string,
    direction: "out" | "in" = "out",
  ): GraphObject[] {
    const matched =
      (direction === "out" ? this.outgoing : this.incoming)
        .get(id)
        ?.get(type) ?? [];
    for (const relationship of matched)
      this.readRelationships.set(relationship.id, relationship);
    const origin = this.byId.get(id);
    if (origin) this.readObjects.set(origin.id, origin);
    const ids = matched.map((r) => (direction === "out" ? r.to : r.from));
    return ids.map((id) => this.object(id));
  }
  objects(type?: string): GraphObject[] {
    const records = type ? (this.byType.get(type) ?? []) : this.graph.objects;
    for (const object of records) this.readObjects.set(object.id, object);
    return structuredClone(records);
  }
  evidence() {
    return structuredClone({
      objects: [...this.readObjects.values()].slice(0, 2000),
      relationships: [...this.readRelationships.values()].slice(0, 5000),
      truncated:
        this.readObjects.size > 2000 || this.readRelationships.size > 5000,
    });
  }
}
export type FunctionContext = {
  graph: GraphView;
  revision: number;
  scenarioId: string | null;
};
export type FunctionDefinition<I = unknown, O = unknown> = {
  id: string;
  name: string;
  description: string;
  ontology: string;
  input: z.ZodType<I>;
  output: z.ZodType<O>;
  scope?: (input: I) => DependencyScope;
  execute: (context: FunctionContext, input: I) => O | Promise<O>;
  explain?: (output: O) => ExplanationClaim[];
};
export function defineFunction<I, O>(
  definition: FunctionDefinition<I, O>,
): FunctionDefinition {
  return {
    ...definition,
    execute: (context, input) =>
      definition.execute(context, definition.input.parse(input)),
    scope: definition.scope
      ? (input) => definition.scope!(definition.input.parse(input))
      : undefined,
    explain: definition.explain
      ? (output) => definition.explain!(definition.output.parse(output))
      : undefined,
  };
}
export class FunctionRuntime {
  private definitions = new Map<string, FunctionDefinition>();
  constructor(
    private store: GraphStore,
    private scenarios: ScenarioService,
    definitions: FunctionDefinition[],
  ) {
    for (const definition of definitions) {
      const key = `${definition.ontology}/${definition.id}`;
      if (this.definitions.has(key))
        throw new Error(`Duplicate function ${key}`);
      this.definitions.set(key, definition);
    }
  }
  list(ontology: string): FunctionInfo[] {
    return [...this.definitions.values()]
      .filter((d) => d.ontology === ontology)
      .map((d) => ({
        id: d.id,
        name: d.name,
        description: d.description,
        ontology: d.ontology,
        inputSchema: z.toJSONSchema(d.input) as Record<string, unknown>,
        outputSchema: z.toJSONSchema(d.output) as Record<string, unknown>,
      }));
  }
  explain(run: FunctionRun): ExplanationClaim[] {
    return (
      run.explanation ??
      this.definitions
        .get(`${run.ontology}/${run.functionId}`)
        ?.explain?.(run.output) ??
      []
    );
  }
  async run(
    ontology: string,
    id: string,
    input: unknown,
    scenarioId?: string,
    history?: HistoricalInput,
    principal = "local-owner",
  ): Promise<FunctionRun> {
    const definition = this.definitions.get(`${ontology}/${id}`);
    if (!definition) throw new PlatformError(404, `Function not found: ${id}`);
    const parsed = definition.input.parse(input);
    const scope = definition.scope
      ? dependencyScopeSchema.parse(definition.scope(parsed))
      : undefined;
    if (scenarioId && history)
      throw new PlatformError(
        400,
        "Select scenario or history context, not both",
      );
    const { state, sources, capturedAt } = await this.store.exclusive(
      async () => {
        const context = history
          ? await new SnapshotService(this.store).resolve(
              ontology,
              history,
              principal,
            )
          : undefined;
        const state = context
          ? scope
            ? await this.store.temporal.traverse(
                ontology,
                context,
                scope.root,
                scope.depth,
                scope.direction,
              )
            : await this.store.temporal.read(ontology, context)
          : scenarioId
            ? await this.scenarios.readState(ontology, scenarioId, scope)
            : {
                ...(scope
                  ? await this.store.traverse(
                      ontology,
                      scope.root,
                      scope.depth,
                      scope.direction,
                    )
                  : await this.store.snapshot(ontology)),
                revision: await this.store.revision(ontology),
              };
        const current = history
          ? await this.store.temporal.ensure(ontology)
          : null;
        const currentSourceContext =
          !history ||
          (current?.revision === state.revision &&
            "generation" in state &&
            current.generation === state.generation);
        return {
          state,
          sources: currentSourceContext
            ? await this.store.documents<Source>("source", ontology)
            : [],
          capturedAt: new Date().toISOString(),
        };
      },
    );
    const graph = new GraphView(state);
    let calculated: unknown;
    try {
      calculated = await definition.execute(
        {
          graph,
          revision: state.revision,
          scenarioId: scenarioId ?? null,
        },
        parsed,
      );
    } catch (error) {
      if (error instanceof PlatformError) throw error;
      throw new PlatformError(
        422,
        error instanceof Error
          ? error.message
          : "Function constraints could not be evaluated",
      );
    }
    const validated = definition.output.safeParse(calculated);
    if (!validated.success)
      throw new PlatformError(
        500,
        "Registered function returned an invalid result",
      );
    const output = validated.data;
    const evidence = graph.evidence();
    const objectIds = new Set(evidence.objects.map((o) => o.id));
    const run: FunctionRun = {
      id: `run-${randomUUID()}`,
      functionId: id,
      ontology,
      revision: state.revision,
      scenarioId: scenarioId ?? null,
      scenarioVersion:
        "scenarioVersion" in state ? Number(state.scenarioVersion) : null,
      executedAt: new Date().toISOString(),
      input: parsed,
      ...(scope
        ? {
            inputScope: {
              ...scope,
              materialization:
                "materialization" in state &&
                state.materialization === "overlay-full-read"
                  ? ("overlay-full-read" as const)
                  : ("native-slice" as const),
              objects: state.objects.length,
              relationships: state.relationships.length,
            },
          }
        : {}),
      output,
      explanation: definition.explain?.(output),
      ...("generation" in state
        ? {
            history: {
              generation: state.generation,
              revision: state.revision,
              committedAt: state.committedAt,
            },
          }
        : {}),
      evidence: {
        ...evidence,
        capturedAt,
        contributors: sources.flatMap((source) =>
          Object.entries(source.managed)
            .filter(([id]) => objectIds.has(id))
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
                  canonical(
                    evidence.objects.find((o) => o.id === objectId)?.properties[
                      field
                    ],
                  ) === canonical(value),
              ),
            })),
        ),
      },
    };
    await this.store.exclusive(() =>
      this.store.saveDocument("run", ontology, run.id, run),
    );
    return run;
  }
  async history(ontology: string) {
    await this.store.ontology(ontology);
    return this.store.documents<FunctionRun>("run", ontology);
  }
}
