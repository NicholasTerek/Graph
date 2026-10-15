import { strict as assert } from "node:assert";
import { GraphClient } from "@graph/sdk";
const client = new GraphClient(
  process.env.API_URL ?? "http://127.0.0.1:3001",
  fetch,
  { token: process.env.GRAPH_API_TOKEN },
);
const phase = process.argv[2],
  id = process.argv[3],
  strategy = process.argv[4] ?? "copy";
if (
  !id ||
  !["prepare", "verify"].includes(phase) ||
  !["copy", "overlay"].includes(strategy)
)
  throw new Error(
    "Usage: node --import tsx scripts/native-demo.ts prepare|verify UNIQUE_SCENARIO_ID [copy|overlay]",
  );
if (phase === "prepare") {
  const live = await client.snapshot("semiconductor");
  assert.notEqual(
    live.objects.find((o) => o.id === "meridian")!.properties.leadDays,
    14,
    "Seed the default demo first",
  );
  await client.createScenario("semiconductor", {
    id,
    name: "Native graph restart check",
    expectedRevision: live.revision,
    strategy: strategy as "copy" | "overlay",
  });
  await client.patchScenarioObject("semiconductor", id, "meridian", {
    properties: { leadDays: 14 },
    expectedVersion: 0,
  });
  console.log(
    JSON.stringify({
      scenario: id,
      prepared: true,
      instructions:
        "Restart the API and FalkorDB gracefully, then run verify with this scenario ID.",
    }),
  );
} else {
  const branch = await client.scenario("semiconductor", id);
  assert.equal(
    branch.storage,
    strategy === "overlay" ? "falkordb-overlay" : "falkordb",
  );
  assert.equal(branch.version, 1);
  const state = await client.scenarioGraph("semiconductor", id);
  assert.equal(
    state.objects.find((o) => o.id === "meridian")!.properties.leadDays,
    14,
  );
  const live = await client.snapshot("semiconductor");
  assert.notEqual(
    live.objects.find((o) => o.id === "meridian")!.properties.leadDays,
    14,
  );
  assert.equal(
    live.revision,
    branch.baseRevision,
    "Live data changed after the check was prepared",
  );
  const rank = await client.runAlgorithm("semiconductor", {
    algorithm: "pagerank",
    scenario: id,
  });
  const path = await client.runAlgorithm("semiconductor", {
    algorithm: "shortest-path",
    source: "aquila-x900",
    target: "northstar",
    direction: "out",
    scenario: id,
  });
  assert.ok(rank.rows.length > 0);
  assert.ok(path.path);
  assert.equal(rank.scenarioVersion, 1);
  console.log(
    JSON.stringify(
      {
        scenario: id,
        nativeGraphRecovered: true,
        liveUnchanged: true,
        pagerank: rank.rows,
        path: path.path,
      },
      null,
      2,
    ),
  );
}
