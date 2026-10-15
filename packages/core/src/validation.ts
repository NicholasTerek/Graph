import type {
  Ontology,
  GraphObject,
  GraphSnapshot,
  Ingestion,
} from "@graph/contracts";

export class PlatformError extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

export function validateObject(ontology: Ontology, object: GraphObject) {
  const type = ontology.objectTypes.find((t) => t.name === object.type);
  if (!type)
    throw new PlatformError(422, `Unknown object type: ${object.type}`);
  for (const [name, definition] of Object.entries(type.properties)) {
    const value = object.properties[name];
    if (value === undefined && definition.required)
      throw new PlatformError(422, `${object.id}: missing ${name}`);
    if (value !== undefined && typeof value !== definition.type)
      throw new PlatformError(
        422,
        `${object.id}: ${name} must be ${definition.type}`,
      );
  }
  for (const name of Object.keys(object.properties)) {
    if (!Object.hasOwn(type.properties, name))
      throw new PlatformError(422, `${object.id}: unknown property ${name}`);
  }
}

export function validateIngestion(
  ontology: Ontology,
  current: GraphSnapshot,
  input: Ingestion,
) {
  const objects = new Map(current.objects.map((o) => [o.id, o]));
  for (const object of input.objects) {
    validateObject(ontology, object);
    const previous = objects.get(object.id);
    if (previous && previous.type !== object.type)
      throw new PlatformError(409, `Cannot change type of ${object.id}`);
    objects.set(object.id, object);
  }
  const relationships = new Map(current.relationships.map((r) => [r.id, r]));
  for (const rel of input.relationships) {
    const type = ontology.relationshipTypes.find((t) => t.name === rel.type);
    if (!type)
      throw new PlatformError(422, `Unknown relationship type: ${rel.type}`);
    if (
      objects.get(rel.from)?.type !== type.from ||
      objects.get(rel.to)?.type !== type.to
    ) {
      throw new PlatformError(
        422,
        `Invalid or missing endpoints for ${rel.id}: expected ${type.from} → ${type.to}`,
      );
    }
    const previous = relationships.get(rel.id);
    if (
      previous &&
      (previous.type !== rel.type ||
        previous.from !== rel.from ||
        previous.to !== rel.to)
    ) {
      throw new PlatformError(
        409,
        `Cannot change endpoints or type of ${rel.id}; delete it first`,
      );
    }
  }
}
