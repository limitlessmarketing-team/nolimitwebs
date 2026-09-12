-- Use a different database for Preview and Production. Contains billing IDs,
-- agreed amounts and operation receipts, never API keys or payment card details.
CREATE TABLE IF NOT EXISTS close_billing_projects (
  id TEXT PRIMARY KEY,
  mode TEXT NOT NULL CHECK (mode IN ('test', 'live')),
  lead_id TEXT NOT NULL,
  state TEXT NOT NULL,
  deposit_id TEXT UNIQUE,
  lock_token TEXT,
  lock_until INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS close_billing_calls (
  project_id TEXT NOT NULL,
  step TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  result TEXT,
  PRIMARY KEY (project_id, step)
);
