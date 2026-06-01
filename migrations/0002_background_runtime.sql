CREATE TABLE IF NOT EXISTS runtime_kv (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_runtime_kv_updated_at ON runtime_kv (updated_at);
