import JobsPanel from "./JobsPanel.js";
import GraphRetention from "./GraphRetention.js";
import { useEffect, useState, useRef } from "react";
import { GraphClient } from "@graph/sdk";
import type {
  Source,
  SourceStatus,
  SyncResult,
  ActionRecord,
  Investigation,
  BackupArchive,
} from "@graph/contracts";
import { Database, RefreshCw, Play, Check, X } from "lucide-react";
import "./operations.css";
import RetentionPanel from "./RetentionPanel.js";
export default function Operations({
  client,
  ontology,
}: {
  client: GraphClient;
  ontology: string;
}) {
  const [tab, setTab] = useState("sources");
  const [sources, setSources] = useState<Source[]>([]);
  const [sourceStatuses, setSourceStatuses] = useState<SourceStatus[]>([]);
  const [actions, setActions] = useState<ActionRecord[]>([]);
  const [actionContext, setActionContext] = useState<{
    revision: number;
    branches: Map<string, number>;
  } | null>(null);
  const [investigations, setInvestigations] = useState<Investigation[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [sourceJson, setSourceJson] = useState("");
  const [sync, setSync] = useState<SyncResult | null>(null);
  const [staged, setStaged] = useState<{ id: string; content?: string } | null>(
    null,
  );
  const [confirmation, setConfirmation] = useState("");
  const [archive, setArchive] = useState<BackupArchive | null>(null);
  const [includeHistory, setIncludeHistory] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const [uploadFor, setUploadFor] = useState("");
  async function refresh() {
    setBusy(true);
    setError("");
    try {
      const [s, a, i, statuses, graph, branches] = await Promise.all([
        client.sources(ontology),
        client.actions(ontology),
        client.investigations(ontology),
        client.sourceStatuses(ontology),
        client.snapshot(ontology),
        client.scenarios(ontology),
      ]);
      setSources(s);
      setSourceStatuses(statuses);
      setActions(a);
      setActionContext({
        revision: graph.revision,
        branches: new Map(branches.map((b) => [b.id, b.version])),
      });
      setInvestigations(i);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    void refresh();
  }, [ontology]);
  async function task(operation: () => Promise<void>) {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await operation();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function preview(id: string, content?: string) {
    setStaged(null);
    setSync(null);
    await task(async () => {
      try {
        setSync(
          await client.syncSource(ontology, id, { content, dryRun: true }),
        );
        setStaged({ id, content });
      } finally {
        await client
          .sourceStatuses(ontology)
          .then(setSourceStatuses)
          .catch(() => {});
      }
    });
  }
  async function apply() {
    if (!staged) return;
    await task(async () => {
      const state = await client.snapshot(ontology);
      setSync(
        await client.syncSource(ontology, staged.id, {
          content: staged.content,
          expectedRevision: state.revision,
          expectedCheckpoint: sync?.checkpoint,
        }),
      );
      setStaged(null);
      setSources(await client.sources(ontology));
      setSourceStatuses(await client.sourceStatuses(ontology));
      setMessage(
        "Source snapshot, record history and checkpoint committed together.",
      );
    });
  }
  async function review(action: ActionRecord, approve: boolean) {
    await task(async () => {
      await client.reviewAction(
        ontology,
        action.id,
        {
          expectedVersion: action.version,
          digest: action.digest,
          comment: approve
            ? "Reviewed exact target, contents and revision in the operations console"
            : "Rejected in the operations console",
        },
        approve,
      );
      setActions(await client.actions(ontology));
    });
  }
  async function execute(action: ActionRecord) {
    await task(async () => {
      const result = await client.executeAction(ontology, action.id, {
        expectedVersion: action.version,
        digest: action.digest,
      });
      setActions(await client.actions(ontology));
      if (result.error) setError(result.error);
      else
        setMessage("Approved action executed. Its result is recorded below.");
    });
  }
  async function download() {
    await task(async () => {
      const data = await client.backup(ontology, { includeHistory });
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }),
      );
      const a = document.createElement("a");
      a.href = url;
      a.download = ontology + "-backup.json";
      a.click();
      URL.revokeObjectURL(url);
      setMessage(
        "Checksummed backup exported. Credentials and executable approvals are excluded.",
      );
    });
  }
  return (
    <section className="operations">
      <div className="operations-heading">
        <div>
          <div className="eyebrow">PLATFORM OPERATIONS</div>
          <h1>Connect, investigate, and act.</h1>
          <p>Shared platform capabilities for {ontology}.</p>
        </div>
        <button
          className="icon-button"
          aria-label="Refresh operations"
          disabled={busy}
          onClick={() => void refresh()}
        >
          <RefreshCw size={18} />
        </button>
      </div>
      <div className="operation-tabs">
        {[
          "sources",
          "actions",
          "investigations",
          "jobs",
          "history",
          "backup",
        ].map((name) => (
          <button
            key={name}
            className={tab === name ? "selected" : ""}
            onClick={() => setTab(name)}
          >
            {name === "sources"
              ? "Data sources"
              : name === "actions"
                ? "Action approvals"
                : name === "investigations"
                  ? "Investigation history"
                  : name === "jobs"
                    ? "Jobs & refresh"
                    : name === "history"
                      ? "History & retention"
                      : "Backup & restore"}
          </button>
        ))}
      </div>
      {error && (
        <div role="alert" className="error">
          {error}
        </div>
      )}
      {message && (
        <div className="operation-message" role="status">
          {message}
        </div>
      )}
      {tab === "sources" && (
        <>
          <div className="source-grid">
            {sources.map((source) => (
              <article className="operation-card" key={source.id}>
                <div className="section-kicker">
                  <Database size={15} />
                  {source.connector.toUpperCase()}
                </div>
                <h2>{source.name}</h2>
                <p>
                  {source.mapping.type} · {Object.keys(source.managed).length}{" "}
                  mapped records
                  <br />
                  {source.repository ??
                    source.connection ??
                    "Uploaded snapshots"}
                </p>
                <dl>
                  <dt>Last sync</dt>
                  <dd>
                    {source.lastSyncedAt
                      ? new Date(source.lastSyncedAt).toLocaleString()
                      : "Not synced"}
                  </dd>
                  <dt>Checkpoint</dt>
                  <dd>{source.checkpoint?.slice(0, 16) ?? "None"}</dd>
                </dl>
                {sourceStatuses
                  .filter((status) => status.sourceId === source.id)
                  .map((status) => (
                    <div className="source-status" key={status.sourceId}>
                      <p>
                        <strong>
                          {
                            {
                              upload: "Upload source",
                              public: "Public GitHub source",
                              configured: "Connection configured",
                              unavailable: "Connection needs setup",
                            }[status.connectionState]
                          }
                        </strong>
                      </p>
                      {status.lastAttempt && (
                        <p>
                          Last recorded attempt: {status.lastAttempt.status} ·{" "}
                          {new Date(status.lastAttempt.at).toLocaleString()}
                        </p>
                      )}
                      {status.lastAttempt?.error && (
                        <p className="source-status-error">
                          {status.lastAttempt.error}
                        </p>
                      )}
                      <details>
                        <summary>Connection and sync guidance</summary>
                        <ul>
                          {status.guidance.map((item) => (
                            <li key={item}>{item}</li>
                          ))}
                        </ul>
                        <p>
                          Provider access is checked only when you preview or
                          sync. Successful previews do not update the last
                          applied sync time.
                        </p>
                      </details>
                    </div>
                  ))}
                <button
                  className="primary-button"
                  disabled={busy}
                  onClick={() => {
                    if (!["csv", "json"].includes(source.connector))
                      void preview(source.id);
                    else {
                      setUploadFor(source.id);
                      file.current?.click();
                    }
                  }}
                >
                  <RefreshCw size={13} />
                  Preview sync
                </button>
              </article>
            ))}
          </div>
          {!sources.length && (
            <p className="operation-hint">
              No sources registered. Add a mapping below or run the example seed
              script.
            </p>
          )}
          {sync && (
            <div className="operation-card sync-review">
              <h2>
                {sync.status === "preview"
                  ? "Review source changes"
                  : "Sync result"}
              </h2>
              <p>
                {sync.added.length} additions · {sync.updated.length} updates ·{" "}
                {sync.removed.length} deletions · {sync.unchanged} unchanged
              </p>
              {sync.relationships && (
                <p aria-label="Relationship changes">
                  Links: {sync.relationships.added.length} additions ·{" "}
                  {sync.relationships.updated.length} updates ·{" "}
                  {sync.relationships.removed.length} deletions ·{" "}
                  {sync.relationships.unchanged} unchanged
                </p>
              )}
              <code>Checkpoint {sync.checkpoint}</code>
              {staged && (
                <button
                  className="primary-button"
                  disabled={busy}
                  onClick={() => void apply()}
                >
                  Apply reviewed snapshot
                </button>
              )}
            </div>
          )}
          <details className="operation-card">
            <summary>Register a source mapping</summary>
            <p>
              Define a CSV, JSON or public GitHub source. The API documentation
              describes the mapping schema.
            </p>
            <textarea
              aria-label="Source mapping JSON"
              rows={8}
              value={sourceJson}
              onChange={(e) => setSourceJson(e.target.value)}
            />
            <button
              className="primary-button"
              disabled={busy || !sourceJson}
              onClick={() =>
                void task(async () => {
                  await client.registerSource(ontology, JSON.parse(sourceJson));
                  setSources(await client.sources(ontology));
                  setSourceStatuses(await client.sourceStatuses(ontology));
                  setSourceJson("");
                })
              }
            >
              Register source
            </button>
          </details>
          <input
            type="file"
            hidden
            ref={file}
            accept=".csv,.json,text/csv,application/json"
            onChange={(e) => {
              const chosen = e.target.files?.[0];
              if (chosen)
                void chosen
                  .text()
                  .then((content) => preview(uploadFor, content));
              e.target.value = "";
            }}
          />
        </>
      )}
      {tab === "actions" && (
        <>
          <p className="operation-hint">
            Review the exact target and contents before approval. Approval and
            execution are separate operations.
          </p>
          {actions.length === 0 && (
            <div className="operation-card">
              No proposed actions. Prepare one from a calculated recovery plan.
            </div>
          )}
          {actions.map((action) => (
            <article className="operation-card action-review" key={action.id}>
              <div className="action-status">
                <span className={"status " + action.status}>
                  {action.status}
                </span>
                <code>
                  v{action.version} · revision {action.revision}
                </code>
              </div>
              <h2>{action.prepared.title}</h2>
              <a href={action.prepared.target} target="_blank" rel="noreferrer">
                {action.prepared.target}
              </a>
              <pre>{action.prepared.description}</pre>
              <div className="action-audit">
                Proposed by {action.createdBy}
                {action.reviewedBy ? " · reviewed by " + action.reviewedBy : ""}
                <br />
                Review digest: {action.digest}
                {action.approvalExpiresAt && (
                  <p>
                    Approval expires{" "}
                    {new Date(action.approvalExpiresAt).toLocaleString()}
                    {Date.parse(action.approvalExpiresAt) <= Date.now()
                      ? " · expired"
                      : ""}
                  </p>
                )}
                {actionContext &&
                  (actionContext.revision !== action.revision ||
                    (action.scenarioId &&
                      actionContext.branches.get(action.scenarioId) !==
                        action.scenarioVersion)) && (
                    <p>
                      Stale context. Refresh the investigation and create a new
                      proposal.
                    </p>
                  )}
                {action.revokedAt && (
                  <p>
                    Revoked by {action.revokedBy}: {action.revocationComment}
                  </p>
                )}
              </div>
              {action.error && <p className="action-error">{action.error}</p>}
              {action.result !== undefined && (
                <pre>{JSON.stringify(action.result, null, 2)}</pre>
              )}
              <div className="action-buttons">
                {action.status === "proposed" && (
                  <>
                    <button
                      className="primary-button"
                      disabled={busy}
                      onClick={() => void review(action, true)}
                    >
                      <Check size={14} />
                      Approve proposal
                    </button>
                    <button
                      disabled={busy}
                      onClick={() => void review(action, false)}
                    >
                      <X size={14} />
                      Reject
                    </button>
                  </>
                )}
                {action.status === "approved" && (
                  <button
                    className="primary-button"
                    disabled={busy}
                    onClick={() => void execute(action)}
                  >
                    <Play size={14} />
                    Execute approved action
                  </button>
                )}
                {["proposed", "approved"].includes(action.status) && (
                  <button
                    disabled={busy}
                    onClick={() =>
                      void task(async () => {
                        await client.revokeAction(ontology, action.id, {
                          expectedVersion: action.version,
                          digest: action.digest,
                          comment: "Revoked in the operations console",
                        });
                        setActions(await client.actions(ontology));
                      })
                    }
                  >
                    Revoke authorization
                  </button>
                )}
                {["executing", "uncertain"].includes(action.status) && (
                  <button
                    className="primary-button"
                    disabled={busy}
                    onClick={() =>
                      void task(async () => {
                        await client.reconcileAction(ontology, action.id);
                        setActions(await client.actions(ontology));
                      })
                    }
                  >
                    Reconcile remote result
                  </button>
                )}
              </div>
            </article>
          ))}
        </>
      )}
      {tab === "investigations" && (
        <>
          {!investigations.length && (
            <div className="operation-card">
              No investigations yet. Start one from the GPU launch workspace.
            </div>
          )}
          {investigations.map((record) => (
            <details className="operation-card" key={record.id}>
              <summary>
                {record.question}
                <span>
                  {record.mode} · {record.status} · owner{" "}
                  {record.owner ?? "local-owner"}
                </span>
              </summary>
              <p>{record.answer}</p>
              <code>{record.id}</code>
              {record.traces.map((trace, index) => (
                <details className="tool-trace" key={index}>
                  <summary>
                    {index + 1}. {trace.name}
                    {trace.error ? " · failed" : ""}
                  </summary>
                  <pre>
                    {JSON.stringify(
                      { input: trace.input, output: trace.output },
                      null,
                      2,
                    )}
                  </pre>
                </details>
              ))}
            </details>
          ))}
        </>
      )}
      {tab === "jobs" && <JobsPanel client={client} ontology={ontology} />}
      {tab === "history" && (
        <>
          <RetentionPanel client={client} ontology={ontology} />
          <GraphRetention key={ontology} client={client} ontology={ontology} />
        </>
      )}
      {tab === "backup" && (
        <div className="backup-grid">
          <article className="operation-card">
            <h2>Save the operational workspace.</h2>
            <label>
              <input
                type="checkbox"
                checked={includeHistory}
                onChange={(e) => setIncludeHistory(e.target.checked)}
              />{" "}
              Include retained temporal versions and commits (v2)
            </label>
            <p>
              Export objects, relationships, source checkpoints, history,
              scenarios, and investigation results as checksummed JSON.
              Credentials and executable approvals are excluded.
            </p>
            <button
              className="primary-button"
              disabled={busy}
              onClick={() => void download()}
            >
              Download backup
            </button>
          </article>
          <article className="operation-card">
            <h2>Replace this ontology’s state.</h2>
            <p>
              Requires admin access and a matching live revision. Restore
              advances the revision so old approvals cannot execute against
              restored data.
            </p>
            <input
              type="file"
              accept=".json"
              aria-label="Backup file"
              onChange={(e) => {
                const selected = e.target.files?.[0];
                if (selected)
                  void selected
                    .text()
                    .then((text) => setArchive(JSON.parse(text)))
                    .catch((cause) => setError(cause.message));
              }}
            />
            <label>
              Type <code>{ontology}</code> to confirm
              <input
                aria-label="Restore confirmation"
                value={confirmation}
                onChange={(e) => setConfirmation(e.target.value)}
              />
            </label>
            <button
              className="primary-button"
              disabled={busy || !archive || confirmation !== ontology}
              onClick={() =>
                void task(async () => {
                  const current = await client.snapshot(ontology);
                  await client.restore(ontology, archive!, current.revision);
                  setConfirmation("");
                  setArchive(null);
                  setMessage("Workspace restored at a new revision.");
                })
              }
            >
              Restore workspace
            </button>
          </article>
        </div>
      )}
    </section>
  );
}
