/** A fixed target list prevents the public demo from becoming an open proxy. */
export const TARGETS = [
  {
    id: "sample-post",
    name: "Sample post",
    url: "https://jsonplaceholder.typicode.com/posts/1",
  },
  {
    id: "sample-user",
    name: "Sample user",
    url: "https://jsonplaceholder.typicode.com/users/1",
  },
  { id: "demo-success", name: "Demo · success", url: "/api/demo/success" },
  { id: "demo-delay", name: "Demo · 750 ms delay", url: "/api/demo/delay" },
  { id: "demo-error", name: "Demo · HTTP 503", url: "/api/demo/error" },
] as const;

/** Stable categories let the UI group failures without parsing error text. */
export type ProbeErrorCategory =
  | "none"
  | "http_error"
  | "timeout"
  | "network_error"
  | "response_too_large";

/** A browser failure cannot reliably distinguish CORS denial from network loss. */
export type ProbeSampleErrorCategory = ProbeErrorCategory | "cors_or_network_error";

/** Each stored row represents exactly one request path. */
export type RequestMode = "browser_direct" | "worker_proxy";

/** Individual D1 result returned by the mode-aware history route. */
export interface ProbeSample {
  id: string;
  requestId: string;
  observedAt: string;
  endpointId: string;
  requestMode: RequestMode;
  fetchDurationMs: number | null;
  handlerDurationMs: number | null;
  status: number | null;
  errorCategory: ProbeSampleErrorCategory;
  errorDetail: string | null;
}

/** Browser results are client-reported; Worker results are measured at the edge. */
export interface ProbeRun {
  /** The persisted run ID is also the request correlation ID. */
  id: string;
  requestId: string;
  targetId: string;
  createdAt: string;
  directDurationMs: number | null;
  directStatus: number | null;
  directError: string | null;
  workerFetchDurationMs: number | null;
  workerHandlerDurationMs: number;
  workerStatus: number | null;
  workerError: string | null;
  workerErrorCategory: ProbeErrorCategory;
}

/** Only these browser measurements may be submitted to the Worker. */
export interface CreateProbeRequest {
  targetId: string;
  directDurationMs: number | null;
  directStatus: number | null;
  directError: string | null;
}
