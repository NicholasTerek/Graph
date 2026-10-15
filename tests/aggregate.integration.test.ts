import { describe, it, expect } from "vitest";
import { FalkorDB } from "falkordb";
import { GraphStore } from "@graph/core";
import { ontologySchema, type GraphObject } from "@graph/contracts";
const suite = process.env.GRAPH_INTEGRATION === "1" ? describe : describe.skip;
suite("native aggregate equivalence", () => {
  it("preserves numeric/null/count/filter semantics across pages, types and ontologies", async () => {
    const db = await FalkorDB.connect({
      socket: {
        host: process.env.FALKORDB_HOST ?? "127.0.0.1",
        port: Number(process.env.FALKORDB_PORT ?? 6379),
      },
    });
    const name = `aggregate_${Date.now()}_${process.pid}`;
    const store = new GraphStore(db, name);
    try {
      await store.initialize();
      const provenance = {
        source: "test",
        externalId: "aggregate",
        observedAt: "2026-10-15T00:00:00Z",
      };
      const records: GraphObject[] = Array.from({ length: 203 }, (_, i) => ({
        id: `r-${i}`,
        type: "Record",
        properties: {
          name: i % 2 ? "Odd" : "EVEN",
          active: i % 2 === 0,
          ...(i % 7 ? { amount: (i - 100) / 4 } : {}),
        },
        provenance,
      }));
      const types = ["Record", "Other"].map((name) => ({
        name,
        properties: {
          name: { type: "string" as const, required: true },
          active: { type: "boolean" as const, required: true },
          amount: { type: "number" as const },
        },
      }));
      for (const id of ["primary", "neighbor"]) {
        await store.register(
          ontologySchema.parse({
            id,
            name: id,
            objectTypes: types,
            relationshipTypes: [],
          }),
        );
        await store.ingest(id, {
          objects:
            id === "primary"
              ? [
                  ...records,
                  {
                    id: "other",
                    type: "Other",
                    properties: { name: "EVEN", active: true, amount: 1000000 },
                    provenance,
                  },
                ]
              : [
                  {
                    id: "foreign",
                    type: "Record",
                    properties: { name: "EVEN", active: true, amount: 1000000 },
                    provenance,
                  },
                ],
          relationships: [],
        });
      }
      const cases = [
        { selected: records, filters: [] },
        {
          selected: records.filter((o) => Number(o.properties.amount) >= 0),
          filters: [{ property: "amount", operator: "gte" as const, value: 0 }],
        },
        {
          selected: records.filter((o) => o.properties.active),
          filters: [
            { property: "name", operator: "contains" as const, value: "even" },
          ],
        },
        {
          selected: records.filter((o) => !o.properties.active),
          filters: [
            { property: "active", operator: "eq" as const, value: false },
          ],
        },
        {
          selected: [],
          filters: [
            { property: "amount", operator: "gt" as const, value: 100000 },
          ],
        },
      ];
      for (const { selected, filters } of cases) {
        const values = selected
          .map((o) => o.properties.amount)
          .filter((n): n is number => typeof n === "number");
        for (const operation of [
          "count",
          "sum",
          "avg",
          "min",
          "max",
        ] as const) {
          const result = await store.aggregate("primary", {
            type: "Record",
            operation,
            property: "amount",
            filters,
          });
          const total = values.reduce((a, b) => a + b, 0);
          const expected =
            operation === "count"
              ? selected.length
              : !values.length
                ? null
                : operation === "sum"
                  ? total
                  : operation === "avg"
                    ? total / values.length
                    : operation === "min"
                      ? Math.min(...values)
                      : Math.max(...values);
          expect(result.count).toBe(selected.length);
          if (expected === null) expect(result.value).toBeNull();
          else expect(result.value).toBeCloseTo(expected, 10);
        }
      }
      await expect(
        store.aggregate("primary", {
          type: "Record",
          operation: "sum",
          property: "name",
          filters: [],
        }),
      ).rejects.toMatchObject({ statusCode: 422 });
      await expect(
        store.aggregate("primary", {
          type: "Record",
          operation: "count",
          filters: [{ property: "active", operator: "eq", value: "true" }],
        }),
      ).rejects.toMatchObject({ statusCode: 422 });
    } finally {
      await db.selectGraph(name).delete();
      await db.close();
    }
  });
});
