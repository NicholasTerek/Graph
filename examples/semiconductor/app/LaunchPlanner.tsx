import RecoveryWorkflow from "./RecoveryWorkflow.js";
import HistoryTimeline from "../../../apps/web/src/HistoryTimeline.js";
import { useEffect, useRef, useState } from "react";
import {
  Activity,
  ArrowUpRight,
  GitBranch,
  CheckCircle2,
  Clock,
  AlertTriangle,
  ChevronDown,
  Database,
  RotateCcw,
  Play,
  ExternalLink,
} from "lucide-react";
import { GraphClient } from "@graph/sdk";
import type {
  GraphState,
  Scenario,
  ScenarioDiff,
  FunctionRun,
} from "@graph/contracts";
import type { LaunchResult } from "../functions/launch-readiness.js";
import "./launch.css";
const usd = (amount: number) =>
  new Intl.NumberFormat("en-CA", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(amount);
const ontology = "semiconductor";
export default function LaunchPlanner({
  client,
  onOpenOperations,
}: {
  client: GraphClient;
  onOpenOperations?: () => void;
}) {
  const [state, setState] = useState<GraphState | null>(null);
  const [run, setRun] = useState<
    (FunctionRun & { output: LaunchResult }) | null
  >(null);
  const [live, setLive] = useState<LaunchResult | null>(null);
  const [scenarios, setScenarios] = useState<Scenario[]>([]);
  const [scenario, setScenario] = useState<Scenario | null>(null);
  const [diff, setDiff] = useState<ScenarioDiff | null>(null);
  const [lead, setLead] = useState(7);
  const [repair, setRepair] = useState(10);
  const [expedite, setExpedite] = useState(10);
  const [capacity, setCapacity] = useState(300);
  const [qualified, setQualified] = useState(true);
  const [demand, setDemand] = useState(1000);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [evidence, setEvidence] = useState<string | null>(null);
  const [historical, setHistorical] = useState<number | null>(null);
  const [liveRevision, setLiveRevision] = useState(0);
  const token = useRef(0);
  const result = run?.output;
  function assumptions(graph: GraphState) {
    setCapacity(
      Number(
        graph.objects.find((o) => o.id === "meridian")?.properties
          .dailyCapacity,
      ),
    );
    setQualified(
      graph.objects.find((o) => o.id === "meridian")?.properties.qualified ===
        true,
    );
    setDemand(
      Number(
        graph.objects.find((o) => o.id === "aquila-x900")?.properties
          .demandUnits,
      ),
    );
    setLead(
      Number(
        graph.objects.find((o) => o.id === "meridian")?.properties.leadDays,
      ),
    );
    setRepair(
      Number(graph.objects.find((o) => o.id === "gpu-142")?.properties.fixDays),
    );
    setExpedite(
      Number(
        graph.objects.find((o) => o.id === "northstar")?.properties
          .expeditedLeadDays,
      ),
    );
  }
  async function refreshLive() {
    const current = ++token.current;
    setBusy(true);
    setError("");
    let pin: string | undefined;
    try {
      const snapshot = await client.createReadSnapshot(ontology);
      pin = snapshot.id;
      const [graph, analysis, branches] = await Promise.all([
        client.stateAt(ontology, { snapshot: pin }),
        client.runFunction<LaunchResult>(
          ontology,
          "launch-readiness",
          { productId: "aquila-x900" },
          undefined,
          { snapshot: pin },
        ),
        client.scenarios(ontology),
      ]);
      if (current !== token.current) return;
      setState(graph);
      setHistorical(null);
      setLiveRevision(graph.revision);
      setRun(analysis);
      setLive(analysis.output);
      setScenarios(branches);
      setScenario(null);
      setDiff(null);
      assumptions(graph);
    } catch (e) {
      if (current === token.current) setError((e as Error).message);
    } finally {
      if (pin) await client.releaseReadSnapshot(ontology, pin).catch(() => {});
      if (current === token.current) setBusy(false);
    }
  }
  useEffect(() => {
    void refreshLive();
    return () => {
      token.current++;
    };
  }, []);
  async function openScenario(id: string) {
    if (!id) {
      await refreshLive();
      return;
    }
    const current = ++token.current;
    setBusy(true);
    setError("");
    try {
      const [branch, graph, comparison, analysis] = await Promise.all([
        client.scenario(ontology, id),
        client.scenarioGraph(ontology, id),
        client.scenarioDiff(ontology, id),
        client.runFunction<LaunchResult>(
          ontology,
          "launch-readiness",
          { productId: "aquila-x900" },
          id,
        ),
      ]);
      if (current !== token.current) return;
      if (
        branch.version !== graph.scenarioVersion ||
        branch.version !== analysis.scenarioVersion ||
        branch.version !== comparison.version
      )
        throw new Error(
          "Scenario changed while loading; select it again to read a consistent version.",
        );
      setScenario(branch);
      setHistorical(null);
      setState(graph);
      setDiff(comparison);
      setRun(analysis);
      assumptions(graph);
    } catch (e) {
      if (current === token.current) setError((e as Error).message);
    } finally {
      if (current === token.current) setBusy(false);
    }
  }
  async function inspectHistorical(revision: number) {
    const current = ++token.current;
    setBusy(true);
    setError("");
    let pin: string | undefined;
    try {
      const snapshot = await client.createReadSnapshot(ontology, {
        revision,
        ttlSeconds: 300,
      });
      pin = snapshot.id;
      const [graph, analysis] = await Promise.all([
        client.stateAt(ontology, { snapshot: pin }),
        client.runFunction<LaunchResult>(
          ontology,
          "launch-readiness",
          { productId: "aquila-x900" },
          undefined,
          { snapshot: pin },
        ),
      ]);
      if (current !== token.current) return;
      setHistorical(graph.revision);
      setState(graph);
      setRun(analysis);
      setScenario(null);
      setDiff(null);
      assumptions(graph);
    } catch (cause) {
      if (current === token.current) setError((cause as Error).message);
    } finally {
      if (pin) await client.releaseReadSnapshot(ontology, pin).catch(() => {});
      if (current === token.current) setBusy(false);
    }
  }
  async function evaluate() {
    if (!state || historical !== null) return;
    if (
      [lead, repair, expedite].some(
        (n) => !Number.isFinite(n) || n < 0 || n > 90,
      )
    ) {
      setError("Enter finite durations between 0 and 90 days.");
      return;
    }
    if (
      !Number.isFinite(capacity) ||
      capacity < 0 ||
      capacity > 1000000 ||
      !Number.isFinite(demand) ||
      demand < 1 ||
      demand > 1000000
    ) {
      setError("Demand and capacity must be valid nonnegative quantities.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      let branch =
        scenario ??
        (await client.createScenario(ontology, {
          id: `recovery-${crypto.randomUUID()}`,
          name: `Recovery · ${new Date().toLocaleTimeString()}`,
          expectedRevision: state.revision,
          description:
            "Packaging and driver recovery assumptions for Aquila X900.",
        }));
      const changes: {
        id: string;
        key: string;
        value: string | number | boolean;
      }[] = [
        { id: "meridian", key: "dailyCapacity", value: capacity },
        { id: "meridian", key: "qualified", value: qualified },
        { id: "aquila-x900", key: "demandUnits", value: demand },
        { id: "meridian", key: "leadDays", value: lead },
        { id: "gpu-142", key: "fixDays", value: repair },
        { id: "northstar", key: "expeditedLeadDays", value: expedite },
      ];
      const changed = new Map<string, GraphState["objects"][number]>();
      for (const change of changes) {
        const base = state.objects.find((o) => o.id === change.id);
        if (!base) throw new Error("Missing example data: " + change.id);
        const object = changed.get(change.id) ?? structuredClone(base);
        if (object.properties[change.key] !== change.value) {
          object.properties[change.key] = change.value;
          object.provenance = {
            source: "scenario:" + branch.id,
            externalId: object.id,
            observedAt: new Date().toISOString(),
          };
          changed.set(object.id, object);
        }
      }
      const objects = [...changed.values()];
      branch = await client.editScenario(ontology, branch.id, {
        objects,
        expectedVersion: branch.version,
      });
      setScenario(branch);
      const [graph, comparison, analysis, branches] = await Promise.all([
        client.scenarioGraph(ontology, branch.id),
        client.scenarioDiff(ontology, branch.id),
        client.runFunction<LaunchResult>(
          ontology,
          "launch-readiness",
          { productId: "aquila-x900" },
          branch.id,
        ),
        client.scenarios(ontology),
      ]);
      setState(graph);
      setDiff(comparison);
      setRun(analysis);
      setScenarios(branches);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function discard() {
    if (!scenario) return;
    setBusy(true);
    try {
      await client.discardScenario(ontology, scenario.id);
      await refreshLive();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }
  const record = result?.evidence.find((e) => e.id === evidence);
  return (
    <div className="launch-workspace">
      <div className="launch-title">
        <div>
          <div className="eyebrow">
            SEMICONDUCTOR OPERATIONS / SYNTHETIC DEMO
          </div>
          <h1>Can Aquila X900 launch on time?</h1>
          <p>
            One decision, connected across hardware supply, driver engineering,
            and customer commitments.
          </p>
        </div>
        <a
          href="/api/docs"
          target="_blank"
          rel="noreferrer"
          className="api-link"
        >
          Public API
          <ExternalLink size={13} />
        </a>
      </div>
      {error && (
        <div role="alert" className="error">
          {error}
          <button onClick={() => void refreshLive()}>Reload live data</button>
        </div>
      )}
      {!result && busy && (
        <div className="planner-loading">
          Reading operational graph and calculating alternatives…
        </div>
      )}
      {result && (
        <>
          <div className="launch-context">
            <span className="context-pill">
              <Clock size={13} />
              {result.deadlineDays} days to launch
            </span>
            <span className="context-pill">
              <Database size={13} />
              Revision {run.revision}
            </span>
            <span className="context-pill">
              <GitBranch size={13} />
              {historical !== null
                ? "Read-only historical snapshot"
                : scenario
                  ? `Scenario · ${scenario.storage === "falkordb-overlay" ? "revision overlay" : "native copy"} · base r${scenario.baseRevision} · v${scenario.version} · owner ${scenario.owner ?? "local-owner"}`
                  : "Live baseline"}
            </span>
            <span className="synthetic-tag">
              Synthetic data · deterministic calculations
            </span>
          </div>
          <HistoryTimeline
            client={client}
            ontology={ontology}
            currentRevision={liveRevision}
            activeRevision={historical}
            onInspect={inspectHistorical}
            onLive={refreshLive}
            disabled={busy}
          />
          <div className="launch-summary">
            <div
              className={`decision-card ${result.recommendation.feasible ? "on-track" : "late"}`}
            >
              <div className="decision-label">
                {result.recommendation.feasible ? (
                  <CheckCircle2 size={18} />
                ) : (
                  <AlertTriangle size={18} />
                )}
                RECOMMENDED RECOVERY
              </div>
              <h2 data-testid="recommendation">
                {result.recommendation.label}
              </h2>
              <p>
                {!result.recommendation.eligible
                  ? "No eligible recovery plan: review qualification, capacity and driver constraints."
                  : result.recommendation.feasible
                    ? `Feasible with ${result.deadlineDays - result.recommendation.readyDays} days of modeled slack.`
                    : `No on-time option under these assumptions. Earliest recommended delay: ${result.recommendation.delayDays} days.`}
              </p>
              <div className="decision-foot">
                <span>
                  Ready in{" "}
                  <strong data-testid="ready-days">
                    {result.recommendation.readyDays} days
                  </strong>
                </span>
                <span>{usd(result.recommendation.costUSD)} incremental</span>
                <span>{result.recommendation.riskPoints} risk points</span>
              </div>
            </div>
            <div className="baseline-card">
              <span>CURRENT SUPPLIER PATH</span>
              <strong>
                {result.baseline.delayDays}
                <small>days late</small>
              </strong>
              <p>
                {result.baseline.hardware.map((h) => h.supplierName).join(", ")}{" "}
                · current driver
              </p>
              <div>
                Hardware {result.baseline.hardwareReadyDays}d · software{" "}
                {result.baseline.softwareReadyDays}d<br />+{" "}
                {result.baseline.validationDays}d hardware validation +{" "}
                {result.baseline.integrationDays}d final integration
              </div>
            </div>
          </div>
          <div className="planner-columns">
            <section className="assumption-panel">
              <div className="section-kicker">
                <GitBranch size={16} />
                WHAT IF?
              </div>
              <h2>Change the recovery assumptions.</h2>
              <p>
                Changes stay in a saved scenario. Live records remain unchanged.
              </p>
              <label>
                Meridian packaging lead time{" "}
                <span>
                  <input
                    aria-label="Meridian lead days"
                    type="number"
                    min="0"
                    max="90"
                    value={Number.isNaN(lead) ? "" : lead}
                    disabled={busy || historical !== null}
                    onChange={(e) =>
                      setLead(
                        e.target.value === "" ? NaN : Number(e.target.value),
                      )
                    }
                  />
                  days
                </span>
              </label>
              <label>
                Driver regression repair{" "}
                <span>
                  <input
                    aria-label="Driver repair days"
                    type="number"
                    min="0"
                    max="90"
                    value={Number.isNaN(repair) ? "" : repair}
                    disabled={busy || historical !== null}
                    onChange={(e) =>
                      setRepair(
                        e.target.value === "" ? NaN : Number(e.target.value),
                      )
                    }
                  />
                  days
                </span>
              </label>
              <label>
                Expedited Northstar delivery{" "}
                <span>
                  <input
                    aria-label="Northstar expedited days"
                    type="number"
                    min="0"
                    max="90"
                    value={Number.isNaN(expedite) ? "" : expedite}
                    disabled={busy || historical !== null}
                    onChange={(e) =>
                      setExpedite(
                        e.target.value === "" ? NaN : Number(e.target.value),
                      )
                    }
                  />
                  days
                </span>
              </label>
              <details className="hard-constraints">
                <summary>Inventory & qualification constraints</summary>
                <label>
                  Launch demand{" "}
                  <input
                    aria-label="Launch demand units"
                    type="number"
                    min="1"
                    value={Number.isNaN(demand) ? "" : demand}
                    disabled={busy || historical !== null}
                    onChange={(e) =>
                      setDemand(
                        e.target.value === "" ? NaN : Number(e.target.value),
                      )
                    }
                  />
                </label>
                <label>
                  Meridian units/day{" "}
                  <input
                    aria-label="Meridian daily capacity"
                    type="number"
                    min="0"
                    value={Number.isNaN(capacity) ? "" : capacity}
                    disabled={busy || historical !== null}
                    onChange={(e) =>
                      setCapacity(
                        e.target.value === "" ? NaN : Number(e.target.value),
                      )
                    }
                  />
                </label>
                <label>
                  Meridian qualified{" "}
                  <input
                    aria-label="Meridian qualification"
                    type="checkbox"
                    checked={qualified}
                    disabled={busy || historical !== null}
                    onChange={(e) => setQualified(e.target.checked)}
                  />
                </label>
              </details>
              <button
                className="primary-button evaluate"
                disabled={busy || historical !== null}
                onClick={() => void evaluate()}
              >
                <Play size={14} />
                {busy ? "Calculating…" : "Evaluate scenario"}
              </button>
              <div className="scenario-controls">
                <select
                  aria-label="Saved scenario"
                  value={scenario?.id ?? ""}
                  disabled={busy || historical !== null}
                  onChange={(e) => void openScenario(e.target.value)}
                >
                  <option value="">Live baseline</option>
                  {scenarios.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
                <button
                  title="Reset to live"
                  disabled={busy}
                  onClick={() => void refreshLive()}
                >
                  <RotateCcw size={15} />
                </button>
              </div>
              {scenario && (
                <button
                  className="discard"
                  disabled={busy || historical !== null}
                  onClick={() => void discard()}
                >
                  Discard this scenario
                </button>
              )}
              {diff && (
                <div className="scenario-diff">
                  <strong>
                    Scenario diff · base revision {diff.baseRevision}
                  </strong>
                  {diff.stale && (
                    <p className="stale-warning">
                      Live data has moved to revision {diff.liveRevision}. This
                      branch still uses its pinned base.
                    </p>
                  )}
                  {diff.objects.length === 0 ? (
                    <p>No object changes.</p>
                  ) : (
                    diff.objects.map((change) => (
                      <div key={change.id}>
                        <code>{change.id}</code>
                        {Object.entries(change.after?.properties ?? {})
                          .filter(
                            ([key, value]) =>
                              value !== change.before?.properties[key],
                          )
                          .map(([key, value]) => (
                            <span key={key}>
                              {key}:{" "}
                              <s>
                                {String(change.before?.properties[key] ?? "—")}
                              </s>{" "}
                              → <b>{String(value)}</b>
                            </span>
                          ))}
                      </div>
                    ))
                  )}
                </div>
              )}
            </section>
            <section className="alternatives-panel">
              <div className="section-kicker">
                <Activity size={16} />
                CALCULATED ALTERNATIVES
              </div>
              <h2>Compare the actual trade-offs.</h2>
              <p>
                On-time plans rank by modeled risk, cost, then readiness. Risk
                points are ordinal assumptions.
              </p>
              <div className="plan-table-scroll">
                <table className="plan-table">
                  <thead>
                    <tr>
                      <th>Recovery plan</th>
                      <th>Ready</th>
                      <th>Cost</th>
                      <th>Risk</th>
                      <th>Launch</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.plans.map((plan) => (
                      <tr
                        key={plan.id}
                        className={
                          plan.id === result.recommendation.id
                            ? "recommended-row"
                            : ""
                        }
                      >
                        <td>
                          <strong>
                            {plan.hardware
                              .map(
                                (h) =>
                                  (h.expedited ? "Expedite " : "") +
                                  h.supplierName,
                              )
                              .join(" + ")}
                          </strong>
                          <span>
                            {plan.validation === "validated"
                              ? "Validated fallback"
                              : "Repair + revalidate"}{" "}
                            · {plan.releaseName}
                          </span>
                          <small>
                            Hardware {plan.hardwareReadyDays}d / software{" "}
                            {plan.softwareReadyDays}d + {plan.integrationDays}d
                            integration
                          </small>
                        </td>
                        <td>{plan.readyDays}d</td>
                        <td>{usd(plan.costUSD)}</td>
                        <td>{plan.riskPoints}</td>
                        <td>
                          <span
                            className={`feasibility ${plan.feasible ? "feasible" : ""}`}
                          >
                            {!plan.eligible
                              ? "Blocked"
                              : plan.feasible
                                ? "On time"
                                : `+${plan.delayDays}d`}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="formula">
                ready = max(hardware readiness, software readiness) + final
                integration
              </div>
            </section>
          </div>
          <section className="operation-card critical-schedule">
            <div className="section-kicker">
              CRITICAL PATH / RECOMMENDED PLAN
            </div>
            <h2>From missing units to validated hardware.</h2>
            <p>
              {result.demandUnits} launch units ·{" "}
              {result.recommendation.hardware
                .map(
                  (h) =>
                    h.inventoryUnits +
                    " in stock, " +
                    h.shortageUnits +
                    " to produce at " +
                    h.dailyCapacity +
                    "/day",
                )
                .join(" · ")}
            </p>
            {result.recommendation.tasks.map((task) => (
              <div
                className={`schedule-row ${task.critical ? "critical" : ""}`}
                key={task.id}
              >
                <span>{task.label}</span>
                <div>
                  <i
                    style={{
                      marginLeft: `${(task.start / result.recommendation.readyDays) * 100}%`,
                      width: `${Math.max(1, (task.duration / result.recommendation.readyDays) * 100)}%`,
                    }}
                  />
                </div>
                <small>
                  {task.start}–{task.end}d
                </small>
              </div>
            ))}
            <div className="constraint-results">
              {result.recommendation.constraints.map((c) => (
                <span key={c.code} className={c.passed ? "passed" : "failed"}>
                  {c.passed ? "✓" : "✕"} {c.message}
                </span>
              ))}
            </div>
          </section>
          <RecoveryWorkflow
            client={client}
            run={run}
            scenario={scenario?.id}
            onChanged={() => void refreshLive()}
            onOpenOperations={onOpenOperations}
            readOnly={historical !== null}
          />
          <section className="evidence-panel">
            <div className="section-kicker">
              <Database size={16} />
              GRAPH EVIDENCE
            </div>
            <div className="evidence-grid">
              <div>
                <h3>Connected blockers</h3>
                {result.blockers.map((b) => (
                  <button
                    className="evidence-row"
                    key={b.id}
                    onClick={() => setEvidence(b.id)}
                  >
                    <AlertTriangle size={13} />
                    <span>
                      {b.name}
                      <small>
                        {b.kind} · {b.status}
                      </small>
                    </span>
                    <ArrowUpRight size={13} />
                  </button>
                ))}
              </div>
              <div>
                <h3>People & commitments</h3>
                {[...result.teams, ...result.customers].map((o) => (
                  <button
                    className="evidence-row"
                    key={o.id}
                    onClick={() => setEvidence(o.id)}
                  >
                    <span>
                      {o.name}
                      <small>{o.id}</small>
                    </span>
                    <ArrowUpRight size={13} />
                  </button>
                ))}
              </div>
              <div>
                <h3>Source records</h3>
                <div className="evidence-chips">
                  {result.evidence.map((o) => (
                    <button key={o.id} onClick={() => setEvidence(o.id)}>
                      {o.id}
                    </button>
                  ))}
                </div>
                <small className="run-id">
                  {run.id}
                  <br />
                  {new Date(run.executedAt).toLocaleString()}
                </small>
              </div>
            </div>
            {record && (
              <div className="evidence-record">
                <button onClick={() => setEvidence(null)}>Close</button>
                <strong>
                  {record.id} · {record.type}
                </strong>
                <pre>{JSON.stringify(record.properties, null, 2)}</pre>
                <small>
                  {record.source} · observed {record.observedAt}
                </small>
              </div>
            )}
          </section>
          <details className="model-assumptions">
            <summary>
              Model assumptions and limits
              <ChevronDown size={14} />
            </summary>
            <ul>
              {result.assumptions.map((a) => (
                <li key={a}>{a}</li>
              ))}
            </ul>
            <p>
              {live && scenario
                ? `Live recommendation at investigation start: ${live.recommendation.label}.`
                : ""}{" "}
              Function runs retain their input, output, and graph revision for
              inspection through the API.
            </p>
          </details>
        </>
      )}
    </div>
  );
}
