/**
 * SQLite DDL and migrations for the state store.
 */

export const CURRENT_SCHEMA_VERSION = 10;

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

export const MIGRATION_V4 = `
-- Handoff audit trail
CREATE TABLE IF NOT EXISTS handoff_events (
  id INTEGER PRIMARY KEY,
  run_id TEXT NOT NULL,
  from_agent TEXT NOT NULL,
  to_agent TEXT NOT NULL,
  payload_hash TEXT,
  validation_result TEXT NOT NULL,
  error_message TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_handoff_events_run ON handoff_events(run_id);
`;

export const MIGRATION_V5 = `
-- Deployment records
CREATE TABLE IF NOT EXISTS deployments (
  id INTEGER PRIMARY KEY,
  deployment_id TEXT NOT NULL UNIQUE,
  target_name TEXT NOT NULL,
  provider TEXT NOT NULL,
  version TEXT NOT NULL,
  environment TEXT NOT NULL,
  state TEXT NOT NULL,
  url TEXT,
  error TEXT,
  started_at TEXT DEFAULT (datetime('now')),
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_deployments_target ON deployments(target_name);
CREATE INDEX IF NOT EXISTS idx_deployments_env ON deployments(environment);

-- Rollout step records
CREATE TABLE IF NOT EXISTS rollout_steps (
  id INTEGER PRIMARY KEY,
  deployment_id TEXT NOT NULL,
  step_number INTEGER NOT NULL,
  weight_percent INTEGER NOT NULL,
  state TEXT NOT NULL,
  metrics_snapshot TEXT,
  started_at TEXT DEFAULT (datetime('now')),
  completed_at TEXT,
  FOREIGN KEY (deployment_id) REFERENCES deployments(deployment_id)
);
CREATE INDEX IF NOT EXISTS idx_rollout_steps_deployment ON rollout_steps(deployment_id);

-- Audit entries (indexed, queryable)
CREATE TABLE IF NOT EXISTS audit_entries (
  id INTEGER PRIMARY KEY,
  entry_id TEXT NOT NULL UNIQUE,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  resource_type TEXT,
  resource_id TEXT,
  detail TEXT,
  hash TEXT,
  previous_hash TEXT,
  signature TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_entries_actor ON audit_entries(actor);
CREATE INDEX IF NOT EXISTS idx_audit_entries_action ON audit_entries(action);
CREATE INDEX IF NOT EXISTS idx_audit_entries_resource ON audit_entries(resource_type, resource_id);
CREATE INDEX IF NOT EXISTS idx_audit_entries_created ON audit_entries(created_at);
`;

export const MIGRATION_V6 = `
-- Cost governance: add stage_name and cache_read_tokens to cost_ledger
ALTER TABLE cost_ledger ADD COLUMN stage_name TEXT;
ALTER TABLE cost_ledger ADD COLUMN cache_read_tokens INTEGER DEFAULT 0;
`;

export const MIGRATION_V7 = `
-- String issue IDs
ALTER TABLE pipeline_runs ADD COLUMN issue_id TEXT;
ALTER TABLE episodic_memory ADD COLUMN issue_id TEXT;
ALTER TABLE cost_ledger ADD COLUMN issue_id TEXT;
ALTER TABLE routing_history ADD COLUMN issue_id TEXT;
`;

export const MIGRATION_V8 = `
-- Priority calibration table (RFC-0005 PPA)
CREATE TABLE IF NOT EXISTS priority_calibration (
  id INTEGER PRIMARY KEY,
  issue_id TEXT NOT NULL,
  priority_composite REAL NOT NULL,
  priority_confidence REAL NOT NULL,
  priority_dimensions TEXT,
  actual_complexity INTEGER,
  files_changed INTEGER,
  outcome TEXT,
  sampled_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_priority_calibration_issue ON priority_calibration(issue_id);
CREATE INDEX IF NOT EXISTS idx_priority_calibration_sampled ON priority_calibration(sampled_at);

-- Extend episodic_memory with priority columns
ALTER TABLE episodic_memory ADD COLUMN priority_composite REAL;
ALTER TABLE episodic_memory ADD COLUMN priority_confidence REAL;
`;

export const MIGRATION_V9 = `
-- Workflow pattern detection tables

-- Tool sequence events captured by PostToolUse hook
CREATE TABLE IF NOT EXISTS tool_sequence_events (
  id INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  action_canonical TEXT NOT NULL,
  project_path TEXT,
  timestamp TEXT NOT NULL,
  ingested_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_tool_seq_session ON tool_sequence_events(session_id);
CREATE INDEX IF NOT EXISTS idx_tool_seq_ts ON tool_sequence_events(timestamp);

-- Detected workflow patterns (from n-gram mining)
CREATE TABLE IF NOT EXISTS workflow_patterns (
  id INTEGER PRIMARY KEY,
  pattern_hash TEXT NOT NULL UNIQUE,
  pattern_type TEXT NOT NULL,
  sequence_json TEXT NOT NULL,
  frequency INTEGER NOT NULL,
  session_count INTEGER NOT NULL,
  confidence REAL NOT NULL,
  first_seen TEXT,
  last_seen TEXT,
  status TEXT DEFAULT 'detected',
  detected_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_workflow_patterns_status ON workflow_patterns(status);

-- Automation proposals for human review
CREATE TABLE IF NOT EXISTS pattern_proposals (
  id INTEGER PRIMARY KEY,
  pattern_id INTEGER NOT NULL,
  proposal_type TEXT NOT NULL,
  artifact_type TEXT NOT NULL,
  artifact_path TEXT,
  draft_content TEXT NOT NULL,
  confidence REAL NOT NULL,
  status TEXT DEFAULT 'pending',
  reviewed_at TEXT,
  reviewer_reason TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (pattern_id) REFERENCES workflow_patterns(id)
);
CREATE INDEX IF NOT EXISTS idx_pattern_proposals_status ON pattern_proposals(status);
`;

export const MIGRATION_V10 = `
-- Design System Governance tables (RFC-0006)

CREATE TABLE IF NOT EXISTS design_token_events (
  id INTEGER PRIMARY KEY,
  binding_name TEXT NOT NULL,
  event_type TEXT NOT NULL,
  tokens_affected INTEGER DEFAULT 0,
  diff_json TEXT,
  actor TEXT,
  pipeline_run_id TEXT,
  design_review_decision TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_design_token_events_binding ON design_token_events(binding_name);
CREATE INDEX IF NOT EXISTS idx_design_token_events_type ON design_token_events(event_type);
CREATE INDEX IF NOT EXISTS idx_design_token_events_run ON design_token_events(pipeline_run_id);

CREATE TABLE IF NOT EXISTS design_review_events (
  id INTEGER PRIMARY KEY,
  binding_name TEXT NOT NULL,
  pr_number INTEGER,
  component_name TEXT,
  reviewer TEXT NOT NULL,
  decision TEXT NOT NULL,
  categories_json TEXT,
  actionable_notes TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_design_review_events_binding ON design_review_events(binding_name);
CREATE INDEX IF NOT EXISTS idx_design_review_events_pr ON design_review_events(pr_number);
CREATE INDEX IF NOT EXISTS idx_design_review_events_decision ON design_review_events(decision);

CREATE TABLE IF NOT EXISTS token_compliance_history (
  id INTEGER PRIMARY KEY,
  binding_name TEXT NOT NULL,
  coverage_percent REAL NOT NULL,
  violations_count INTEGER NOT NULL DEFAULT 0,
  scanned_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_token_compliance_binding ON token_compliance_history(binding_name);

CREATE TABLE IF NOT EXISTS visual_regression_results (
  id INTEGER PRIMARY KEY,
  binding_name TEXT NOT NULL,
  story_name TEXT NOT NULL,
  viewport INTEGER,
  diff_percentage REAL NOT NULL,
  approved INTEGER DEFAULT 0,
  approver TEXT,
  baseline_url TEXT,
  current_url TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_visual_regression_binding ON visual_regression_results(binding_name);
CREATE INDEX IF NOT EXISTS idx_visual_regression_story ON visual_regression_results(story_name);

CREATE TABLE IF NOT EXISTS usability_simulation_results (
  id INTEGER PRIMARY KEY,
  binding_name TEXT NOT NULL,
  story_name TEXT NOT NULL,
  persona_id TEXT,
  task_id TEXT,
  completed INTEGER DEFAULT 0,
  actions_taken INTEGER,
  expected_actions INTEGER,
  efficiency REAL,
  findings_json TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_usability_sim_binding ON usability_simulation_results(binding_name);
CREATE INDEX IF NOT EXISTS idx_usability_sim_story ON usability_simulation_results(story_name);
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
  {
    version: 4,
    sql: MIGRATION_V4,
  },
  {
    version: 5,
    sql: MIGRATION_V5,
  },
  {
    version: 6,
    sql: MIGRATION_V6,
  },
  {
    version: 7,
    sql: MIGRATION_V7,
  },
  {
    version: 8,
    sql: MIGRATION_V8,
  },
  {
    version: 9,
    sql: MIGRATION_V9,
  },
  {
    version: 10,
    sql: MIGRATION_V10,
  },
];
