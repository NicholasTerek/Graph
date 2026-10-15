import { randomUUID, createHash } from "node:crypto";
import {
  jobCreate,
  scheduleInput,
  type JobRequest,
  type JobRecord,
  type SourceSchedule,
} from "@graph/contracts";
import { GraphStore } from "./store.js";
import { PlatformError } from "./validation.js";
export class JobFailure extends Error {
  constructor(
    message: string,
    public retryable = false,
    public result?: unknown,
  ) {
    super(message);
  }
}
export type JobHandler = (
  job: JobRecord,
  signal: AbortSignal,
) => Promise<unknown>;
const terminal = new Set<JobRecord["status"]>([
  "cancelled",
  "succeeded",
  "failed",
  "interrupted",
]);
export class JobService {
  private busy = false;
  private active?: Promise<void>;
  private controllers = new Map<string, AbortController>();
  private timer?: ReturnType<typeof setInterval>;
  private stopped = false;
  constructor(
    private store: GraphStore,
    private handlers: Record<JobRecord["input"]["kind"], JobHandler>,
    private leaseMs = 120000,
  ) {}
  async list(ontology: string) {
    await this.store.ontology(ontology);
    return this.store.documents<JobRecord>("job", ontology);
  }
  async get(ontology: string, id: string) {
    await this.store.ontology(ontology);
    const job = await this.store.document<JobRecord>("job", ontology, id);
    if (!job) throw new PlatformError(404, "Job not found");
    return job;
  }
  private make(
    ontology: string,
    owner: string,
    request: JobRequest,
    id = `job-${randomUUID()}`,
  ): JobRecord {
    const input = jobCreate.parse(request),
      now = new Date().toISOString();
    return {
      id,
      ontology,
      owner,
      input,
      status: "queued",
      version: 0,
      attempt: 0,
      maxAttempts: input.kind === "source-sync" ? input.maxAttempts : 1,
      createdAt: now,
      updatedAt: now,
      notBefore: input.notBefore ?? now,
    };
  }
  private async bindContext(job: JobRecord) {
    if (job.input.kind === "investigation") {
      job.queuedRevision = await this.store.revision(job.ontology);
      if (job.input.request.scenario) {
        const branch = await this.store.document<{ version: number }>(
          "scenario",
          job.ontology,
          job.input.request.scenario,
        );
        if (!branch) throw new PlatformError(404, "Scenario not found");
        job.queuedScenarioVersion = branch.version;
      } else job.queuedScenarioVersion = null;
    }
    return job;
  }
  async enqueue(ontology: string, request: JobRequest, owner: string) {
    return this.store.exclusive(async () => {
      await this.store.ontology(ontology);
      if (request.kind === "source-sync") {
        const source = await this.store.document<{ connector: string }>(
          "source",
          ontology,
          request.sourceId,
        );
        if (
          !source ||
          !["github", "notion", "discord"].includes(source.connector)
        )
          throw new PlatformError(
            422,
            "Source jobs require a registered remote source",
          );
      }
      const pending = (await this.list(ontology)).filter(
        (j) => !terminal.has(j.status),
      );
      if (pending.length >= 100)
        throw new PlatformError(429, "Ontology has 100 pending jobs");
      const job = await this.bindContext(this.make(ontology, owner, request));
      await this.store.saveDocument("job", ontology, job.id, job);
      return job;
    });
  }
  async cancel(
    ontology: string,
    id: string,
    expectedVersion: number,
    actor: string,
    admin = false,
  ) {
    return this.store.exclusive(async () => {
      const job = await this.get(ontology, id);
      if (job.owner !== actor && !admin)
        throw new PlatformError(
          403,
          "Only the job owner or an administrator can cancel it",
        );
      if (job.version !== expectedVersion)
        throw new PlatformError(409, "Job version changed");
      if (terminal.has(job.status))
        throw new PlatformError(409, "Job is already terminal");
      const updated: JobRecord = {
        ...job,
        version: job.version + 1,
        cancellationRequestedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        status: job.status === "running" ? "running" : "cancelled",
      };
      await this.store.saveDocument("job", ontology, id, updated);
      this.controllers.get(id)?.abort(new Error("Job cancelled"));
      return updated;
    });
  }
  async retry(
    ontology: string,
    id: string,
    expectedVersion: number,
    actor: string,
    admin = false,
  ) {
    return this.store.exclusive(async () => {
      const job = await this.get(ontology, id);
      if (job.owner !== actor && !admin)
        throw new PlatformError(
          403,
          "Only the job owner or an administrator can retry it",
        );
      if (
        job.version !== expectedVersion ||
        !["failed", "interrupted", "cancelled"].includes(job.status)
      )
        throw new PlatformError(
          409,
          "Only a matching failed/interrupted/cancelled job can be retried",
        );
      const next = await this.bindContext(
        this.make(ontology, actor, job.input),
      );
      await this.store.saveDocument("job", ontology, next.id, next);
      return next;
    });
  }
  async schedules(ontology: string) {
    await this.store.ontology(ontology);
    return this.store.documents<SourceSchedule>("schedule", ontology);
  }
  async schedule(
    ontology: string,
    value: Parameters<typeof scheduleInput.parse>[0],
    owner: string,
    admin = false,
  ) {
    const input = scheduleInput.parse(value);
    return this.store.exclusive(async () => {
      await this.store.ontology(ontology);
      const source = await this.store.document<{ connector: string }>(
        "source",
        ontology,
        input.sourceId,
      );
      if (
        !source ||
        !["github", "notion", "discord"].includes(source.connector)
      )
        throw new PlatformError(
          422,
          "Schedules require a registered remote source; uploads are explicit",
        );
      const previous = await this.store.document<SourceSchedule>(
        "schedule",
        ontology,
        input.id,
      );
      if (previous && previous.owner !== owner && !admin)
        throw new PlatformError(
          403,
          "Only the schedule owner or an administrator can change it",
        );
      if (
        previous
          ? input.expectedVersion !== previous.version
          : input.expectedVersion !== undefined
      )
        throw new PlatformError(409, "Schedule version changed");
      const schedules = await this.schedules(ontology);
      if (!previous && schedules.length >= 20)
        throw new PlatformError(429, "Ontology has 20 source schedules");
      const now = new Date().toISOString();
      const schedule: SourceSchedule = {
        id: input.id,
        ontology,
        sourceId: input.sourceId,
        owner: previous?.owner ?? owner,
        intervalSeconds: input.intervalSeconds,
        enabled: input.enabled,
        version: (previous?.version ?? -1) + 1,
        nextRunAt: new Date(
          Date.now() + input.intervalSeconds * 1000,
        ).toISOString(),
        updatedAt: now,
      };
      await this.store.saveDocument("schedule", ontology, input.id, schedule);
      return schedule;
    });
  }
  private async prepare(ontology: string) {
    return this.store.exclusive(async () => {
      const now = Date.now();
      const jobs = await this.list(ontology);
      for (const job of jobs)
        if (
          job.status === "running" &&
          Date.parse(job.leaseUntil ?? "0") <= now
        ) {
          const updated: JobRecord = {
            ...job,
            version: job.version + 1,
            recovered: true,
            updatedAt: new Date(now).toISOString(),
            status: job.cancellationRequestedAt
              ? "cancelled"
              : job.input.kind === "source-sync" &&
                  job.attempt < job.maxAttempts
                ? "retrying"
                : "interrupted",
            notBefore: new Date(now).toISOString(),
            error:
              "Worker lease expired; review any partial investigation artifacts before explicit retry",
          };
          await this.store.saveDocument("job", ontology, job.id, updated);
          Object.assign(job, updated);
        }
      for (const schedule of await this.schedules(ontology))
        if (schedule.enabled && Date.parse(schedule.nextRunAt) <= now) {
          const active = jobs.some(
            (j) => j.scheduleId === schedule.id && !terminal.has(j.status),
          );
          if (
            active ||
            jobs.filter((j) => !terminal.has(j.status)).length >= 100
          )
            continue;
          const id =
            "job-" +
            createHash("sha256")
              .update(`${ontology}/${schedule.id}/${schedule.nextRunAt}`)
              .digest("hex")
              .slice(0, 32);
          const job = {
            ...this.make(
              ontology,
              schedule.owner,
              { kind: "source-sync", sourceId: schedule.sourceId },
              id,
            ),
            scheduleId: schedule.id,
          };
          const next = {
            ...schedule,
            version: schedule.version + 1,
            updatedAt: new Date(now).toISOString(),
            nextRunAt: new Date(
              now + schedule.intervalSeconds * 1000,
            ).toISOString(),
          };
          await this.store.saveDocuments(ontology, [
            { kind: "job", id, value: job },
            { kind: "schedule", id: schedule.id, value: next },
          ]);
          jobs.push(job);
        }
      const next = jobs
        .filter(
          (j) =>
            ["queued", "retrying"].includes(j.status) &&
            Date.parse(j.notBefore) <= now,
        )
        .sort(
          (a, b) =>
            a.notBefore.localeCompare(b.notBefore) || a.id.localeCompare(b.id),
        )[0];
      if (!next) return null;
      const running: JobRecord = {
        ...next,
        status: "running",
        version: next.version + 1,
        attempt: next.attempt + 1,
        lease: randomUUID(),
        leaseUntil: new Date(now + this.leaseMs).toISOString(),
        updatedAt: new Date(now).toISOString(),
      };
      await this.store.saveDocument("job", ontology, next.id, running);
      return running;
    });
  }
  tick(): Promise<void> {
    if (this.active) return this.active;
    const work = this.run();
    this.active = work;
    void work
      .finally(() => {
        if (this.active === work) this.active = undefined;
      })
      .catch(() => {});
    return work;
  }
  private async run() {
    if (this.busy || this.stopped) return;
    this.busy = true;
    try {
      for (const ontology of await this.store.listOntologies()) {
        if (this.stopped) break;
        const job = await this.prepare(ontology.id);
        if (!job) continue;
        const controller = new AbortController();
        this.controllers.set(job.id, controller);
        const heartbeat = setInterval(
          () => {
            void this.store
              .exclusive(async () => {
                const current = await this.get(job.ontology, job.id);
                if (
                  current.lease !== job.lease ||
                  current.status !== "running"
                ) {
                  controller.abort();
                  return;
                }
                if (current.cancellationRequestedAt)
                  controller.abort(new Error("Job cancelled"));
                else
                  await this.store.saveDocument("job", job.ontology, job.id, {
                    ...current,
                    leaseUntil: new Date(
                      Date.now() + this.leaseMs,
                    ).toISOString(),
                  });
              })
              .catch(() => controller.abort());
          },
          Math.max(10, Math.floor(this.leaseMs / 3)),
        );
        heartbeat.unref();
        let result: unknown, failure: unknown;
        try {
          if ((await this.get(job.ontology, job.id)).cancellationRequestedAt)
            controller.abort(new Error("Job cancelled"));
          if (this.stopped) controller.abort(new Error("Worker stopping"));
          controller.signal.throwIfAborted();
          result = await this.handlers[job.input.kind](job, controller.signal);
        } catch (error) {
          failure = error;
        } finally {
          clearInterval(heartbeat);
          this.controllers.delete(job.id);
        }
        await this.store.exclusive(async () => {
          const current = await this.get(job.ontology, job.id);
          if (current.lease !== job.lease || current.status !== "running")
            return;
          const cancelled =
            controller.signal.aborted && !!current.cancellationRequestedAt;
          const retry =
            !cancelled &&
            ((failure instanceof JobFailure && failure.retryable) ||
              (this.stopped && job.input.kind === "source-sync")) &&
            current.attempt < current.maxAttempts;
          const final: JobRecord = {
            ...current,
            version: current.version + 1,
            updatedAt: new Date().toISOString(),
            status: failure
              ? cancelled
                ? "cancelled"
                : retry
                  ? "retrying"
                  : this.stopped
                    ? "interrupted"
                    : "failed"
              : "succeeded",
            ...(failure
              ? {
                  error:
                    failure instanceof Error
                      ? failure.message
                      : String(failure),
                }
              : { result }),
            ...(failure instanceof JobFailure && failure.result !== undefined
              ? { result: failure.result }
              : {}),
            ...(retry
              ? {
                  notBefore: new Date(
                    Date.now() +
                      Math.min(60000, 1000 * 2 ** (current.attempt - 1)),
                  ).toISOString(),
                }
              : {}),
          };
          await this.store.saveDocument("job", job.ontology, job.id, final);
        });
      }
    } finally {
      this.busy = false;
    }
  }
  start(pollMs = 1000) {
    if (this.timer) return;
    this.stopped = false;
    this.timer = setInterval(() => {
      void this.tick().catch(() => {});
    }, pollMs);
    this.timer.unref();
  }
  async stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    for (const controller of this.controllers.values())
      controller.abort(new Error("Worker stopping"));
    await this.active?.catch(() => {});
  }
}
