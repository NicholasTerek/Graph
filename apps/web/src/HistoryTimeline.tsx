import { useEffect, useState } from "react";
import { History, RotateCcw } from "lucide-react";
import type { GraphClient } from "@graph/sdk";
import type { CommitList } from "@graph/contracts";
import "./history.css";
export default function HistoryTimeline({
  client,
  ontology,
  currentRevision,
  activeRevision,
  onInspect,
  onLive,
  disabled = false,
}: {
  client: GraphClient;
  ontology: string;
  currentRevision: number;
  activeRevision: number | null;
  onInspect: (revision: number) => Promise<void>;
  onLive: () => Promise<void>;
  disabled?: boolean;
}) {
  const [commits, setCommits] = useState<CommitList | null>(null),
    [index, setIndex] = useState(0),
    [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    client
      .commits(ontology, Math.max(-1, currentRevision - 100), 100)
      .then((result) => {
        if (active) {
          setCommits(result);
          setIndex(result.items.length - 1);
          setError("");
        }
      })
      .catch((cause) => {
        if (active) setError((cause as Error).message);
      });
    return () => {
      active = false;
    };
  }, [client, ontology, currentRevision]);
  const selected = commits?.items[index];
  return (
    <section
      className="history-timeline"
      aria-label="Historical graph revisions"
    >
      <div className="history-title">
        <History size={17} />
        <strong>Inspect an earlier revision</strong>
        <span>
          {activeRevision !== null
            ? `Read-only · revision ${activeRevision}`
            : `Live · revision ${currentRevision}`}
        </span>
      </div>
      <p>
        Read the graph and recalculate the launch plan from the same committed
        snapshot. Historical inspection does not change live data.
      </p>
      {commits && (
        <>
          <label htmlFor="history-revision">
            Revision {selected?.revision ?? "—"} ·{" "}
            {selected?.committedAt
              ? new Date(selected.committedAt).toLocaleString()
              : "No commits"}
          </label>
          <input
            id="history-revision"
            aria-label="Historical revision"
            type="range"
            min={0}
            max={Math.max(0, commits.items.length - 1)}
            step={1}
            value={Math.max(0, index)}
            disabled={disabled || !commits.items.length}
            onChange={(event) => setIndex(Number(event.target.value))}
          />
          <div className="history-actions">
            <button
              disabled={disabled || !selected}
              onClick={() => selected && void onInspect(selected.revision)}
            >
              Inspect revision {selected?.revision ?? ""}
            </button>
            {activeRevision !== null && (
              <button disabled={disabled} onClick={() => void onLive()}>
                <RotateCcw size={13} />
                Return to live
              </button>
            )}
            <small>
              Recent {commits.items.length} commits · history starts at{" "}
              {commits.retainedFrom}
            </small>
          </div>
        </>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </section>
  );
}
