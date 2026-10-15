import { createHash, randomUUID } from "node:crypto";
import { backupSchema, type BackupArchive } from "@graph/contracts";
import { GraphStore } from "./store.js";
import { canonical } from "./state.js";
import { PlatformError, isAdditiveSchema } from "./validation.js";
const kinds = [
  "source",
  "sync",
  "history",
  "base",
  "scenario",
  "run",
  "promotion",
  "investigation",
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
      for (const kind of kinds)
        for (const document of await this.store.documentEntries(kind, ontology))
          documents.push({ kind, id: document.id, value: document.value });
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
    if (input.confirmOntology !== ontology || archive.ontology.id !== ontology)
      throw new PlatformError(
        400,
        "Backup and confirmation must match the destination ontology",
      );
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
            ...archive.documents,
            { kind: "restore", id: result.id, value: result },
          ],
          removeDocuments,
          result,
        };
      },
    );
  }
}
