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
    const run = await created.json() as { id: string; workerStatus: number; directDurationMs: number };
    expect(run.workerStatus).toBe(200);
    expect(run.directDurationMs).toBe(42);

    const history = await worker.fetch(new Request("https://example.test/api/probes"), testEnv());
    const runs = await history.json() as Array<{ id: string }>;
    expect(runs.some((entry) => entry.id === run.id)).toBe(true);
  });

  it("stops reading an oversized upstream response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("x".repeat(65 * 1_024))));
    const created = await worker.fetch(probeRequest({
      targetId: "sample-user", directDurationMs: null,
      directStatus: null, directError: "cors_or_network_error",
    }), testEnv());
    expect(created.status).toBe(201);
    const run = await created.json() as { workerError: string };
    expect(run.workerError).toBe("response_too_large");
  });
});
