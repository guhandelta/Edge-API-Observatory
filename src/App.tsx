import { useEffect, useMemo, useState } from "react";
import { TARGETS, type CreateProbeRequest, type ProbeRun } from "../shared/contracts";
import { STATUS_BUCKETS, summarizeRuns } from "./metrics";

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
  const [batchSize, setBatchSize] = useState<3 | 5>(3);
  const [runs, setRuns] = useState<ProbeRun[]>([]);
  const [lastBatch, setLastBatch] = useState<{ targetId: string; requested: number; runs: ProbeRun[] } | null>(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const target = TARGETS.find((item) => item.id === targetId)!;

  // History is optional for reading the page; a missing migration gets a clear message.
  useEffect(() => {
    fetch("/api/probes")
      .then((response) => readApi<ProbeRun[]>(response))
      .then(setRuns)
      .catch((cause: unknown) => setError(
        `${cause instanceof Error ? cause.message : "Could not load history."} Check local D1 migrations if needed.`,
      ))
      .finally(() => setLoading(false));
  }, []);

  const selectedRuns = useMemo(() => runs.filter((run) => run.targetId === targetId), [runs, targetId]);
  const summary = useMemo(() => summarizeRuns(selectedRuns), [selectedRuns]);
  const visibleBatch = lastBatch?.targetId === targetId ? lastBatch : null;
  const batchSummary = visibleBatch ? summarizeRuns(visibleBatch.runs) : null;

  /** Run each browser/Worker pair sequentially against one fixed endpoint. */
  async function runBatch() {
    setRunning(true);
    setError(null);
    setProgress(0);
    setLastBatch(null);
    const completed: ProbeRun[] = [];
    try {
      for (let index = 0; index < batchSize; index += 1) {
        const direct = await measureDirect(target.url);
        const response = await fetch("/api/probes", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ targetId, ...direct } satisfies CreateProbeRequest),
        });
        const run = await readApi<ProbeRun>(response);
        completed.push(run);
        setProgress(index + 1);
        setRuns((current) => [run, ...current].slice(0, 30));
      }
    } catch (cause) {
      setError(`${cause instanceof Error ? cause.message : "Comparison failed."} ${completed.length} of ${batchSize} comparisons completed.`);
    } finally {
      if (completed.length > 0) setLastBatch({ targetId, requested: batchSize, runs: completed });
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
          <p className="muted">Each pair uses the same approved endpoint. Pairs run sequentially.</p>
          {target.id.startsWith("demo-") && <p className="muted">Controlled demo: both paths reach this app's Worker-hosted fixture. Status and programmed delay are fixed; observed latency still varies.</p>}
        </div>
        <div className="control-fields">
          <div className="control-field"><label htmlFor="target">Target API</label>
            <select id="target" value={targetId} onChange={(event) => { setTargetId(event.target.value); setLastBatch(null); }} disabled={running}>
              {TARGETS.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </div>
          <div className="control-field"><label htmlFor="batch-size">Pairs to run</label>
            <select id="batch-size" value={batchSize} onChange={(event) => setBatchSize(Number(event.target.value) as 3 | 5)} disabled={running}>
              <option value={3}>3 pairs</option>
              <option value={5}>5 pairs</option>
            </select>
          </div>
          <button onClick={runBatch} disabled={running}>{running ? `Running ${progress}/${batchSize}…` : `Run ${batchSize} pairs →`}</button>
        </div>
      </section>

      {error && <div className="error" role="alert">{error}</div>}

      {visibleBatch && batchSummary && <section className="panel batch-result" aria-label="Last batch median comparison">
        <div className="batch-heading"><div><p className="section-kicker">LATEST BATCH</p><h2>{target.name} · {batchSummary.comparisons}/{visibleBatch.requested} pairs</h2></div><span className="sample-badge">Small sample · n &lt; 10</span></div>
        <div className="batch-medians">
          <div><span>Browser direct median</span><strong>{formatMs(batchSummary.directMedian)}</strong><small>n={batchSummary.directMeasured} measured</small></div>
          <div><span>Worker upstream median</span><strong>{formatMs(batchSummary.workerMedian)}</strong><small>n={batchSummary.workerMeasured} measured</small></div>
        </div>
        <p className="muted">These medians compare two network paths. Their difference does not measure Worker overhead.</p>
      </section>}

      <section className="metrics" aria-label="Selected target summary">
        <div className="metric"><span>Recent comparisons</span><strong>{summary.comparisons}</strong><small>Selected endpoint · up to 30 total stored</small></div>
        <div className="metric"><span>Browser median</span><strong>{formatMs(summary.directMedian)}</strong><small>n={summary.directMeasured} measured</small></div>
        <div className="metric"><span>Worker fetch median</span><strong>{formatMs(summary.workerMedian)}</strong><small>n={summary.workerMeasured} measured</small></div>
        <div className="metric"><span>Worker success rate</span><strong>{summary.workerSuccessRate === null ? "—" : `${summary.workerSuccessRate}%`}</strong><small>2xx with no fetch error · n={summary.comparisons}</small></div>
      </section>

      <section className="panel status-panel" aria-labelledby="status-heading">
        <div className="section-head"><div><p className="section-kicker">02 / OUTCOMES</p><h2 id="status-heading">Worker status breakdown</h2></div><span className="muted">{summary.comparisons} recent results</span></div>
        {summary.comparisons > 0 ? <>
          <div className="status-stack" role="img" aria-label={STATUS_BUCKETS.map((bucket) => `${bucket}: ${summary.statusCounts[bucket]}`).join(", ")}>
            {STATUS_BUCKETS.map((bucket) => summary.statusCounts[bucket] > 0 && <span key={bucket} className={`status-segment status-${bucket.replace(/[^a-z0-9]/gi, "").toLowerCase()}`} style={{ width: `${(summary.statusCounts[bucket] / summary.comparisons) * 100}%` }} />)}
          </div>
          <div className="status-legend">{STATUS_BUCKETS.map((bucket) => <span key={bucket}><i className={`status-dot status-${bucket.replace(/[^a-z0-9]/gi, "").toLowerCase()}`} />{bucket}: <strong>{summary.statusCounts[bucket]}</strong></span>)}</div>
        </> : <p className="empty">No Worker results for this endpoint yet.</p>}
        {summary.comparisons > 0 && summary.comparisons < 10 && <p className="sample-note">Small sample: fewer than 10 comparisons. Treat rates and medians as directional.</p>}
      </section>

      <section className="panel history" aria-labelledby="history-heading">
        <div className="section-head">
          <div><p className="section-kicker">03 / HISTORY</p><h2 id="history-heading">Recent measurements</h2></div>
          <div className="legend"><span><i className="legend-direct" /> Browser direct</span><span><i className="legend-worker" /> Worker upstream</span></div>
        </div>
        {loading ? <p className="empty">Loading history…</p> : <HistoryChart runs={selectedRuns} />}
        <div className="table-wrap">
          <table>
            <thead><tr><th>Time</th><th>Target</th><th>Browser</th><th>Browser status</th><th>Worker fetch</th><th>Worker status</th></tr></thead>
            <tbody>
              {selectedRuns.slice(0, 8).map((run) => (
                <tr key={run.id}>
                  <td>{new Date(run.createdAt).toLocaleString()}</td>
                  <td>{target.name}</td>
                  <td>{formatMs(run.directDurationMs)}</td>
                  <td>{run.directError ?? run.directStatus ?? "—"}</td>
                  <td>{formatMs(run.workerFetchDurationMs)}</td>
                  <td>{run.workerError ?? run.workerStatus ?? "—"}</td>
                </tr>
              ))}
              {selectedRuns.length === 0 && <tr><td colSpan={6} className="empty">No measurements yet.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>

      <p className="footnote">These paths have different network routes. Their difference does not isolate Worker overhead. Browser failures may reflect CORS restrictions.</p>
    </main>
  );
}
