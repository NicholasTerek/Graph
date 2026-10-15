import { writeFileSync } from "node:fs";
const provenance = (id: string) => ({
  source: "synthetic-demo",
  externalId: id,
  observedAt: "2026-10-15T00:00:00Z",
});
const object = (
  id: string,
  type: string,
  name: string,
  status: string,
  extra = {},
) => ({
  id,
  type,
  properties: { name, status, ...extra },
  provenance: provenance(id),
});
const relationship = (id: string, type: string, from: string, to: string) => ({
  id,
  type,
  from,
  to,
  provenance: provenance(id),
});
const definitions = [
  ["Product", "Commercial hardware and its launch dependencies"],
  ["Component", "Required hardware component"],
  ["Supplier", "Manufacturing or packaging partner"],
  ["Release", "Software release required for launch"],
  ["Issue", "Engineering defect"],
  ["Test", "Validation gate"],
  ["Team", "Accountable engineering team"],
  ["Customer", "Synthetic customer commitment"],
  ["Launch", "Commercial launch milestone"],
];
const links = [
  ["REQUIRES", "Product", "Component"],
  ["SUPPLIED_BY", "Component", "Supplier"],
  ["NEEDS_RELEASE", "Product", "Release"],
  ["BLOCKED_BY", "Release", "Issue"],
  ["VALIDATED_BY", "Release", "Test"],
  ["OWNED_BY", "Issue", "Team"],
  ["SCHEDULED_FOR", "Product", "Launch"],
  ["COMMITS_TO", "Launch", "Customer"],
  ["ALTERNATIVE", "Supplier", "Supplier"],
  ["FALLBACK", "Release", "Release"],
];
const extraProperties: Record<
  string,
  Record<string, { type: "number" | "string"; required: boolean }>
> = {
  Product: {
    architecture: { type: "string", required: false },
    integrationDays: { type: "number", required: false },
  },
  Component: { assemblyDays: { type: "number", required: false } },
  Supplier: Object.fromEntries(
    [
      "riskPoints",
      "costUSD",
      "expeditedLeadDays",
      "expeditedRiskPoints",
      "expeditedCostUSD",
    ].map((name) => [name, { type: "number" as const, required: false }]),
  ),
  Release: {
    architecture: { type: "string", required: false },
    validationDays: { type: "number", required: false },
    riskPoints: { type: "number", required: false },
    repairCostUSD: { type: "number", required: false },
  },
  Issue: { fixDays: { type: "number", required: false } },
};
const ontology = {
  id: "semiconductor",
  name: "Aquila Semiconductor",
  description:
    "Synthetic hardware and software operations, connected through launch dependencies.",
  objectTypes: definitions.map(([name, description]) => ({
    name,
    description,
    properties: {
      name: { type: "string", required: true },
      status: { type: "string", required: true },
      ...extraProperties[name],
      ...(name === "Supplier"
        ? { leadDays: { type: "number", required: true } }
        : {}),
      ...(name === "Launch"
        ? { daysRemaining: { type: "number", required: true } }
        : {}),
    },
  })),
  relationshipTypes: links.map(([name, from, to]) => ({
    name,
    from,
    to,
    description: "",
  })),
};
const data = {
  objects: [
    object("aquila-x900", "Product", "Aquila X900", "at-risk", {
      architecture: "Borealis",
      integrationDays: 5,
    }),
    object("aquila-x700", "Product", "Aquila X700", "ready", {
      architecture: "Borealis",
      integrationDays: 5,
    }),
    object("advanced-package", "Component", "Advanced package", "delayed", {
      assemblyDays: 5,
    }),
    object("standard-package", "Component", "Standard package", "ready", {
      assemblyDays: 3,
    }),
    object("northstar", "Supplier", "Northstar Packaging", "delayed", {
      leadDays: 28,
      riskPoints: 1,
      costUSD: 0,
      expeditedLeadDays: 10,
      expeditedRiskPoints: 4,
      expeditedCostUSD: 180000,
    }),
    object("meridian", "Supplier", "Meridian Packaging", "available", {
      leadDays: 7,
      riskPoints: 2,
      costUSD: 65000,
    }),
    object("driver-26-10", "Release", "Driver 26.10", "blocked", {
      architecture: "Borealis",
      validationDays: 5,
      riskPoints: 2,
      repairCostUSD: 30000,
    }),
    object("driver-26-09", "Release", "Driver 26.09", "validated", {
      architecture: "Borealis",
      validationDays: 0,
      riskPoints: 4,
      repairCostUSD: 0,
    }),
    object("gpu-142", "Issue", "GPU-142 · memory regression", "open", {
      fixDays: 10,
    }),
    object("memory-validation", "Test", "Memory residency suite", "failed"),
    object("graphics-team", "Team", "Graphics systems", "assigned"),
    object("launch-x900", "Launch", "X900 launch · Nov 5", "at-risk", {
      daysRemaining: 21,
    }),
    object("customer-orbit", "Customer", "Orbit Compute", "committed"),
    object("customer-cinder", "Customer", "Cinder Labs", "committed"),
  ],
  relationships: [
    relationship("r01", "REQUIRES", "aquila-x900", "advanced-package"),
    relationship("r02", "SUPPLIED_BY", "advanced-package", "northstar"),
    relationship("r03", "ALTERNATIVE", "northstar", "meridian"),
    relationship("r04", "NEEDS_RELEASE", "aquila-x900", "driver-26-10"),
    relationship("r05", "BLOCKED_BY", "driver-26-10", "gpu-142"),
    relationship("r06", "VALIDATED_BY", "driver-26-10", "memory-validation"),
    relationship("r07", "OWNED_BY", "gpu-142", "graphics-team"),
    relationship("r08", "SCHEDULED_FOR", "aquila-x900", "launch-x900"),
    relationship("r09", "COMMITS_TO", "launch-x900", "customer-orbit"),
    relationship("r10", "COMMITS_TO", "launch-x900", "customer-cinder"),
    relationship("r11", "REQUIRES", "aquila-x700", "standard-package"),
    relationship("r12", "SUPPLIED_BY", "standard-package", "meridian"),
    relationship("r13", "NEEDS_RELEASE", "aquila-x700", "driver-26-09"),
    relationship("r14", "FALLBACK", "driver-26-10", "driver-26-09"),
  ],
};
writeFileSync(
  "examples/semiconductor/ontology.json",
  JSON.stringify(ontology, null, 2) + "\n",
);
writeFileSync(
  "examples/semiconductor/data.json",
  JSON.stringify(data, null, 2) + "\n",
);
const library = {
  id: "library",
  name: "City Library",
  description:
    "A second ontology demonstrating that the platform has no semiconductor assumptions.",
  objectTypes: [
    {
      name: "Book",
      description: "",
      properties: {
        name: { type: "string", required: true },
        status: { type: "string", required: true },
      },
    },
    {
      name: "Author",
      description: "",
      properties: {
        name: { type: "string", required: true },
        status: { type: "string", required: true },
      },
    },
  ],
  relationshipTypes: [
    { name: "WRITTEN_BY", from: "Book", to: "Author", description: "" },
  ],
};
writeFileSync(
  "examples/library/ontology.json",
  JSON.stringify(library, null, 2) + "\n",
);
writeFileSync(
  "examples/library/data.json",
  JSON.stringify(
    {
      objects: [
        object("book-1", "Book", "The Connected City", "available"),
        object("author-1", "Author", "Alex Rivers", "active"),
      ],
      relationships: [
        relationship("written-1", "WRITTEN_BY", "book-1", "author-1"),
      ],
    },
    null,
    2,
  ) + "\n",
);
