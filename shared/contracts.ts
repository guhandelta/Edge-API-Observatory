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
  /** Worker rows include the probe path through its primary D1 commit. */
  handlerDurationMs: number | null;
  status: number | null;
  errorCategory: ProbeSampleErrorCategory;
  errorDetail: string | null;
  /** Present on Worker rows when tracing supplies a nonzero ID. */
  traceId: string | null;
}

/** Browser results are client-reported; Worker results are measured at the edge. */
export interface ProbeRun {
  /** The persisted run ID is also the request correlation ID. */
  id: string;
  requestId: string;
  /** Correlates this probe with a Cloudflare trace; does not guarantee storage. */
  traceId: string | null;
  targetId: string;
  createdAt: string;
  directDurationMs: number | null;
  /** Browser-measured POST response time; available only for the current session. */
  browserPostRoundTripMs: number | null;
  directStatus: number | null;
  directError: string | null;
  workerFetchDurationMs: number | null;
  /** Worker entry through the primary D1 commit; excludes timing metadata update. */
  workerHandlerDurationMs: number | null;
  workerStatus: number | null;
  workerError: string | null;
  workerErrorCategory: ProbeErrorCategory;
}

/** One Cloudflare platform span from the selected probe trace. */
export interface TraceSpan {
  name: string;
  durationMs: number;
}

/** A trace lookup is explicit about absent storage or missing configuration. */
export interface TraceInvestigation {
  requestId: string;
  traceId: string | null;
  workerFetchDurationMs: number | null;
  workerHandlerDurationMs: number | null;
  status: "available" | "not_stored" | "not_configured" | "unavailable";
  spans: TraceSpan[];
}

/** An experiment fixes the target, scenario, and Worker deployment before sampling. */
export interface Experiment {
  id: string;
  scenario: string;
  endpointId: string;
  deploymentVersion: string;
  requestedPairs: 3 | 5;
  windowStartedAt: string;
  windowEndedAt: string | null;
  samples: ExperimentSample[];
}

/** One ordered observation; two consecutive modes form one comparison pair. */
export interface ExperimentSample {
  id: string;
  experimentId: string;
  ordinal: number;
  pairIndex: number;
  requestMode: RequestMode;
  observedAt: string;
  durationMs: number | null;
  status: number | null;
  errorCategory: ProbeSampleErrorCategory;
  traceId: string | null;
}

/** Only these browser measurements may be submitted to the Worker. */
export interface CreateProbeRequest {
  targetId: string;
  directDurationMs: number | null;
  directStatus: number | null;
  directError: string | null;
}
