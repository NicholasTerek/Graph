import { useState } from "react";
import type { GraphClient } from "@graph/sdk";
export default function GraphRetention({
  client,
  ontology,
}: {
  client: GraphClient;
  ontology: string;
}) {
  const [plan, setPlan] = useState<Awaited<
    ReturnType<GraphClient["collectNativeGraphs"]>
  > | null>(null);
  const [confirmation, setConfirmation] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  async function run(apply: boolean) {
    setBusy(true);
    setError("");
    try {
      setPlan(
        await client.collectNativeGraphs(
          ontology,
          apply
            ? {
                dryRun: false,
                digest: plan!.digest,
                confirmOntology: confirmation,
              }
            : {},
        ),
      );
      setConfirmation("");
    } catch (e) {
      setError((e as Error).message);
      setPlan(null);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="operation-card">
      <h2>Native branch graph retention</h2>
      <p>
        Review unpublished copy/projection graphs in this ontology. Published
        branch and base graphs are retained. Overlay deltas and temporal history
        have separate retention rules.
      </p>
      <button disabled={busy} onClick={() => void run(false)}>
        Preview orphan graphs
      </button>
      {error && <p role="alert">{error}</p>}
      {plan && (
        <>
          <p>
            {plan.graphs.length} native graphs · {plan.orphanCount} unreferenced
            · {plan.deleted.length} deleted
          </p>
          <ul>
            {plan.graphs.map((g) => (
              <li key={g.key}>
                <code>{g.key}</code> ·{" "}
                {g.retained ? "retained" : "unreferenced"}
              </li>
            ))}
          </ul>
          {plan.dryRun && plan.orphanCount > 0 && (
            <>
              <label>
                Type {ontology} to collect{" "}
                <input
                  aria-label="Confirm graph collection ontology"
                  value={confirmation}
                  onChange={(e) => setConfirmation(e.target.value)}
                />
              </label>
              <button
                disabled={busy || confirmation !== ontology}
                onClick={() => void run(true)}
              >
                Collect reviewed orphan graphs
              </button>
            </>
          )}
        </>
      )}
    </section>
  );
}
