import { describe, it, expect } from "vitest";
import { GraphView } from "@graph/core";
import { dependencyFixture } from "../scripts/lib/dependency-fixture.js";
describe("indexed captured graph views", () => {
  for (const shape of ["chain", "bounded", "hub"] as const)
    it(`preserves ${shape} order, direction, multiplicity and captured evidence`, () => {
      const graph = dependencyFixture(30, shape);
      graph.relationships.push({ ...graph.relationships[0], id: "parallel" });
      const view = new GraphView(graph);
      for (const node of graph.objects)
        for (const direction of ["out", "in"] as const) {
          const expected = graph.relationships
            .filter(
              (r) =>
                r.type === "DEPENDS_ON" &&
                (direction === "out" ? r.from : r.to) === node.id,
            )
            .map(
              (r) =>
                graph.objects.find(
                  (o) => o.id === (direction === "out" ? r.to : r.from),
                )!,
            );
          expect(view.related(node.id, "DEPENDS_ON", direction)).toEqual(
            expected,
          );
          expect(view.related(node.id, "MISSING", direction)).toEqual([]);
        }
      expect(view.objects("Task")).toEqual(graph.objects);
      expect(view.objects("MISSING")).toEqual([]);
      expect(new Set(view.evidence().relationships.map((r) => r.id))).toEqual(
        new Set(graph.relationships.map((r) => r.id)),
      );
      const record = view.object("task-0");
      record.properties.name = "mutated";
      graph.objects[0].properties.name = "changed original";
      expect(view.object("task-0").properties.name).toBe(
        "Qualification task 0",
      );
      expect(() => view.object("missing")).toThrow("Required object not found");
    });
});
