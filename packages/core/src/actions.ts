import { createHash } from "node:crypto";
import { z } from "zod";
import type { ActionInfo, ActionRecord, FunctionRun } from "@graph/contracts";
import { GraphStore } from "./store.js";
import { ScenarioService } from "./scenarios.js";
import { GraphView } from "./functions.js";
import { canonical } from "./state.js";
import { PlatformError } from "./validation.js";
export type PreparedAction = ActionRecord["prepared"];
export type ActionContext = {
  ontology: string;
  graph: GraphView;
  revision: number;
  scenarioId: string | null;
  run: (id: string) => Promise<FunctionRun>;
};
export type ActionDefinition = {
  id: string;
  name: string;
  description: string;
  ontology: string;
  input: z.ZodType;
  prepare: (
    context: ActionContext,
    input: unknown,
  ) => Promise<PreparedAction> | PreparedAction;
  execute: (prepared: PreparedAction, id: string) => Promise<unknown>;
  reconcile?: (prepared: PreparedAction, id: string) => Promise<unknown | null>;
};
export class ExternalActionError extends Error {
  constructor(
    message: string,
    public uncertain: boolean,
  ) {
    super(message);
  }
}
const hash = (value: unknown) =>
  createHash("sha256").update(canonical(value)).digest("hex");
export class ActionService {
  private definitions = new Map<string, ActionDefinition>();
  constructor(
    private store: GraphStore,
    private scenarios: ScenarioService,
    definitions: ActionDefinition[],
  ) {
    for (const definition of definitions) {
      const key = `${definition.ontology}/${definition.id}`;
      if (this.definitions.has(key))
        throw new Error("Duplicate action definition");
      this.definitions.set(key, definition);
    }
  }
  list(ontology: string): ActionInfo[] {
    return [...this.definitions.values()]
      .filter((d) => d.ontology === ontology)
      .map((d) => ({
        id: d.id,
        name: d.name,
        description: d.description,
        ontology: d.ontology,
        inputSchema: z.toJSONSchema(d.input) as Record<string, unknown>,
      }));
  }
  async records(ontology: string) {
    await this.store.ontology(ontology);
    return this.store.documents<ActionRecord>("action", ontology);
  }
  async get(ontology: string, id: string) {
    const record = await this.store.document<ActionRecord>(
      "action",
      ontology,
      id,
    );
    if (!record) throw new PlatformError(404, `Action not found: ${id}`);
    return record;
  }
  private definition(ontology: string, type: string) {
    const definition = this.definitions.get(`${ontology}/${type}`);
    if (!definition)
      throw new PlatformError(404, `Action type not found: ${type}`);
    return definition;
  }
  async propose(
    ontology: string,
    input: {
      type: string;
      input: unknown;
      idempotencyKey: string;
      scenario?: string;
    },
    actor: string,
  ) {
    const definition = this.definition(ontology, input.type);
    const parsed = definition.input.parse(input.input);
    const id =
      "action-" +
      hash([ontology, input.type, input.idempotencyKey]).slice(0, 32);
    return this.store.exclusive(async () => {
      const existing = await this.store.document<ActionRecord>(
        "action",
        ontology,
        id,
      );
      if (existing) {
        if (
          canonical(existing.input) !== canonical(parsed) ||
          existing.scenarioId !== (input.scenario ?? null)
        )
          throw new PlatformError(
            409,
            "Idempotency key already used for another proposal",
          );
        return existing;
      }
      const liveRevision = await this.store.revision(ontology);
      let snapshot = await this.store.snapshot(ontology);
      let scenarioVersion: number | null = null;
      if (input.scenario) {
        const branch = await this.scenarios.reference(ontology, input.scenario);
        if (branch.baseRevision !== liveRevision)
          throw new PlatformError(
            409,
            "Refresh the investigation: scenario base differs from live data",
          );
        snapshot = await this.scenarios.readState(ontology, input.scenario);
        scenarioVersion = branch.version;
      }
      const context: ActionContext = {
        ontology,
        graph: new GraphView(snapshot),
        revision: liveRevision,
        scenarioId: input.scenario ?? null,
        run: async (id) => {
          const run = await this.store.document<FunctionRun>(
            "run",
            ontology,
            id,
          );
          if (!run) throw new PlatformError(404, "Function run not found");
          if (
            run.revision !== liveRevision ||
            run.scenarioId !== (input.scenario ?? null) ||
            run.scenarioVersion !== scenarioVersion
          )
            throw new PlatformError(
              409,
              "Function run no longer matches the action context",
            );
          return run;
        },
      };
      const prepared = await definition.prepare(context, parsed);
      const digest = hash({
        prepared,
        revision: liveRevision,
        scenario: input.scenario ?? null,
        scenarioVersion,
      });
      const action: ActionRecord = {
        id,
        type: definition.id,
        ontology,
        version: 0,
        status: "proposed",
        input: parsed,
        prepared,
        digest,
        revision: liveRevision,
        scenarioId: input.scenario ?? null,
        scenarioVersion,
        createdBy: actor,
        createdAt: new Date().toISOString(),
      };
      await this.store.saveDocument("action", ontology, id, action);
      return action;
    });
  }
  async review(
    ontology: string,
    id: string,
    input: {
      expectedVersion: number;
      digest: string;
      comment: string;
      expiresInSeconds?: number;
    },
    approve: boolean,
    actor: string,
  ) {
    return this.store.exclusive(async () => {
      const action = await this.get(ontology, id);
      if (
        action.version !== input.expectedVersion ||
        action.digest !== input.digest
      )
        throw new PlatformError(409, "The proposal changed after review");
      if (action.status !== "proposed")
        throw new PlatformError(409, "Only proposed actions can be reviewed");
      if (approve) await this.checkContext(action);
      const updated: ActionRecord = {
        ...action,
        version: action.version + 1,
        status: approve ? "approved" : "rejected",
        reviewedBy: actor,
        reviewedAt: new Date().toISOString(),
        reviewComment: input.comment,
        ...(approve
          ? {
              approvalExpiresAt: new Date(
                Date.now() + (input.expiresInSeconds ?? 3600) * 1000,
              ).toISOString(),
            }
          : {}),
      };
      await this.store.saveDocument("action", ontology, id, updated);
      return updated;
    });
  }
  private async checkContext(action: ActionRecord) {
    if ((await this.store.revision(action.ontology)) !== action.revision)
      throw new PlatformError(
        409,
        "Live data changed since proposal; create a new proposal",
      );
    if (action.scenarioId) {
      const branch = await this.scenarios.reference(
        action.ontology,
        action.scenarioId,
      );
      if (branch.version !== action.scenarioVersion)
        throw new PlatformError(
          409,
          "Scenario changed since proposal; create a new proposal",
        );
    }
  }
  async revoke(
    ontology: string,
    id: string,
    input: { expectedVersion: number; digest: string; comment: string },
    actor: string,
  ) {
    return this.store.exclusive(async () => {
      const action = await this.get(ontology, id);
      if (
        action.version !== input.expectedVersion ||
        action.digest !== input.digest
      )
        throw new PlatformError(409, "Action changed before revocation");
      if (!["proposed", "approved"].includes(action.status))
        throw new PlatformError(
          409,
          "Only unexecuted proposals or approvals can be revoked",
        );
      const updated: ActionRecord = {
        ...action,
        version: action.version + 1,
        status: "revoked",
        revokedBy: actor,
        revokedAt: new Date().toISOString(),
        revocationComment: input.comment,
      };
      await this.store.saveDocument("action", ontology, id, updated);
      return updated;
    });
  }
  async execute(
    ontology: string,
    id: string,
    input: { expectedVersion: number; digest: string },
    actor: string,
  ) {
    const action = await this.store.exclusive(async () => {
      const action = await this.get(ontology, id);
      if (action.status === "succeeded") return action;
      if (
        action.version !== input.expectedVersion ||
        action.digest !== input.digest
      )
        throw new PlatformError(
          409,
          "Action version or review digest mismatch",
        );
      if (action.status !== "approved")
        throw new PlatformError(
          409,
          "Action requires approval and cannot be executed again",
        );
      if (
        !action.approvalExpiresAt ||
        !Number.isFinite(Date.parse(action.approvalExpiresAt)) ||
        Date.parse(action.approvalExpiresAt) <= Date.now()
      )
        throw new PlatformError(
          409,
          "Approval expired or has no deadline; create and review a new proposal",
        );
      await this.checkContext(action);
      const running: ActionRecord = {
        ...action,
        status: "executing",
        version: action.version + 1,
        executionStartedAt: new Date().toISOString(),
        executedBy: actor,
      };
      await this.store.saveDocument("action", ontology, id, running);
      return running;
    });
    if (action.status === "succeeded") return action;
    try {
      const result = await this.definition(ontology, action.type).execute(
        action.prepared,
        action.id,
      );
      return this.finish(action, "succeeded", { result });
    } catch (error) {
      return this.finish(
        action,
        error instanceof ExternalActionError && !error.uncertain
          ? "failed"
          : "uncertain",
        {
          error:
            error instanceof Error ? error.message : "External action failed",
        },
      );
    }
  }
  private async finish(
    action: ActionRecord,
    status: ActionRecord["status"],
    result: Partial<ActionRecord>,
  ) {
    return this.store.exclusive(async () => {
      const current = await this.get(action.ontology, action.id);
      if (current.status !== "executing" && current.status !== "uncertain")
        throw new PlatformError(409, "Action state changed during execution");
      const updated = {
        ...current,
        ...result,
        status,
        version: current.version + 1,
        finishedAt: new Date().toISOString(),
      };
      await this.store.saveDocument(
        "action",
        action.ontology,
        action.id,
        updated,
      );
      return updated;
    });
  }
  async reconcile(ontology: string, id: string) {
    const action = await this.get(ontology, id);
    if (!["executing", "uncertain"].includes(action.status))
      throw new PlatformError(
        409,
        "Only uncertain or interrupted executions need reconciliation",
      );
    if (
      action.status === "executing" &&
      Date.now() - Date.parse(action.executionStartedAt ?? action.createdAt) <
        60000
    )
      throw new PlatformError(
        409,
        "Execution is still in progress; reconcile after its timeout",
      );
    const definition = this.definition(ontology, action.type);
    if (!definition.reconcile)
      throw new PlatformError(422, "This action has no reconciliation handler");
    const result = await definition.reconcile(action.prepared, action.id);
    return result ? this.finish(action, "succeeded", { result }) : action;
  }
}
