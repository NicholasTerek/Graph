import { defineFunction } from "@graph/core";
import { z } from "zod";
export const libraryAvailability = defineFunction({
  id: "availability",
  ontology: "library",
  name: "Library availability",
  description:
    "Count available books and their authors from one captured graph snapshot.",
  input: z.object({}).strict(),
  output: z.object({
    available: z.number(),
    books: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        authors: z.array(z.string()),
      }),
    ),
  }),
  execute: ({ graph }) => {
    const books = graph
      .objects("Book")
      .filter((b) => b.properties.status === "available")
      .map((b) => ({
        id: b.id,
        name: String(b.properties.name),
        authors: graph
          .related(b.id, "WRITTEN_BY")
          .map((a) => String(a.properties.name)),
      }));
    return { available: books.length, books };
  },
});
