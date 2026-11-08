import { describe, expect, it } from "vitest";
import type { ProbeRun } from "../shared/contracts";
import { median, statusBucket, summarizeRuns } from "../src/metrics";

/** Build complete records so summary tests use the same contract as the API. */
function run(id: string, direct: number | null, worker: number, status: number | null,
  category: ProbeRun["workerErrorCategory"]): ProbeRun {
  return {
    id,
    requestId: id,
    targetId: "sample-post",
    createdAt: "2026-11-07T12:00:00.000Z",
    directDurationMs: direct,
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
    const summary = summarizeRuns([sample]);
    expect(summary.directMeasured).toBe(0);
    expect(summary.workerMeasured).toBe(0);
    expect(summary.directMedian).toBeNull();
    expect(summary.workerMedian).toBeNull();
  });
});
