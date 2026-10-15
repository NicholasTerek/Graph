import { createHash, randomUUID } from "node:crypto";
import {
  vacuumInput,
  type VacuumInput,
  type VacuumPlan,
  type ReadSnapshot,
} from "@graph/contracts";
import { GraphStore } from "./store.js";
import { canonical } from "./state.js";
import { PlatformError } from "./validation.js";
export class VacuumService {
  constructor(private store: GraphStore) {}
  async run(
    ontology: string,
    input: VacuumInput,
    actor: string,
  ): Promise<VacuumPlan> {
    const args = vacuumInput.parse(input);
    return this.store.exclusive(async () => {
      const context = await this.store.temporal.ensure(ontology);
      if (context.generation !== args.generation)
        throw new PlatformError(
          409,
          "History generation changed; preview vacuum again",
        );
      if (context.revision !== args.expectedRevision)
        throw new PlatformError(
          409,
          "Live revision changed; preview vacuum again",
        );
      await this.store.temporal.resolve(ontology, {
        revision: args.retainFrom,
      });
      const pins = (
        await this.store.documents<ReadSnapshot>("snapshot", ontology)
      )
        .filter(
          (p) =>
            p.generation === context.generation &&
            Date.parse(p.expiresAt) > Date.now(),
        )
        .sort((a, b) => a.id.localeCompare(b.id));
      const branches = (
        await this.store.documents<{
          id: string;
          storage?: string;
          historyGeneration?: string;
          baseRevision: number;
        }>("scenario", ontology)
      )
        .filter(
          (b) =>
            b.storage === "falkordb-overlay" &&
            b.historyGeneration === context.generation,
        )
        .sort((a, b) => a.id.localeCompare(b.id));
      const watermark = Math.min(
        args.retainFrom,
        ...pins.map((p) => p.revision),
        ...branches.map((b) => b.baseRevision),
      );
      if (watermark < context.startRevision)
        throw new PlatformError(
          409,
          "A snapshot dependency refers to already-pruned history; stop and inspect retention state",
        );
      const eligible = await this.store.temporal.vacuumCounts(
        ontology,
        context.generation,
        watermark,
      );
      const planWithoutDigest = {
        ontology,
        generation: context.generation,
        revision: context.revision,
        retainedFrom: context.startRevision,
        requestedFrom: args.retainFrom,
        watermark,
        batchSize: args.batchSize,
        protectedSnapshots: pins.map((p) => ({
          id: p.id,
          owner: p.owner,
          revision: p.revision,
          expiresAt: p.expiresAt,
        })),
        protectedBranches: branches.map((b) => ({
          id: b.id,
          revision: b.baseRevision,
        })),
        eligible,
      };
      const digest = createHash("sha256")
        .update(canonical(planWithoutDigest))
        .digest("hex");
      if (args.dryRun) return { ...planWithoutDigest, digest, applied: false };
      if (args.digest !== digest)
        throw new PlatformError(
          409,
          "Vacuum plan or snapshot pins changed after preview",
        );
      const id = `vacuum-${randomUUID()}`;
      const removed = await this.store.temporal.vacuumBatch(
        ontology,
        context.generation,
        watermark,
        args.batchSize,
        { id, actor, digest, at: new Date().toISOString() },
      );
      return { ...planWithoutDigest, digest, applied: true, removed };
    });
  }
}
