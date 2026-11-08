import { describe, expect, it } from "vitest";
import type { ProbeRun } from "../shared/contracts";
import { summarizeRuns } from "../src/metrics";

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
});
