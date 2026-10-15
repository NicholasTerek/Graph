import type { GraphSnapshot } from "@graph/contracts";
import { identifier } from "@graph/contracts";
import { z } from "zod";
import { PlatformError } from "./validation.js";
export type DependencyScope = {
  root: string;
  depth: number;
  direction: "out" | "in" | "both";
};
export const dependencyScopeSchema = z
  .object({
    root: identifier,
    depth: z.number().int().min(1).max(5),
    direction: z.enum(["out", "in", "both"]),
  })
  .strict();
export function dependencySlice(
  graph: GraphSnapshot,
  scope: DependencyScope,
): GraphSnapshot {
  scope = dependencyScopeSchema.parse(scope);
  const seen = new Set([scope.root]),
    adjacency = new Map<string, string[]>();
  if (!graph.objects.some((o) => o.id === scope.root))
    throw new PlatformError(404, "Dependency root not found");
  const add = (from: string, to: string) => {
    const neighbors = adjacency.get(from) ?? [];
    neighbors.push(to);
    adjacency.set(from, neighbors);
  };
  for (const r of graph.relationships) {
    if (scope.direction !== "in") add(r.from, r.to);
    if (scope.direction !== "out") add(r.to, r.from);
  }
  let frontier = [scope.root];
  for (let level = 0; level < scope.depth; level++) {
    const next: string[] = [];
    for (const id of frontier)
      for (const neighbor of adjacency.get(id) ?? [])
        if (!seen.has(neighbor)) {
          seen.add(neighbor);
          next.push(neighbor);
        }
    if (seen.size > 2000)
      throw new PlatformError(422, "Dependency slice exceeds 2000 objects");
    frontier = next;
  }
  const objects = graph.objects
    .filter((o) => seen.has(o.id))
    .sort((a, b) => a.id.localeCompare(b.id));
  const relationships = graph.relationships
    .filter((r) => seen.has(r.from) && seen.has(r.to))
    .sort((a, b) => a.id.localeCompare(b.id));
  if (relationships.length > 5000)
    throw new PlatformError(422, "Dependency slice exceeds 5000 relationships");
  return { objects, relationships };
}
