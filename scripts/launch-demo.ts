import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { GraphClient } from "@graph/sdk";
import type { LaunchResult } from "../examples/semiconductor/functions/launch-readiness.js";
const client = new GraphClient(process.env.API_URL ?? "http://127.0.0.1:3001");
const live = await client.snapshot("semiconductor");
const baseline = await client.runFunction<LaunchResult>(
  "semiconductor",
  "launch-readiness",
  { productId: "aquila-x900" },
);
const branch = await client.createScenario("semiconductor", {
  id: `demo-${randomUUID()}`,
  name: "SDK demo · 14-day alternative",
  expectedRevision: live.revision,
});
await client.patchScenarioObject("semiconductor", branch.id, "meridian", {
  properties: { leadDays: 14 },
  expectedVersion: 0,
});
const hypothetical = await client.runFunction<LaunchResult>(
  "semiconductor",
  "launch-readiness",
  { productId: "aquila-x900" },
  branch.id,
);
assert.equal(
  baseline.output.recommendation.hardware[0].supplierId,
  "meridian",
  "Run pnpm seed to restore the default synthetic assumptions",
);
assert.equal(
  hypothetical.output.recommendation.hardware[0].supplierId,
  "northstar",
);
assert.equal(hypothetical.output.recommendation.hardware[0].expedited, true);
assert.deepEqual(
  await client.snapshot("semiconductor"),
  live,
  "Scenario changed live graph",
);
console.log(
  JSON.stringify(
    {
      live: baseline.output.recommendation,
      scenario: hypothetical.output.recommendation,
      diff: await client.scenarioDiff("semiconductor", branch.id),
      scenarioId: branch.id,
      liveGraphUnchanged: true,
    },
    null,
    2,
  ),
);
