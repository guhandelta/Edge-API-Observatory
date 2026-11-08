-- Store each browser and Worker measurement as its own result.
CREATE TABLE probe_samples (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  endpoint_id TEXT NOT NULL,
  request_mode TEXT NOT NULL CHECK (request_mode IN ('browser_direct', 'worker_proxy')),
  fetch_duration_ms REAL,
  handler_duration_ms REAL,
  status INTEGER,
  error_category TEXT NOT NULL,
  error_detail TEXT,
  UNIQUE (request_id, request_mode)
);

CREATE INDEX idx_probe_samples_history
  ON probe_samples (observed_at DESC, id DESC);

CREATE INDEX idx_probe_samples_endpoint_mode
  ON probe_samples (endpoint_id, request_mode, observed_at DESC);

-- Preserve measurements made before individual-mode storage was introduced.
INSERT INTO probe_samples (
  id, request_id, observed_at, endpoint_id, request_mode, fetch_duration_ms,
  handler_duration_ms, status, error_category, error_detail
)
SELECT
  id || ':browser', id, created_at, target_id, 'browser_direct', direct_duration_ms,
  NULL, direct_status,
  CASE
    WHEN direct_error = 'timeout' THEN 'timeout'
    WHEN direct_error IS NOT NULL THEN 'cors_or_network_error'
    WHEN direct_status >= 400 THEN 'http_error'
    ELSE 'none'
  END,
  direct_error
FROM probe_runs;

INSERT INTO probe_samples (
  id, request_id, observed_at, endpoint_id, request_mode, fetch_duration_ms,
  handler_duration_ms, status, error_category, error_detail
)
SELECT
  id || ':worker', id, created_at, target_id, 'worker_proxy', worker_fetch_duration_ms,
  worker_handler_duration_ms, worker_status,
  CASE
    WHEN worker_error = 'timeout' THEN 'timeout'
    WHEN worker_error = 'response_too_large' THEN 'response_too_large'
    WHEN worker_error IS NOT NULL THEN 'network_error'
    WHEN worker_status >= 400 THEN 'http_error'
    ELSE 'none'
  END,
  worker_error
FROM probe_runs;

DROP TABLE probe_runs;
