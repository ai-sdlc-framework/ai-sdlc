/**
 * SQLite DDL and migrations for the state store.
 */

export const CURRENT_SCHEMA_VERSION = 1;

export const SCHEMA_DDL = `
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY,
  applied_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS complexity_profile (
  id INTEGER PRIMARY KEY,
  repo_path TEXT NOT NULL,
  score REAL NOT NULL,
  files_count INTEGER,
  modules_count INTEGER,
  dependency_count INTEGER,
  analyzed_at TEXT DEFAULT (datetime('now')),
  raw_data TEXT
);

CREATE TABLE IF NOT EXISTS episodic_memory (
  id INTEGER PRIMARY KEY,
  issue_number INTEGER,
  pr_number INTEGER,
  pipeline_type TEXT NOT NULL,
  outcome TEXT NOT NULL,
  duration_ms INTEGER,
  files_changed INTEGER,
  error_message TEXT,
  metadata TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS autonomy_ledger (
  id INTEGER PRIMARY KEY,
  agent_name TEXT NOT NULL UNIQUE,
  current_level INTEGER DEFAULT 0,
  total_tasks INTEGER DEFAULT 0,
  success_count INTEGER DEFAULT 0,
  failure_count INTEGER DEFAULT 0,
  last_task_at TEXT,
  metrics TEXT
);

CREATE TABLE IF NOT EXISTS pipeline_runs (
  id INTEGER PRIMARY KEY,
  run_id TEXT NOT NULL UNIQUE,
  issue_number INTEGER,
  pr_number INTEGER,
  pipeline_type TEXT NOT NULL,
  status TEXT NOT NULL,
  current_stage TEXT,
  started_at TEXT DEFAULT (datetime('now')),
  completed_at TEXT,
  result TEXT,
  gate_results TEXT
);

CREATE TABLE IF NOT EXISTS conventions (
  id INTEGER PRIMARY KEY,
  category TEXT NOT NULL,
  pattern TEXT NOT NULL,
  confidence REAL,
  examples TEXT,
  detected_at TEXT DEFAULT (datetime('now'))
);
`;

export interface Migration {
  version: number;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    sql: SCHEMA_DDL,
  },
];
