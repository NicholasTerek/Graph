import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { GraphView } from "@graph/core";
import { calculateLaunch } from "../examples/semiconductor/functions/launch-readiness.js";
import { ingestionSchema } from "@graph/contracts";
const fixture = ingestionSchema.parse(
  JSON.parse(readFileSync("examples/semiconductor/data.json", "utf8")),
);
function evaluate(changes: Record<string, Record<string, number>> = {}) {
  const graph = structuredClone(fixture);
  for (const [id, properties] of Object.entries(changes)) {
    const object = graph.objects.find((o) => o.id === id)!;
    Object.assign(object.properties, properties);
  }
  return calculateLaunch(
    { graph: new GraphView(graph), revision: 1, scenarioId: null },
    { productId: "aquila-x900" },
  );
}
describe("GPU launch model constraints", () => {
  it("ranks the 7-day supplier with a repaired driver and exact timing", () => {
    const result = evaluate();
    expect(result.recommendation.id).toBe("meridian_driver-26-10");
    expect(result.recommendation.readyDays).toBe(20);
    expect(result.recommendation.costUSD).toBe(95000);
    expect(result.recommendation.riskPoints).toBe(4);
  });
  it("changes the supplier decision at the exact deadline boundary", () => {
    expect(evaluate({ meridian: { leadDays: 11 } }).recommendation.id).toBe(
      "meridian_driver-26-10",
    );
    expect(evaluate({ meridian: { leadDays: 12 } }).recommendation.id).toBe(
      "northstar-expedited_driver-26-10",
    );
  });
  it("uses the validated fallback if driver repair exceeds the deadline", () => {
    const result = evaluate({ "gpu-142": { fixDays: 20 } });
    expect(result.recommendation.releaseId).toBe("driver-26-09");
    expect(result.recommendation.readyDays).toBe(17);
    expect(result.recommendation.validation).toBe("validated");
  });
  it("reports infeasibility if every hardware route misses the deadline", () => {
    const result = evaluate({
      meridian: { leadDays: 20 },
      northstar: { expeditedLeadDays: 30 },
    });
    expect(result.plans.every((p) => !p.feasible)).toBe(true);
    expect(result.recommendation.delayDays).toBe(9);
  });
  it("rejects negative durations instead of inventing a recovery", () =>
    expect(() => evaluate({ meridian: { leadDays: -1 } })).toThrow(
      "nonnegative",
    ));
  it("does not mutate source objects during computation", () => {
    const before = JSON.stringify(fixture);
    evaluate();
    expect(JSON.stringify(fixture)).toBe(before);
  });
});
