import { useEffect, useState } from "react";
import type { GraphClient } from "@graph/sdk";
import type { HistoryStatus, VacuumPlan } from "@graph/contracts";
import { History, ShieldCheck } from "lucide-react";
export default function RetentionPanel({
  client,
  ontology,
}: {
  client: GraphClient;
  ontology: string;
}) {
  const [status, setStatus] = useState<HistoryStatus | null>(null),
    [from, setFrom] = useState(0),
    [plan, setPlan] = useState<VacuumPlan | null>(null),
    [confirmed, setConfirmed] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState("");
  async function refresh() {
    const next = await client.historyStatus(ontology);
    setStatus(next);
    setFrom(next.retainedFrom);
  }
  useEffect(() => {
    setPlan(null);
    setConfirmed(false);
    setMessage("");
    setError("");
    void refresh().catch((cause) => setError((cause as Error).message));
  }, [ontology]);
  async function preview() {
    if (!status) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      setPlan(
        await client.vacuum(ontology, {
          generation: status.generation,
          expectedRevision: status.revision,
          retainFrom: from,
          batchSize: 100,
          dryRun: true,
        }),
      );
      setConfirmed(false);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function apply() {
    if (!plan || !confirmed) return;
    setBusy(true);
    setError("");
    try {
      const result = await client.vacuum(ontology, {
        generation: plan.generation,
        expectedRevision: plan.revision,
        retainFrom: plan.requestedFrom,
        batchSize: plan.batchSize,
        dryRun: false,
        digest: plan.digest,
        confirm: true,
      });
      setMessage(
        `Removed ${result.removed?.objectVersions} object versions, ${result.removed?.relationshipVersions} relationship versions and ${result.removed?.commits} commit records. Preview again to continue a larger cleanup.`,
      );
      setPlan(null);
      setConfirmed(false);
      await refresh();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <article className="operation-card retention-panel">
      <div className="section-kicker">
        <History size={16} />
        HISTORY RETENTION
      </div>
      <h2>Keep the snapshots that still matter.</h2>
      <p>
        Preview a retained revision boundary. Active read snapshots hold the
        watermark back; current data and independent native scenario copies
        remain available. Pruning removes historical versions, not live records.
      </p>
      {status && (
        <>
          <dl>
            <dt>Current revision</dt>
            <dd>{status.revision}</dd>
            <dt>Oldest retained revision</dt>
            <dd>{status.retainedFrom}</dd>
            <dt>Active read snapshots</dt>
            <dd>
              {status.activeSnapshots}
              {status.oldestPinnedRevision !== null
                ? ` · oldest at ${status.oldestPinnedRevision}`
                : ""}
            </dd>
          </dl>
          <label>
            Retain revisions from
            <input
              aria-label="Retain revisions from"
              type="number"
              min={status.retainedFrom}
              max={status.revision}
              value={from}
              disabled={busy}
              onChange={(event) => {
                setFrom(Number(event.target.value));
                setPlan(null);
                setConfirmed(false);
              }}
            />
          </label>
          <p className="operation-hint">
            Older history becomes unavailable at the effective watermark. No
            background vacuum runs automatically. Preview/apply requires admin
            access.
          </p>
          <button
            className="primary-button"
            disabled={busy || !Number.isInteger(from)}
            onClick={() => void preview()}
          >
            Preview history pruning
          </button>
          <button
            disabled={busy}
            onClick={() =>
              void refresh()
                .then(() => {
                  setPlan(null);
                  setConfirmed(false);
                  setError("");
                })
                .catch((cause) => setError((cause as Error).message))
            }
          >
            Refresh history status
          </button>
        </>
      )}
      {plan && (
        <section className="sync-review">
          <h3>Review retention plan</h3>
          <p>
            Requested boundary: revision {plan.requestedFrom}. Protected
            watermark: <strong>{plan.watermark}</strong>.
          </p>
          <p>
            {plan.eligible.objectVersions} object versions ·{" "}
            {plan.eligible.relationshipVersions} relationship versions ·{" "}
            {plan.eligible.commits} commit records eligible. Each apply removes
            at most {plan.batchSize} per kind.
          </p>
          {plan.protectedSnapshots.length > 0 && (
            <ul>
              {plan.protectedSnapshots.map((pin) => (
                <li key={pin.id}>
                  Snapshot at revision {pin.revision} · {pin.owner} · expires{" "}
                  {new Date(pin.expiresAt).toLocaleString()}
                </li>
              ))}
            </ul>
          )}
          {plan.protectedBranches.length > 0 && (
            <p>
              Versioned branches pin revisions{" "}
              {plan.protectedBranches
                .map((branch) => branch.revision)
                .join(", ")}
              .
            </p>
          )}
          <label>
            <input
              aria-label="Confirm history pruning"
              type="checkbox"
              checked={confirmed}
              onChange={(event) => setConfirmed(event.target.checked)}
            />
            I reviewed this boundary and want to remove eligible historical
            versions.
          </label>
          <button
            className="primary-button"
            disabled={busy || !confirmed}
            onClick={() => void apply()}
          >
            <ShieldCheck size={14} />
            Prune reviewed batch
          </button>
          <small>Review digest: {plan.digest}</small>
        </section>
      )}
      {message && (
        <p className="operation-message" role="status">
          {message}
        </p>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </article>
  );
}
