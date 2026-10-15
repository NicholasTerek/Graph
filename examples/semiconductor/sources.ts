import type { SourceConfig } from "@graph/contracts";
export const semiconductorSources: SourceConfig[] = [
  {
    id: "packaging-feed",
    name: "Packaging operations · CSV",
    connector: "csv",
    mapping: {
      type: "Supplier",
      idField: "id",
      objectIdField: "id",
      properties: {
        name: { field: "name" },
        status: { field: "status" },
        leadDays: { field: "leadDays" },
        dailyCapacity: { field: "dailyCapacity" },
        qualified: { field: "qualified" },
        riskPoints: { field: "riskPoints" },
        costUSD: { field: "costUSD" },
      },
    },
  },
  {
    id: "driver-feed",
    name: "Driver engineering · JSON",
    connector: "json",
    mapping: {
      type: "Issue",
      idField: "id",
      objectIdField: "id",
      properties: {
        name: { field: "name" },
        status: { field: "status" },
        fixDays: { field: "fixDays" },
      },
    },
  },
  {
    id: "public-github",
    name: "Graph project · public GitHub",
    connector: "github",
    githubResource: "repository",
    repository: "NicholasTerek/Graph",
    mapping: {
      type: "Repository",
      idField: "id",
      properties: {
        name: { field: "full_name" },
        status: { value: "public" },
        url: { field: "html_url" },
      },
    },
  },
];
