import type { ProbeRun } from "../shared/contracts";

/** Buckets describe Worker outcomes; browser status remains visible per run. */
export const STATUS_BUCKETS = ["2xx", "3xx", "4xx", "5xx", "Fetch error"] as const;
export type StatusBucket = (typeof STATUS_BUCKETS)[number];

/** Summary counts make the denominator of each dashboard metric explicit. */
export interface RunSummary {
  comparisons: number;
  directMeasured: number;
  workerMeasured: number;
  directMedian: number | null;
  workerMedian: number | null;
  workerSuccessRate: number | null;
  statusCounts: Record<StatusBucket, number>;
}

/** Median is less sensitive to a single slow network request than the mean. */
export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

/** Classify a Worker response, giving transport failures priority over HTTP status. */
export function statusBucket(run: ProbeRun): StatusBucket {
  if (run.workerErrorCategory !== "none" && run.workerErrorCategory !== "http_error") {
    return "Fetch error";
  }
  const status = run.workerStatus;
  if (status === null) return "Fetch error";
  if (status >= 500) return "5xx";
  if (status >= 400) return "4xx";
  if (status >= 300) return "3xx";
  return "2xx";
}

/** Summarize one endpoint's paired runs for charts and median comparisons. */
export function summarizeRuns(runs: ProbeRun[]): RunSummary {
  const direct = runs.flatMap((run) => run.directDurationMs === null ? [] : [run.directDurationMs]);
  const worker = runs.flatMap((run) => run.workerFetchDurationMs === null ? [] : [run.workerFetchDurationMs]);
  const statusCounts: Record<StatusBucket, number> = {
    "2xx": 0,
    "3xx": 0,
    "4xx": 0,
    "5xx": 0,
    "Fetch error": 0,
  };
  for (const run of runs) statusCounts[statusBucket(run)] += 1;
  const successful = runs.filter((run) => statusBucket(run) === "2xx").length;
  return {
    comparisons: runs.length,
    directMeasured: direct.length,
    workerMeasured: worker.length,
    directMedian: median(direct),
    workerMedian: median(worker),
    workerSuccessRate: runs.length === 0 ? null : Math.round((successful / runs.length) * 100),
    statusCounts,
  };
}
