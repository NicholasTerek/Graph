import { describe, it, expect } from "vitest";
import {
  readRemoteSource,
  connectionsSchema,
} from "../packages/core/src/connectors.js";
const channel = "123456789012345678";
const resource = "0123456789abcdef0123456789abcdef";
const connections = connectionsSchema.parse({
  notes: {
    connector: "notion",
    token: "test-notion-secret",
    resource,
    ontologies: ["library"],
  },
  chat: {
    connector: "discord",
    token: "test-discord-secret",
    resource: channel,
    ontologies: ["library"],
  },
});
const notion = (id: string) => ({
  object: "page",
  id,
  url: "https://notion.so/" + id,
  last_edited_time: "2026-10-15T00:00:00Z",
  properties: {
    Title: {
      type: "title",
      title: [{ plain_text: "Driver " }, { plain_text: "issue" }],
    },
    Days: { type: "number", number: 7 },
    Active: { type: "checkbox", checkbox: true },
    State: { type: "status", status: { name: "Open" } },
    Related: { type: "relation", relation: [] },
  },
});
const message = (id: string) => ({
  id,
  channel_id: channel,
  content: "Packaging delayed",
  timestamp: "2026-10-15T00:00:00Z",
  edited_timestamp: null,
  author: { id: "user1", username: "engineer" },
});
describe("bounded remote readers", () => {
  it("reads Notion data-source pages, normalizes scalar fields and confines credentials", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const request: typeof fetch = async (url, init) => {
      calls.push({ url: String(url), init });
      return Response.json({
        results: [notion(String(calls.length))],
        has_more: calls.length === 1,
        next_cursor: calls.length === 1 ? "cursor2" : null,
      });
    };
    const rows = await readRemoteSource(
      "notion",
      "notes",
      "library",
      connections,
      request,
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      "property:Title": "Driver issue",
      "property:Days": 7,
      "property:Active": true,
      "property:State": "Open",
    });
    expect(rows[0]).not.toHaveProperty("property:Related");
    expect(calls[0].url).toBe(
      `https://api.notion.com/v1/data_sources/${resource}/query`,
    );
    expect(calls[0].init).toMatchObject({
      redirect: "error",
      method: "POST",
      headers: {
        authorization: "Bearer test-notion-secret",
        "Notion-Version": "2025-09-03",
      },
    });
    expect(JSON.parse(String(calls[1].init?.body)).start_cursor).toBe(
      "cursor2",
    );
  });
  it("paginates Discord history without losing snowflake precision", async () => {
    const urls: string[] = [];
    const request: typeof fetch = async (url, init) => {
      urls.push(String(url));
      expect(init).toMatchObject({
        headers: { authorization: "Bot test-discord-secret" },
        redirect: "error",
      });
      return Response.json(
        urls.length === 1
          ? Array.from({ length: 100 }, (_, i) =>
              message(String(999999999999999999n - BigInt(i))),
            )
          : [message("999999999999999899")],
      );
    };
    const rows = await readRemoteSource(
      "discord",
      "chat",
      "library",
      connections,
      request,
    );
    expect(rows).toHaveLength(101);
    expect(rows[100]).toMatchObject({
      content: "Packaging delayed",
      author_name: "engineer",
    });
    expect(urls[1]).toContain("before=999999999999999900");
  });
  it("rejects unconfigured, mismatched and cross-ontology connections before network access", async () => {
    let calls = 0;
    const request: typeof fetch = async () => {
      calls++;
      return Response.json([]);
    };
    for (const [kind, name, ontology] of [
      ["notion", "missing", "library"],
      ["notion", "chat", "library"],
      ["discord", "chat", "other"],
    ] as const)
      await expect(
        readRemoteSource(kind, name, ontology, connections, request),
      ).rejects.toMatchObject({ statusCode: 422 });
    expect(calls).toBe(0);
    expect(
      connectionsSchema.safeParse({
        bad: {
          connector: "discord",
          token: "x",
          resource: "../../bad",
          ontologies: ["library"],
        },
      }).success,
    ).toBe(false);
  });
  it("sanitizes provider errors and does not retry or expose credentials", async () => {
    for (const request of [
      async () =>
        Response.json({ error: "test-notion-secret" }, { status: 429 }),
      async () => {
        throw new Error("test-notion-secret");
      },
    ]) {
      await expect(
        readRemoteSource("notion", "notes", "library", connections, request),
      ).rejects.toMatchObject({ statusCode: 422 });
      try {
        await readRemoteSource(
          "notion",
          "notes",
          "library",
          connections,
          request,
        );
      } catch (error) {
        expect(String(error)).not.toContain("test-notion-secret");
      }
    }
  });
  it("rejects malformed responses, wrong channels and oversized content", async () => {
    for (const payload of [
      { nope: [] },
      [{ ...message("999999999999999999"), channel_id: "wrong" }],
    ])
      await expect(
        readRemoteSource("discord", "chat", "library", connections, async () =>
          Response.json(payload),
        ),
      ).rejects.toMatchObject({ statusCode: 422 });
    await expect(
      readRemoteSource(
        "notion",
        "notes",
        "library",
        connections,
        async () => new Response("x".repeat(2_000_001)),
      ),
    ).rejects.toMatchObject({ statusCode: 422 });
  });
  it("rejects repeated Notion cursors and incomplete large Discord snapshots", async () => {
    await expect(
      readRemoteSource("notion", "notes", "library", connections, async () =>
        Response.json({ results: [], has_more: true, next_cursor: "same" }),
      ),
    ).rejects.toMatchObject({ statusCode: 422 });
    let n = 0n;
    await expect(
      readRemoteSource("discord", "chat", "library", connections, async () =>
        Response.json(
          Array.from({ length: 100 }, () =>
            message(String(999999999999999999n - n++)),
          ),
        ),
      ),
    ).rejects.toMatchObject({ statusCode: 422 });
  });
});
