import { z } from "zod";
import { setTimeout } from "node:timers/promises";
import { PlatformError } from "./validation.js";

export const connectionsSchema = z.record(
  z.string().regex(/^[a-zA-Z0-9_-]+$/),
  z.discriminatedUnion("connector", [
    z
      .object({
        connector: z.literal("notion"),
        token: z.string().min(1),
        resource: z
          .string()
          .regex(
            /^[a-fA-F0-9]{32}$|^[a-fA-F0-9]{8}(-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}$/,
          ),
        ontologies: z.array(z.string()).min(1),
      })
      .strict(),
    z
      .object({
        connector: z.literal("discord"),
        token: z.string().min(1),
        resource: z.string().regex(/^\d{17,20}$/),
        ontologies: z.array(z.string()).min(1),
      })
      .strict(),
  ]),
);
export type SourceConnections = z.infer<typeof connectionsSchema>;
const text = z
  .array(z.object({ plain_text: z.string() }))
  .transform((parts) => parts.map((p) => p.plain_text).join(""));
const notionPage = z.object({
  object: z.literal("page"),
  id: z.string().min(1),
  url: z.string(),
  last_edited_time: z.string(),
  properties: z.record(z.string(), z.record(z.string(), z.unknown())),
});
const discordMessage = z.object({
  id: z.string().regex(/^\d{17,20}$/),
  channel_id: z.string(),
  content: z.string(),
  timestamp: z.string(),
  edited_timestamp: z.string().nullable(),
  author: z.object({ id: z.string(), username: z.string() }),
});

export async function readRemoteSource(
  connector: "notion" | "discord",
  name: string,
  ontology: string,
  connections: SourceConnections,
  request: typeof fetch = fetch,
): Promise<Record<string, unknown>[]> {
  const connection = Object.hasOwn(connections, name)
    ? connections[name]
    : undefined;
  if (
    !connection ||
    connection.connector !== connector ||
    !connection.ontologies.includes(ontology)
  )
    throw new PlatformError(
      422,
      "Source connection is not configured for this connector and ontology",
    );
  const get = async (url: string, body?: unknown): Promise<unknown> => {
    let response: Response;
    try {
      response = await request(url, {
        method: body === undefined ? "GET" : "POST",
        redirect: "error",
        signal: AbortSignal.timeout(15000),
        headers:
          connector === "notion"
            ? {
                authorization: `Bearer ${connection.token}`,
                "Notion-Version": "2025-09-03",
                "content-type": "application/json",
              }
            : { authorization: `Bot ${connection.token}` },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new PlatformError(
        422,
        `${connector} read failed; check connection and retry`,
      );
    }
    if (!response.ok)
      throw new PlatformError(
        422,
        `${connector} read failed (${response.status}); check permissions or rate limits`,
      );
    if (!response.body)
      throw new PlatformError(422, `${connector} returned an empty response`);
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.length;
        if (size > 2_000_000) throw new Error("page too large");
        chunks.push(part.value);
      }
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      await reader.cancel().catch(() => {});
      throw new PlatformError(
        422,
        `${connector} returned invalid or oversized content`,
      );
    } finally {
      reader.releaseLock();
    }
  };
  const records: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < 21; page++) {
    let next: string | undefined;
    if (connector === "notion") {
      if (page > 0) await setTimeout(350);
      const parsed = z
        .object({
          results: z.array(notionPage),
          has_more: z.boolean(),
          next_cursor: z.string().nullable(),
        })
        .safeParse(
          await get(
            `https://api.notion.com/v1/data_sources/${connection.resource}/query`,
            { page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) },
          ),
        );
      if (!parsed.success)
        throw new PlatformError(422, "Invalid Notion page response");
      for (const p of parsed.data.results) {
        const row: Record<string, unknown> = {
          id: p.id,
          url: p.url,
          last_edited_time: p.last_edited_time,
        };
        for (const [key, property] of Object.entries(p.properties)) {
          let value: unknown;
          switch (property.type) {
            case "title":
            case "rich_text":
              const parsedText = text.safeParse(
                property[String(property.type)],
              );
              if (!parsedText.success)
                throw new PlatformError(422, "Invalid Notion text property");
              value = parsedText.data;
              break;
            case "number":
            case "checkbox":
            case "url":
            case "email":
            case "phone_number":
              value = property[String(property.type)];
              break;
            case "select":
            case "status":
              value = (
                property[String(property.type)] as { name?: string } | null
              )?.name;
              break;
            case "date":
              value = (property.date as { start?: string } | null)?.start;
              break;
          }
          if (
            typeof value === "string" ||
            typeof value === "boolean" ||
            typeof value === "number"
          )
            row[`property:${key}`] = value;
        }
        records.push(row);
      }
      if (parsed.data.has_more) {
        if (!parsed.data.next_cursor)
          throw new PlatformError(422, "Missing Notion continuation cursor");
        next = parsed.data.next_cursor;
      }
    } else {
      const parsed = z
        .array(discordMessage)
        .max(100)
        .safeParse(
          await get(
            `https://discord.com/api/v10/channels/${connection.resource}/messages?limit=100${cursor ? `&before=${cursor}` : ""}`,
          ),
        );
      if (
        !parsed.success ||
        parsed.data.some((m) => m.channel_id !== connection.resource)
      )
        throw new PlatformError(422, "Invalid Discord message response");
      for (const m of parsed.data) {
        if (cursor && BigInt(m.id) >= BigInt(cursor))
          throw new PlatformError(422, "Discord pagination did not advance");
        records.push({
          id: m.id,
          content: m.content,
          channel_id: m.channel_id,
          author_id: m.author.id,
          author_name: m.author.username,
          timestamp: m.timestamp,
          edited_timestamp: m.edited_timestamp ?? "",
        });
      }
      if (parsed.data.length === 100)
        next = parsed.data.reduce(
          (a, m) => (BigInt(a) < BigInt(m.id) ? a : m.id),
          parsed.data[0].id,
        );
    }
    if (records.length > 2000) break;
    if (!next) return records;
    if (seen.has(next))
      throw new PlatformError(422, "Repeated source pagination cursor");
    seen.add(next);
    cursor = next;
  }
  throw new PlatformError(
    422,
    "Source exceeds the 2,000-record snapshot limit; no changes applied",
  );
}
