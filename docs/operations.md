# Operating Graph

## Diagnose

`pnpm doctor:graph` checks a real database query, visible ontologies, source checkpoints, and agent mode through HTTP. Use the explicit script name: `pnpm doctor` invokes pnpm's unrelated built-in diagnostic command.

`GET /api/metrics` reports process uptime and per-route request counts, errors, total response time, and mean milliseconds. Fastify request IDs are returned in error bodies and `x-request-id` headers. Check application logs for server errors without exposing connector or model credentials.

## Source sync

For Notion and Discord setup, fields, credential restrictions, and add/update-only semantics, see [connectors](connectors.md). Configure `GRAPH_SOURCE_CONNECTIONS` on the server; credentials never belong in source mappings. Remote sources preview and apply from the same console without uploading files.

The seed registers packaging CSV, driver JSON, and a public GitHub repository source. The operations console previews a snapshot before applying it. File contents are uploaded; the API does not read arbitrary server paths or fetch arbitrary URLs.

A source mapping defines its object type, external ID field, mapped properties, optional existing object-ID field, and optional shared identity field. Shared identities are normalized by trimming and case-folding, then scoped by ontology and type. This is explicit deterministic resolution, not fuzzy entity matching. Mapping definitions are immutable; use a new source ID to change them.

JSON/CSV syncs support at most 2,000 rows per request. GitHub syncs support at most ten 100-item pages and reject a possibly incomplete result at the limit. Only public repositories are read, without credentials; pull requests are excluded from issue records. GitHub rate-limit or network errors do not advance checkpoints.

Successful sync writes operational changes, history, mappings, checkpoint, and run result together. No-op replay leaves the graph revision unchanged. Source-managed manual edits and manual deletions conflict instead of being overwritten. Removing a source-created entity requires no remaining relationships, no other contributor, and no manual extension. Pre-existing objects are not automatically deleted by losing one source row. Use explicit graph edits after reviewing those cases.

`expectedCheckpoint` binds an apply request to the exact previewed content. `expectedRevision` rejects a changed live graph. Uploads use full source snapshots; they are not append feeds. Background scheduling, resumable large imports, and CDC are not implemented.

## Approvals and external execution

Propose → review digest → approve/reject → execute → record result.

Execution checks the stored approval digest, proposal version, live revision, and scenario version. Replaying a succeeded action returns its existing result. Concurrent execution cannot issue a second POST from this API process. A definite failure is terminal; correct the cause and create a newly reviewed proposal. An ambiguous result becomes `uncertain`, and an interrupted `executing` record is eligible for reconciliation after its timeout. Reconciliation reads the configured repository and looks for the unique `graph-action` marker. It never creates another issue.

The connector scans at most 1,000 issues for reconciliation; beyond that, it refuses to assume the action is absent. GitHub delivery is not exactly-once, and the application cannot guarantee that a remote operation rolls back after a lost response. Use a small demonstration repository.

No external issue is created automatically by seeding, calculating, investigating, proposing, or approving. The agent has no approval/execution tool or scope.

## Model setup

The default mode uses deterministic discovery, traversal, and function tools. A configured compatible Chat Completions endpoint enables model-driven tool selection. Hosted keys remain in the server environment. Read-graph results and source text are treated as untrusted evidence, not system instructions. Investigations have a 60-second timeout and a maximum of 16 tool calls, and cannot succeed without a completed deterministic calculation.

The adapter supports standard function-tool messages. It does not implement every vendor extension, streaming, provider fallback, or sandbox arbitrary code. A model's prose can still be wrong: inspect the structured calculation and trace. Historical summaries are context, not current operational truth.

## Backup and restore

```sh
pnpm backup semiconductor /path/to/semiconductor-backup.json
pnpm restore semiconductor /path/to/semiconductor-backup.json --confirm=semiconductor
```

The browser provides the same export and restore flow. The archive includes the schema, operational state, source/checkpoint records, history, pinned scenario bases/overlays, and calculation/investigation records. A SHA-256 checksum detects accidental changes. This is not a signed or encrypted archive; protect it as business data.

Credentials and executable action approvals are excluded. The destination ontology must already exist, and its schema must support the archive. Restoration requires admin scope, an explicit ontology confirmation, and the current revision. State and documents are restored in one graph write; the revision advances beyond the archive/current values so old approvals cannot execute against restored state.

This is a logical prototype backup, not point-in-time recovery, automatic retention, encryption, or a substitute for volume-level operational backups. Keep exported backups outside the container. A named Docker volume alone is persistence, not a backup strategy.

## Access controls

Configure `GRAPH_API_TOKENS` as server-side JSON. Each secret must be at least 24 characters. Scopes are `read`, `write`, `approve`, `execute`, and `admin`; optional ontology lists constrain access. Tokens are never stored in graph documents or exported archives. The web shell remains accessible so a user can enter a session credential; business API endpoints require authentication when tokens are configured.

The default loopback workspace has a local owner without a token. Explicit Host/Origin validation helps protect it from foreign browser origins and DNS rebinding. Custom hosting requires explicit host/origin configuration, valid credentials, transport security, and operational deployment work. There is no enterprise user directory or per-object/property authorization.

## Failure boundaries

The write queue belongs to one API process. Do not run multiple replicas or mutate the database directly. Native property backfill at startup upgrades records from earlier milestones without changing their semantic revisions. The graph is intended for small datasets; full-state copies, historical scans, and function execution remain bounded by this prototype's size limits.

External calls are bounded but remain synchronous. A process restart does not automatically replay work. Source sync can be re-run; external actions use explicit status and reconciliation rather than blind retries. There is no durable job scheduler or distributed lease manager yet.
