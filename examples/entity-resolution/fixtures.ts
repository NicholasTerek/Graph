import type { GraphClient } from "@graph/sdk";
import type { GraphObject } from "@graph/contracts";
import {
  resolutionOntology,
  resolutionSchema,
  resolutionSources,
} from "./model.js";
export const supplierCsv =
  "id,name,component,product,issue\nsupplier-csv-row,Meridian Pkg,advanced-package,aquila,issue-142\nsupplier-ambiguous,Meridian Services,advanced-package,aquila,\n";
export const supplierJson = JSON.stringify([
  {
    id: "supplier-json-row",
    name: "MERIDIAN Packaging Ltd.",
    component: "advanced-package",
    product: "aquila",
    issue: "issue-142",
    location: "waterloo-plant",
  },
]);
export const resolutionFixtureFetch: typeof fetch = async (input, init) => {
  const url = String(input);
  if (url === "https://api.github.com/repos/demo-company/supply-issues")
    return Response.json({ private: false });
  if (
    url.startsWith(
      "https://api.github.com/repos/demo-company/supply-issues/issues?",
    )
  )
    return Response.json([
      {
        number: 142,
        title: "Meridan Packaging",
        body: "issue-142",
        state: "open",
      },
    ]);
  return fetch(input, init);
};
export async function seedResolution(client: GraphClient) {
  await client.register(resolutionSchema);
  const provenance = {
    source: "synthetic-resolution-fixture",
    externalId: "seed",
    observedAt: "2026-10-15T00:00:00Z",
  };
  const objects: Omit<GraphObject, "provenance">[] = [
    {
      id: "canonical-packaging",
      type: "Supplier",
      properties: { name: "Meridian Packaging", kind: "canonical" },
    },
    {
      id: "canonical-logistics",
      type: "Supplier",
      properties: { name: "Meridian Logistics", kind: "canonical" },
    },
    {
      id: "advanced-package",
      type: "Component",
      properties: { name: "Advanced package" },
    },
    { id: "aquila", type: "Product", properties: { name: "Aquila GPU" } },
    {
      id: "issue-142",
      type: "Issue",
      properties: { name: "Packaging qualification" },
    },
    {
      id: "issue-999",
      type: "Issue",
      properties: { name: "Freight qualification" },
    },
    {
      id: "waterloo-plant",
      type: "Location",
      properties: { name: "Waterloo plant" },
    },
  ];
  const relationships = ["canonical-packaging", "canonical-logistics"].flatMap(
    (from, i) => [
      {
        id: `seed-component-${i}`,
        type: "COMPONENT_REF",
        from,
        to: "advanced-package",
        provenance,
      },
      {
        id: `seed-product-${i}`,
        type: "PRODUCT_REF",
        from,
        to: "aquila",
        provenance,
      },
      {
        id: `seed-issue-${i}`,
        type: "ISSUE_REF",
        from,
        to: i === 0 ? "issue-142" : "issue-999",
        provenance,
      },
    ],
  );
  await client.ingest(resolutionOntology, {
    objects: objects.map((o) => ({ ...o, provenance })),
    relationships,
  });
  for (const source of resolutionSources)
    await client.registerSource(resolutionOntology, source);
  await replayResolutionSources(client);
  const aliases = (await client.snapshot(resolutionOntology)).objects.filter(
    (o) => o.type === "Supplier" && o.properties.kind === "alias",
  );
  await client.ingest(resolutionOntology, {
    objects: aliases.map((_, i) => ({
      id: `order-${i}`,
      type: "Order",
      properties: { name: `Synthetic purchase order ${i}` },
      provenance,
    })),
    relationships: aliases.map((alias, i) => ({
      id: `order-supplier-${i}`,
      type: "ORDERED_FROM",
      from: `order-${i}`,
      to: alias.id,
      provenance,
    })),
  });
}
export async function replayResolutionSources(client: GraphClient) {
  for (const [id, content] of [
    ["supplier-csv", supplierCsv],
    ["supplier-json", supplierJson],
    ["supplier-github", undefined],
  ] as const) {
    const preview = await client.syncSource(resolutionOntology, id, {
      content,
      dryRun: true,
    });
    await client.syncSource(resolutionOntology, id, {
      content,
      expectedCheckpoint: preview.checkpoint,
      expectedRevision: (await client.snapshot(resolutionOntology)).revision,
    });
  }
}
