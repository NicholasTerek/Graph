import { it, expect } from "vitest";
import { scheduleTasks } from "../examples/semiconductor/functions/schedule.js";
it("waits for parallel prerequisites and identifies critical tasks", () => {
  const s = scheduleTasks([
    {
      id: "hardware",
      label: "H",
      duration: 12,
      dependencies: [],
      evidence: [],
    },
    {
      id: "software",
      label: "S",
      duration: 13,
      dependencies: [],
      evidence: [],
    },
    {
      id: "gate",
      label: "G",
      duration: 2,
      dependencies: ["hardware", "software"],
      evidence: [],
    },
    {
      id: "integration",
      label: "I",
      duration: 5,
      dependencies: ["gate"],
      evidence: [],
    },
  ]);
  expect(s.duration).toBe(20);
  expect(s.criticalPath).toEqual(["software", "gate", "integration"]);
});
it("rejects cyclic dependencies instead of producing a schedule", () =>
  expect(() =>
    scheduleTasks([
      { id: "a", label: "A", duration: 1, dependencies: ["b"], evidence: [] },
      { id: "b", label: "B", duration: 1, dependencies: ["a"], evidence: [] },
    ]),
  ).toThrow("cycle"));
