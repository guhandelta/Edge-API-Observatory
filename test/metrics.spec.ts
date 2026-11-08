import { describe, expect, it } from "vitest";
import type { ExperimentSample, ProbeRun } from "../shared/contracts";
import { experimentPercentiles, median, p95, statusBucket, summarizeRuns } from "../src/metrics";

/** Build complete records so summary tests use the same contract as the API. */
function run(id: string, direct: number | null, worker: number, status: number | null,
  category: ProbeRun["workerErrorCategory"]): ProbeRun {
  return {
    id,
    requestId: id,
    traceId: null,
    targetId: "sample-post",
    createdAt: "2026-11-07T12:00:00.000Z",
    directDurationMs: direct,
    browserPostRoundTripMs: null,
    directStatus: direct === null ? null : 200,
    directError: direct === null ? "cors_or_network_error" : null,
    workerFetchDurationMs: worker,
    workerHandlerDurationMs: worker,
    workerStatus: status,
    workerError: category === "none" || category === "http_error" ? null : category,
    workerErrorCategory: category,
  };
}

describe("dashboard metrics", () => {
  it("uses the nearest observed rank for p95 and excludes missing experiment durations", () => {
    expect(p95([])).toBeNull();
    expect(p95([40, 10, 30, 20, 50])).toBe(50);
    const samples = [10, 30, null, 20].map((durationMs, ordinal) => ({
      id: String(ordinal), experimentId: "e", ordinal, pairIndex: Math.floor(ordinal / 2),
      requestMode: ordinal === 1 ? "worker_proxy" : "browser_direct",
      observedAt: "2026-11-08T00:00:00Z", durationMs, status: 200,
      errorCategory: "none", traceId: null,
    })) as ExperimentSample[];
    expect(experimentPercentiles(samples, "browser_direct")).toEqual({ count: 2, p50: 15, p95: 20 });
    expect(experimentPercentiles(samples, "worker_proxy")).toEqual({ count: 1, p50: 30, p95: 30 });
    expect(experimentPercentiles([], "worker_proxy")).toEqual({ count: 0, p50: null, p95: null });
  });
  it("uses measured sample counts and excludes failures from success rate", () => {
    const summary = summarizeRuns([
      run("one", 110, 100, 200, "none"),
      run("two", null, 200, 503, "http_error"),
      run("three", 310, 300, null, "network_error"),
      run("four", 410, 400, 200, "response_too_large"),
    ]);
    expect(summary.directMedian).toBe(310);
    expect(summary.workerMedian).toBe(250);
    expect(summary.directMeasured).toBe(3);
    expect(summary.workerMeasured).toBe(4);
    expect(summary.postMeasured).toBe(0);
    expect(summary.handlerMeasured).toBe(4);
    expect(summary.workerSuccessRate).toBe(25);
    expect(summary.statusCounts).toEqual({
      "2xx": 1, "3xx": 0, "4xx": 0, "5xx": 1, "Fetch error": 2,
    });
  });

  it("marks an empty endpoint as having no rate or medians", () => {
    const summary = summarizeRuns([]);
    expect(summary.workerSuccessRate).toBeNull();
    expect(summary.directMedian).toBeNull();
    expect(summary.workerMedian).toBeNull();
    expect(summary.postMedian).toBeNull();
    expect(summary.handlerMedian).toBeNull();
  });

  it("uses the middle value for odd samples and the midpoint for even samples", () => {
    expect(median([7, 1, 3])).toBe(3);
    expect(median([8, 2])).toBe(5);
    expect(median([])).toBeNull();
  });

  it("separates all HTTP status families from fetch failures", () => {
    const cases = [
      [run("redirect", 5, 10, 302, "none"), "3xx"],
      [run("missing", 5, 10, 404, "http_error"), "4xx"],
      [run("server", 5, 10, 503, "http_error"), "5xx"],
      [run("no-status", 5, 10, null, "none"), "Fetch error"],
      [run("transport", 5, 10, 200, "timeout"), "Fetch error"],
    ] as const;
    for (const [sample, expected] of cases) expect(statusBucket(sample)).toBe(expected);
    const summary = summarizeRuns(cases.map(([sample]) => sample));
    expect(summary.statusCounts).toEqual({
      "2xx": 0, "3xx": 1, "4xx": 1, "5xx": 1, "Fetch error": 2,
    });
  });

  it("counts only available durations when one request path has no measurement", () => {
    const sample = run("missing-measurements", null, 0, null, "network_error");
    sample.workerFetchDurationMs = null;
    sample.workerHandlerDurationMs = null;
    const summary = summarizeRuns([sample]);
    expect(summary.directMeasured).toBe(0);
    expect(summary.workerMeasured).toBe(0);
    expect(summary.directMedian).toBeNull();
    expect(summary.workerMedian).toBeNull();
    expect(summary.handlerMedian).toBeNull();
  });

  it("summarizes browser POST and Worker handler timing only when available", () => {
    const first = run("first", 15, 10, 200, "none");
    first.browserPostRoundTripMs = 35;
    first.workerHandlerDurationMs = 22;
    const second = run("second", 20, 15, 200, "none");
    second.browserPostRoundTripMs = 45;
    second.workerHandlerDurationMs = 30;
    const third = run("history", 25, 20, 200, "none");
    third.browserPostRoundTripMs = null;
    third.workerHandlerDurationMs = null;
    const summary = summarizeRuns([first, second, third]);
    expect(summary.postMeasured).toBe(2);
    expect(summary.handlerMeasured).toBe(2);
    expect(summary.postMedian).toBe(40);
    expect(summary.handlerMedian).toBe(26);
  });
});
