# Small remote connectors

Notion and Discord use the same source mappings, preview/checkpoint binding, history, conflict detection, SDK methods, and operations console as file sources. They are explicit, bounded readers, not OAuth integrations or continuous sync services. No connector-specific application code is required.

## Configure connections

Set `GRAPH_SOURCE_CONNECTIONS` to a JSON object in the server environment, then restart. With Compose, quote the whole value in `.env`:

```dotenv
GRAPH_SOURCE_CONNECTIONS='{"team-notes":{"connector":"notion","token":"YOUR_NOTION_CONNECTION_TOKEN","resource":"YOUR_DATA_SOURCE_UUID","ontologies":["semiconductor"]},"team-chat":{"connector":"discord","token":"YOUR_DISCORD_BOT_TOKEN","resource":"YOUR_CHANNEL_SNOWFLAKE","ontologies":["semiconductor"]}}'
```

Replace the resource placeholders with actual IDs. Each named connection permits one fixed resource and an explicit list of ontologies. Tokens stay in server configuration; source registration stores only the connection name. They are excluded from API responses and logical backups. HTTP targets are fixed provider endpoints and redirects are refused. Connector configuration is trusted operator configuration; this is not a credential-management UI.

## Notion

Use a Notion connection with read-content access and share the relevant database with it. Use the **data source ID**, which is distinct from the database ID in newer Notion APIs. The connector uses `POST /v1/data_sources/:id/query` with `Notion-Version: 2025-09-03`. This POST reads data; it does not modify Notion.

Rows expose `id`, `url`, `last_edited_time`, and supported values under `property:NAME`. Supported properties: title/rich text (concatenated plain text), number, checkbox, select/status (name), date (start), URL, email, and phone number. Null/unsupported values are omitted; mapping a missing required value fails. Blocks, nested documents, attachments, people, relations, formulas, rollups, rich formatting, and property-item pagination are not imported. Those require additional endpoints and data modeling.

Example mapping for an existing `Issue` type:

```ts
await client.registerSource("semiconductor", {
  id: "notion-issues",
  name: "Engineering notes",
  connector: "notion",
  connection: "team-notes",
  mapping: {
    type: "Issue",
    idField: "id",
    properties: {
      name: { field: "property:Name" },
      status: { field: "property:Status" },
      fixDays: { field: "property:Fix days" },
    },
  },
});
```

## Discord

Create/install a Discord bot in your demonstration server and give it `VIEW_CHANNEL` and `READ_MESSAGE_HISTORY` for the configured channel. Enable the Message Content privileged intent when reading ordinary message text. Without it Discord may return empty content. The reader does not infer whether an empty string means an intentionally empty message or missing intent. Use a bot token, not a user token.

The reader paginates `GET /api/v10/channels/:id/messages` using exact snowflake strings, newest to oldest. Exposed fields: `id`, `content`, `channel_id`, `author_id`, `author_name`, `timestamp`, `edited_timestamp` (empty when absent). It imports one channel, not its threads or an entire server. Attachments, embeds, reactions, files, gateway events, and message sending are outside this connector.

For an `Issue` mapping, use `name: {field: 'content'}`, `status: {value: 'open'}`, and `fixDays: {value: 0}`. That is an explicit operator mapping, not automatic extraction of actionable issues from chat.

## Preview and apply

```ts
const preview = await client.syncSource("semiconductor", "notion-issues", {
  dryRun: true,
});
await client.syncSource("semiconductor", "notion-issues", {
  dryRun: false,
  expectedCheckpoint: preview.checkpoint,
});
```

Alternatively register the JSON mapping in Operations console and use Preview sync, then Apply. No file upload is needed for remote sources. Mapping properties must match the ontology. Mapping changes require a new source ID.

Remote imports are capped at 2,000 records, 21 page requests, 2 MB per response page, and 15 seconds per request. Notion page requests are paced. Rate limits, network failures, invalid responses, repeated cursors, and oversized/incomplete results fail without applying any records or advancing checkpoints. There is no durable retry queue. Preview and apply each fetch the provider; changed content requires a fresh preview.

**Notion and Discord imports only add/update visible records.** Absence never deletes a previously mapped entity: permission changes, archived pages, and mutable pagination do not establish deletion. Historical mappings remain so later reappearance still detects manual edits. Deletion requires an explicit reviewed graph operation. Concurrent provider changes are not a transactionally consistent source snapshot. This is a deliberate safety/complexity tradeoff for the initial readers.

Protocol and graph/API behavior are tested with fixtures, including pagination, failure/checkpoint isolation, retained records, and secret exclusion. No live Notion or Discord account was configured during verification.

References: [Notion query](https://developers.notion.com/reference/query-a-data-source), [Notion properties](https://developers.notion.com/reference/page-property-values), [Discord messages](https://docs.discord.com/developers/resources/message).
