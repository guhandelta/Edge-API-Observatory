import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker, { usableTraceId } from "../worker/index";

/** Use the real D1 binding while controlling the rate-limit decision per test. */
function testEnv(allowed = true, traceConfig?: { accountId?: string; token?: string; version?: string }): Parameters<typeof worker.fetch>[1] {
  const bindings = env as typeof env & { DB: D1Database };
  return {
    DB: bindings.DB,
    PROBE_RATE_LIMITER: {
      limit: async () => ({ success: allowed }),
    } as RateLimit,
    CLOUDFLARE_ACCOUNT_ID: traceConfig?.accountId,
    CLOUDFLARE_OBSERVABILITY_TOKEN: traceConfig?.token,
    CF_VERSION_METADATA: traceConfig?.version ? { id: traceConfig.version } as WorkerVersionMetadata : undefined,
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

/** Keep validation cases focused on one invalid field at a time. */
function validBody() {
  return { targetId: "sample-post", directDurationMs: 12, directStatus: 200, directError: null };
}

/** Exercise experiment routes with the same bounded JSON shape as probes. */
function experimentRequest(path: string, body?: unknown): Request {
  return new Request(`https://example.test/api/experiments${path}`, {
    method: "POST",
    ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("Worker API", () => {
  it("stores a versioned experiment with alternating direct and Worker samples", async () => {
    const empty = await worker.fetch(new Request("https://example.test/api/experiments"), testEnv());
    expect(await empty.json()).toEqual([]);
    const started = await worker.fetch(experimentRequest("", { ...validBody(), targetId: "demo-success", requestedPairs: 3 }),
      testEnv(true, { version: "deployment-123" }));
    expect(started.status).toBe(201);
    const experiment = await started.json() as { id: string; scenario: string; deploymentVersion: string; windowStartedAt: string };
    expect(experiment.scenario).toBe("immediate-success");
    expect(experiment.deploymentVersion).toBe("deployment-123");
    expect(experiment.windowStartedAt).toMatch(/^2026/);
    const id = experiment.id;
    const direct = (body: unknown) => experimentRequest(`/${id}/direct`, body);
    const workerRequest = () => experimentRequest(`/${id}/worker`);
    let fetchCount = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      fetchCount += 1;
      if (fetchCount === 2) return new Response("error", { status: 503 });
      if (fetchCount === 3) throw new TypeError("offline");
      return new Response("ok");
    }));

    expect((await worker.fetch(workerRequest(), testEnv())).status).toBe(409);
    expect((await worker.fetch(direct(validBody()), testEnv(false))).status).toBe(429);
    expect((await worker.fetch(direct({ ...validBody(), targetId: "sample-user" }), testEnv())).status).toBe(400);
    expect((await worker.fetch(experimentRequest(`/${id}/direct`), testEnv())).status).toBe(415);
    const samples = [];
    samples.push(await (await worker.fetch(direct({ ...validBody(), targetId: "demo-success" }), testEnv())).json());
    expect((await worker.fetch(direct({ ...validBody(), targetId: "demo-success" }), testEnv())).status).toBe(409);
    samples.push(await (await worker.fetch(workerRequest(), testEnv())).json());
    samples.push(await (await worker.fetch(workerRequest(), testEnv())).json());
    samples.push(await (await worker.fetch(direct({ ...validBody(), targetId: "demo-success",
      directDurationMs: null, directStatus: null, directError: "timeout" }), testEnv())).json());
    samples.push(await (await worker.fetch(direct({ ...validBody(), targetId: "demo-success",
      directDurationMs: null, directStatus: null, directError: "cors_or_network_error" }), testEnv())).json());
    samples.push(await (await worker.fetch(workerRequest(), testEnv())).json());
    expect(samples.map((sample) => (sample as { requestMode: string }).requestMode)).toEqual([
      "browser_direct", "worker_proxy", "worker_proxy", "browser_direct", "browser_direct", "worker_proxy",
    ]);
    expect(samples.map((sample) => (sample as { pairIndex: number }).pairIndex)).toEqual([0, 0, 1, 1, 2, 2]);
    expect(samples.map((sample) => (sample as { errorCategory: string }).errorCategory)).toEqual([
      "none", "none", "http_error", "timeout", "cors_or_network_error", "network_error",
    ]);
    expect((await worker.fetch(direct({ ...validBody(), targetId: "demo-success" }), testEnv())).status).toBe(409);

    const before = await worker.fetch(new Request(`https://example.test/api/experiments/${id}`), testEnv());
    expect((await before.json() as { samples: unknown[]; windowEndedAt: string | null }).samples).toHaveLength(6);
    const finished = await worker.fetch(experimentRequest(`/${id}/complete`), testEnv());
    const result = await finished.json() as { samples: unknown[]; windowEndedAt: string };
    expect(result.samples).toHaveLength(6);
    expect(result.windowEndedAt).toMatch(/^2026/);
    const again = await worker.fetch(experimentRequest(`/${id}/complete`), testEnv());
    expect((await again.json() as { windowEndedAt: string }).windowEndedAt).toBe(result.windowEndedAt);
    expect((await worker.fetch(workerRequest(), testEnv())).status).toBe(409);
    const index = await worker.fetch(new Request("https://example.test/api/experiments"), testEnv());
    const listed = await index.json() as Array<{ id: string; samples: unknown[] }>;
    expect(listed[0]).toMatchObject({ id, samples: [] });
  });

  it("validates experiment creation and missing IDs, and fixes scenario labels", async () => {
    expect((await worker.fetch(experimentRequest("", {}), testEnv())).status).toBe(400);
    expect((await worker.fetch(experimentRequest("", { ...validBody(), requestedPairs: 2 }), testEnv())).status).toBe(400);
    expect((await worker.fetch(experimentRequest("", { ...validBody(), requestedPairs: 3 }), testEnv(false))).status).toBe(429);
    const created = [];
    for (const targetId of ["demo-delay", "demo-error", "sample-user"]) {
      const response = await worker.fetch(experimentRequest("", { ...validBody(), targetId, requestedPairs: 5 }), testEnv());
      created.push(await response.json() as { scenario: string; deploymentVersion: string; requestedPairs: number });
    }
    expect(created.map((item) => item.scenario)).toEqual(["750ms-delay", "http-503", "external-baseline"]);
    expect(created[0]).toMatchObject({ deploymentVersion: "local-development", requestedPairs: 5 });
    expect((await worker.fetch(new Request("https://example.test/api/experiments/bad"), testEnv())).status).toBe(400);
    const missing = crypto.randomUUID();
    expect((await worker.fetch(new Request(`https://example.test/api/experiments/${missing}`), testEnv())).status).toBe(404);
    expect((await worker.fetch(experimentRequest(`/${missing}/direct`, validBody()), testEnv())).status).toBe(404);
    expect((await worker.fetch(experimentRequest(`/${missing}/complete`), testEnv())).status).toBe(404);
    expect((await worker.fetch(experimentRequest(`/${missing}/unknown`), testEnv())).status).toBe(404);
    expect((await worker.fetch(new Request(`https://example.test/api/experiments/${missing}/worker`), testEnv())).status).toBe(404);
  });
  it("normalizes disabled and usable trace IDs", () => {
    expect(usableTraceId("0".repeat(32))).toBeNull();
    expect(usableTraceId("a".repeat(32))).toBe("a".repeat(32));
  });

  it("correlates a probe with a custom-span trace ID in D1", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("ok")));
    const created = await worker.fetch(probeRequest(validBody()), testEnv());
    const run = await created.json() as { requestId: string; traceId: string | null };
    const history = await worker.fetch(new Request("https://example.test/api/history?mode=worker_proxy&limit=100"), testEnv());
    const rows = await history.json() as Array<{ requestId: string; traceId: string | null }>;
    expect(rows.find((row) => row.requestId === run.requestId)?.traceId).toBe(run.traceId);
  });

  it("looks up only a saved run and distinguishes absent, unconfigured, and unstored traces", async () => {
    const bindings = env as typeof env & { DB: D1Database };
    const id = crypto.randomUUID();
    const traceId = "a".repeat(32);
    await bindings.DB.prepare(
      `INSERT INTO probe_samples (id, request_id, observed_at, endpoint_id, request_mode,
       fetch_duration_ms, handler_duration_ms, status, error_category, error_detail, trace_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(`${id}:worker`, id, new Date().toISOString(), "sample-post", "worker_proxy",
      15, 22, 200, "none", null, traceId).run();
    const url = `https://example.test/api/investigations/${id}`;
    const invalid = await worker.fetch(new Request("https://example.test/api/investigations/bad"), testEnv());
    const missing = await worker.fetch(new Request(`https://example.test/api/investigations/${crypto.randomUUID()}`), testEnv());
    expect([invalid.status, missing.status]).toEqual([400, 404]);

    const noAccount = await worker.fetch(new Request(url), testEnv());
    const noToken = await worker.fetch(new Request(url), testEnv(true, { accountId: "account" }));
    expect((await noAccount.json() as { status: string }).status).toBe("not_configured");
    expect((await noToken.json() as { status: string }).status).toBe("not_configured");

    await bindings.DB.prepare("UPDATE probe_samples SET trace_id = NULL WHERE request_id = ?").bind(id).run();
    const unavailable = await worker.fetch(new Request(url), testEnv());
    expect((await unavailable.json() as { status: string }).status).toBe("unavailable");
    await bindings.DB.prepare("UPDATE probe_samples SET trace_id = ? WHERE request_id = ?").bind(traceId, id).run();

    expect((await worker.fetch(new Request(url), testEnv(false, { accountId: "account", token: "token" }))).status).toBe(429);

    const query = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { parameters: { filters: Array<{ value: string }> }; timeframe: { from: number; to: number } };
      expect(String(_input)).toBe("https://api.cloudflare.com/client/v4/accounts/account/workers/observability/telemetry/query");
      expect(init?.headers).toMatchObject({ Authorization: "Bearer token" });
      expect(body.parameters.filters[0].value).toBe(traceId);
      expect(body.timeframe.to - body.timeframe.from).toBe(120_000);
      return Response.json({ success: true, result: { events: { events: [
        {},
        { $metadata: { traceId: "b".repeat(32), spanName: "api.probe", spanId: "other" } },
        { $metadata: { traceId, spanId: "probe-span", spanName: "api.probe", duration: 22 } },
        { $metadata: { traceId, parentSpanId: "probe-span", spanName: "fetch", duration: 12 } },
        { $metadata: { traceId, parentSpanId: "probe-span", spanName: "d1_batch", duration: 5 } },
        { $metadata: { traceId, parentSpanId: "probe-span", spanName: "d1_run", duration: 2 } },
        { $metadata: { traceId, parentSpanId: "other", spanName: "fetch", duration: 44 } },
        { $metadata: { traceId: "b".repeat(32), parentSpanId: "probe-span", spanName: "fetch", duration: 99 } },
        { $metadata: { traceId, parentSpanId: "probe-span", spanName: "custom", duration: 5 } },
        { $metadata: { traceId, parentSpanId: "probe-span", spanName: "fetch", duration: -1 } },
        { $metadata: { traceId, parentSpanId: "probe-span", spanName: "fetch", duration: "bad" } },
        { $metadata: { traceId, parentSpanId: "probe-span", duration: 2 } },
        {},
      ] } } });
    });
    vi.stubGlobal("fetch", query);
    const available = await worker.fetch(new Request(url), testEnv(true, { accountId: "account", token: "token" }));
    const data = await available.json() as { status: string; spans: Array<{ name: string; durationMs: number }>; workerFetchDurationMs: number };
    expect(data.status).toBe("available");
    expect(data.workerFetchDurationMs).toBe(15);
    expect(data.spans).toEqual([
      { name: "fetch", durationMs: 12 }, { name: "d1_batch", durationMs: 5 }, { name: "d1_run", durationMs: 2 },
    ]);
    expect(query).toHaveBeenCalledOnce();

    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ success: true, result: { events: { events: [] } } })));
    const unstored = await worker.fetch(new Request(url), testEnv(true, { accountId: "account", token: "token" }));
    expect((await unstored.json() as { status: string }).status).toBe("not_stored");
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ success: true })));
    expect((await (await worker.fetch(new Request(url), testEnv(true, { accountId: "account", token: "token" }))).json() as { status: string }).status).toBe("not_stored");
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ success: true, result: {} })));
    expect((await (await worker.fetch(new Request(url), testEnv(true, { accountId: "account", token: "token" }))).json() as { status: string }).status).toBe("not_stored");

    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 503 })));
    expect((await worker.fetch(new Request(url), testEnv(true, { accountId: "account", token: "token" }))).status).toBe(502);
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ success: false })));
    expect((await worker.fetch(new Request(url), testEnv(true, { accountId: "account", token: "token" }))).status).toBe(502);
  });
  it("exposes only approved targets", async () => {
    const response = await worker.fetch(new Request("https://example.test/api/targets"), testEnv());
    expect(response.status).toBe(200);
    const targets = await response.json() as Array<{ id: string; url: string }>;
    expect(targets.map((target) => target.id)).toEqual([
      "sample-post", "sample-user", "demo-success", "demo-delay", "demo-error",
    ]);
    expect(targets.map((target) => target.url).filter((url) => url.startsWith("/")))
      .toEqual(["/api/demo/success", "/api/demo/delay", "/api/demo/error"]);
  });

  it("serves fixed success, delayed success, and HTTP error fixtures", async () => {
    const success = await worker.fetch(new Request("https://example.test/api/demo/success"), testEnv());
    const started = performance.now();
    const delayed = await worker.fetch(new Request("https://example.test/api/demo/delay"), testEnv());
    const elapsedMs = performance.now() - started;
    const failed = await worker.fetch(new Request("https://example.test/api/demo/error"), testEnv());
    expect([success.status, delayed.status, failed.status]).toEqual([200, 200, 503]);
    expect((await delayed.json() as { delayMs: number }).delayMs).toBe(750);
    expect(elapsedMs).toBeGreaterThanOrEqual(700);
    expect((await failed.json() as { scenario: string }).scenario).toBe("error");
    expect(success.headers.get("Cache-Control")).toBe("no-store");
  });

  it("resolves a fixture probe to the same public origin", async () => {
    const upstream = vi.fn(async () => new Response('{"scenario":"error"}', { status: 503 }));
    vi.stubGlobal("fetch", upstream);
    const created = await worker.fetch(probeRequest({
      targetId: "demo-error", directDurationMs: 25, directStatus: 503, directError: null,
    }), testEnv());
    const run = await created.json() as { workerStatus: number; workerErrorCategory: string };
    expect(upstream).toHaveBeenCalledWith("https://example.test/api/demo/error", expect.any(Object));
    expect(run.workerStatus).toBe(503);
    expect(run.workerErrorCategory).toBe("http_error");
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

  it("includes the primary D1 write in Worker handler timing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("ok")));
    const normal = testEnv();
    const realDb = normal.DB;
    const delayedDb = {
      prepare: realDb.prepare.bind(realDb),
      batch: async (statements: D1PreparedStatement[]) => {
        await new Promise<void>((resolve) => setTimeout(resolve, 45));
        return realDb.batch(statements);
      },
    } as unknown as D1Database;
    const created = await worker.fetch(probeRequest(validBody()), { ...normal, DB: delayedDb });
    expect(created.status).toBe(201);
    const run = await created.json() as {
      requestId: string; browserPostRoundTripMs: number | null;
      workerFetchDurationMs: number; workerHandlerDurationMs: number;
    };
    expect(run.browserPostRoundTripMs).toBeNull();
    expect(run.workerHandlerDurationMs - run.workerFetchDurationMs).toBeGreaterThanOrEqual(40);

    const history = await worker.fetch(new Request(
      "https://example.test/api/history?endpointId=sample-post&mode=worker_proxy&limit=100",
    ), testEnv());
    const samples = await history.json() as Array<{ requestId: string; handlerDurationMs: number | null }>;
    expect(samples.find((sample) => sample.requestId === run.requestId)?.handlerDurationMs)
      .toBe(run.workerHandlerDurationMs);
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

  it("rejects empty, malformed, undecodable, and overdeclared request bodies", async () => {
    const empty = new Request("https://example.test/api/probes", {
      method: "POST", headers: { "Content-Type": "application/json" },
    });
    const undecodable = new Request("https://example.test/api/probes", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: new Uint8Array([0xff]),
    });
    const overdeclared = new Request("https://example.test/api/probes", {
      method: "POST", headers: { "Content-Type": "application/json", "Content-Length": "2049" },
      body: "{}",
    });
    const responses = await Promise.all([
      worker.fetch(empty, testEnv()),
      worker.fetch(probeRequest("{"), testEnv()),
      worker.fetch(undecodable, testEnv()),
      worker.fetch(overdeclared, testEnv()),
    ]);
    expect(responses.map((response) => response.status)).toEqual([400, 400, 400, 413]);
    expect((await responses[0].json() as { error: string }).error).toMatch(/request body/i);
  });

  it("rejects invalid browser measurements and accepts JSON with a charset", async () => {
    const invalid = [
      null,
      [],
      { ...validBody(), directDurationMs: -1 },
      { ...validBody(), directDurationMs: 60001 },
      { ...validBody(), directDurationMs: "12" },
      { ...validBody(), directStatus: 99 },
      { ...validBody(), directStatus: 600 },
      { ...validBody(), directStatus: 200.5 },
      { ...validBody(), directStatus: "200" },
      { ...validBody(), directError: "internal_error" },
      { ...validBody(), directError: 0 },
    ];
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 204 })));
    for (const input of invalid) {
      expect((await worker.fetch(probeRequest(input), testEnv())).status).toBe(400);
    }
    const nonfinite = '{"targetId":"sample-post","directDurationMs":1e400,"directStatus":200,"directError":null}';
    expect((await worker.fetch(probeRequest(nonfinite), testEnv())).status).toBe(400);
    const accepted = await worker.fetch(probeRequest(validBody(), "application/json; charset=utf-8"), testEnv());
    expect(accepted.status).toBe(201);
    expect((await accepted.json() as { workerStatus: number }).workerStatus).toBe(204);
  });

  it("stores browser timeout and CORS/network categories independently of the Worker outcome", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("ok")));
    for (const [directError, expected] of [
      ["timeout", "timeout"],
      ["cors_or_network_error", "cors_or_network_error"],
    ] as const) {
      const created = await worker.fetch(probeRequest({
        ...validBody(), directDurationMs: null, directStatus: null, directError,
      }), testEnv());
      const run = await created.json() as { requestId: string };
      const history = await worker.fetch(new Request(
        `https://example.test/api/history?endpointId=sample-post&mode=browser_direct&limit=100`,
      ), testEnv());
      const rows = await history.json() as Array<{ requestId: string; errorCategory: string }>;
      expect(rows.find((row) => row.requestId === run.requestId)?.errorCategory).toBe(expected);
    }
  });

  it("validates endpoint and numeric history filters and omits incomplete pairs", async () => {
    for (const query of ["endpointId=unknown", "limit=0", "limit=1.5", "limit=abc"]) {
      expect((await worker.fetch(new Request(`https://example.test/api/history?${query}`), testEnv())).status).toBe(400);
    }
    const bindings = env as typeof env & { DB: D1Database };
    await bindings.DB.prepare(
      `INSERT INTO probe_samples (id, request_id, observed_at, endpoint_id, request_mode,
       fetch_duration_ms, handler_duration_ms, status, error_category, error_detail)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind("incomplete:browser", "incomplete", new Date().toISOString(), "sample-post",
      "browser_direct", 1, null, 200, "none", null).run();
    const pairs = await worker.fetch(new Request("https://example.test/api/probes"), testEnv());
    expect((await pairs.json() as Array<{ requestId: string }>).some((row) => row.requestId === "incomplete"))
      .toBe(false);
    // Older or manually imported rows can lack handler timing; paired history stays readable.
    const insert = bindings.DB.prepare(
      `INSERT INTO probe_samples (id, request_id, observed_at, endpoint_id, request_mode,
       fetch_duration_ms, handler_duration_ms, status, error_category, error_detail)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const observedAt = new Date().toISOString();
    await bindings.DB.batch([
      insert.bind("legacy:browser", "legacy", observedAt, "sample-post", "browser_direct",
        10, null, 200, "none", null),
      insert.bind("legacy:worker", "legacy", observedAt, "sample-post", "worker_proxy",
        8, null, 200, "none", null),
    ]);
    const withLegacy = await worker.fetch(new Request("https://example.test/api/probes"), testEnv());
    expect((await withLegacy.json() as Array<{ requestId: string; workerHandlerDurationMs: number | null }>)
      .find((row) => row.requestId === "legacy")?.workerHandlerDurationMs).toBeNull();
    const defaultHistory = await worker.fetch(new Request("https://example.test/api/history"), testEnv());
    expect(defaultHistory.status).toBe(200);
  });

  it("returns a correlated 500 when D1 cannot persist a completed probe", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("ok")));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const broken = {
      ...testEnv(),
      DB: {
        prepare: () => ({ bind: () => ({}) }),
        batch: async () => { throw new Error("D1 unavailable"); },
      } as unknown as D1Database,
    };
    const response = await worker.fetch(probeRequest(validBody()), broken);
    expect(response.status).toBe(500);
    expect(response.headers.get("X-Request-ID")).toMatch(/^[0-9a-f-]{36}$/);
    expect((await response.json() as { requestId: string }).requestId)
      .toBe(response.headers.get("X-Request-ID"));
    expect(log).toHaveBeenCalledOnce();
    log.mockRestore();
  });

  it("returns 404 for unrecognized paths and methods", async () => {
    expect((await worker.fetch(new Request("https://example.test/api/other"), testEnv())).status).toBe(404);
    expect((await worker.fetch(new Request("https://example.test/api/demo/success", {
      method: "POST",
    }), testEnv())).status).toBe(404);
  });
});
