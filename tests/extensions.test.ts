import { describe, it, expect } from "vitest";
import { composeExtensions } from "@graph/core";
import { exampleExtensions } from "../examples/server.js";
describe("trusted extension composition", () => {
  it("selects a domain and composes its schema and functions independently", () => {
    const selected = exampleExtensions({ GRAPH_EXTENSIONS: "library" });
    const result = composeExtensions(selected);
    expect(result.ontologies.map((o) => o.id)).toEqual(["library"]);
    expect(result.functions.map((f) => f.id)).toEqual(["availability"]);
    expect(result.actions).toEqual([]);
    expect(() => exampleExtensions({ GRAPH_EXTENSIONS: "missing" })).toThrow(
      "unknown",
    );
  });
  it("rejects duplicate identities and definitions outside their declared ontology", () => {
    const [library] = exampleExtensions({ GRAPH_EXTENSIONS: "library" });
    expect(() => composeExtensions([library, library])).toThrow(
      "Duplicate extension",
    );
    expect(() =>
      composeExtensions([library, { ...library, id: "second" }]),
    ).toThrow("Duplicate extension ontology");
    expect(() =>
      composeExtensions([
        {
          ...library,
          functions: [...library.functions!, ...library.functions!],
        },
      ]),
    ).toThrow("Duplicate registration");
    expect(() =>
      composeExtensions([
        {
          ...library,
          functions: [{ ...library.functions![0], ontology: "other" }],
        },
      ]),
    ).toThrow("has no ontology");
  });
});
