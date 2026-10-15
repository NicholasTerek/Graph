import { useEffect, useState } from "react";
import { Route, FileSearch, AlertTriangle } from "lucide-react";
import type { Explanation } from "@graph/contracts";
import type { GraphClient } from "@graph/sdk";
import "./evidence.css";
export default function EvidencePanel({
  client,
  ontology,
  root,
  runId,
  scenario,
}: {
  client: GraphClient;
  ontology: string;
  root: string;
  runId?: string;
  scenario?: string;
}) {
  const [evidence, setEvidence] = useState<Explanation | null>(null);
  const [selected, setSelected] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    setEvidence(null);
    setSelected("");
    setError("");
  }, [ontology, root, runId, scenario]);
  async function load() {
    setBusy(true);
    setError("");
    try {
      const result = await client.explain(ontology, {
        root,
        runId,
        scenario,
        maxDepth: 5,
      });
      setEvidence(result);
      setSelected(result.paths[0]?.target ?? root);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const record = evidence?.records.find((o) => o.id === selected);
  const path = evidence?.paths.find((p) => p.target === selected);
  const name = (id: string) =>
    String(evidence?.records.find((o) => o.id === id)?.properties.name ?? id);
  return (
    <article className="operation-card decision-evidence">
      <div className="section-kicker">
        <FileSearch size={16} />
        DECISION EVIDENCE
      </div>
      <h2>Why this recovery?</h2>
      <p>
        Inspect the calculation rules, actual dependency paths, and the source
        values used. Saved evidence stays attached to its calculation.
      </p>
      <button
        className="primary-button"
        disabled={busy}
        onClick={() => void load()}
      >
        {busy
          ? "Tracing evidence…"
          : evidence
            ? "Refresh evidence context"
            : "Explain this recommendation"}
      </button>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {evidence && (
        <div className="decision-content">
          <div className="decision-context">
            <span>Revision {evidence.context.revision}</span>
            <span>
              {evidence.context.scenario
                ? `Scenario v${evidence.context.scenarioVersion}`
                : "Live calculation"}
            </span>
            <span>
              {evidence.context.scope === "calculation-readset"
                ? "Captured calculation inputs"
                : "Current graph evidence"}
            </span>
          </div>
          {evidence.context.stale && (
            <p className="decision-warning" role="status">
              <AlertTriangle size={15} />
              Context has changed. This explanation shows the saved calculation,
              not a recalculation against current values.
            </p>
          )}
          <div className="decision-claims">
            {evidence.claims
              .filter(
                (c) =>
                  c.kind === "calculated" &&
                  (c.id === "recommendation" || c.id === "baseline"),
              )
              .map((claim) => (
                <div key={claim.id}>
                  <strong>
                    {claim.id === "recommendation"
                      ? "Selected recovery"
                      : "Current supplier path"}
                  </strong>
                  <p>{claim.text}</p>
                  <small>Rule {claim.ruleId}</small>
                </div>
              ))}
          </div>
          <div className="decision-path-heading">
            <Route size={16} />
            <h3>Follow a dependency</h3>
            <small>
              Directed native paths · up to {evidence.query.maxDepth} hops
            </small>
          </div>
          <div className="decision-targets">
            {evidence.paths.map((p) => (
              <button
                key={p.target}
                aria-pressed={p.target === selected}
                onClick={() => setSelected(p.target)}
              >
                {name(p.target)}
                <small>
                  {p.hops} {p.hops === 1 ? "hop" : "hops"}
                </small>
              </button>
            ))}
          </div>
          {path && (
            <ol className="decision-path" aria-label="Evidence dependency path">
              {path.objects.map((id, index) => (
                <li key={id + index}>
                  <button onClick={() => setSelected(id)}>{name(id)}</button>
                  {index < path.relationships.length && (
                    <span>
                      {evidence.relationships.find(
                        (r) => r.id === path.relationships[index],
                      )?.type ?? path.relationships[index]}
                      <small>{path.relationships[index]}</small>
                    </span>
                  )}
                </li>
              ))}
            </ol>
          )}
          {record && (
            <section className="decision-record">
              <h3>{name(record.id)}</h3>
              <small>
                {record.type} · {record.id}
              </small>
              <p>
                Record source: {record.provenance.source} · observed{" "}
                {new Date(record.provenance.observedAt).toLocaleString()}
              </p>
              <dl>
                {Object.entries(record.properties).map(([key, value]) => (
                  <div key={key}>
                    <dt>{key}</dt>
                    <dd>{String(value)}</dd>
                  </div>
                ))}
              </dl>
              {evidence.contributors
                .filter((c) => c.objectId === record.id)
                .map((contributor) => (
                  <div className="decision-source" key={contributor.sourceId}>
                    <strong>{contributor.sourceId}</strong>
                    <p>
                      {contributor.matches
                        ? "Mapped source values match these calculation inputs."
                        : "These inputs override or differ from the mapped source values."}
                    </p>
                    <small>
                      External ID: {contributor.externalId}
                      <br />
                      Checkpoint: {contributor.checkpoint ?? "none"}
                      <br />
                      Source sync: {contributor.observedAt ?? "not recorded"}
                    </small>
                    <details>
                      <summary>Mapped source values</summary>
                      <pre>{JSON.stringify(contributor.values, null, 2)}</pre>
                    </details>
                  </div>
                ))}
              {!evidence.contributors.some((c) => c.objectId === record.id) && (
                <p className="decision-note">
                  No registered source mapping was captured for this record; its
                  record provenance is shown above.
                </p>
              )}
            </section>
          )}
          <details className="decision-details">
            <summary>Eligibility checks and calculation steps</summary>
            <ul>
              {evidence.claims
                .filter(
                  (c) =>
                    c.kind !== "assumption" &&
                    c.id !== "recommendation" &&
                    c.id !== "baseline",
                )
                .map((claim) => (
                  <li key={claim.id}>
                    <span
                      className={
                        claim.passed === false ? "decision-failed" : ""
                      }
                    >
                      {claim.passed === undefined
                        ? "Step"
                        : claim.passed
                          ? "Pass"
                          : "Fail"}{" "}
                      · {claim.text}
                    </span>
                    <small>
                      {claim.ruleId} · evidence: {claim.recordIds.join(", ")}
                    </small>
                  </li>
                ))}
            </ul>
          </details>
          <details className="decision-details">
            <summary>Model assumptions</summary>
            <ul>
              {evidence.claims
                .filter((c) => c.kind === "assumption")
                .map((claim) => (
                  <li key={claim.id}>
                    {claim.text}
                    <small>Rule {claim.ruleId ?? "unspecified"}</small>
                    <div className="decision-paths">
                      {claim.recordIds.map((id) => (
                        <button key={id} onClick={() => setSelected(id)}>
                          {name(id)}
                        </button>
                      ))}
                    </div>
                  </li>
                ))}
            </ul>
          </details>
          {evidence.warnings.length > 0 && (
            <details className="decision-details">
              <summary>Evidence limits ({evidence.warnings.length})</summary>
              <ul>
                {evidence.warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            </details>
          )}
          <small className="decision-note">
            Calculation: {evidence.calculation?.id ?? "none selected"} ·{" "}
            {evidence.calculation?.executedAt ?? "current state"}
          </small>
        </div>
      )}
    </article>
  );
}
