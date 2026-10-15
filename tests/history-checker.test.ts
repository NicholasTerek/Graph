import { describe, expect, it } from "vitest";
import {
  checkHistory,
  type HistoryEntry,
  type Observation,
} from "../scripts/lib/history-checker.js";
const state = (
  revision: number,
  counter: number,
  left = 0,
  right = left,
): Observation => ({
  revision,
  generation: "generation",
  objects: [
    ["counter", counter],
    ["left", left],
    ["right", right],
  ].map(([id, value]) => ({
    id: String(id),
    type: "Cell",
    properties: { value: Number(value) },
    provenance: {
      source: "test",
      externalId: String(id),
      observedAt: "2026-10-15T00:00:00Z",
    },
  })),
  relationships: [
    {
      id: "pair",
      type: "PAIR",
      from: "left",
      to: "right",
      provenance: {
        source: "test",
        externalId: "pair",
        observedAt: "2026-10-15T00:00:00Z",
      },
    },
  ],
});
const entry = (
  id: number,
  kind: string,
  output: unknown,
  input: Record<string, unknown> = {},
): HistoryEntry => ({
  id,
  actor: "test",
  kind,
  start: id * 2,
  end: id * 2 + 1,
  input,
  output,
  status: "ok",
});
const valid = () => [
  entry(0, "read", state(1, 0)),
  entry(1, "cas", { revision: 2 }, { expectedRevision: 1 }),
  entry(2, "pinned", state(1, 0), { snapshot: "pin" }),
  entry(3, "final", state(2, 1)),
];
describe("concurrent history checker rejects injected anomalies", () => {
  it("accepts guarded increments and stable old snapshots", () =>
    expect(checkHistory(valid()).ok).toBe(true));
  it("finds a lost update", () => {
    const h = valid();
    h[3].output = state(2, 0);
    expect(checkHistory(h).violations.join()).toContain("lost update");
  });
  it("finds read skew and dangling edges", () => {
    const h = valid();
    h[3].output = state(2, 1, 1, 2);
    (h[3].output as Observation).objects.pop();
    const result = checkHistory(h);
    expect(result.violations.join()).toContain("skewed");
    expect(result.violations.join()).toContain("dangling");
  });
  it("finds a pin that moves", () => {
    const h = valid();
    h.push(entry(4, "pinned", state(2, 1), { snapshot: "pin" }));
    expect(checkHistory(h).violations.join()).toContain("snapshot changed");
  });
  it("finds a read older than a completed write", () => {
    const h = valid();
    h.splice(3, 0, entry(3, "read", state(1, 0)));
    expect(checkHistory(h).violations.join()).toContain("predates");
  });
  it("finds two states at one revision", () => {
    const h = valid();
    h.push(entry(4, "read", state(2, 1, 9)));
    expect(checkHistory(h).violations.join()).toContain("different states");
  });
  it("finds a stale guarded write accepted at the wrong revision", () => {
    const h = valid();
    h[1].input.expectedRevision = 0;
    expect(checkHistory(h).violations.join()).toContain("expected revision");
  });
  it("distinguishes expected conflicts from unexpected errors and incomplete journals", () => {
    const h = valid();
    h.push({ ...entry(4, "cas", undefined), status: "error", code: 409 });
    expect(checkHistory(h).ok).toBe(true);
    h[4].code = 500;
    expect(checkHistory(h).ok).toBe(false);
    expect(checkHistory([]).violations.join()).toContain("incomplete");
  });
});
