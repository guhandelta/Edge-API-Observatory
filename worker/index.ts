import { tracing } from "cloudflare:workers";
import {
  TARGETS,
  type CreateProbeRequest,
  type Experiment,
  type ExperimentSample,
  type ProbeErrorCategory,
  type ProbeRun,
  type ProbeSample,
  type ProbeSampleErrorCategory,
  type RequestMode,
  type TraceInvestigation,
  type TraceSpan,
} from "../shared/contracts";

/** The D1 binding is configured in wrangler.jsonc. */
interface Env {
  DB: D1Database;
  PROBE_RATE_LIMITER: RateLimit;
  /** Optional read path for account telemetry; never expose this token to the browser. */
  CLOUDFLARE_ACCOUNT_ID?: string;
  CLOUDFLARE_OBSERVABILITY_TOKEN?: string;
  CF_VERSION_METADATA?: WorkerVersionMetadata;
}

/** Keep upstream probes short so one dashboard action cannot tie up a Worker. */
const UPSTREAM_TIMEOUT_MS = 8_000;
const MAX_REQUEST_BYTES = 2_048;
const MAX_RESPONSE_BYTES = 64 * 1_024;
const DEMO_DELAY_MS = 750;

/** All-zero IDs mean tracing is disabled in this runtime. */
export function usableTraceId(id: string): string | null {
  return /^0+$/.test(id) ? null : id;
}

/** Fixed fixture routes make status outcomes repeatable without an open proxy. */
async function demoResponse(pathname: string): Promise<Response> {
  if (pathname === "/api/demo/delay") {
    await new Promise<void>((resolve) => setTimeout(resolve, DEMO_DELAY_MS));
    return json({ scenario: "delay", delayMs: DEMO_DELAY_MS, ok: true });
  }
  if (pathname === "/api/demo/error") {
    return json({ scenario: "error", error: "Intentional demo failure." }, 503);
  }
  return json({ scenario: "success", ok: true });
}

/** Return uncached JSON and expose the probe ID for tracing a request. */
function json(data: unknown, status = 200, requestId?: string): Response {
  return Response.json(data, {
    status,
    headers: {
      "Cache-Control": "no-store",
      ...(requestId ? { "X-Request-ID": requestId } : {}),
    },
  });
}

/** Keep HTTP failures distinct from transport and response-size failures. */
function errorCategory(status: number | null, error: string | null): ProbeErrorCategory {
  if (error === "timeout") return "timeout";
  if (error === "response_too_large") return "response_too_large";
  if (error !== null) return "network_error";
  if (status !== null && status >= 400) return "http_error";
  return "none";
}

/** Accept only the small, expected browser measurement shape. */
function parseRequest(value: unknown): CreateProbeRequest | null {
  if (typeof value !== "object" || value === null) return null;
  const input = value as Record<string, unknown>;
  const targetExists = TARGETS.some((target) => target.id === input.targetId);
  const durationValid =
    input.directDurationMs === null ||
    (typeof input.directDurationMs === "number" &&
      Number.isFinite(input.directDurationMs) &&
      input.directDurationMs >= 0 &&
      input.directDurationMs <= 60_000);
  const statusValid =
    input.directStatus === null ||
    (typeof input.directStatus === "number" &&
      Number.isInteger(input.directStatus) &&
      input.directStatus >= 100 &&
      input.directStatus <= 599);
  const errorValid =
    input.directError === null ||
    input.directError === "timeout" ||
    input.directError === "cors_or_network_error";

  if (!targetExists || !durationValid || !statusValid || !errorValid) return null;
  return input as unknown as CreateProbeRequest;
}

/** Read a stream up to a fixed byte limit, including when Content-Length is absent. */
async function readBounded(stream: ReadableStream<Uint8Array> | null, limit: number): Promise<boolean> {
  if (!stream) return true;
  const reader = stream.getReader();
  let received = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return true;
      received += value.byteLength;
      if (received > limit) {
        await reader.cancel();
        return false;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/** Parse a small JSON request without trusting its Content-Length header. */
async function readProbeBody(request: Request): Promise<
  | { input: CreateProbeRequest }
  | { status: number; error: string }
> {
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
    return { status: 415, error: "Content-Type must be application/json." };
  }
  if (Number(request.headers.get("content-length") ?? 0) > MAX_REQUEST_BYTES) {
    return { status: 413, error: "Request body is too large." };
  }

  const reader = request.body?.getReader();
  if (!reader) return { status: 400, error: "Expected a JSON request body." };
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_REQUEST_BYTES) {
        await reader.cancel();
        return { status: 413, error: "Request body is too large." };
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const input = parseRequest(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
    return input ? { input } : { status: 400, error: "Invalid probe request." };
  } catch {
    return { status: 400, error: "Expected a valid JSON request body." };
  }
}

/** Measure elapsed fetch I/O, including reading the response body. */
async function probeUpstream(url: string): Promise<{
  durationMs: number | null;
  status: number | null;
  error: string | null;
}> {
  const started = performance.now();
  const signal = AbortSignal.timeout(UPSTREAM_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: { "Cache-Control": "no-cache" },
      signal,
    });
    if (!await readBounded(response.body, MAX_RESPONSE_BYTES)) {
      return { durationMs: performance.now() - started, status: response.status, error: "response_too_large" };
    }
    return {
      durationMs: performance.now() - started,
      status: response.status,
      error: null,
    };
  } catch (error) {
    return {
      durationMs: performance.now() - started,
      status: null,
      error: signal.aborted || (error instanceof Error && error.name === "TimeoutError")
        ? "timeout"
        : "network_error",
    };
  }
}

/** Convert one D1 row into the mode-aware result returned by /api/history. */
function mapSample(row: Record<string, unknown>): ProbeSample {
  return {
    id: String(row.id),
    requestId: String(row.request_id),
    observedAt: String(row.observed_at),
    endpointId: String(row.endpoint_id),
    requestMode: row.request_mode as RequestMode,
    fetchDurationMs: row.fetch_duration_ms as number | null,
    handlerDurationMs: row.handler_duration_ms as number | null,
    status: row.status as number | null,
    errorCategory: row.error_category as ProbeSampleErrorCategory,
    errorDetail: row.error_detail as string | null,
    traceId: row.trace_id as string | null,
  };
}

/** Reassemble the old comparison shape for the existing React dashboard. */
function pairSamples(samples: ProbeSample[]): ProbeRun[] {
  const byRequest = new Map<string, Partial<Record<RequestMode, ProbeSample>>>();
  for (const sample of samples) {
    const pair = byRequest.get(sample.requestId) ?? {};
    pair[sample.requestMode] = sample;
    byRequest.set(sample.requestId, pair);
  }
  return [...byRequest.entries()].flatMap(([requestId, pair]) => {
    const direct = pair.browser_direct;
    const worker = pair.worker_proxy;
    if (!direct || !worker) return [];
    return [{
      id: requestId,
      requestId,
      traceId: worker.traceId,
      targetId: worker.endpointId,
      createdAt: worker.observedAt,
      directDurationMs: direct.fetchDurationMs,
      browserPostRoundTripMs: null,
      directStatus: direct.status,
      directError: direct.errorDetail,
      workerFetchDurationMs: worker.fetchDurationMs,
      workerHandlerDurationMs: worker.handlerDurationMs,
      workerStatus: worker.status,
      workerError: worker.errorDetail,
      workerErrorCategory: worker.errorCategory as ProbeErrorCategory,
    }];
  });
}

/** Run one approved probe and persist both perspectives as one comparison. */
async function createProbe(request: Request, env: Env, requestId: string, handlerStarted: number, traceId: string | null): Promise<Response> {
  // This anonymous demo uses a shared per-location budget to bound total traffic.
  const allowance = await env.PROBE_RATE_LIMITER.limit({ key: "public-probes" });
  if (!allowance.success) {
    return json({ error: "Probe limit reached. Try again in about a minute.", requestId }, 429, requestId);
  }
  const parsed = await readProbeBody(request);
  if ("error" in parsed) return json({ error: parsed.error, requestId }, parsed.status, requestId);
  const { input } = parsed;

  const target = TARGETS.find((item) => item.id === input.targetId)!;
  // Relative fixture URLs resolve to this public Worker origin for both request modes.
  const upstream = await probeUpstream(new URL(target.url, request.url).href);
  const run: ProbeRun = {
    id: requestId,
    requestId,
    traceId,
    targetId: target.id,
    createdAt: new Date().toISOString(),
    directDurationMs: input.directDurationMs,
    browserPostRoundTripMs: null,
    directStatus: input.directStatus,
    directError: input.directError,
    workerFetchDurationMs: upstream.durationMs,
    workerHandlerDurationMs: null,
    workerStatus: upstream.status,
    workerError: upstream.error,
    workerErrorCategory: errorCategory(upstream.status, upstream.error),
  };

  const insert = env.DB.prepare(
    `INSERT INTO probe_samples (
      id, request_id, observed_at, endpoint_id, request_mode, fetch_duration_ms,
      handler_duration_ms, status, error_category, error_detail, trace_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  // D1 executes the two inserts as one transaction, so history never has half a pair.
  await env.DB.batch([
    insert.bind(
      `${requestId}:browser`, requestId, run.createdAt, target.id, "browser_direct",
      run.directDurationMs, null, run.directStatus,
      run.directError === "timeout" ? "timeout" : run.directError ? "cors_or_network_error"
        : errorCategory(run.directStatus, null),
      run.directError, null,
    ),
    insert.bind(
      `${requestId}:worker`, requestId, run.createdAt, target.id, "worker_proxy",
      run.workerFetchDurationMs, run.workerHandlerDurationMs, run.workerStatus,
      run.workerErrorCategory, run.workerError, traceId,
    ),
  ]);

  // Capture the full probe path through its primary D1 commit. The subsequent
  // timing-metadata update cannot include itself in the value it writes.
  run.workerHandlerDurationMs = performance.now() - handlerStarted;
  await env.DB.prepare(
    "UPDATE probe_samples SET handler_duration_ms = ? WHERE request_id = ? AND request_mode = 'worker_proxy'",
  ).bind(run.workerHandlerDurationMs, requestId).run();

  return json(run, 201, requestId);
}

/** Query only the selected stored probe's trace and return bounded platform timings. */
async function investigate(requestId: string, env: Env): Promise<Response> {
  const row = await env.DB.prepare(
    "SELECT request_id, trace_id, fetch_duration_ms, handler_duration_ms, observed_at FROM probe_samples WHERE request_id = ? AND request_mode = 'worker_proxy'",
  ).bind(requestId).first<Record<string, unknown>>();
  if (!row) return json({ error: "Probe not found." }, 404);

  const traceId = row.trace_id as string | null;
  const result: TraceInvestigation = {
    requestId,
    traceId,
    workerFetchDurationMs: row.fetch_duration_ms as number | null,
    workerHandlerDurationMs: row.handler_duration_ms as number | null,
    status: "unavailable",
    spans: [],
  };
  if (!traceId) return json(result);
  if (!env.CLOUDFLARE_ACCOUNT_ID || !env.CLOUDFLARE_OBSERVABILITY_TOKEN) {
    return json({ ...result, status: "not_configured" });
  }

  // Public investigation links must not create an unbounded account API workload.
  const allowance = await env.PROBE_RATE_LIMITER.limit({ key: "public-trace-lookups" });
  if (!allowance.success) return json({ error: "Trace lookup limit reached." }, 429);

  // The account query is fixed to a D1-owned trace ID and a narrow time window.
  // No browser input can alter the account, query, or Cloudflare destination.
  const observed = Date.parse(String(row.observed_at));
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/workers/observability/telemetry/query`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.CLOUDFLARE_OBSERVABILITY_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        queryId: "edge-api-observatory-trace",
        timeframe: { from: observed - 60_000, to: observed + 60_000 },
        limit: 100,
        parameters: {
          view: "events",
          filters: [{ key: "$metadata.traceId", operation: "eq", type: "string", value: traceId }],
        },
      }),
      signal: AbortSignal.timeout(5_000),
    },
  );
  if (!response.ok) return json({ error: "Cloudflare trace lookup failed." }, 502);
  const data = await response.json() as {
    success?: boolean;
    result?: { events?: { events?: Array<{ $metadata?: {
      traceId?: string; spanId?: string; parentSpanId?: string; spanName?: string; duration?: number
    } }> } };
  };
  if (!data.success) return json({ error: "Cloudflare trace lookup failed." }, 502);
  const events = data.result?.events?.events ?? [];
  const probeSpanId = events.find((event) => event.$metadata?.traceId === traceId &&
    event.$metadata.spanName === "api.probe")?.$metadata?.spanId;
  const spans: TraceSpan[] = events
    .map((event) => event.$metadata)
    .filter((meta): meta is { traceId: string; parentSpanId: string; spanName: string; duration: number } =>
      meta?.traceId === traceId && meta.parentSpanId === probeSpanId &&
      typeof meta.spanName === "string" &&
      (meta.spanName === "fetch" || meta.spanName.startsWith("d1_")) &&
      typeof meta.duration === "number" && Number.isFinite(meta.duration) && meta.duration >= 0)
    .map((meta) => ({ name: meta.spanName, durationMs: meta.duration }));
  return json({ ...result, status: probeSpanId ? "available" : "not_stored", spans });
}

/** Serve recent comparisons for the dashboard. */
async function listProbes(env: Env): Promise<Response> {
  const result = await env.DB.prepare(
    "SELECT * FROM probe_samples ORDER BY observed_at DESC, id DESC LIMIT 60",
  ).all<Record<string, unknown>>();
  return json(pairSamples(result.results.map(mapSample)));
}

/** Return individual rows with validated endpoint, mode, and size filters. */
async function listHistory(url: URL, env: Env): Promise<Response> {
  const endpointId = url.searchParams.get("endpointId");
  const mode = url.searchParams.get("mode");
  const limitText = url.searchParams.get("limit") ?? "30";
  const limit = Number(limitText);
  if (endpointId !== null && !TARGETS.some((target) => target.id === endpointId)) {
    return json({ error: "Unknown endpointId." }, 400);
  }
  if (mode !== null && mode !== "browser_direct" && mode !== "worker_proxy") {
    return json({ error: "Unknown request mode." }, 400);
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    return json({ error: "limit must be an integer from 1 to 100." }, 400);
  }
  const result = await env.DB.prepare(
    `SELECT * FROM probe_samples
     WHERE (?1 IS NULL OR endpoint_id = ?1) AND (?2 IS NULL OR request_mode = ?2)
     ORDER BY observed_at DESC, id DESC LIMIT ?3`,
  ).bind(endpointId, mode, limit).all<Record<string, unknown>>();
  return json(result.results.map(mapSample));
}

/** Map D1 experiment rows without letting browser input claim a deployment version. */
function mapExperiment(row: Record<string, unknown>, samples: ExperimentSample[] = []): Experiment {
  return {
    id: String(row.id),
    scenario: String(row.scenario),
    endpointId: String(row.endpoint_id),
    deploymentVersion: String(row.deployment_version),
    requestedPairs: row.requested_pairs as 3 | 5,
    windowStartedAt: String(row.window_started_at),
    windowEndedAt: row.window_ended_at as string | null,
    samples,
  };
}

/** Preserve order and mode in every stored experiment observation. */
function mapExperimentSample(row: Record<string, unknown>): ExperimentSample {
  return {
    id: String(row.id),
    experimentId: String(row.experiment_id),
    ordinal: Number(row.ordinal),
    pairIndex: Number(row.pair_index),
    requestMode: row.request_mode as RequestMode,
    observedAt: String(row.observed_at),
    durationMs: row.duration_ms as number | null,
    status: row.status as number | null,
    errorCategory: row.error_category as ProbeSampleErrorCategory,
    traceId: row.trace_id as string | null,
  };
}

/** Resolve the fixed scenario from the approved endpoint rather than trusting a label. */
function scenarioFor(endpointId: string): string {
  if (endpointId === "demo-success") return "immediate-success";
  if (endpointId === "demo-delay") return "750ms-delay";
  if (endpointId === "demo-error") return "http-503";
  return "external-baseline";
}

/** Every pair reverses order to reduce time drift favoring one path. */
function expectedExperimentMode(ordinal: number): RequestMode {
  return (Math.floor(ordinal / 2) + ordinal) % 2 === 0 ? "browser_direct" : "worker_proxy";
}

/** Start a durable experiment before sending any samples. */
async function createExperiment(request: Request, env: Env): Promise<Response> {
  const parsed = await readProbeBody(request);
  if ("error" in parsed) return json({ error: parsed.error }, parsed.status);
  const input = parsed.input as CreateProbeRequest & { requestedPairs?: unknown };
  if (input.requestedPairs !== 3 && input.requestedPairs !== 5) {
    return json({ error: "requestedPairs must be 3 or 5." }, 400);
  }
  const allowance = await env.PROBE_RATE_LIMITER.limit({ key: "public-experiment-starts" });
  if (!allowance.success) return json({ error: "Experiment limit reached." }, 429);
  const id = crypto.randomUUID();
  const started = new Date().toISOString();
  const version = env.CF_VERSION_METADATA?.id ?? "local-development";
  await env.DB.prepare(
    "INSERT INTO experiments (id, scenario, endpoint_id, deployment_version, requested_pairs, window_started_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).bind(id, scenarioFor(input.targetId), input.targetId, version, input.requestedPairs, started).run();
  return json({ id, scenario: scenarioFor(input.targetId), endpointId: input.targetId,
    deploymentVersion: version, requestedPairs: input.requestedPairs,
    windowStartedAt: started, windowEndedAt: null, samples: [] } satisfies Experiment, 201);
}

/** Fetch one experiment with its independently ordered observations. */
async function getExperiment(id: string, env: Env): Promise<Experiment | null> {
  const row = await env.DB.prepare("SELECT * FROM experiments WHERE id = ?").bind(id).first<Record<string, unknown>>();
  if (!row) return null;
  const samples = await env.DB.prepare(
    "SELECT * FROM experiment_samples WHERE experiment_id = ? ORDER BY ordinal ASC",
  ).bind(id).all<Record<string, unknown>>();
  return mapExperiment(row, samples.results.map(mapExperimentSample));
}

/** Append one direct or Worker sample in the fixed alternating order. */
async function addExperimentSample(request: Request, env: Env, id: string, mode: RequestMode): Promise<Response> {
  const experiment = await getExperiment(id, env);
  if (!experiment) return json({ error: "Experiment not found." }, 404);
  if (experiment.windowEndedAt) return json({ error: "Experiment is complete." }, 409);
  const ordinal = experiment.samples.length;
  if (ordinal >= experiment.requestedPairs * 2 || expectedExperimentMode(ordinal) !== mode) {
    return json({ error: "Sample is out of sequence." }, 409);
  }
  const allowance = await env.PROBE_RATE_LIMITER.limit({ key: "public-experiment-samples" });
  if (!allowance.success) return json({ error: "Experiment sample limit reached." }, 429);

  let durationMs: number | null;
  let status: number | null;
  let category: ProbeSampleErrorCategory;
  let traceId: string | null = null;
  if (mode === "browser_direct") {
    const parsed = await readProbeBody(request);
    if ("error" in parsed) return json({ error: parsed.error }, parsed.status);
    if (parsed.input.targetId !== experiment.endpointId) return json({ error: "Target does not match experiment." }, 400);
    durationMs = parsed.input.directDurationMs;
    status = parsed.input.directStatus;
    category = parsed.input.directError === "timeout" ? "timeout"
      : parsed.input.directError ? "cors_or_network_error" : errorCategory(status, null);
  } else {
    const target = TARGETS.find((item) => item.id === experiment.endpointId)!;
    const upstream = await tracing.enterSpan("api.experiment_probe", async (span) => {
      span.setAttribute("experiment.id", id);
      traceId = usableTraceId(span.spanContext().traceId);
      return probeUpstream(new URL(target.url, request.url).href);
    });
    durationMs = upstream.durationMs;
    status = upstream.status;
    category = errorCategory(status, upstream.error);
  }
  const sample: ExperimentSample = {
    id: crypto.randomUUID(), experimentId: id, ordinal, pairIndex: Math.floor(ordinal / 2),
    requestMode: mode, observedAt: new Date().toISOString(), durationMs, status,
    errorCategory: category, traceId,
  };
  await env.DB.prepare(
    `INSERT INTO experiment_samples (id, experiment_id, ordinal, pair_index, request_mode,
     observed_at, duration_ms, status, error_category, trace_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(sample.id, id, ordinal, sample.pairIndex, mode, sample.observedAt,
    durationMs, status, category, traceId).run();
  return json(sample, 201);
}

/** Close the time window even if a browser run stopped partway through. */
async function completeExperiment(id: string, env: Env): Promise<Response> {
  const experiment = await getExperiment(id, env);
  if (!experiment) return json({ error: "Experiment not found." }, 404);
  if (!experiment.windowEndedAt) {
    await env.DB.prepare("UPDATE experiments SET window_ended_at = ? WHERE id = ?")
      .bind(new Date().toISOString(), id).run();
  }
  return json((await getExperiment(id, env))!);
}

/** List recent experiment metadata; detail requests include individual samples. */
async function listExperiments(env: Env): Promise<Response> {
  const result = await env.DB.prepare(
    "SELECT * FROM experiments ORDER BY window_started_at DESC LIMIT 20",
  ).all<Record<string, unknown>>();
  return json(result.results.map((row) => mapExperiment(row)));
}

/** The Worker owns only API routes; Vite/Workers Assets serve the React app. */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const handlerStarted = performance.now();
    const url = new URL(request.url);
    const requestId = url.pathname === "/api/probes" && request.method === "POST"
      ? crypto.randomUUID()
      : undefined;
    try {
      if (request.method === "GET" &&
        (url.pathname === "/api/demo/success" || url.pathname === "/api/demo/delay" || url.pathname === "/api/demo/error")) {
        return await demoResponse(url.pathname);
      }
      if (url.pathname === "/api/targets" && request.method === "GET") {
        return json(TARGETS);
      }
      if (url.pathname === "/api/probes" && request.method === "GET") {
        return await listProbes(env);
      }
      if (url.pathname === "/api/history" && request.method === "GET") {
        return await listHistory(url, env);
      }
      if (url.pathname === "/api/experiments" && request.method === "GET") return listExperiments(env);
      if (url.pathname === "/api/experiments" && request.method === "POST") return createExperiment(request, env);
      if (url.pathname.startsWith("/api/experiments/")) {
        const parts = url.pathname.slice("/api/experiments/".length).split("/");
        const id = parts[0];
        if (!/^[0-9a-f-]{36}$/.test(id)) return json({ error: "Invalid experiment ID." }, 400);
        if (parts.length === 1 && request.method === "GET") {
          const experiment = await getExperiment(id, env);
          return experiment ? json(experiment) : json({ error: "Experiment not found." }, 404);
        }
        if (parts.length === 2 && request.method === "POST") {
          if (parts[1] === "direct") return addExperimentSample(request, env, id, "browser_direct");
          if (parts[1] === "worker") return addExperimentSample(request, env, id, "worker_proxy");
          if (parts[1] === "complete") return completeExperiment(id, env);
        }
      }
      if (url.pathname.startsWith("/api/investigations/") && request.method === "GET") {
        const id = url.pathname.slice("/api/investigations/".length);
        if (!/^[0-9a-f-]{36}$/.test(id)) return json({ error: "Invalid request ID." }, 400);
        return await investigate(id, env);
      }
      if (url.pathname === "/api/probes" && request.method === "POST") {
        return await tracing.enterSpan("api.probe", async (span) => {
          span.setAttribute("probe.request_id", requestId!);
          const id = span.spanContext().traceId;
          const traceId = usableTraceId(id);
          return createProbe(request, env, requestId!, handlerStarted, traceId);
        });
      }
      return json({ error: "Route not found." }, 404);
    } catch (error) {
      // Log the full error server-side, but do not expose internals to visitors.
      console.error("API request failed", { requestId, error });
      return json({ error: "The API could not complete this request.", requestId }, 500, requestId);
    }
  },
} satisfies ExportedHandler<Env>;
