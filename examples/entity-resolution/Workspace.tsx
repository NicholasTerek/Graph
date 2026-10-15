import { useEffect, useState } from "react";
import type { GraphClient } from "@graph/sdk";
import type { GraphObject, Source } from "@graph/contracts";
import type { ResolutionResult } from "./functions.js";
import { resolutionOntology } from "./constants.js";
import {
  prepareResolution,
  prepareResolutionUndo,
  promoteResolution,
  type ResolutionReview,
} from "./workflow.js";
export default function ResolutionWorkspace({
  client,
}: {
  client: GraphClient;
}) {
  const [result, setResult] = useState<ResolutionResult | null>(null),
    [revision, setRevision] = useState(0),
    [scoreRevision, setScoreRevision] = useState(0),
    [records, setRecords] = useState<GraphObject[]>([]),
    [sources, setSources] = useState<Source[]>([]);
  const [selected, setSelected] = useState<string[]>([]),
    [review, setReview] = useState<ResolutionReview | null>(null),
    [confirmed, setConfirmed] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState("");
  async function load() {
    const run = await client.runFunction<ResolutionResult>(
        resolutionOntology,
        "supplier-candidates",
        {},
      ),
      state = await client.snapshot(resolutionOntology);
    setResult(run.output);
    setScoreRevision(run.revision);
    setRevision(state.revision);
    setRecords(state.objects.filter((o) => o.type === "Resolution"));
    setSources(await client.sources(resolutionOntology));
  }
  async function task(work: () => Promise<void>) {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await work();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    void task(load);
  }, []);
  return (
    <section className="operations resolution-workspace">
      <div className="section-kicker">SYNTHETIC IDENTITY LAB</div>
      <h1>Review shared-neighbor evidence.</h1>
      <p>
        One bounded supplier example across CSV, JSON and a GitHub issue
        fixture. Jaccard overlap scores shared graph neighbors. Tied candidates
        are rejected. Original aliases and source evidence remain available
        after review.
      </p>
      <button disabled={busy} onClick={() => void task(load)}>
        Refresh identity evidence
      </button>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {message && <p role="status">{message}</p>}
      {result && (
        <>
          <p>
            Rule {result.ruleId} · minimum overlap {result.threshold * 100}% ·
            scored revision {scoreRevision} · live revision {revision}
          </p>
          <div className="identity-candidates">
            {result.aliases.map((alias) => (
              <article className="operation-card identity-alias" key={alias.id}>
                <h2>{alias.name}</h2>
                <p>
                  {sources.find((s) => s.id === alias.sourceId)?.connector ??
                    alias.sourceId}{" "}
                  · source {alias.sourceId} · row {alias.externalId}
                </p>
                <strong>{alias.status}</strong>
                {alias.status === "ambiguous" && (
                  <p>
                    Equal top scores. This alias cannot be included in a merge.
                  </p>
                )}
                {alias.status === "resolved" && (
                  <p>Canonical identity: {alias.canonicalId}</p>
                )}
                <label>
                  <input
                    aria-label={`Select ${alias.name}`}
                    type="checkbox"
                    disabled={busy || alias.status !== "matched" || !!review}
                    checked={selected.includes(alias.id)}
                    onChange={(e) =>
                      setSelected(
                        e.target.checked
                          ? [...selected, alias.id]
                          : selected.filter((id) => id !== alias.id),
                      )
                    }
                  />{" "}
                  Include this alias
                </label>
                <ul>
                  {alias.candidates.map((candidate) => (
                    <li key={candidate.canonicalId}>
                      <strong>{candidate.name}</strong> ·{" "}
                      {(candidate.score * 100).toFixed(1)}% (
                      {candidate.shared.length}/{candidate.unionCount}{" "}
                      neighbors)
                      <ul>
                        {candidate.shared.map((e) => (
                          <li key={e.id}>
                            {e.name} · {e.type} · <code>{e.id}</code>
                          </li>
                        ))}
                      </ul>
                    </li>
                  ))}
                </ul>
              </article>
            ))}
          </div>
          <button
            disabled={
              busy || !selected.length || !!review || scoreRevision !== revision
            }
            onClick={() =>
              void task(async () => {
                const targets = new Set(
                  result.aliases
                    .filter((a) => selected.includes(a.id))
                    .map((a) => a.canonicalId),
                );
                if (targets.size !== 1 || ![...targets][0])
                  throw Error(
                    "Select aliases matched to one canonical supplier",
                  );
                setReview(
                  await prepareResolution(client, selected, [...targets][0]!),
                );
                setConfirmed(false);
                await load();
              })
            }
          >
            Prepare identity review
          </button>
        </>
      )}
      {review && (
        <article className="operation-card identity-review">
          <h2>
            Review prepared identity{" "}
            {review.operation === "resolve" ? "change" : "reversal"}
          </h2>
          <p>
            Branch {review.scenarioId} · v{review.preview.version} · live
            revision {review.preview.liveRevision}
          </p>
          <p>
            {review.preview.changes.objects.length} audit record changes ·{" "}
            {
              review.preview.changes.relationships.filter(
                (c) => c.before?.type === "ORDERED_FROM",
              ).length
            }{" "}
            operational references · {review.preview.conflicts.length} conflicts
          </p>
          {review.preview.liveRevision !== revision && (
            <p>Live data changed. Discard this review and prepare it again.</p>
          )}
          <details>
            <summary>Exact native changes</summary>
            <pre>{JSON.stringify(review.preview.changes, null, 2)}</pre>
          </details>
          <label>
            <input
              aria-label="Confirm supplier identity promotion"
              type="checkbox"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
            />{" "}
            I reviewed the selected aliases, evidence and exact reference
            changes.
          </label>
          <button
            disabled={
              busy ||
              !confirmed ||
              !!review.preview.conflicts.length ||
              review.preview.liveRevision !== revision
            }
            onClick={() =>
              void task(async () => {
                await promoteResolution(client, review, confirmed);
                const operation = review.operation;
                setReview(null);
                setSelected([]);
                setConfirmed(false);
                await load();
                setMessage(
                  operation === "resolve"
                    ? "Resolution applied. Source aliases retained."
                    : "Resolution reverted. Original references restored; audit retained.",
                );
              })
            }
          >
            {review.operation === "resolve"
              ? "Promote reviewed resolution"
              : "Promote reviewed reversal"}
          </button>
          <button
            disabled={busy}
            onClick={() =>
              void task(async () => {
                await client.discardScenario(
                  resolutionOntology,
                  review.scenarioId,
                );
                setReview(null);
                setConfirmed(false);
              })
            }
          >
            Discard prepared identity review
          </button>
        </article>
      )}
      {records.map((record) => (
        <article className="operation-card" key={record.id}>
          <h2>{String(record.properties.name)}</h2>
          <p>
            {String(record.properties.status)} · {record.id} · canonical{" "}
            {String(record.properties.canonicalId)}
          </p>
          <p>
            Review branch {String(record.properties.branchId)} retains the
            native before/after states needed for reversal.
          </p>
          {record.properties.status === "applied" && (
            <button
              disabled={busy || !!review}
              onClick={() =>
                void task(async () => {
                  setReview(await prepareResolutionUndo(client, record.id));
                  setConfirmed(false);
                  await load();
                })
              }
            >
              Prepare identity reversal
            </button>
          )}
        </article>
      ))}
    </section>
  );
}
