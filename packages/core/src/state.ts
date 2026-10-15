import type { GraphSnapshot, Change } from "@graph/contracts";
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => JSON.stringify(k) + ":" + canonical(v))
      .join(",")}}`;
  return JSON.stringify(value);
}
export function digestInput(value: unknown) {
  return canonical(value);
}
export function recordChanges<T extends { id: string }>(
  before: T[],
  after: T[],
): Change<T>[] {
  const a = new Map(before.map((x) => [x.id, x]));
  const b = new Map(after.map((x) => [x.id, x]));
  return [...new Set([...a.keys(), ...b.keys()])].sort().flatMap((id) => {
    const left = a.get(id) ?? null,
      right = b.get(id) ?? null;
    return canonical(left) === canonical(right)
      ? []
      : [
          {
            id,
            kind:
              left === null
                ? ("added" as const)
                : right === null
                  ? ("removed" as const)
                  : ("modified" as const),
            before: left,
            after: right,
          },
        ];
  });
}
export function validateUniqueState(state: GraphSnapshot) {
  for (const records of [state.objects, state.relationships])
    if (new Set(records.map((r) => r.id)).size !== records.length)
      throw new Error("Duplicate IDs in graph state");
}
