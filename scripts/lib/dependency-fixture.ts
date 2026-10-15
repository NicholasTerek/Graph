import type { GraphSnapshot } from "@graph/contracts";
/** Synthetic task DAGs; deterministic IDs, order and expected edge cardinality. */
export function dependencyFixture(
  count: number,
  shape: "chain" | "bounded" | "hub",
): GraphSnapshot {
  if (!Number.isInteger(count) || count < 2 || count > 100000)
    throw Error("Fixture count must be 2..100000");
  const provenance = {
    source: "synthetic-dependency-fixture",
    externalId: "generator-v1",
    observedAt: "2026-10-15T00:00:00Z",
  };
  const objects = Array.from({ length: count }, (_, i) => ({
    id: `task-${i}`,
    type: "Task",
    properties: { name: `Qualification task ${i}`, durationDays: (i % 7) + 1 },
    provenance,
  }));
  const relationships: GraphSnapshot["relationships"] = [];
  for (let i = 1; i < count; i++) {
    const targets =
      shape === "hub"
        ? [0]
        : shape === "chain"
          ? [i - 1]
          : Array.from({ length: Math.min(i, 3) }, (_, j) => i - j - 1);
    for (const j of targets)
      relationships.push({
        id: `dependency-${i}-${j}`,
        type: "DEPENDS_ON",
        from: objects[i].id,
        to: objects[j].id,
        provenance,
      });
  }
  return { objects, relationships };
}
