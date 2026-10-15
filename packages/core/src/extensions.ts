import {
  identifier,
  ontologySchema,
  sourceSchema,
  type Ontology,
} from "@graph/contracts";
import type { FunctionDefinition } from "./functions.js";
import type { ActionDefinition } from "./actions.js";

/** Trusted application composition, not dynamically uploaded executable code. */
export type PlatformExtension = {
  id: string;
  ontologies: Ontology[];
  functions?: FunctionDefinition[];
  actions?: ActionDefinition[];
  sources?: {
    ontology: string;
    source: Parameters<typeof sourceSchema.parse>[0];
  }[];
};
export function composeExtensions(extensions: PlatformExtension[]) {
  const ids = new Set<string>(),
    schemas = new Map<string, Ontology>();
  const functions: FunctionDefinition[] = [],
    actions: ActionDefinition[] = [];
  const sources: NonNullable<PlatformExtension["sources"]> = [];
  const registrations = new Set<string>();
  for (const extension of extensions) {
    identifier.parse(extension.id);
    if (ids.has(extension.id))
      throw Error(`Duplicate extension ${extension.id}`);
    ids.add(extension.id);
    const local = new Set<string>();
    for (const raw of extension.ontologies) {
      const schema = ontologySchema.parse(raw);
      if (schemas.has(schema.id))
        throw Error(`Duplicate extension ontology ${schema.id}`);
      schemas.set(schema.id, schema);
      local.add(schema.id);
    }
    for (const [kind, definitions] of [
      ["function", extension.functions ?? []],
      ["action", extension.actions ?? []],
    ] as const) {
      for (const definition of definitions) {
        identifier.parse(definition.id);
        if (!local.has(definition.ontology))
          throw Error(
            `${kind} ${definition.id} has no ontology in extension ${extension.id}`,
          );
        const key = `${kind}/${definition.ontology}/${definition.id}`;
        if (registrations.has(key))
          throw Error(`Duplicate registration ${key}`);
        registrations.add(key);
      }
    }
    functions.push(...(extension.functions ?? []));
    actions.push(...(extension.actions ?? []));
    for (const entry of extension.sources ?? []) {
      if (!local.has(entry.ontology))
        throw Error(`Source has no ontology in extension ${extension.id}`);
      const source = sourceSchema.parse(entry.source),
        key = `source/${entry.ontology}/${source.id}`;
      if (registrations.has(key)) throw Error(`Duplicate registration ${key}`);
      registrations.add(key);
      sources.push({ ontology: entry.ontology, source });
    }
  }
  return { ontologies: [...schemas.values()], functions, actions, sources };
}
