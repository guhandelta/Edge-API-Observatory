import { useEffect, useMemo, useState } from "react";
import { TARGETS, type CreateProbeRequest, type Experiment, type ProbeRun, type TraceInvestigation } from "../shared/contracts";
import { experimentPercentiles, STATUS_BUCKETS, summarizeRuns } from "./metrics";
import { applyTheme, type Theme } from "./theme";

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
              style={{ width: `${Math.min(100, ((run.directDurationMs ?? 0) / largest) * 100)}%` }}
              title={`Browser direct: ${formatMs(run.directDurationMs)}`}
            />
            <span
              className="chart-bar worker"
              style={{ width: `${Math.min(100, ((run.workerFetchDurationMs ?? 0) / largest) * 100)}%` }}
              title={`Worker upstream: ${formatMs(run.workerFetchDurationMs)}`}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

/** Keep the theme control tied to the same palette used by every dashboard panel. */
function ThemeIcon({ theme }: { theme: Theme }) {
  return theme === "light" ? (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2m0 16v2M4.93 4.93l1.42 1.42m11.3 11.3 1.42 1.42M2 12h2m16 0h2M4.93 19.07l1.42-1.42m11.3-11.3 1.42-1.42" />
    </svg>
  ) : (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20.4 14.5A8.7 8.7 0 0 1 9.5 3.6 8.8 8.8 0 1 0 20.4 14.5Z" />
    </svg>
  );
}

/** Coordinate the browser probe, Worker probe, persisted history, and theme. */
export default function App({ initialTheme }: { initialTheme: Theme }) {
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const [targetId, setTargetId] = useState<string>(TARGETS[0].id);
  const [batchSize, setBatchSize] = useState<3 | 5>(3);
  const [runs, setRuns] = useState<ProbeRun[]>([]);
  const [lastBatch, setLastBatch] = useState<{ targetId: string; requested: number; runs: ProbeRun[] } | null>(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [investigation, setInvestigation] = useState<TraceInvestigation | null>(null);
  const [investigationError, setInvestigationError] = useState<string | null>(null);
  const [investigating, setInvestigating] = useState(false);
  const [experiment, setExperiment] = useState<Experiment | null>(null);
  const [savedExperiments, setSavedExperiments] = useState<Experiment[]>([]);
  const [experimentRunning, setExperimentRunning] = useState(false);
  const [experimentError, setExperimentError] = useState<string | null>(null);
  const [experimentProgress, setExperimentProgress] = useState(0);
  const target = TARGETS.find((item) => item.id === targetId)!;

  /** Switch the visual palette without interrupting a running probe. */
  function toggleTheme() {
    const nextTheme = theme === "light" ? "dark" : "light";
    applyTheme(nextTheme, true);
    setTheme(nextTheme);
  }

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
  const directExperiment = experiment ? experimentPercentiles(experiment.samples, "browser_direct") : null;
  const workerExperiment = experiment ? experimentPercentiles(experiment.samples, "worker_proxy") : null;

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
        const postStarted = performance.now();
        const response = await fetch("/api/probes", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ targetId, ...direct } satisfies CreateProbeRequest),
        });
        const run = await readApi<ProbeRun>(response);
        // This includes POST network time and response-body parsing, and is
        // known only after the Worker has already persisted its probe rows.
        const measuredRun: ProbeRun = {
          ...run,
          browserPostRoundTripMs: performance.now() - postStarted,
        };
        completed.push(measuredRun);
        setProgress(index + 1);
        setRuns((current) => [measuredRun, ...current].slice(0, 30));
      }
    } catch (cause) {
      setError(`${cause instanceof Error ? cause.message : "Comparison failed."} ${completed.length} of ${batchSize} comparisons completed.`);
    } finally {
      if (completed.length > 0) setLastBatch({ targetId, requested: batchSize, runs: completed });
      setRunning(false);
    }
  }

  /** Load platform spans for one persisted run without exposing account credentials. */
  async function openInvestigation(run: ProbeRun) {
    setInvestigation(null);
    setInvestigationError(null);
    setInvestigating(true);
    try {
      const response = await fetch(`/api/investigations/${run.requestId}`);
      setInvestigation(await readApi<TraceInvestigation>(response));
    } catch (cause) {
      setInvestigationError(cause instanceof Error ? cause.message : "Trace lookup failed.");
    } finally {
      setInvestigating(false);
    }
  }

  /** Alternate request order across pairs, leaving a durable record if interrupted. */
  async function runExperiment() {
    setExperimentRunning(true);
    setExperimentError(null);
    setExperimentProgress(0);
    let id: string | null = null;
    try {
      const created = await readApi<Experiment>(await fetch("/api/experiments", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetId, requestedPairs: batchSize,
          directDurationMs: null, directStatus: null, directError: null }),
      }));
      id = created.id;
      setExperiment(created);
      for (let ordinal = 0; ordinal < batchSize * 2; ordinal += 1) {
        const directFirst = Math.floor(ordinal / 2) % 2 === 0;
        const direct = ordinal % 2 === 0 ? directFirst : !directFirst;
        const response = direct
          ? await fetch(`/api/experiments/${id}/direct`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ targetId, ...await measureDirect(target.url) } satisfies CreateProbeRequest),
          })
          : await fetch(`/api/experiments/${id}/worker`, { method: "POST" });
        await readApi(response);
        setExperimentProgress(ordinal + 1);
      }
    } catch (cause) {
      setExperimentError(cause instanceof Error ? cause.message : "Experiment failed.");
    } finally {
      if (id) {
        try {
          const completed = await readApi<Experiment>(await fetch(`/api/experiments/${id}/complete`, { method: "POST" }));
          setExperiment(completed);
          setSavedExperiments((current) => [completed, ...current].slice(0, 20));
        } catch (cause) {
          setExperimentError(cause instanceof Error ? cause.message : "Could not close experiment window.");
        }
      }
      setExperimentRunning(false);
    }
  }

  /** Refresh the durable experiment index after a page reload. */
  async function loadExperiments() {
    try {
      setSavedExperiments(await readApi<Experiment[]>(await fetch("/api/experiments")));
    } catch (cause) {
      setExperimentError(cause instanceof Error ? cause.message : "Could not load experiments.");
    }
  }

  /** Open one saved experiment with its ordered samples. */
  async function openExperiment(id: string) {
    try {
      setExperiment(await readApi<Experiment>(await fetch(`/api/experiments/${id}`)));
    } catch (cause) {
      setExperimentError(cause instanceof Error ? cause.message : "Could not open experiment.");
    }
  }

  return (
    <main className="page">
      <header className="topbar">
        <div className="brand"><span className="brand-mark">◈</span> Edge API Observatory</div>
        <div className="topbar-actions">
          <span className="topbar-note">Synthetic diagnostics · Workers + D1</span>
          <button className="theme-toggle" type="button" onClick={toggleTheme} aria-label={`Switch to ${theme === "light" ? "dark" : "light"} mode`} title={`Switch to ${theme === "light" ? "dark" : "light"} mode`}>
            <ThemeIcon theme={theme} />
            <span>{theme === "light" ? "Light" : "Dark"}</span>
          </button>
        </div>
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
            <select id="target" value={targetId} onChange={(event) => { setTargetId(event.target.value); setLastBatch(null); }} disabled={running || experimentRunning}>
              {TARGETS.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </div>
          <div className="control-field"><label htmlFor="batch-size">Pairs to run</label>
            <select id="batch-size" value={batchSize} onChange={(event) => setBatchSize(Number(event.target.value) as 3 | 5)} disabled={running || experimentRunning}>
              <option value={3}>3 pairs</option>
              <option value={5}>5 pairs</option>
            </select>
          </div>
          <button onClick={runBatch} disabled={running || experimentRunning}>{running ? `Running ${progress}/${batchSize}…` : `Run ${batchSize} pairs →`}</button>
          <button onClick={runExperiment} disabled={running || experimentRunning}>{experimentRunning ? `Experiment ${experimentProgress}/${batchSize * 2}…` : "Run experiment"}</button>
        </div>
      </section>

      {error && <div className="error" role="alert">{error}</div>}

      <section className="panel experiment-panel" aria-label="Reproducible experiments">
        <div className="section-head"><div><p className="section-kicker">EXPERIMENTS</p><h2>Reproducible experiments</h2></div><button type="button" onClick={loadExperiments}>Load saved experiments</button></div>
        <p className="muted">Each pair alternates order: direct → Worker, then Worker → direct. p95 uses the nearest observed rank; fewer than 20 measured samples make tail estimates exploratory.</p>
        {experimentError && <p role="alert">{experimentError}</p>}
        {savedExperiments.length > 0 && <div className="experiment-list">{savedExperiments.map((item) => <button type="button" key={item.id} onClick={() => openExperiment(item.id)}>{item.scenario} · {item.windowStartedAt}</button>)}</div>}
        {experiment && directExperiment && workerExperiment && <>
          <p><strong>{experiment.scenario}</strong> · {TARGETS.find((item) => item.id === experiment.endpointId)!.name}</p>
          <p>Deployment version: <code>{experiment.deploymentVersion}</code></p>
          <p>Time window: {experiment.windowStartedAt} → {experiment.windowEndedAt ?? "In progress"}</p>
          <p>Requested: {experiment.requestedPairs} pairs · Stored: {experiment.samples.length} samples</p>
          <div className="trace-comparison">
            <div>Browser direct: p50 {formatMs(directExperiment.p50)} · p95 {formatMs(directExperiment.p95)} · n={directExperiment.count}</div>
            <div>Worker proxy: p50 {formatMs(workerExperiment.p50)} · p95 {formatMs(workerExperiment.p95)} · n={workerExperiment.count}</div>
          </div>
          <p className="sample-note">Small sample: p95 is exploratory with fewer than 20 measured samples per mode.</p>
        </>}
      </section>

      {visibleBatch && batchSummary && <section className="panel batch-result" aria-label="Last batch median comparison">
        <div className="batch-heading"><div><p className="section-kicker">LATEST BATCH</p><h2>{target.name} · {batchSummary.comparisons}/{visibleBatch.requested} pairs</h2></div><span className="sample-badge">Small sample · n &lt; 10</span></div>
        <div className="batch-medians">
          <div><span>Browser direct median</span><strong>{formatMs(batchSummary.directMedian)}</strong><small>n={batchSummary.directMeasured} measured</small></div>
          <div><span>Worker upstream median</span><strong>{formatMs(batchSummary.workerMedian)}</strong><small>n={batchSummary.workerMeasured} measured</small></div>
          <div><span>Worker handler median</span><strong>{formatMs(batchSummary.handlerMedian)}</strong><small>n={batchSummary.handlerMeasured} measured</small></div>
          <div><span>Browser POST round trip median</span><strong>{formatMs(batchSummary.postMedian)}</strong><small>n={batchSummary.postMeasured} measured · this session</small></div>
        </div>
        <p className="muted">The POST round trip includes the Worker probe and browser network time. These durations overlap and should not be added or subtracted as separate stages.</p>
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
            <thead><tr><th>Time</th><th>Target</th><th>Browser direct</th><th>Browser status</th><th>Worker fetch</th><th>Worker handler</th><th>Browser POST (session)</th><th>Worker status</th><th>Trace</th></tr></thead>
            <tbody>
              {selectedRuns.slice(0, 8).map((run) => (
                <tr key={run.id}>
                  <td>{new Date(run.createdAt).toLocaleString()}</td>
                  <td>{target.name}</td>
                  <td>{formatMs(run.directDurationMs)}</td>
                  <td>{run.directError ?? run.directStatus ?? "—"}</td>
                  <td>{formatMs(run.workerFetchDurationMs)}</td>
                  <td>{formatMs(run.workerHandlerDurationMs)}</td>
                  <td>{formatMs(run.browserPostRoundTripMs)}</td>
                  <td>{run.workerError ?? run.workerStatus ?? "—"}</td>
                  <td><button type="button" onClick={() => openInvestigation(run)}>Investigate</button></td>
                </tr>
              ))}
              {selectedRuns.length === 0 && <tr><td colSpan={9} className="empty">No measurements yet.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>

      {(investigation || investigationError || investigating) && <section className="panel investigation" aria-label="Trace investigation">
        <h2>Trace investigation</h2>
        {investigating && <p>Loading trace…</p>}
        {investigationError && <p role="alert">{investigationError}</p>}
        {investigation && <>
          <p>Request ID: <code>{investigation.requestId}</code></p>
          <p>Trace ID: <code>{investigation.traceId ?? "Unavailable"}</code></p>
          <div className="trace-comparison">
            <div>App upstream fetch <strong>{formatMs(investigation.workerFetchDurationMs)}</strong></div>
            <div>App Worker handler <strong>{formatMs(investigation.workerHandlerDurationMs)}</strong></div>
            {investigation.spans.map((span, index) => <div key={`${span.name}-${index}`}>Cloudflare {span.name} span <strong>{formatMs(span.durationMs)}</strong></div>)}
          </div>
          {investigation.status === "unavailable" && <p>No trace ID was recorded for this run.</p>}
          {investigation.status === "not_configured" && <p>Cloudflare trace lookup is not configured. Add the account ID and Observability API token to compare spans.</p>}
          {investigation.status === "not_stored" && <p>No stored trace was found. This request may have been sampled out, may still be ingesting, or may have expired.</p>}
          {investigation.status === "available" && <p>App timings include response-body reading and application work; platform spans cover their own operations. Intervals may overlap.</p>}
        </>}
      </section>}

      <p className="footnote">These paths have different network routes. Their difference does not isolate Worker overhead. Browser POST timing is available only in this session; browser failures may reflect CORS restrictions.</p>
    </main>
  );
}
