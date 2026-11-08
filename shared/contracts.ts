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
] as const;

/** Browser results are client-reported; Worker results are measured at the edge. */
export interface ProbeRun {
  id: string;
  targetId: string;
  createdAt: string;
  directDurationMs: number | null;
  directStatus: number | null;
  directError: string | null;
  workerFetchDurationMs: number | null;
  workerHandlerDurationMs: number;
  workerStatus: number | null;
  workerError: string | null;
}

/** Only these browser measurements may be submitted to the Worker. */
export interface CreateProbeRequest {
  targetId: string;
  directDurationMs: number | null;
  directStatus: number | null;
  directError: string | null;
}
