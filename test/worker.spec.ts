import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../worker/index";

/** Use the real D1 binding while controlling the rate-limit decision per test. */
function testEnv(allowed = true): Parameters<typeof worker.fetch>[1] {
  const bindings = env as typeof env & { DB: D1Database };
  return {
    DB: bindings.DB,
    PROBE_RATE_LIMITER: {
      limit: async () => ({ success: allowed }),
    } as RateLimit,
  };
}

/** Construct a probe request without depending on browser state. */
function probeRequest(body: unknown, contentType = "application/json"): Request {
  return new Request("https://example.test/api/probes", {
    method: "POST",
    headers: { "Content-Type": contentType },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("Worker API", () => {
  it("exposes only approved targets", async () => {
    const response = await worker.fetch(new Request("https://example.test/api/targets"), testEnv());
    expect(response.status).toBe(200);
    const targets = await response.json() as Array<{ id: string; url: string }>;
    expect(targets.map((target) => target.id)).toEqual(["sample-post", "sample-user"]);
    expect(targets.every((target) => target.url.startsWith("https://jsonplaceholder.typicode.com/"))).toBe(true);
  });

  it("rejects unsupported input before an upstream fetch", async () => {
    const upstream = vi.fn();
    vi.stubGlobal("fetch", upstream);
    const wrongType = await worker.fetch(probeRequest("{}", "text/plain"), testEnv());
    const unknownTarget = await worker.fetch(probeRequest({
      targetId: "https://example.test/private", directDurationMs: null,
      directStatus: null, directError: null,
    }), testEnv());
    const oversized = await worker.fetch(probeRequest("x".repeat(2_100)), testEnv());
    expect([wrongType.status, unknownTarget.status, oversized.status]).toEqual([415, 400, 413]);
    expect(unknownTarget.headers.get("X-Request-ID")).toMatch(/^[0-9a-f-]{36}$/);
    expect((await unknownTarget.json() as { requestId: string }).requestId)
      .toBe(unknownTarget.headers.get("X-Request-ID"));
    expect(upstream).not.toHaveBeenCalled();
  });

  it("returns 429 before reaching the upstream when the budget is exhausted", async () => {
    const upstream = vi.fn();
    vi.stubGlobal("fetch", upstream);
    const response = await worker.fetch(probeRequest({
      targetId: "sample-post", directDurationMs: null, directStatus: null, directError: null,
    }), testEnv(false));
    expect(response.status).toBe(429);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("records a comparison in D1 and returns it in recent history", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response('{"ok":true}', { status: 200 })));
    const created = await worker.fetch(probeRequest({
      targetId: "sample-post", directDurationMs: 42,
      directStatus: 200, directError: null,
    }), testEnv());
    expect(created.status).toBe(201);
    const run = await created.json() as {
      id: string; requestId: string; workerStatus: number;
      workerErrorCategory: string; directDurationMs: number;
    };
    expect(run.workerStatus).toBe(200);
    expect(run.workerErrorCategory).toBe("none");
    expect(run.directDurationMs).toBe(42);
    expect(run.requestId).toBe(run.id);
    expect(created.headers.get("X-Request-ID")).toBe(run.requestId);

    const history = await worker.fetch(new Request("https://example.test/api/probes"), testEnv());
    const runs = await history.json() as Array<{ id: string; requestId: string; workerErrorCategory: string }>;
    expect(runs.some((entry) => entry.id === run.id && entry.requestId === run.requestId && entry.workerErrorCategory === "none")).toBe(true);

    const samplesResponse = await worker.fetch(new Request(
      "https://example.test/api/history?endpointId=sample-post&limit=100",
    ), testEnv());
    const samples = await samplesResponse.json() as Array<{
      requestId: string; endpointId: string; requestMode: string;
      fetchDurationMs: number | null; status: number | null; observedAt: string;
    }>;
    const pair = samples.filter((sample) => sample.requestId === run.requestId);
    expect(pair).toHaveLength(2);
    expect(pair.map((sample) => sample.requestMode).sort()).toEqual(["browser_direct", "worker_proxy"]);
    expect(pair.every((sample) => sample.endpointId === "sample-post" && sample.observedAt.length > 0)).toBe(true);
    expect(pair.find((sample) => sample.requestMode === "browser_direct")?.fetchDurationMs).toBe(42);
    expect(pair.find((sample) => sample.requestMode === "worker_proxy")?.status).toBe(200);
  });

  it("filters individual history and rejects invalid filters", async () => {
    const selected = await worker.fetch(new Request(
      "https://example.test/api/history?endpointId=sample-user&mode=worker_proxy&limit=5",
    ), testEnv());
    expect(selected.status).toBe(200);
    const rows = await selected.json() as Array<{ endpointId: string; requestMode: string }>;
    expect(rows.every((row) => row.endpointId === "sample-user" && row.requestMode === "worker_proxy")).toBe(true);

    const invalidMode = await worker.fetch(new Request("https://example.test/api/history?mode=other"), testEnv());
    const invalidLimit = await worker.fetch(new Request("https://example.test/api/history?limit=101"), testEnv());
    expect([invalidMode.status, invalidLimit.status]).toEqual([400, 400]);
  });

  it("categorizes an upstream HTTP error without hiding its status", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("unavailable", { status: 503 })));
    const created = await worker.fetch(probeRequest({
      targetId: "sample-post", directDurationMs: null,
      directStatus: null, directError: null,
    }), testEnv());
    const run = await created.json() as { workerStatus: number; workerErrorCategory: string };
    expect(run.workerStatus).toBe(503);
    expect(run.workerErrorCategory).toBe("http_error");
  });

  it("categorizes a timed-out upstream request", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      const timeout = new Error("Upstream timed out");
      timeout.name = "TimeoutError";
      throw timeout;
    }));
    const created = await worker.fetch(probeRequest({
      targetId: "sample-post", directDurationMs: null,
      directStatus: null, directError: null,
    }), testEnv());
    const run = await created.json() as { workerStatus: number | null; workerErrorCategory: string };
    expect(run.workerStatus).toBeNull();
    expect(run.workerErrorCategory).toBe("timeout");
  });

  it("categorizes an upstream network failure without inventing an HTTP status", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Network unavailable"); }));
    const created = await worker.fetch(probeRequest({
      targetId: "sample-post", directDurationMs: null,
      directStatus: null, directError: null,
    }), testEnv());
    const run = await created.json() as { workerStatus: number | null; workerErrorCategory: string };
    expect(run.workerStatus).toBeNull();
    expect(run.workerErrorCategory).toBe("network_error");
  });

  it("stops reading an oversized upstream response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("x".repeat(65 * 1_024))));
    const created = await worker.fetch(probeRequest({
      targetId: "sample-user", directDurationMs: null,
      directStatus: null, directError: "cors_or_network_error",
    }), testEnv());
    expect(created.status).toBe(201);
    const run = await created.json() as { workerError: string; workerErrorCategory: string };
    expect(run.workerError).toBe("response_too_large");
    expect(run.workerErrorCategory).toBe("response_too_large");
  });
});
