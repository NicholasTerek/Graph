import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ReactFlow,
  Background,
  Controls,
  Handle,
  Position,
  MarkerType,
  type NodeProps,
  type Node,
} from "@xyflow/react";
import {
  Boxes,
  Network,
  Database,
  ArrowUpRight,
  Search,
  X,
  ChevronRight,
  Layers,
  RefreshCw,
  Upload,
  CircleDot,
} from "lucide-react";
import { GraphClient } from "@graph/sdk";
import type {
  GraphObject,
  GraphSnapshot,
  Ontology,
  Traversal,
} from "@graph/contracts";
import "@xyflow/react/dist/style.css";
import "./style.css";

const client = new GraphClient();
const colors = [
  "#86d8bd",
  "#c9b5f7",
  "#e8bc7c",
  "#85bfea",
  "#e69b9c",
  "#b5c975",
  "#dcafdc",
  "#9eabbf",
  "#75cdd2",
];
function ObjectNode({
  data,
}: NodeProps<Node<{ object: GraphObject; color: string }>>) {
  return (
    <div className="object-node" style={{ borderLeftColor: data.color }}>
      <Handle type="target" position={Position.Left} />
      <span className="node-type" style={{ color: data.color }}>
        {data.object.type}
      </span>
      <strong>{String(data.object.properties.name ?? data.object.id)}</strong>
      <span className={`status ${data.object.properties.status}`}>
        {String(data.object.properties.status ?? "connected")}
      </span>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}
const nodeTypes = { object: ObjectNode };

function App() {
  const [ontologies, setOntologies] = useState<Ontology[]>([]);
  const [ontologyId, setOntologyId] = useState("");
  const [graph, setGraph] = useState<GraphSnapshot>({
    objects: [],
    relationships: [],
  });
  const [view, setView] = useState<GraphSnapshot | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [depth, setDepth] = useState(3);
  const [direction, setDirection] = useState<Traversal["direction"]>("both");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<"graph" | "schema">("graph");
  const requestId = useRef(0);
  const upload = useRef<HTMLInputElement>(null);
  const schemaUpload = useRef<HTMLInputElement>(null);
  const ontology = ontologies.find((o) => o.id === ontologyId);
  const object = graph.objects.find((o) => o.id === selected);
  const current = view ?? graph;
  async function loadOntologies(preferred?: string) {
    const all = (await client.ontologies()).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    setOntologies(all);
    setOntologyId(
      (previous) =>
        preferred ??
        (all.some((o) => o.id === previous) ? previous : (all[0]?.id ?? "")),
    );
  }
  async function loadGraph(id: string) {
    const token = ++requestId.current;
    setBusy(true);
    setError("");
    try {
      const result = await client.snapshot(id);
      if (token === requestId.current) {
        setGraph(result);
        setView(null);
        setSelected(null);
      }
    } catch (e) {
      if (token === requestId.current) setError((e as Error).message);
    } finally {
      if (token === requestId.current) setBusy(false);
    }
  }
  useEffect(() => {
    loadOntologies().catch((e) => setError(e.message));
  }, []);
  useEffect(() => {
    setGraph({ objects: [], relationships: [] });
    setView(null);
    setSelected(null);
    if (ontologyId) void loadGraph(ontologyId);
  }, [ontologyId]);
  const typeColor = (type: string) =>
    colors[
      Math.max(
        0,
        ontology?.objectTypes.findIndex((t) => t.name === type) ?? 0,
      ) % colors.length
    ];
  const visibleIds = useMemo(
    () =>
      new Set(
        current.objects
          .filter((o) =>
            `${o.id} ${o.type} ${Object.values(o.properties).join(" ")}`
              .toLowerCase()
              .includes(search.toLowerCase()),
          )
          .map((o) => o.id),
      ),
    [current, search],
  );
  const layout = useMemo(() => {
    const types = ontology?.objectTypes.map((t) => t.name) ?? [];
    const counts = new Map<string, number>();
    return current.objects.map((o) => {
      const index = counts.get(o.type) ?? 0;
      counts.set(o.type, index + 1);
      const column = types.indexOf(o.type);
      return {
        id: o.id,
        type: "object",
        position: {
          x: (column % 3) * 310,
          y: Math.floor(column / 3) * 300 + index * 125,
        },
        data: { object: o, color: typeColor(o.type) },
        selected: o.id === selected,
        hidden: !visibleIds.has(o.id),
      };
    });
  }, [current, ontology, selected, visibleIds]);
  const edges = current.relationships.map((r) => ({
    id: r.id,
    source: r.from,
    target: r.to,
    label: r.type.replaceAll("_", " ").toLowerCase(),
    hidden: !visibleIds.has(r.from) || !visibleIds.has(r.to),
    type: "smoothstep",
    markerEnd: { type: MarkerType.ArrowClosed, color: "#64777b" },
    style: { stroke: "#48595e" },
    labelStyle: { fill: "#a0afb3", fontSize: 10 },
    labelBgStyle: { fill: "#151c20" },
  }));
  async function traverse() {
    if (!selected) return;
    const token = ++requestId.current;
    setBusy(true);
    setError("");
    try {
      const result = await client.traverse(
        ontologyId,
        selected,
        depth,
        direction,
      );
      if (token === requestId.current) setView(result);
    } catch (e) {
      if (token === requestId.current) setError((e as Error).message);
    } finally {
      if (token === requestId.current) setBusy(false);
    }
  }
  async function importFile(file: File | undefined, schema: boolean) {
    if (!file) return;
    setBusy(true);
    setError("");
    try {
      const data = JSON.parse(await file.text());
      if (schema) {
        const result = await client.register(data);
        await loadOntologies(result.id);
      } else {
        await client.ingest(ontologyId, data);
        await loadGraph(ontologyId);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="/">
          <span className="brand-mark">
            <Network size={22} />
          </span>
          graph<span className="brand-dot">.</span>
        </a>
        <div className="workspace-tag">
          <span className="online-dot" />
          LOCAL WORKSPACE
        </div>
        <div className="nav-label">WORKSPACE</div>
        <button
          className={`nav-item ${mode === "graph" ? "active" : ""}`}
          onClick={() => setMode("graph")}
        >
          <Network size={17} />
          Graph explorer
          <ChevronRight size={14} />
        </button>
        <button
          className={`nav-item ${mode === "schema" ? "active" : ""}`}
          onClick={() => setMode("schema")}
        >
          <Boxes size={17} />
          Ontology registry
        </button>
        <div className="nav-label source-heading">
          ONTOLOGIES{" "}
          <button
            title="Register ontology JSON"
            onClick={() => schemaUpload.current?.click()}
          >
            <Upload size={14} />
          </button>
        </div>
        {ontologies.map((o) => (
          <button
            key={o.id}
            className={`source-item ${ontologyId === o.id ? "chosen" : ""}`}
            onClick={() => {
              setOntologyId(o.id);
              setSearch("");
            }}
          >
            <Database size={15} />
            <span>{o.name}</span>
          </button>
        ))}
        <div className="sidebar-bottom">
          <span className="online-dot" />
          FalkorDB persistence<div>Connected data. Clear decisions.</div>
        </div>
      </aside>
      <main>
        <header>
          <div className="breadcrumb">
            Workspace <ChevronRight size={13} />
            <span>{ontology?.name ?? "Get started"}</span>
          </div>
          <span className="version">FOUNDATION / 01</span>
        </header>
        <section className="page-heading">
          <div>
            <div className="eyebrow">OPERATIONAL ONTOLOGY</div>
            <h1>
              {mode === "graph"
                ? "See how everything connects."
                : "Your domain, defined."}
            </h1>
            <p>
              {mode === "graph"
                ? "Explore dependencies across your operations, with evidence at every connection."
                : "Register the objects and relationships that describe how your organization works."}
            </p>
          </div>
          <button
            className="primary-button"
            disabled={!ontologyId || busy}
            onClick={() => upload.current?.click()}
          >
            <Upload size={15} />
            Import data
          </button>
        </section>
        {error && (
          <div role="alert" className="error">
            {error}
            <button aria-label="Dismiss error" onClick={() => setError("")}>
              <X size={15} />
            </button>
          </div>
        )}
        {!ontology && (
          <div className="empty">
            <Database size={36} />
            <h2>Start with an ontology</h2>
            <p>
              Register an ontology JSON, then import its objects and
              relationships.
              <br />
              Run <code>pnpm seed</code> to explore the included synthetic
              examples.
            </p>
            <button
              className="primary-button"
              onClick={() => schemaUpload.current?.click()}
            >
              Register ontology
            </button>
          </div>
        )}
        {ontology && (
          <>
            <div className="metrics">
              <div>
                <span>Objects</span>
                <strong>
                  {graph.objects.length}
                  <Boxes size={20} />
                </strong>
              </div>
              <div>
                <span>Relationships</span>
                <strong>
                  {graph.relationships.length}
                  <Network size={20} />
                </strong>
              </div>
              <div>
                <span>Object types</span>
                <strong>
                  {ontology.objectTypes.length}
                  <Layers size={20} />
                </strong>
              </div>
              <div>
                <span>Data origin</span>
                <strong className="text-metric">
                  {new Set(graph.objects.map((o) => o.provenance.source)).size}{" "}
                  sources
                  <CircleDot size={20} />
                </strong>
              </div>
            </div>
            {mode === "schema" ? (
              <section className="schema-panel">
                <div className="panel-title">
                  {ontology.name}
                  <span>{ontology.id}</span>
                </div>
                <p>{ontology.description}</p>
                <div className="schema-grid">
                  {ontology.objectTypes.map((t) => (
                    <article key={t.name}>
                      <h3 style={{ color: typeColor(t.name) }}>{t.name}</h3>
                      <p>{t.description}</p>
                      {Object.entries(t.properties).map(
                        ([name, definition]) => (
                          <div className="property" key={name}>
                            <span>
                              {name}
                              {definition.required ? " *" : ""}
                            </span>
                            <code>{definition.type}</code>
                          </div>
                        ),
                      )}
                    </article>
                  ))}
                </div>
                <h3>Relationship definitions</h3>
                {ontology.relationshipTypes.map((r) => (
                  <div className="relationship-definition" key={r.name}>
                    <code>{r.from}</code>
                    <span>— {r.name} →</span>
                    <code>{r.to}</code>
                  </div>
                ))}
              </section>
            ) : (
              <section className="explorer">
                <div className="graph-toolbar">
                  <div>
                    <Network size={16} />
                    <strong>Relationship map</strong>
                    <span className="count-tag">
                      {current.objects.length} objects
                    </span>
                    {view && (
                      <button
                        className="reset-button"
                        onClick={() => {
                          setView(null);
                          setSearch("");
                        }}
                      >
                        Clear traversal <X size={12} />
                      </button>
                    )}
                  </div>
                  <label className="search">
                    <Search size={14} />
                    <input
                      placeholder="Find an object…"
                      aria-label="Find an object"
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                    />
                  </label>
                  <button
                    className="icon-button"
                    title="Refresh graph"
                    disabled={busy}
                    onClick={() => void loadGraph(ontologyId)}
                  >
                    <RefreshCw size={15} className={busy ? "spin" : ""} />
                  </button>
                </div>
                <div className="graph-area">
                  <ReactFlow
                    key={ontologyId}
                    nodes={layout}
                    edges={edges}
                    nodeTypes={nodeTypes}
                    fitView
                    fitViewOptions={{ padding: 0.2 }}
                    minZoom={0.2}
                    maxZoom={1.5}
                    nodesDraggable={false}
                    onNodeClick={(_, node) => setSelected(node.id)}
                    onPaneClick={() => setSelected(null)}
                    colorMode="dark"
                  >
                    <Background color="#334046" gap={24} size={1} />
                    <Controls showInteractive={false} />
                  </ReactFlow>
                  {busy && <div className="loading">Querying graph…</div>}
                  {graph.objects.length === 0 && (
                    <div className="graph-empty">
                      No objects yet. Import a JSON dataset to get started.
                    </div>
                  )}
                  {object && (
                    <aside className="inspector">
                      <div className="inspector-top">
                        <span style={{ color: typeColor(object.type) }}>
                          {object.type}
                        </span>
                        <button
                          aria-label="Close inspector"
                          onClick={() => setSelected(null)}
                        >
                          <X size={16} />
                        </button>
                      </div>
                      <h2>{String(object.properties.name ?? object.id)}</h2>
                      <code className="object-id">{object.id}</code>
                      <div className="detail-label">PROPERTIES</div>
                      {Object.entries(object.properties).map(
                        ([name, value]) => (
                          <div className="property" key={name}>
                            <span>{name}</span>
                            <strong>{String(value)}</strong>
                          </div>
                        ),
                      )}
                      <div className="detail-label">EXPLORE CONNECTIONS</div>
                      <label className="control-label">
                        Depth
                        <select
                          value={depth}
                          onChange={(e) => setDepth(Number(e.target.value))}
                        >
                          {[1, 2, 3, 4, 5].map((n) => (
                            <option key={n}>{n}</option>
                          ))}
                        </select>
                      </label>
                      <label className="control-label">
                        Direction
                        <select
                          value={direction}
                          onChange={(e) =>
                            setDirection(
                              e.target.value as Traversal["direction"],
                            )
                          }
                        >
                          <option value="both">Both</option>
                          <option value="out">Outgoing</option>
                          <option value="in">Incoming</option>
                        </select>
                      </label>
                      <button
                        className="primary-button traverse"
                        disabled={busy}
                        onClick={() => void traverse()}
                      >
                        Trace dependencies
                        <ArrowUpRight size={15} />
                      </button>
                      <div className="detail-label">PROVENANCE</div>
                      <div className="provenance">
                        <Database size={13} />
                        {object.provenance.source}
                        <br />
                        {object.provenance.externalId}
                        <br />
                        {new Date(
                          object.provenance.observedAt,
                        ).toLocaleString()}
                      </div>
                    </aside>
                  )}
                </div>
                <footer className="graph-footer">
                  <span>
                    <span className="online-dot" />
                    Live graph ·{" "}
                    {view ? "Bounded traversal" : "All connections"}
                  </span>
                  <span>Click an object to inspect its evidence</span>
                </footer>
              </section>
            )}
            <div className="legend">
              {ontology.objectTypes.map((t) => (
                <span key={t.name}>
                  <i style={{ background: typeColor(t.name) }} />
                  {t.name}
                </span>
              ))}
            </div>
          </>
        )}
      </main>
      <input
        ref={upload}
        type="file"
        accept="application/json,.json"
        hidden
        onChange={(e) => {
          void importFile(e.target.files?.[0], false);
          e.target.value = "";
        }}
      />
      <input
        ref={schemaUpload}
        type="file"
        accept="application/json,.json"
        hidden
        onChange={(e) => {
          void importFile(e.target.files?.[0], true);
          e.target.value = "";
        }}
      />
    </div>
  );
}
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
