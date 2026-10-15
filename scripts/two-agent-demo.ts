import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { strict as assert } from "node:assert";
import { GraphClient } from "@graph/sdk";
export async function twoAgentDemo(
  capacity: GraphClient,
  driver: GraphClient,
  reviewer?: GraphClient,
) {
  const ontology = "semiconductor",
    prefix = `agents-${randomUUID().slice(0, 8)}`;
  const live = await capacity.snapshot(ontology);
  const roles: {
    role: string;
    client: GraphClient;
    id: string;
    object: string;
    properties: Record<string, number>;
    strategy: "copy" | "overlay";
  }[] = [
    {
      role: "Capacity analyst",
      client: capacity,
      id: `${prefix}-capacity`,
      object: "meridian",
      properties: { leadDays: 14 },
      strategy: "overlay" as const,
    },
    {
      role: "Driver analyst",
      client: driver,
      id: `${prefix}-driver`,
      object: "gpu-142",
      properties: { fixDays: 4 },
      strategy: "copy" as const,
    },
  ];
  const results = await Promise.all(
    roles.map(async (r) => {
      const branch = await r.client.createScenario(ontology, {
        id: r.id,
        name: r.role,
        description:
          "Synthetic independent-agent alternative; human review required",
        strategy: r.strategy,
        expectedRevision: live.revision,
      });
      const edited = await r.client.patchScenarioObject(
        ontology,
        r.id,
        r.object,
        { properties: r.properties, expectedVersion: branch.version },
      );
      const investigation = await r.client.investigate(ontology, {
        question: `${r.role}: evaluate this isolated alternative and explain its evidence`,
        root: "aquila-x900",
        functionId: "launch-readiness",
        input: { productId: "aquila-x900" },
        scenario: r.id,
        maxSteps: 12,
      });
      assert.equal(investigation.status, "completed");
      assert.equal(investigation.owner, branch.owner);
      return {
        role: r.role,
        branch: {
          id: r.id,
          owner: branch.owner,
          version: edited.version,
          storage: edited.storage,
          baseRevision: branch.baseRevision,
        },
        investigation,
      };
    }),
  );
  assert.notEqual(
    results[0].branch.owner,
    results[1].branch.owner,
    "Configure distinct named agent credentials",
  );
  assert.deepEqual(
    await capacity.snapshot(ontology),
    live,
    "Agent alternatives changed live state",
  );
  let promotion: unknown = null;
  if (reviewer) {
    const review = await reviewer.reviewScenario(
      ontology,
      results[0].branch.id,
    );
    assert.deepEqual(review.conflicts, []);
    // Explicit scripted-reviewer mode exercises the same guarded call as the human UI.
    promotion = await reviewer.promoteScenario(ontology, results[0].branch.id, {
      expectedVersion: review.version,
      expectedRevision: review.liveRevision,
      objects: ["meridian"],
      relationships: [],
      confirm: true,
    });
  }
  return {
    fixture: "synthetic GPU alternatives",
    results,
    liveUnchangedBeforeReview: true,
    reviewMode: reviewer ? "scripted-reviewer" : "awaiting-human-in-UI",
    promotion,
  };
}
if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? "")).href) {
  const base = process.env.API_URL ?? "http://127.0.0.1:3001";
  if (
    !process.env.GRAPH_CAPACITY_AGENT_TOKEN ||
    !process.env.GRAPH_DRIVER_AGENT_TOKEN
  )
    throw Error(
      "Configure separate kind:agent credentials in GRAPH_API_TOKENS and provide GRAPH_CAPACITY_AGENT_TOKEN / GRAPH_DRIVER_AGENT_TOKEN",
    );
  const capacity = new GraphClient(base, fetch, {
      token: process.env.GRAPH_CAPACITY_AGENT_TOKEN,
    }),
    driver = new GraphClient(base, fetch, {
      token: process.env.GRAPH_DRIVER_AGENT_TOKEN,
    });
  const promote = process.argv.includes("--scripted-reviewer-promote");
  if (promote && !process.env.GRAPH_REVIEWER_TOKEN)
    throw Error("Explicit scripted promotion requires GRAPH_REVIEWER_TOKEN");
  console.log(
    JSON.stringify(
      await twoAgentDemo(
        capacity,
        driver,
        promote
          ? new GraphClient(base, fetch, {
              token: process.env.GRAPH_REVIEWER_TOKEN,
            })
          : undefined,
      ),
      null,
      2,
    ),
  );
}
