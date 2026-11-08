-- A trace ID correlates a probe with telemetry, but does not imply it was sampled and stored.
ALTER TABLE probe_samples ADD COLUMN trace_id TEXT;
CREATE INDEX idx_probe_samples_trace_id ON probe_samples (trace_id);
