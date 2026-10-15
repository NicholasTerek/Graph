import { ontologySchema, type SourceConfig } from "@graph/contracts";
import { resolutionOntology } from "./constants.js";
export { resolutionOntology } from "./constants.js";
const named = { name: { type: "string" as const, required: true } };
export const resolutionSchema = ontologySchema.parse({
  id: resolutionOntology,
  name: "Supplier identity lab",
  description:
    "Synthetic bounded resolution example; shared neighbors are evidence, not identity proof.",
  objectTypes: [
    {
      name: "Supplier",
      properties: { ...named, kind: { type: "string", required: true } },
    },
    ...["Component", "Product", "Issue", "Location", "Order"].map((name) => ({
      name,
      properties: named,
    })),
    {
      name: "Resolution",
      properties: {
        ...named,
        status: { type: "string", required: true },
        branchId: { type: "string", required: true },
        canonicalId: { type: "string", required: true },
      },
    },
  ],
  relationshipTypes: [
    ...[
      ["COMPONENT_REF", "Component"],
      ["PRODUCT_REF", "Product"],
      ["ISSUE_REF", "Issue"],
      ["LOCATION_REF", "Location"],
    ].map(([name, to]) => ({ name, from: "Supplier", to })),
    { name: "ORDERED_FROM", from: "Order", to: "Supplier" },
    { name: "RESOLVES_TO", from: "Supplier", to: "Supplier" },
    { name: "MEMBER", from: "Resolution", to: "Supplier" },
    { name: "TARGET", from: "Resolution", to: "Supplier" },
  ],
});
const references = [
  {
    id: "component",
    type: "COMPONENT_REF",
    target: { objectId: { field: "component" } },
  },
  {
    id: "product",
    type: "PRODUCT_REF",
    target: { objectId: { field: "product" } },
  },
  {
    id: "issue",
    type: "ISSUE_REF",
    optional: true,
    target: { objectId: { field: "issue" } },
  },
] as const;
export const resolutionSources: SourceConfig[] = [
  {
    id: "supplier-csv",
    name: "Synthetic supplier CSV",
    connector: "csv",
    mapping: {
      type: "Supplier",
      idField: "id",
      objectIdField: "id",
      properties: { name: { field: "name" }, kind: { value: "alias" } },
      relationships: [...references],
    },
  },
  {
    id: "supplier-json",
    name: "Synthetic JSON feed",
    connector: "json",
    mapping: {
      type: "Supplier",
      idField: "id",
      objectIdField: "id",
      properties: { name: { field: "name" }, kind: { value: "alias" } },
      relationships: [
        ...references,
        {
          id: "location",
          type: "LOCATION_REF",
          target: { objectId: { field: "location" } },
        },
      ],
    },
  },
  {
    id: "supplier-github",
    name: "Synthetic GitHub issue fixture",
    connector: "github",
    repository: "demo-company/supply-issues",
    githubResource: "issues",
    mapping: {
      type: "Supplier",
      idField: "number",
      properties: { name: { field: "title" }, kind: { value: "alias" } },
      relationships: [
        {
          id: "component",
          type: "COMPONENT_REF",
          target: { objectId: { value: "advanced-package" } },
        },
        {
          id: "product",
          type: "PRODUCT_REF",
          target: { objectId: { value: "aquila" } },
        },
        {
          id: "issue",
          type: "ISSUE_REF",
          target: { objectId: { field: "body" } },
        },
      ],
    },
  },
];
