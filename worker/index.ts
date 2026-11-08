import { TARGETS, type CreateProbeRequest, type ProbeRun } from "../shared/contracts";

/** The D1 binding is configured in wrangler.jsonc. */
interface Env {
  DB: D1Database;
  PROBE_RATE_LIMITER: RateLimit;
}

/** Keep upstream probes short so one dashboard action cannot tie up a Worker. */
const UPSTREAM_TIMEOUT_MS = 8_000;
const MAX_REQUEST_BYTES = 2_048;
const MAX_RESPONSE_BYTES = 64 * 1_024;

/** Return JSON with a consistent content type and without reusable cache entries. */
function json(data: unknown, status = 200): Response {
  return Response.json(data, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
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
    (typeof input.directError === "string" && input.directError.length <= 80);

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
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: { "Cache-Control": "no-cache" },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
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
      error: error instanceof Error && error.name === "TimeoutError" ? "timeout" : "network_error",
    };
  }
}

/** Map a D1 row into the stable JSON contract consumed by the dashboard. */
function mapRow(row: Record<string, unknown>): ProbeRun {
  return {
    id: String(row.id),
    targetId: String(row.target_id),
    createdAt: String(row.created_at),
    directDurationMs: row.direct_duration_ms as number | null,
    directStatus: row.direct_status as number | null,
    directError: row.direct_error as string | null,
    workerFetchDurationMs: row.worker_fetch_duration_ms as number | null,
    workerHandlerDurationMs: Number(row.worker_handler_duration_ms),
    workerStatus: row.worker_status as number | null,
    workerError: row.worker_error as string | null,
  };
}

/** Run one approved probe and persist both perspectives as one comparison. */
async function createProbe(request: Request, env: Env): Promise<Response> {
  // This anonymous demo uses a shared per-location budget to bound total traffic.
  const allowance = await env.PROBE_RATE_LIMITER.limit({ key: "public-probes" });
  if (!allowance.success) {
    return json({ error: "Probe limit reached. Try again in about a minute." }, 429);
  }
  const parsed = await readProbeBody(request);
  if ("error" in parsed) return json({ error: parsed.error }, parsed.status);
  const { input } = parsed;

  const target = TARGETS.find((item) => item.id === input.targetId)!;
  const handlerStarted = performance.now();
  const upstream = await probeUpstream(target.url);
  // Worker clocks advance on I/O, so this is handler wall time, not CPU time.
  const handlerDurationMs = performance.now() - handlerStarted;
  const run: ProbeRun = {
    id: crypto.randomUUID(),
    targetId: target.id,
    createdAt: new Date().toISOString(),
    directDurationMs: input.directDurationMs,
    directStatus: input.directStatus,
    directError: input.directError,
    workerFetchDurationMs: upstream.durationMs,
    workerHandlerDurationMs: handlerDurationMs,
    workerStatus: upstream.status,
    workerError: upstream.error,
  };

  await env.DB.prepare(
    `INSERT INTO probe_runs (
      id, target_id, created_at, direct_duration_ms, direct_status, direct_error,
      worker_fetch_duration_ms, worker_handler_duration_ms, worker_status, worker_error
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      run.id, run.targetId, run.createdAt, run.directDurationMs, run.directStatus,
      run.directError, run.workerFetchDurationMs, run.workerHandlerDurationMs,
      run.workerStatus, run.workerError,
    )
    .run();

  return json(run, 201);
}

/** Serve recent comparisons for the dashboard. */
async function listProbes(env: Env): Promise<Response> {
  const result = await env.DB.prepare(
    "SELECT * FROM probe_runs ORDER BY created_at DESC LIMIT 30",
  ).all<Record<string, unknown>>();
  return json(result.results.map(mapRow));
}

/** The Worker owns only API routes; Vite/Workers Assets serve the React app. */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/api/targets" && request.method === "GET") {
        return json(TARGETS);
      }
      if (url.pathname === "/api/probes" && request.method === "GET") {
        return await listProbes(env);
      }
      if (url.pathname === "/api/probes" && request.method === "POST") {
        return await createProbe(request, env);
      }
      return json({ error: "Route not found." }, 404);
    } catch (error) {
      // Log the full error server-side, but do not expose internals to visitors.
      console.error("API request failed", error);
      return json({ error: "The API could not complete this request." }, 500);
    }
  },
} satisfies ExportedHandler<Env>;
