import { randomUUID } from "node:crypto";
import { z } from "zod";
import type {
  GraphObject,
  GraphSnapshot,
  FunctionInfo,
  FunctionRun,
} from "@graph/contracts";
import { GraphStore } from "./store.js";
import { ScenarioService } from "./scenarios.js";
import { PlatformError } from "./validation.js";

export class GraphView {
  private graph: GraphSnapshot;
  constructor(graph: GraphSnapshot) {
    this.graph = structuredClone(graph);
  }
  object(id: string): GraphObject {
    const object = this.graph.objects.find((o) => o.id === id);
    if (!object)
      throw new PlatformError(422, `Required object not found: ${id}`);
    return structuredClone(object);
  }
  related(
    id: string,
    type: string,
    direction: "out" | "in" = "out",
  ): GraphObject[] {
    const ids = this.graph.relationships
      .filter(
        (r) => r.type === type && (direction === "out" ? r.from : r.to) === id,
      )
      .map((r) => (direction === "out" ? r.to : r.from));
    return ids.map((id) => this.object(id));
  }
  objects(type?: string): GraphObject[] {
    return structuredClone(
      this.graph.objects.filter((o) => !type || o.type === type),
    );
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
  execute: (context: FunctionContext, input: I) => O | Promise<O>;
};
export function defineFunction<I, O>(
  definition: FunctionDefinition<I, O>,
): FunctionDefinition {
  return {
    ...definition,
    execute: (context, input) =>
      definition.execute(context, definition.input.parse(input)),
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
  async run(
    ontology: string,
    id: string,
    input: unknown,
    scenarioId?: string,
  ): Promise<FunctionRun> {
    const definition = this.definitions.get(`${ontology}/${id}`);
    if (!definition) throw new PlatformError(404, `Function not found: ${id}`);
    const parsed = definition.input.parse(input);
    const state = scenarioId
      ? await this.scenarios.state(ontology, scenarioId)
      : await this.store.state(ontology);
    let calculated: unknown;
    try {
      calculated = await definition.execute(
        {
          graph: new GraphView(state),
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
      output,
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
