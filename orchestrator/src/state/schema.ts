/**
 * SQLite DDL and migrations for the state store.
 */

export const CURRENT_SCHEMA_VERSION = 3;

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

export const MIGRATION_V2 = `
ALTER TABLE complexity_profile ADD COLUMN architectural_patterns TEXT;
ALTER TABLE complexity_profile ADD COLUMN hotspots TEXT;
ALTER TABLE complexity_profile ADD COLUMN module_graph TEXT;
ALTER TABLE complexity_profile ADD COLUMN conventions_data TEXT;

CREATE TABLE IF NOT EXISTS hotspots (
  id INTEGER PRIMARY KEY,
  repo_path TEXT NOT NULL,
  file_path TEXT NOT NULL,
  churn_rate REAL NOT NULL,
  complexity INTEGER NOT NULL,
  commit_count INTEGER,
  last_modified TEXT,
  note TEXT,
  analyzed_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS routing_history (
  id INTEGER PRIMARY KEY,
  issue_number INTEGER,
  task_complexity INTEGER,
  codebase_complexity REAL,
  routing_strategy TEXT NOT NULL,
  agent_name TEXT,
  reason TEXT,
  decided_at TEXT DEFAULT (datetime('now'))
);
`;

export const MIGRATION_V3 = `
-- Cost tracking
CREATE TABLE IF NOT EXISTS cost_ledger (
  id INTEGER PRIMARY KEY,
  run_id TEXT NOT NULL,
  agent_name TEXT NOT NULL,
  pipeline_type TEXT NOT NULL,
  model TEXT,
  input_tokens INTEGER DEFAULT 0,
  output_tokens INTEGER DEFAULT 0,
  total_tokens INTEGER DEFAULT 0,
  cost_usd REAL DEFAULT 0.0,
  issue_number INTEGER,
  pr_number INTEGER,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_cost_ledger_run ON cost_ledger(run_id);
CREATE INDEX IF NOT EXISTS idx_cost_ledger_agent ON cost_ledger(agent_name);

-- Gate threshold overrides per complexity band
CREATE TABLE IF NOT EXISTS gate_threshold_overrides (
  id INTEGER PRIMARY KEY,
  gate_name TEXT NOT NULL,
  complexity_band TEXT NOT NULL,
  enforcement_level TEXT NOT NULL,
  threshold_overrides TEXT,
  active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(gate_name, complexity_band)
);

-- Autonomy event log (immutable)
CREATE TABLE IF NOT EXISTS autonomy_events (
  id INTEGER PRIMARY KEY,
  agent_name TEXT NOT NULL,
  event_type TEXT NOT NULL,
  from_level INTEGER NOT NULL,
  to_level INTEGER NOT NULL,
  trigger TEXT,
  metrics_snapshot TEXT,
  unmet_conditions TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_autonomy_events_agent ON autonomy_events(agent_name);

-- Extend autonomy_ledger
ALTER TABLE autonomy_ledger ADD COLUMN pr_approval_rate REAL DEFAULT 0.0;
ALTER TABLE autonomy_ledger ADD COLUMN rollback_count INTEGER DEFAULT 0;
ALTER TABLE autonomy_ledger ADD COLUMN security_incidents INTEGER DEFAULT 0;
ALTER TABLE autonomy_ledger ADD COLUMN promoted_at TEXT;
ALTER TABLE autonomy_ledger ADD COLUMN demoted_at TEXT;
ALTER TABLE autonomy_ledger ADD COLUMN time_at_level_ms INTEGER DEFAULT 0;

-- Extend episodic_memory
ALTER TABLE episodic_memory ADD COLUMN agent_name TEXT;
ALTER TABLE episodic_memory ADD COLUMN complexity_score INTEGER;
ALTER TABLE episodic_memory ADD COLUMN routing_strategy TEXT;
ALTER TABLE episodic_memory ADD COLUMN gate_pass_count INTEGER;
ALTER TABLE episodic_memory ADD COLUMN gate_fail_count INTEGER;
ALTER TABLE episodic_memory ADD COLUMN cost_usd REAL;
ALTER TABLE episodic_memory ADD COLUMN is_regression INTEGER DEFAULT 0;
ALTER TABLE episodic_memory ADD COLUMN related_episodes TEXT;

-- Extend pipeline_runs
ALTER TABLE pipeline_runs ADD COLUMN cost_usd REAL DEFAULT 0.0;
ALTER TABLE pipeline_runs ADD COLUMN tokens_used INTEGER DEFAULT 0;
ALTER TABLE pipeline_runs ADD COLUMN model TEXT;
ALTER TABLE pipeline_runs ADD COLUMN agent_name TEXT;
ALTER TABLE pipeline_runs ADD COLUMN complexity_score INTEGER;
`;

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    sql: SCHEMA_DDL,
  },
  {
    version: 2,
    sql: MIGRATION_V2,
  },
  {
    version: 3,
    sql: MIGRATION_V3,
  },
];
