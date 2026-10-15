import { randomUUID } from "node:crypto";
import {
  historicalInput,
  historicalTraversalInput,
  type HistoricalTraversalInput,
  snapshotInput,
  type HistoricalInput,
  type HistoricalState,
  type ReadSnapshot,
} from "@graph/contracts";
import { GraphStore } from "./store.js";
import { PlatformError } from "./validation.js";
export class SnapshotService {
  constructor(private store: GraphStore) {}
  async status(ontology: string) {
    return this.store.exclusive(async () => {
      const context = await this.store.temporal.ensure(ontology);
      const pins = (
        await this.store.documents<ReadSnapshot>("snapshot", ontology)
      ).filter(
        (pin) =>
          pin.generation === context.generation &&
          Date.parse(pin.expiresAt) > Date.now(),
      );
      return {
        generation: context.generation,
        revision: context.revision,
        retainedFrom: context.startRevision,
        committedAt: context.committedAt,
        activeSnapshots: pins.length,
        oldestPinnedRevision: pins.length
          ? Math.min(...pins.map((p) => p.revision))
          : null,
      };
    });
  }
  async traverse(
    ontology: string,
    input: HistoricalTraversalInput,
    owner: string,
  ) {
    const { root, depth, direction, ...selector } =
      historicalTraversalInput.parse(input);
    return this.store.exclusive(async () =>
      this.store.temporal.traverse(
        ontology,
        await this.resolve(ontology, selector, owner),
        root,
        depth,
        direction,
      ),
    );
  }
  async resolve(ontology: string, input: HistoricalInput, owner: string) {
    const args = historicalInput.parse(input);
    const current = await this.store.temporal.ensure(ontology);
    if (args.generation && args.generation !== current.generation)
      throw new PlatformError(
        409,
        "History generation changed; acquire a new read snapshot",
      );
    if (args.snapshot) {
      const snapshot = await this.store.document<ReadSnapshot>(
        "snapshot",
        ontology,
        args.snapshot,
      );
      if (!snapshot) throw new PlatformError(404, "Read snapshot not found");
      if (snapshot.owner !== owner)
        throw new PlatformError(
          403,
          "Read snapshot belongs to another principal",
        );
      if (snapshot.generation !== current.generation)
        throw new PlatformError(
          409,
          "History generation changed after restore; acquire a new read snapshot",
        );
      if (Date.parse(snapshot.expiresAt) <= Date.now())
        throw new PlatformError(410, "Read snapshot lease expired");
      if (snapshot.revision < current.startRevision)
        throw new PlatformError(
          410,
          "Read snapshot is outside retained history",
        );
      return {
        generation: snapshot.generation,
        revision: snapshot.revision,
        committedAt: snapshot.committedAt,
        startRevision: current.startRevision,
      };
    }
    return this.store.temporal.resolve(ontology, args);
  }
  async state(
    ontology: string,
    input: HistoricalInput,
    owner: string,
  ): Promise<HistoricalState> {
    return this.store.exclusive(async () => {
      const context = await this.resolve(ontology, input, owner);
      return {
        ...(await this.store.temporal.read(ontology, context)),
        ...(input.snapshot ? { snapshot: input.snapshot } : {}),
      };
    });
  }
  async create(
    ontology: string,
    input: HistoricalInput & { ttlSeconds?: number },
    owner: string,
  ) {
    const { ttlSeconds, ...selector } = snapshotInput.parse(input);
    return this.store.exclusive(async () => {
      const context = await this.resolve(ontology, selector, owner);
      const pins = await this.store.documents<ReadSnapshot>(
        "snapshot",
        ontology,
      );
      const expired = pins.filter(
        (p) =>
          Date.parse(p.expiresAt) <= Date.now() ||
          p.generation !== context.generation,
      );
      if (pins.length - expired.length >= 100)
        throw new PlatformError(
          429,
          "At most 100 active read snapshots are allowed per ontology",
        );
      for (const pin of expired)
        await this.store.removeDocument("snapshot", ontology, pin.id);
      const createdAt = new Date().toISOString();
      const snapshot: ReadSnapshot = {
        id: `snapshot-${randomUUID()}`,
        ontology,
        owner,
        generation: context.generation,
        revision: context.revision,
        committedAt: context.committedAt,
        createdAt,
        expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString(),
      };
      await this.store.saveDocument(
        "snapshot",
        ontology,
        snapshot.id,
        snapshot,
      );
      return snapshot;
    });
  }
  async release(ontology: string, id: string, owner: string) {
    return this.store.exclusive(async () => {
      const snapshot = await this.store.document<ReadSnapshot>(
        "snapshot",
        ontology,
        id,
      );
      if (!snapshot) throw new PlatformError(404, "Read snapshot not found");
      if (snapshot.owner !== owner)
        throw new PlatformError(
          403,
          "Read snapshot belongs to another principal",
        );
      await this.store.removeDocument("snapshot", ontology, id);
    });
  }
}
