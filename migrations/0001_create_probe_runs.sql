CREATE TABLE IF NOT EXISTS probe_runs (
  id TEXT PRIMARY KEY,
  target_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  direct_duration_ms REAL,
  direct_status INTEGER,
  direct_error TEXT,
  worker_fetch_duration_ms REAL,
  worker_handler_duration_ms REAL NOT NULL,
  worker_status INTEGER,
  worker_error TEXT
);

CREATE INDEX IF NOT EXISTS idx_probe_runs_created_at
  ON probe_runs (created_at DESC);
