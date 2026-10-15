import { createHash, randomUUID } from "node:crypto";
import {
  backupSchema,
  jobRecordSchema,
  sourceScheduleSchema,
  type BackupArchive,
} from "@graph/contracts";
import { GraphStore } from "./store.js";
import { canonical } from "./state.js";
import { PlatformError, isAdditiveSchema } from "./validation.js";
import { ScenarioService } from "./scenarios.js";
import type { Scenario } from "@graph/contracts";
const kinds = [
  "source",
  "sync",
  "history",
  "base",
  "scenario",
  "run",
  "promotion",
  "investigation",
  "job",
  "schedule",
] as const;
const digest = (value: unknown) =>
  createHash("sha256").update(canonical(value)).digest("hex");
export class BackupService {
  constructor(private store: GraphStore) {}
  async export(ontology: string): Promise<BackupArchive> {
    return this.store.exclusive(async () => {
      const schema = await this.store.ontology(ontology);
      const state = await this.store.snapshot(ontology);
      const revision = await this.store.revision(ontology);
      const documents: BackupArchive["documents"] = [];
      const scenarios = new ScenarioService(this.store);
      for (const kind of kinds)
        for (const document of await this.store.documentEntries(
          kind,
          ontology,
        )) {
          let value = document.value;
          if (kind === "job") {
            const job = value as import("@graph/contracts").JobRecord;
            const { lease, leaseUntil, ...portable } = job;
            value = ["queued", "running", "retrying"].includes(job.status)
              ? {
                  ...portable,
                  status: "interrupted",
                  error:
                    "Restored job history is not executable; explicitly retry after reviewing context",
                }
              : portable;
          }
          if (kind === "schedule")
            value = { ...(value as object), enabled: false };

          if (
            kind === "base" &&
            (value as { storage?: string }).storage === "falkordb"
          ) {
            const base = value as import("./native-graphs.js").NativeBase;
            value = {
              ...(await this.store.nativeGraphs.snapshot(
                ontology,
                base.graphKey,
              )),
              revision: base.revision,
            };
          }
          if (kind === "scenario") {
            const {
              storage,
              graphKey,
              baseGraphKey,
              historyGeneration,
              strategy,
              ...portable
            } = await scenarios.get(ontology, (value as Scenario).id);
            value = portable;
            if (
              storage === "falkordb-overlay" &&
              !documents.some(
                (d) =>
                  d.kind === "base" && d.id === String(portable.baseRevision),
              )
            ) {
              documents.push({
                kind: "base",
                id: String(portable.baseRevision),
                value: await scenarios.base(
                  await scenarios.reference(ontology, portable.id),
                ),
              });
            }
          }
          documents.push({ kind, id: document.id, value });
        }
      const payload = {
        format: "graph-backup-v1" as const,
        createdAt: new Date().toISOString(),
        ontology: schema,
        revision,
        state,
        documents,
      };
      return { ...payload, digest: digest(payload) };
    });
  }
  async restore(
    ontology: string,
    input: {
      archive: BackupArchive;
      expectedRevision: number;
      confirmOntology: string;
    },
    actor: string,
  ) {
    const archive = backupSchema.parse(input.archive);
    const { digest: checksum, ...payload } = archive;
    if (checksum !== digest(payload))
      throw new PlatformError(422, "Backup checksum mismatch");
    if (
      archive.documents.some(
        (d) =>
          (d.kind === "base" || d.kind === "scenario") &&
          d.value &&
          typeof d.value === "object" &&
          ("graphKey" in d.value ||
            "baseGraphKey" in d.value ||
            "storage" in d.value),
      )
    )
      throw new PlatformError(
        422,
        "Backups must contain portable scenario data, not native graph references",
      );
    if (input.confirmOntology !== ontology || archive.ontology.id !== ontology)
      throw new PlatformError(
        400,
        "Backup and confirmation must match the destination ontology",
      );
    const restoredDocuments = archive.documents.map((document) => {
      if (document.kind === "job") {
        const parsed = jobRecordSchema.safeParse(document.value);
        if (
          !parsed.success ||
          parsed.data.id !== document.id ||
          parsed.data.ontology !== ontology
        )
          throw new PlatformError(422, "Invalid job history in backup");
        const { lease, leaseUntil, ...job } = parsed.data;
        return {
          ...document,
          value: ["queued", "running", "retrying"].includes(job.status)
            ? {
                ...job,
                status: "interrupted",
                error: "Restored job history requires explicit retry",
              }
            : job,
        };
      }
      if (document.kind === "schedule") {
        const parsed = sourceScheduleSchema.safeParse(document.value);
        if (
          !parsed.success ||
          parsed.data.id !== document.id ||
          parsed.data.ontology !== ontology
        )
          throw new PlatformError(422, "Invalid source schedule in backup");
        return { ...document, value: { ...parsed.data, enabled: false } };
      }
      return document;
    });
    return this.store.transact(
      ontology,
      input.expectedRevision,
      async (state, schema) => {
        if (!isAdditiveSchema(archive.ontology, schema))
          throw new PlatformError(
            422,
            "Register the backup schema before restoring; breaking schema changes are unsupported",
          );
        const removeDocuments = [];
        for (const kind of kinds)
          for (const entry of await this.store.documentEntries(kind, ontology))
            removeDocuments.push({ kind, id: entry.id });
        const result = {
          id: `restore-${randomUUID()}`,
          actor,
          sourceDigest: archive.digest,
          restoredAt: new Date().toISOString(),
          objects: archive.state.objects.length,
          relationships: archive.state.relationships.length,
        };
        return {
          state: archive.state,
          revisionFloor: Math.max(state.revision, archive.revision) + 1,
          documents: [
            ...restoredDocuments,
            { kind: "restore", id: result.id, value: result },
          ],
          removeDocuments,
          result,
        };
      },
    );
  }
}
