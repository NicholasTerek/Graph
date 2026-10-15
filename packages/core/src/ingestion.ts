import { createHash, randomUUID } from "node:crypto";
import { parse } from "csv-parse/sync";
import {
  identifier,
  sourceSchema,
  type Source,
  type SourceConfig,
  type GraphObject,
  type GraphRelationship,
  type SyncResult,
  type SourceStatus,
} from "@graph/contracts";
import { GraphStore } from "./store.js";
import { canonical } from "./state.js";
import { PlatformError, validateIngestion } from "./validation.js";
import { readRemoteSource, type SourceConnections } from "./connectors.js";
const hash = (value: unknown) =>
  createHash("sha256").update(canonical(value)).digest("hex");
export class SourceService {
  constructor(
    private store: GraphStore,
    private request: typeof fetch = fetch,
    private connections: SourceConnections = {},
  ) {}
  async list(ontology: string) {
    await this.store.ontology(ontology);
    return this.store.documents<Source>("source", ontology);
  }
  async get(ontology: string, id: string) {
    const source = await this.store.document<Source>("source", ontology, id);
    if (!source) throw new PlatformError(404, `Source not found: ${id}`);
    return source;
  }
  async statuses(ontology: string): Promise<SourceStatus[]> {
    return this.store.exclusive(async () => {
      const sources = await this.list(ontology);
      const latest = new Map<string, SyncResult>();
      for (const run of await this.store.documents<SyncResult>(
        "sync",
        ontology,
      )) {
        const previous = latest.get(run.sourceId);
        if (
          !previous ||
          run.finishedAt > previous.finishedAt ||
          (run.finishedAt === previous.finishedAt && run.id > previous.id)
        )
          latest.set(run.sourceId, run);
      }
      return sources.map((source) => {
        const remote =
          source.connector === "notion" || source.connector === "discord";
        const connection =
          source.connection &&
          Object.hasOwn(this.connections, source.connection)
            ? this.connections[source.connection]
            : undefined;
        const configured =
          connection?.connector === source.connector &&
          connection.ontologies.includes(ontology);
        const connectionState = remote
          ? configured
            ? "configured"
            : "unavailable"
          : source.connector === "github"
            ? "public"
            : "upload";
        const last = latest.get(source.id);
        const guidance =
          connectionState === "unavailable"
            ? [
                `Configure the named ${source.connector} connection on the server for this ontology.`,
                source.connector === "notion"
                  ? "Share the data source with the integration and grant read access."
                  : "Grant the bot View Channel, Read Message History and the required Message Content intent.",
              ]
            : connectionState === "configured"
              ? [
                  "Server connection is configured. Preview sync to check access; this status does not contact the provider.",
                ]
              : connectionState === "public"
                ? [
                    "Reads public repository metadata or issues. Preview sync to check the repository and current rate limit.",
                  ]
                : [
                    "Upload a complete CSV or JSON snapshot, then review the preview before applying.",
                  ];
        if (last?.status === "failed") {
          if (/read failed \((401|403)\)/.test(last.error ?? ""))
            guidance.push(
              "The provider rejected access. Check the server credential and resource permissions before retrying preview.",
            );
          else if (/read failed \(429\)/.test(last.error ?? ""))
            guidance.push(
              "The provider rate-limited the request. Wait before retrying preview; no partial snapshot was applied.",
            );
          else if (/Source connection is not configured/.test(last.error ?? ""))
            guidance.push(
              "The named connection must match both the connector and ontology allowlist.",
            );
          else
            guidance.push(
              "Review the last sync error and preview again after correcting the input or connection.",
            );
        }
        return {
          sourceId: source.id,
          connector: source.connector,
          connectionState,
          connectivity: "not_probed",
          lastSuccessfulSync: source.lastSyncedAt,
          lastAttempt: last
            ? {
                status: last.status,
                at: last.finishedAt,
                ...(last.error ? { error: last.error } : {}),
              }
            : null,
          guidance,
        };
      });
    });
  }
  async register(ontology: string, config: SourceConfig) {
    config = sourceSchema.parse(config);
    return this.store.exclusive(async () => {
      const schema = await this.store.ontology(ontology);
      if (!schema.objectTypes.some((t) => t.name === config.mapping.type))
        throw new PlatformError(
          422,
          "Mapping references an unknown object type",
        );
      const names = new Set<string>();
      for (const mapping of config.mapping.relationships ?? []) {
        if (names.has(mapping.id))
          throw new PlatformError(422, "Duplicate relationship mapping ID");
        names.add(mapping.id);
        const relation = schema.relationshipTypes.find(
          (r) => r.name === mapping.type,
        );
        if (!relation)
          throw new PlatformError(
            422,
            "Mapping references an unknown relationship type",
          );
        const incoming = mapping.direction === "in";
        if (
          (incoming ? relation.to : relation.from) !== config.mapping.type ||
          ("type" in mapping.target &&
            mapping.target.type !== (incoming ? relation.from : relation.to))
        )
          throw new PlatformError(
            422,
            "Relationship mapping endpoint types do not match the ontology",
          );
      }
      const previous = await this.store.document<Source>(
        "source",
        ontology,
        config.id,
      );
      if (previous) {
        const {
          version,
          checkpoint,
          lastSyncedAt,
          managed,
          managedRelationships,
          ...old
        } = previous;
        if (canonical(old) !== canonical(config))
          throw new PlatformError(
            409,
            "Source mapping is immutable; register a new source ID",
          );
        return previous;
      }
      const source: Source = {
        ...sourceSchema.parse(config),
        version: 0,
        checkpoint: null,
        lastSyncedAt: null,
        managed: {},
      };
      await this.store.saveDocument("source", ontology, source.id, source);
      return source;
    });
  }
  private async github(repository: string, resource: string) {
    const records: Record<string, unknown>[] = [];
    const get = async (url: string) => {
      const response = await this.request(url, {
        headers: {
          accept: "application/vnd.github+json",
          "user-agent": "Graph-Ontology",
        },
        signal: AbortSignal.timeout(15000),
        redirect: "error",
      });
      if (!response.ok)
        throw new PlatformError(422, `GitHub read failed (${response.status})`);
      return response.json();
    };
    const repo = await get(`https://api.github.com/repos/${repository}`);
    if (resource === "repository" && repo.private === false) return [repo];
    if (repo.private !== false)
      throw new PlatformError(422, "Only public repositories may be ingested");
    for (let page = 1; page <= 10; page++) {
      const batch = await get(
        `https://api.github.com/repos/${repository}/issues?state=all&per_page=100&page=${page}`,
      );
      if (!Array.isArray(batch))
        throw new PlatformError(422, "Invalid GitHub issue response");
      records.push(
        ...batch.filter((r: Record<string, unknown>) => !r.pull_request),
      );
      if (batch.length < 100) return records;
    }
    throw new PlatformError(
      422,
      "Source exceeds the 1,000-record GitHub sync limit; refusing an incomplete snapshot",
    );
  }
  async sync(
    ontology: string,
    id: string,
    input: {
      content?: string;
      dryRun: boolean;
      expectedRevision?: number;
      expectedCheckpoint?: string;
    },
  ): Promise<SyncResult> {
    const source = await this.get(ontology, id);
    const startedAt = new Date().toISOString();
    const runId = `sync-${randomUUID()}`;
    try {
      let records: Record<string, unknown>[];
      if (source.connector === "notion" || source.connector === "discord") {
        if (input.content !== undefined)
          throw new PlatformError(
            400,
            "Remote sources fetch their configured connection",
          );
        records = await readRemoteSource(
          source.connector,
          source.connection!,
          ontology,
          this.connections,
          this.request,
        );
      } else if (source.connector === "github") {
        if (input.content !== undefined)
          throw new PlatformError(
            400,
            "GitHub sources fetch their configured public repository",
          );
        records = await this.github(source.repository!, source.githubResource);
      } else {
        if (input.content === undefined)
          throw new PlatformError(400, "CSV and JSON sync require content");
        try {
          records =
            source.connector === "csv"
              ? parse(input.content, {
                  columns: true,
                  skip_empty_lines: true,
                  bom: true,
                })
              : JSON.parse(input.content);
        } catch {
          throw new PlatformError(400, "Could not parse the source content");
        }
      }
      if (
        !Array.isArray(records) ||
        records.length > 2000 ||
        records.some((r) => !r || typeof r !== "object" || Array.isArray(r))
      )
        throw new PlatformError(
          422,
          "Source content must contain at most 2,000 record objects",
        );
      const checkpoint = hash(records);
      if (input.expectedCheckpoint && input.expectedCheckpoint !== checkpoint)
        throw new PlatformError(
          409,
          "Source changed after preview; review the new snapshot",
        );
      const observedAt = new Date().toISOString();
      const outcome = await this.store.transact(
        ontology,
        input.expectedRevision,
        async (state, schema) => {
          const current = await this.get(ontology, id);
          if (current.version !== source.version)
            throw new PlatformError(409, "Source changed during sync; retry");
          const type = schema.objectTypes.find(
            (t) => t.name === source.mapping.type,
          )!;
          const objects = new Map(state.objects.map((o) => [o.id, o]));
          const managed: Source["managed"] = Object.create(null);
          const relationships = new Map(
            state.relationships.map((r) => [r.id, r]),
          );
          const managedRelationships: NonNullable<
            Source["managedRelationships"]
          > = Object.create(null);
          const relationshipChanges = {
            added: [] as string[],
            updated: [] as string[],
            removed: [] as string[],
            unchanged: 0,
          };
          const mappedRows: {
            record: Record<string, unknown>;
            objectId: string;
            externalId: string;
          }[] = [];
          const added: string[] = [],
            updated: string[] = [],
            removed: string[] = [];
          let unchanged = 0;
          const externalIds = new Set<string>();
          let mappedRelationshipCount = 0;
          for (const record of records) {
            const rawId = record[source.mapping.idField];
            if (rawId === null || rawId === undefined || String(rawId) === "")
              throw new PlatformError(
                422,
                "A source record is missing its external ID",
              );
            const externalId = String(rawId);
            if (externalIds.has(externalId))
              throw new PlatformError(
                422,
                `Duplicate external ID: ${externalId}`,
              );
            externalIds.add(externalId);
            const identity = source.mapping.identityField
              ? record[source.mapping.identityField]
              : externalId;
            if (
              identity === null ||
              identity === undefined ||
              String(identity).trim() === ""
            )
              throw new PlatformError(422, "Missing entity identity value");
            const objectId = source.mapping.objectIdField
              ? identifier.parse(record[source.mapping.objectIdField])
              : `entity-${hash([ontology, type.name, source.mapping.identityField ? "shared" : id, String(identity).trim().toLowerCase()]).slice(0, 24)}`;
            if (managed[objectId])
              throw new PlatformError(
                422,
                "Multiple source rows resolve to the same entity; supply a unique identity",
              );
            mappedRows.push({ record, objectId, externalId });
            const fields: GraphObject["properties"] = {};
            for (const [key, mapping] of Object.entries(
              source.mapping.properties,
            )) {
              const definition = type.properties[key];
              if (!definition)
                throw new PlatformError(422, `Unknown mapped property: ${key}`);
              let value =
                "value" in mapping ? mapping.value : record[mapping.field];
              if (value === undefined || value === null)
                throw new PlatformError(422, `Missing mapped value for ${key}`);
              if (definition.type === "number") {
                if (value === "")
                  throw new PlatformError(422, `Empty numeric field ${key}`);
                value = Number(value);
                if (!Number.isFinite(value))
                  throw new PlatformError(422, `Invalid number for ${key}`);
              }
              if (definition.type === "boolean") {
                if (
                  ![true, false, "true", "false", "1", "0", 1, 0].includes(
                    value as string,
                  )
                )
                  throw new PlatformError(422, `Invalid boolean for ${key}`);
                value = [true, "true", "1", 1].includes(value as string);
              }
              if (definition.type === "string") value = String(value);
              fields[key] = value as string | number | boolean;
            }
            const previous = objects.get(objectId);
            const last = Object.hasOwn(current.managed, objectId)
              ? current.managed[objectId]
              : undefined;
            if (!previous && last)
              throw new PlatformError(
                409,
                `Source entity was deleted outside synchronization: ${objectId}`,
              );
            if (previous && previous.type !== type.name)
              throw new PlatformError(
                409,
                `Entity identity collides with a different type: ${objectId}`,
              );
            if (
              previous &&
              last &&
              Object.entries(last.fields).some(
                ([key, value]) =>
                  canonical(previous.properties[key]) !== canonical(value),
              )
            )
              throw new PlatformError(
                409,
                `Source-managed fields were edited outside this source: ${objectId}`,
              );
            managed[objectId] = {
              externalId,
              fields,
              created: last?.created ?? !previous,
            };
            if (
              previous &&
              Object.entries(fields).every(
                ([key, value]) =>
                  canonical(previous.properties[key]) === canonical(value),
              )
            ) {
              unchanged++;
              continue;
            }
            const object: GraphObject = {
              id: objectId,
              type: type.name,
              properties: { ...previous?.properties, ...fields },
              provenance: { source: id, externalId, observedAt },
            };
            objects.set(objectId, object);
            (previous ? updated : added).push(objectId);
          }
          const peers = await this.list(ontology);
          for (const { record, objectId, externalId } of mappedRows) {
            for (const mapping of source.mapping.relationships ?? []) {
              const selector =
                "objectId" in mapping.target
                  ? mapping.target.objectId
                  : mapping.target.identity;
              const raw =
                "value" in selector ? selector.value : record[selector.field];
              if (
                raw === null ||
                raw === undefined ||
                String(raw).trim() === ""
              ) {
                if (mapping.optional) continue;
                throw new PlatformError(
                  422,
                  `Missing target for relationship mapping ${mapping.id} in row ${externalId}`,
                );
              }
              if (!["string", "number", "boolean"].includes(typeof raw))
                throw new PlatformError(
                  422,
                  `Invalid target for relationship mapping ${mapping.id}`,
                );
              const targetId =
                "objectId" in mapping.target
                  ? identifier.safeParse(raw)
                  : {
                      success: true as const,
                      data: `entity-${hash([ontology, mapping.target.type, "shared", String(raw).trim().toLowerCase()]).slice(0, 24)}`,
                    };
              if (!targetId.success)
                throw new PlatformError(
                  422,
                  `Invalid target object ID for relationship mapping ${mapping.id}`,
                );
              if (!objects.has(targetId.data))
                throw new PlatformError(
                  422,
                  `Target not found for relationship mapping ${mapping.id} in row ${externalId}: ${targetId.data}`,
                );
              const relationshipId = `link-${hash([ontology, id, mapping.id, externalId]).slice(0, 24)}`;
              const previous = relationships.get(relationshipId);
              const last = current.managedRelationships?.[relationshipId];
              if (
                last &&
                (!previous ||
                  canonical(previous) !== canonical(last.relationship))
              )
                throw new PlatformError(
                  409,
                  `Source-managed relationship was changed outside this source: ${relationshipId}`,
                );
              const from =
                mapping.direction === "in" ? targetId.data : objectId;
              const to = mapping.direction === "in" ? objectId : targetId.data;
              const matches =
                previous?.type === mapping.type &&
                previous.from === from &&
                previous.to === to;
              if (previous && !last && !matches)
                throw new PlatformError(
                  409,
                  `Relationship identity collides with an existing link: ${relationshipId}`,
                );
              const relationship: GraphRelationship = matches
                ? previous!
                : {
                    id: relationshipId,
                    type: mapping.type,
                    from,
                    to,
                    provenance: { source: id, externalId, observedAt },
                  };
              managedRelationships[relationshipId] = {
                externalId,
                relationship,
                created: last?.created ?? !previous,
              };
              if (++mappedRelationshipCount > 5000)
                throw new PlatformError(
                  422,
                  "Source exceeds the 5,000-relationship snapshot limit",
                );
              relationships.set(relationshipId, relationship);
              if (matches) relationshipChanges.unchanged++;
              else
                (previous
                  ? relationshipChanges.updated
                  : relationshipChanges.added
                ).push(relationshipId);
            }
          }
          for (const [relationshipId, last] of Object.entries(
            current.managedRelationships ?? {},
          )) {
            if (managedRelationships[relationshipId]) continue;
            if (["notion", "discord"].includes(source.connector)) {
              managedRelationships[relationshipId] = last;
              continue;
            }
            if (
              peers.some(
                (peer) =>
                  peer.id !== id &&
                  Object.hasOwn(
                    peer.managedRelationships ?? {},
                    relationshipId,
                  ),
              )
            )
              continue;
            const previous = relationships.get(relationshipId);
            if (
              !previous ||
              !last.created ||
              canonical(previous) !== canonical(last.relationship)
            )
              throw new PlatformError(
                409,
                `Cannot delete a pre-existing or externally changed relationship: ${relationshipId}`,
              );
            relationships.delete(relationshipId);
            relationshipChanges.removed.push(relationshipId);
          }

          for (const objectId of Object.keys(current.managed))
            if (!managed[objectId]) {
              if (
                source.connector === "notion" ||
                source.connector === "discord"
              ) {
                managed[objectId] = current.managed[objectId];
                continue;
              }
              if (
                peers.some(
                  (peer) =>
                    peer.id !== id && Object.hasOwn(peer.managed, objectId),
                )
              )
                continue;
              const previous = objects.get(objectId);
              if (!previous) continue;
              if (
                !current.managed[objectId].created ||
                Object.keys(previous.properties).some(
                  (key) =>
                    !Object.hasOwn(current.managed[objectId].fields, key),
                )
              )
                throw new PlatformError(
                  409,
                  `Cannot delete a pre-existing or manually extended entity: ${objectId}`,
                );
              if (
                Object.entries(current.managed[objectId].fields).some(
                  ([key, value]) =>
                    canonical(previous.properties[key]) !== canonical(value),
                )
              )
                throw new PlatformError(
                  409,
                  `Cannot delete an externally edited entity: ${objectId}`,
                );
              if (
                [...relationships.values()].some(
                  (r) => r.from === objectId || r.to === objectId,
                )
              )
                throw new PlatformError(
                  409,
                  `Missing source entity ${objectId} still has relationships; remove links explicitly before syncing deletion`,
                );
              objects.delete(objectId);
              removed.push(objectId);
            }
          const candidate = {
            objects: [...objects.values()],
            relationships: [...relationships.values()],
          };
          validateIngestion(
            schema,
            { objects: [], relationships: [] },
            candidate,
          );
          const changed =
            added.length +
            updated.length +
            removed.length +
            relationshipChanges.added.length +
            relationshipChanges.updated.length +
            relationshipChanges.removed.length;
          const revision = state.revision + (changed ? 1 : 0);
          const result: SyncResult = {
            id: runId,
            sourceId: id,
            status: input.dryRun ? "preview" : "succeeded",
            revision,
            added,
            updated,
            removed,
            unchanged,
            relationships: relationshipChanges,
            checkpoint,
            startedAt,
            finishedAt: new Date().toISOString(),
          };
          if (input.dryRun) return { state, result };
          return {
            state: candidate,
            documents: [
              {
                kind: "source",
                id,
                value: {
                  ...current,
                  version: current.version + 1,
                  managed,
                  managedRelationships,
                  checkpoint,
                  lastSyncedAt: observedAt,
                },
              },
              { kind: "sync", id: runId, value: result },
            ],
            result,
          };
        },
      );
      return outcome.result;
    } catch (error) {
      await this.store.exclusive(() =>
        this.store.saveDocument("sync", ontology, runId, {
          id: runId,
          sourceId: id,
          status: "failed",
          error: error instanceof Error ? error.message : "Sync failed",
          startedAt,
          finishedAt: new Date().toISOString(),
        }),
      );
      throw error;
    }
  }
  async history(ontology: string, id: string) {
    await this.get(ontology, id);
    return (await this.store.documents<SyncResult>("sync", ontology)).filter(
      (r) => r.sourceId === id,
    );
  }
}
