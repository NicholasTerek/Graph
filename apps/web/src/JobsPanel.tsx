import { useEffect, useState, useRef } from "react";
import { GraphClient } from "@graph/sdk";
import type { JobRecord, SourceSchedule, Source } from "@graph/contracts";
export default function JobsPanel({
  client,
  ontology,
}: {
  client: GraphClient;
  ontology: string;
}) {
  const [jobs, setJobs] = useState<JobRecord[]>([]),
    [schedules, setSchedules] = useState<SourceSchedule[]>([]),
    [sources, setSources] = useState<Source[]>([]);
  const [selected, setSelected] = useState(""),
    [interval, setIntervalSeconds] = useState(300),
    [enabled, setEnabled] = useState(false),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const token = useRef(0);
  const load = async () => {
    const current = ++token.current;
    const [j, s, src, c] = await Promise.all([
      client.jobs(ontology),
      client.sourceSchedules(ontology),
      client.sources(ontology),
      client.jobCapabilities(),
    ]);
    if (current !== token.current) return;
    setJobs(j.sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
    setSchedules(s);
    setSources(src.filter((x) => !["csv", "json"].includes(x.connector)));
    setEnabled(c.workerEnabled);
  };
  useEffect(() => {
    let active = true;
    const refresh = () => {
      if (active)
        void load().catch((e) => {
          if (active) setError(e.message);
        });
    };
    refresh();
    const timer = window.setInterval(refresh, 3000);
    return () => {
      active = false;
      token.current++;
      window.clearInterval(timer);
    };
  }, [ontology]);
  async function task(work: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await work();
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="jobs-panel">
      <p>
        {enabled
          ? "Worker enabled. Queued work is persisted and processed by this server."
          : "Worker paused. Queued jobs persist; enable the server worker to process them."}{" "}
        Investigations interrupted by a restart require explicit retry.
        Cancelling cannot undo an already committed tool or sync.
      </p>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <section className="operation-card">
        <h2>Remote source refresh</h2>
        <label>
          Source{" "}
          <select
            aria-label="Scheduled source"
            value={selected}
            onChange={(e) => setSelected(e.target.value)}
          >
            <option value="">Select a remote source</option>
            {sources.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        <button
          disabled={busy || !selected}
          onClick={() =>
            void task(() =>
              client.enqueueJob(ontology, {
                kind: "source-sync",
                sourceId: selected,
              }),
            )
          }
        >
          Queue refresh
        </button>
        <label>
          Interval seconds{" "}
          <input
            aria-label="Refresh interval seconds"
            type="number"
            min={60}
            max={604800}
            value={interval}
            onChange={(e) => setIntervalSeconds(Number(e.target.value))}
          />
        </label>
        <button
          disabled={
            busy ||
            !selected ||
            !Number.isInteger(interval) ||
            interval < 60 ||
            interval > 604800
          }
          onClick={() =>
            void task(() =>
              client.setSourceSchedule(ontology, {
                id: `refresh-${crypto.randomUUID()}`,
                sourceId: selected,
                intervalSeconds: interval,
              }),
            )
          }
        >
          Schedule explicit refresh
        </button>
        <p>
          Scheduling authorizes future snapshot applies with normal conflict
          protection. Uploads are not scheduled. Missed intervals coalesce; jobs
          never overlap for one schedule.
        </p>
      </section>
      {schedules.map((s) => (
        <article className="operation-card" key={s.id}>
          <strong>
            {s.sourceId} · {s.enabled ? "scheduled" : "paused"}
          </strong>
          <p>
            Every {s.intervalSeconds}s · next{" "}
            {new Date(s.nextRunAt).toLocaleString()} · v{s.version}
          </p>
          <button
            disabled={busy}
            onClick={() =>
              void task(() =>
                client.setSourceSchedule(ontology, {
                  id: s.id,
                  sourceId: s.sourceId,
                  intervalSeconds: s.intervalSeconds,
                  enabled: !s.enabled,
                  expectedVersion: s.version,
                }),
              )
            }
          >
            {s.enabled ? "Pause schedule" : "Resume schedule"}
          </button>
        </article>
      ))}
      {!jobs.length && (
        <p>
          No jobs. Queue an investigation from the planner or a remote refresh
          here.
        </p>
      )}
      {jobs.map((job) => (
        <article className="operation-card job-record" key={job.id}>
          <h2>
            {job.input.kind} · {job.status}
          </h2>
          <code>{job.id}</code>
          <p>
            Owner {job.owner} · attempt {job.attempt}/{job.maxAttempts} · v
            {job.version}
            {job.recovered ? " · recovered after expired lease" : ""}
          </p>
          {job.status === "retrying" && (
            <p>Retry after {new Date(job.notBefore).toLocaleString()}</p>
          )}
          {job.cancellationRequestedAt && (
            <p>
              Cancellation requested. Work committed before cancellation is
              retained.
            </p>
          )}
          {job.error && <p className="action-error">{job.error}</p>}
          {job.retriedAs && (
            <p>
              Retried as <code>{job.retriedAs}</code>
            </p>
          )}
          {job.result !== undefined && (
            <details>
              <summary>Recorded result</summary>
              <pre>{JSON.stringify(job.result, null, 2)}</pre>
            </details>
          )}
          {["queued", "running", "retrying"].includes(job.status) && (
            <button
              disabled={busy || !!job.cancellationRequestedAt}
              onClick={() =>
                void task(() => client.cancelJob(ontology, job.id, job.version))
              }
            >
              Cancel job
            </button>
          )}
          {!job.retriedAs &&
            ["failed", "interrupted", "cancelled"].includes(job.status) && (
              <button
                disabled={busy}
                onClick={() =>
                  void task(() =>
                    client.retryJob(ontology, job.id, job.version),
                  )
                }
              >
                Retry as new job
              </button>
            )}
        </article>
      ))}
    </div>
  );
}
