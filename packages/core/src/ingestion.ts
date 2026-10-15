import { createHash, randomUUID } from "node:crypto";
import { parse } from "csv-parse/sync";
import {
  identifier,
  sourceSchema,
  type Source,
  type SourceConfig,
  type GraphObject,
  type SyncResult,
} from "@graph/contracts";
import { GraphStore } from "./store.js";
import { canonical } from "./state.js";
import { PlatformError } from "./validation.js";
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
  async register(ontology: string, config: SourceConfig) {
    return this.store.exclusive(async () => {
      const schema = await this.store.ontology(ontology);
      if (!schema.objectTypes.some((t) => t.name === config.mapping.type))
        throw new PlatformError(
          422,
          "Mapping references an unknown object type",
        );
      const previous = await this.store.document<Source>(
        "source",
        ontology,
        config.id,
      );
      if (previous) {
        const { version, checkpoint, lastSyncedAt, managed, ...old } = previous;
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
          const added: string[] = [],
            updated: string[] = [],
            removed: string[] = [];
          let unchanged = 0;
          const externalIds = new Set<string>();
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
                state.relationships.some(
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
          const changed = added.length + updated.length + removed.length;
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
            checkpoint,
            startedAt,
            finishedAt: new Date().toISOString(),
          };
          if (input.dryRun) return { state, result };
          return {
            state: {
              objects: [...objects.values()],
              relationships: state.relationships,
            },
            documents: [
              {
                kind: "source",
                id,
                value: {
                  ...current,
                  version: current.version + 1,
                  managed,
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
