import { useEffect, useState } from "react";
import type {
  FunctionRun,
  Investigation,
  ActionRecord,
  PromotionPreview,
} from "@graph/contracts";
import { GraphClient } from "@graph/sdk";
import { GitBranch, ShieldCheck, Search, ExternalLink } from "lucide-react";
import EvidencePanel from "../../../apps/web/src/EvidencePanel.js";
export default function RecoveryWorkflow({
  client,
  run,
  scenario,
  onChanged,
  onOpenOperations,
}: {
  client: GraphClient;
  run: FunctionRun;
  scenario?: string;
  onChanged: () => void;
  onOpenOperations?: () => void;
}) {
  const [question, setQuestion] = useState(
    "Can Aquila X900 still launch on schedule? Explain the lowest-risk feasible recovery and its graph evidence.",
  );
  const [mode, setMode] = useState("deterministic-tools");
  const [investigation, setInvestigation] = useState<Investigation | null>(
    null,
  );
  const [action, setAction] = useState<ActionRecord | null>(null);
  const [review, setReview] = useState<PromotionPreview | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    client
      .agentCapabilities()
      .then((c) => setMode(c.mode))
      .catch(() => {});
  }, []);
  useEffect(() => {
    setAction(null);
    setReview(null);
    setSelected([]);
    setConfirmed(false);
  }, [run.id]);
  async function task(work: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await work();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function investigate() {
    await task(async () => {
      setInvestigation(
        await client.investigate("semiconductor", {
          question,
          root: "aquila-x900",
          functionId: "launch-readiness",
          input: { productId: "aquila-x900" },
          scenario,
          maxSteps: 12,
        }),
      );
    });
  }
  async function propose() {
    await task(async () =>
      setAction(
        await client.proposeAction("semiconductor", {
          type: "github-recovery-issue",
          input: { runId: run.id },
          idempotencyKey: "recovery-" + run.id,
          scenario,
        }),
      ),
    );
  }
  async function preview() {
    if (scenario)
      await task(async () => {
        setReview(await client.reviewScenario("semiconductor", scenario));
        setSelected([]);
        setConfirmed(false);
      });
  }
  async function promote() {
    if (!scenario || !review) return;
    await task(async () => {
      await client.promoteScenario("semiconductor", scenario, {
        expectedVersion: review.version,
        expectedRevision: review.liveRevision,
        objects: selected
          .filter((s) => s.startsWith("object:"))
          .map((s) => s.slice(7)),
        relationships: selected
          .filter((s) => s.startsWith("relationship:"))
          .map((s) => s.slice(13)),
        confirm: true,
      });
      onChanged();
    });
  }
  return (
    <section className="recovery-workflow">
      <EvidencePanel
        client={client}
        ontology="semiconductor"
        root="aquila-x900"
        runId={run.id}
        scenario={scenario}
      />
      <div className="workflow-grid">
        <article className="operation-card">
          <div className="section-kicker">
            <Search size={16} />
            INVESTIGATION
          </div>
          <h2>Ask the connected system.</h2>
          <p>
            {mode === "model-tools"
              ? "A configured model orchestrates bounded graph tools."
              : "Deterministic tool orchestration is active. Configure a model endpoint for open-ended conversation."}{" "}
            Approval and execution are unavailable to the agent.
          </p>
          <textarea
            aria-label="Investigation question"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            rows={3}
          />
          <button
            className="primary-button"
            disabled={busy || !question}
            onClick={() => void investigate()}
          >
            Investigate through tools
          </button>
          {investigation && (
            <div className="investigation-result">
              <strong>
                {investigation.status} · {investigation.mode}
              </strong>
              <p>{investigation.answer}</p>
              <div className="tool-chips">
                {investigation.traces.map((trace, i) => (
                  <span key={i}>
                    {i + 1}. {trace.name}
                    {trace.error ? " (failed)" : ""}
                  </span>
                ))}
              </div>
              <small>{investigation.runIds.join(", ")}</small>
            </div>
          )}
        </article>
        <article className="operation-card">
          <div className="section-kicker">
            <ShieldCheck size={16} />
            PROPOSE AN ACTION
          </div>
          <h2>Turn the recovery into a task.</h2>
          <p>
            Prepare an issue containing this exact calculation and source
            evidence. Human review and explicit execution happen in the
            operations console.
          </p>
          <button
            className="primary-button"
            disabled={busy}
            onClick={() => void propose()}
          >
            Prepare GitHub recovery issue
          </button>
          {action && (
            <div className="proposal-preview">
              <strong>{action.prepared.title}</strong>
              <a href={action.prepared.target} target="_blank" rel="noreferrer">
                {action.prepared.target}
                <ExternalLink size={12} />
              </a>
              <p>Proposed only · no external changes made.</p>
              <button onClick={onOpenOperations}>
                Open action approvals →
              </button>
            </div>
          )}
        </article>
      </div>
      {scenario && (
        <article className="operation-card">
          <div className="section-kicker">
            <GitBranch size={16} />
            REVIEW LIVE CHANGES
          </div>
          <h2>Apply only the changes you choose.</h2>
          <p>
            Review against current live state. Unrelated edits are preserved;
            conflicting values block promotion.
          </p>
          <button
            className="primary-button"
            disabled={busy}
            onClick={() => void preview()}
          >
            Review scenario promotion
          </button>
          {review && (
            <div className="promotion-review">
              <p>
                Scenario v{review.version} · live revision {review.liveRevision}
              </p>
              {[
                ...review.changes.objects.map((c) => ({
                  ...c,
                  key: "object:" + c.id,
                  kindName: "object",
                })),
                ...review.changes.relationships.map((c) => ({
                  ...c,
                  key: "relationship:" + c.id,
                  kindName: "relationship",
                })),
              ].map((change) => {
                const conflicts = review.conflicts.filter(
                  (c) => c.id === change.id && c.kind === change.kindName,
                );
                return (
                  <label key={change.key}>
                    <input
                      type="checkbox"
                      checked={selected.includes(change.key)}
                      disabled={conflicts.length > 0 || busy}
                      onChange={(e) =>
                        setSelected(
                          e.target.checked
                            ? [...selected, change.key]
                            : selected.filter((s) => s !== change.key),
                        )
                      }
                    />
                    <span>
                      {change.id} · {change.kind}
                      {conflicts.length > 0
                        ? " · CONFLICT: " +
                          conflicts.map((c) => c.field ?? "record").join(", ")
                        : ""}
                    </span>
                  </label>
                );
              })}
              <label className="promotion-confirm">
                <input
                  type="checkbox"
                  aria-label="Confirm live promotion"
                  checked={confirmed}
                  onChange={(e) => setConfirmed(e.target.checked)}
                />
                I reviewed the selected changes and want to apply them to live
                state.
              </label>
              <button
                className="primary-button"
                disabled={busy || !confirmed || !selected.length}
                onClick={() => void promote()}
              >
                Apply selected changes live
              </button>
            </div>
          )}
        </article>
      )}
      {error && (
        <div role="alert" className="error">
          {error}
        </div>
      )}
    </section>
  );
}
