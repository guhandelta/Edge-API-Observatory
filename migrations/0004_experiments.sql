-- Experiments hold reproducibility metadata and independent, ordered samples.
CREATE TABLE experiments (
  id TEXT PRIMARY KEY,
  scenario TEXT NOT NULL,
  endpoint_id TEXT NOT NULL,
  deployment_version TEXT NOT NULL,
  requested_pairs INTEGER NOT NULL CHECK (requested_pairs IN (3, 5)),
  window_started_at TEXT NOT NULL,
  window_ended_at TEXT
);

CREATE TABLE experiment_samples (
  id TEXT PRIMARY KEY,
  experiment_id TEXT NOT NULL REFERENCES experiments(id),
  ordinal INTEGER NOT NULL,
  pair_index INTEGER NOT NULL,
  request_mode TEXT NOT NULL CHECK (request_mode IN ('browser_direct', 'worker_proxy')),
  observed_at TEXT NOT NULL,
  duration_ms REAL,
  status INTEGER,
  error_category TEXT NOT NULL,
  trace_id TEXT,
  UNIQUE (experiment_id, ordinal)
);

CREATE INDEX idx_experiments_recent ON experiments (window_started_at DESC);
CREATE INDEX idx_experiment_samples_order ON experiment_samples (experiment_id, ordinal);
