import { useEffect, useMemo, useState } from "react";
import { TARGETS, type CreateProbeRequest, type ProbeRun } from "../shared/contracts";

/** Bound chart bars so one unusually slow request cannot break the layout. */
const MAX_BAR_WIDTH_PX = 380;

/** Format a measured duration without suggesting sub-millisecond precision. */
function formatMs(value: number | null): string {
  return value === null ? "Unavailable" : `${Math.round(value)} ms`;
}

/** A failed browser fetch may mean CORS denial or a network error. */
async function measureDirect(targetUrl: string): Promise<Omit<CreateProbeRequest, "targetId">> {
  const started = performance.now();
  try {
    const response = await fetch(targetUrl, {
      method: "GET",
      cache: "no-store",
      signal: AbortSignal.timeout(8_000),
    });
    await response.arrayBuffer();
    return {
      directDurationMs: performance.now() - started,
      directStatus: response.status,
      directError: null,
    };
  } catch (error) {
    return {
      directDurationMs: null,
      directStatus: null,
      directError: error instanceof Error && error.name === "TimeoutError"
        ? "timeout"
        : "cors_or_network_error",
    };
  }
}

/** Parse a JSON response and surface API failures to the dashboard. */
async function readApi<T>(response: Response): Promise<T> {
  const data: unknown = await response.json();
  if (!response.ok) {
    const message = typeof data === "object" && data !== null && "error" in data
      ? String(data.error)
      : `HTTP ${response.status}`;
    throw new Error(message);
  }
  return data as T;
}

/** Median is less sensitive to one slow network request than an average. */
function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

/** Display a small history chart without adding a charting dependency. */
function HistoryChart({ runs }: { runs: ProbeRun[] }) {
  const recent = [...runs].reverse().slice(-10);
  const largest = Math.max(
    1,
    ...recent.flatMap((run) => [run.directDurationMs ?? 0, run.workerFetchDurationMs ?? 0]),
  );

  return (
    <div className="chart" aria-label="Recent direct and Worker upstream durations">
      {recent.length === 0 && <p className="empty">Run a comparison to build the chart.</p>}
      {recent.map((run) => (
        <div className="chart-row" key={run.id}>
          <span className="chart-label">{new Date(run.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
          <div className="chart-bars">
            <span
              className="chart-bar direct"
              style={{ width: Math.min(MAX_BAR_WIDTH_PX, ((run.directDurationMs ?? 0) / largest) * MAX_BAR_WIDTH_PX) }}
              title={`Browser direct: ${formatMs(run.directDurationMs)}`}
            />
            <span
              className="chart-bar worker"
              style={{ width: Math.min(MAX_BAR_WIDTH_PX, ((run.workerFetchDurationMs ?? 0) / largest) * MAX_BAR_WIDTH_PX) }}
              title={`Worker upstream: ${formatMs(run.workerFetchDurationMs)}`}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

/** Coordinate the browser probe, Worker probe, and persisted history. */
export default function App() {
  const [targetId, setTargetId] = useState<string>(TARGETS[0].id);
  const [runs, setRuns] = useState<ProbeRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const target = TARGETS.find((item) => item.id === targetId)!;

  // History is optional for reading the page; a missing migration gets a clear message.
  useEffect(() => {
    fetch("/api/probes")
      .then((response) => readApi<ProbeRun[]>(response))
      .then(setRuns)
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "Could not load history."))
      .finally(() => setLoading(false));
  }, []);

  const summary = useMemo(() => {
    const selected = runs.filter((run) => run.targetId === targetId);
    const failed = selected.filter((run) => run.workerError !== null || (run.workerStatus ?? 0) >= 400);
    return {
      count: selected.length,
      directMedian: median(selected.flatMap((run) => run.directDurationMs === null ? [] : [run.directDurationMs])),
      workerMedian: median(selected.flatMap((run) => run.workerFetchDurationMs === null ? [] : [run.workerFetchDurationMs])),
      errorRate: selected.length === 0 ? null : Math.round((failed.length / selected.length) * 100),
    };
  }, [runs, targetId]);

  /** Run the two paths in sequence so the browser and Worker use the same target. */
  async function runComparison() {
    setRunning(true);
    setError(null);
    try {
      const direct = await measureDirect(target.url);
      const response = await fetch("/api/probes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetId, ...direct } satisfies CreateProbeRequest),
      });
      const run = await readApi<ProbeRun>(response);
      setRuns((current) => [run, ...current].slice(0, 30));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Comparison failed.");
    } finally {
      setRunning(false);
    }
  }

  return (
    <main className="page">
      <header className="topbar">
        <div className="brand"><span className="brand-mark">◈</span> Edge API Observatory</div>
        <span className="topbar-note">Synthetic diagnostics · Workers + D1</span>
      </header>

      <section className="hero">
        <p className="eyebrow">THE EDGE, MADE VISIBLE</p>
        <h1>See an API request<br /><em>from two perspectives.</em></h1>
        <p className="hero-copy">Compare a request made by your browser with one made by a Cloudflare Worker. Watch latency, status, and errors accumulate into a useful diagnostic history.</p>
      </section>

      <section className="panel controls" aria-labelledby="probe-heading">
        <div>
          <p className="section-kicker">01 / PROBE</p>
          <h2 id="probe-heading">Run a comparison</h2>
          <p className="muted">Both requests use the same approved sample API endpoint.</p>
        </div>
        <div className="control-fields">
          <label htmlFor="target">Target API</label>
          <select id="target" value={targetId} onChange={(event) => setTargetId(event.target.value)} disabled={running}>
            {TARGETS.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
          <button onClick={runComparison} disabled={running}>{running ? "Measuring…" : "Run comparison →"}</button>
        </div>
      </section>

      {error && <div className="error" role="alert">{error} If the API is unavailable locally, check that D1 migrations have been applied.</div>}

      <section className="metrics" aria-label="Selected target summary">
        <div className="metric"><span>Comparisons</span><strong>{summary.count}</strong><small>Selected endpoint</small></div>
        <div className="metric"><span>Browser median</span><strong>{formatMs(summary.directMedian)}</strong><small>Visitor → upstream</small></div>
        <div className="metric"><span>Worker fetch median</span><strong>{formatMs(summary.workerMedian)}</strong><small>Edge → upstream</small></div>
        <div className="metric"><span>Worker error rate</span><strong>{summary.errorRate === null ? "—" : `${summary.errorRate}%`}</strong><small>HTTP 4xx/5xx or fetch error</small></div>
      </section>

      <section className="panel history" aria-labelledby="history-heading">
        <div className="section-head">
          <div><p className="section-kicker">02 / HISTORY</p><h2 id="history-heading">Recent measurements</h2></div>
          <div className="legend"><span><i className="legend-direct" /> Browser direct</span><span><i className="legend-worker" /> Worker upstream</span></div>
        </div>
        {loading ? <p className="empty">Loading history…</p> : <HistoryChart runs={runs.filter((run) => run.targetId === targetId)} />}
        <div className="table-wrap">
          <table>
            <thead><tr><th>Time</th><th>Target</th><th>Browser</th><th>Browser status</th><th>Worker fetch</th><th>Worker status</th></tr></thead>
            <tbody>
              {runs.filter((run) => run.targetId === targetId).slice(0, 8).map((run) => (
                <tr key={run.id}>
                  <td>{new Date(run.createdAt).toLocaleString()}</td>
                  <td>{target.name}</td>
                  <td>{formatMs(run.directDurationMs)}</td>
                  <td>{run.directError ?? run.directStatus ?? "—"}</td>
                  <td>{formatMs(run.workerFetchDurationMs)}</td>
                  <td>{run.workerError ?? run.workerStatus ?? "—"}</td>
                </tr>
              ))}
              {runs.filter((run) => run.targetId === targetId).length === 0 && <tr><td colSpan={6} className="empty">No measurements yet.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>

      <p className="footnote">These paths have different network routes. Their difference does not isolate Worker overhead. Browser failures may reflect CORS restrictions.</p>
    </main>
  );
}
