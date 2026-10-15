import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { ontologySchema, ingestionSchema } from "@graph/contracts";
import { validateIngestion } from "@graph/core";
const ontology = ontologySchema.parse(
  JSON.parse(readFileSync("examples/library/ontology.json", "utf8")),
);
const data = ingestionSchema.parse(
  JSON.parse(readFileSync("examples/library/data.json", "utf8")),
);
const empty = { objects: [], relationships: [] };
describe("ontology validation", () => {
  it("accepts a domain unrelated to semiconductors", () =>
    expect(() => validateIngestion(ontology, empty, data)).not.toThrow());
  it("rejects duplicate type definitions", () =>
    expect(() =>
      ontologySchema.parse({
        ...ontology,
        objectTypes: [...ontology.objectTypes, ontology.objectTypes[0]],
      }),
    ).toThrow());
  it("rejects relationships referencing undefined types", () =>
    expect(() =>
      ontologySchema.parse({
        ...ontology,
        relationshipTypes: [{ name: "X", from: "Missing", to: "Book" }],
      }),
    ).toThrow());
  it("rejects missing and incorrectly typed properties", () => {
    expect(() =>
      validateIngestion(ontology, empty, {
        objects: [{ ...data.objects[0], properties: {} }],
        relationships: [],
      }),
    ).toThrow("missing name");
    expect(() =>
      validateIngestion(ontology, empty, {
        objects: [
          { ...data.objects[0], properties: { name: 12, status: "ok" } },
        ],
        relationships: [],
      }),
    ).toThrow("must be string");
  });
  it("rejects unexpected properties", () =>
    expect(() =>
      validateIngestion(ontology, empty, {
        objects: [
          {
            ...data.objects[0],
            properties: { ...data.objects[0].properties, extra: "bad" },
          },
        ],
        relationships: [],
      }),
    ).toThrow("unknown property"));
  it("rejects dangling and incorrectly typed endpoints", () => {
    expect(() =>
      validateIngestion(ontology, empty, {
        objects: [],
        relationships: data.relationships,
      }),
    ).toThrow("endpoints");
    expect(() =>
      validateIngestion(ontology, data, {
        objects: [],
        relationships: [
          { ...data.relationships[0], from: "author-1", to: "book-1" },
        ],
      }),
    ).toThrow("endpoints");
  });
  it("prevents changing identity types or relationship endpoints", () => {
    expect(() =>
      validateIngestion(ontology, data, {
        objects: [{ ...data.objects[0], type: "Author" }],
        relationships: [],
      }),
    ).toThrow("Cannot change type");
    const extra = { ...data.objects[1], id: "author-2" };
    expect(() =>
      validateIngestion(
        ontology,
        {
          objects: [...data.objects, extra],
          relationships: data.relationships,
        },
        {
          objects: [],
          relationships: [{ ...data.relationships[0], to: extra.id }],
        },
      ),
    ).toThrow("Cannot change endpoints");
  });
  it("rejects duplicate ingestion IDs and unsafe identifiers", () => {
    expect(() =>
      ingestionSchema.parse({
        objects: [data.objects[0], data.objects[0]],
        relationships: [],
      }),
    ).toThrow();
    expect(() =>
      ontologySchema.parse({ ...ontology, id: "x'}) DELETE n" }),
    ).toThrow();
  });
});
