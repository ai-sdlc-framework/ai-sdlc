/**
 * SQLite-backed state store for the AI-SDLC orchestrator.
 *
 * Uses better-sqlite3 for synchronous operations. The state store is
 * optional — the orchestrator works without it.
 */

import { createRequire } from 'node:module';
import type BetterSqlite3 from 'better-sqlite3';
import { CURRENT_SCHEMA_VERSION, MIGRATIONS } from './schema.js';
import type {
  ComplexityProfile,
  EpisodicRecord,
  AutonomyLedgerEntry,
  PipelineRun,
  PipelineRunStatus,
  Convention,
  HotspotRecord,
  RoutingDecision,
  CostLedgerEntry,
  GateThresholdOverride,
  AutonomyEvent,
  HandoffEvent,
  DeploymentRecord,
  DeploymentRecordState,
  RolloutStepRecord,
  AuditEntryRecord,
  PriorityCalibrationSample,
  ToolSequenceEvent,
  WorkflowPattern,
  PatternProposal,
  DesignTokenEventRecord,
  DesignReviewEventRecord,
  TokenComplianceRecord,
  VisualRegressionResultRecord,
  UsabilitySimulationResultRecord,
  DidCompiledArtifactRecord,
  DidScoringEventRecord,
  SaDimension,
  SaPhase,
  DidFeedbackEventRecord,
  FeedbackSignal,
  DesignChangeEventRecord,
  CodeAreaMetricsRecord,
  DesignLookaheadNotificationRecord,
  SaPhaseWeightsRecord,
} from './types.js';

export class StateStore {
  private db: BetterSqlite3.Database;

  constructor(db: BetterSqlite3.Database) {
    this.db = db;
    this.migrate();
  }

  /**
   * Create a StateStore from a file path or :memory: for testing.
   */
  static open(pathOrDb: string | BetterSqlite3.Database): StateStore {
    if (typeof pathOrDb === 'string') {
      // Dynamic require to keep better-sqlite3 optional at import time
      const esmRequire = createRequire(import.meta.url);
      const SqliteConstructor = esmRequire('better-sqlite3') as typeof BetterSqlite3;
      const db = new SqliteConstructor(pathOrDb);
      db.pragma('journal_mode = WAL');
      return new StateStore(db);
    }
    return new StateStore(pathOrDb);
  }

  private migrate(): void {
    // Check current schema version
    try {
      const row = this.db.prepare('SELECT MAX(version) as v FROM schema_version').get() as
        | { v: number | null }
        | undefined;
      const current = row?.v ?? 0;
      if (current >= CURRENT_SCHEMA_VERSION) return;

      for (const migration of MIGRATIONS) {
        if (migration.version > (current ?? 0)) {
          this.db.exec(migration.sql);
          this.db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(migration.version);
        }
      }
    } catch {
      // Table doesn't exist yet — run all migrations
      for (const migration of MIGRATIONS) {
        this.db.exec(migration.sql);
        this.db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(migration.version);
      }
    }
  }

  // ── Complexity Profiles ──────────────────────────────────────────

  saveComplexityProfile(profile: ComplexityProfile): number {
    const stmt = this.db.prepare(`
      INSERT INTO complexity_profile (repo_path, score, files_count, modules_count, dependency_count, raw_data, architectural_patterns, hotspots, module_graph, conventions_data)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      profile.repoPath,
      profile.score,
      profile.filesCount ?? null,
      profile.modulesCount ?? null,
      profile.dependencyCount ?? null,
      profile.rawData ?? null,
      profile.architecturalPatterns ?? null,
      profile.hotspots ?? null,
      profile.moduleGraph ?? null,
      profile.conventionsData ?? null,
    );
    return Number(result.lastInsertRowid);
  }

  getLatestComplexityProfile(repoPath: string): ComplexityProfile | undefined {
    const row = this.db
      .prepare(
        'SELECT * FROM complexity_profile WHERE repo_path = ? ORDER BY analyzed_at DESC LIMIT 1',
      )
      .get(repoPath) as Record<string, unknown> | undefined;
    return row ? this.mapComplexityProfile(row) : undefined;
  }

  private mapComplexityProfile(row: Record<string, unknown>): ComplexityProfile {
    return {
      id: row.id as number,
      repoPath: row.repo_path as string,
      score: row.score as number,
      filesCount: row.files_count as number | undefined,
      modulesCount: row.modules_count as number | undefined,
      dependencyCount: row.dependency_count as number | undefined,
      analyzedAt: row.analyzed_at as string | undefined,
      rawData: row.raw_data as string | undefined,
      architecturalPatterns: row.architectural_patterns as string | undefined,
      hotspots: row.hotspots as string | undefined,
      moduleGraph: row.module_graph as string | undefined,
      conventionsData: row.conventions_data as string | undefined,
    };
  }

  // ── Episodic Memory ──────────────────────────────────────────────

  saveEpisodicRecord(record: EpisodicRecord): number {
    const stmt = this.db.prepare(`
      INSERT INTO episodic_memory (issue_id, issue_number, pr_number, pipeline_type, outcome, duration_ms, files_changed, error_message, metadata,
        agent_name, complexity_score, routing_strategy, gate_pass_count, gate_fail_count, cost_usd, is_regression, related_episodes,
        priority_composite, priority_confidence)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      record.issueId ?? null,
      record.issueNumber ?? null,
      record.prNumber ?? null,
      record.pipelineType,
      record.outcome,
      record.durationMs ?? null,
      record.filesChanged ?? null,
      record.errorMessage ?? null,
      record.metadata ?? null,
      record.agentName ?? null,
      record.complexityScore ?? null,
      record.routingStrategy ?? null,
      record.gatePassCount ?? null,
      record.gateFailCount ?? null,
      record.costUsd ?? null,
      record.isRegression ?? 0,
      record.relatedEpisodes ?? null,
      record.priorityComposite ?? null,
      record.priorityConfidence ?? null,
    );
    return Number(result.lastInsertRowid);
  }

  getEpisodicRecords(issueNumber?: number, limit = 50): EpisodicRecord[] {
    const sql = issueNumber
      ? 'SELECT * FROM episodic_memory WHERE issue_number = ? ORDER BY created_at DESC LIMIT ?'
      : 'SELECT * FROM episodic_memory ORDER BY created_at DESC LIMIT ?';
    const rows = (
      issueNumber ? this.db.prepare(sql).all(issueNumber, limit) : this.db.prepare(sql).all(limit)
    ) as Record<string, unknown>[];
    return rows.map((r) => this.mapEpisodicRecord(r));
  }

  private mapEpisodicRecord(row: Record<string, unknown>): EpisodicRecord {
    return {
      id: row.id as number,
      issueId: row.issue_id as string | undefined,
      issueNumber: row.issue_number as number | undefined,
      prNumber: row.pr_number as number | undefined,
      pipelineType: row.pipeline_type as string,
      outcome: row.outcome as string,
      durationMs: row.duration_ms as number | undefined,
      filesChanged: row.files_changed as number | undefined,
      errorMessage: row.error_message as string | undefined,
      metadata: row.metadata as string | undefined,
      createdAt: row.created_at as string | undefined,
      agentName: row.agent_name as string | undefined,
      complexityScore: row.complexity_score as number | undefined,
      routingStrategy: row.routing_strategy as string | undefined,
      gatePassCount: row.gate_pass_count as number | undefined,
      gateFailCount: row.gate_fail_count as number | undefined,
      costUsd: row.cost_usd as number | undefined,
      isRegression: row.is_regression as number | undefined,
      relatedEpisodes: row.related_episodes as string | undefined,
      priorityComposite: row.priority_composite as number | undefined,
      priorityConfidence: row.priority_confidence as number | undefined,
    };
  }

  // ── Autonomy Ledger ──────────────────────────────────────────────

  getAutonomyLedger(agentName: string): AutonomyLedgerEntry | undefined {
    const row = this.db
      .prepare('SELECT * FROM autonomy_ledger WHERE agent_name = ?')
      .get(agentName) as Record<string, unknown> | undefined;
    return row ? this.mapAutonomyLedger(row) : undefined;
  }

  upsertAutonomyLedger(entry: AutonomyLedgerEntry): void {
    this.db
      .prepare(
        `INSERT INTO autonomy_ledger (agent_name, current_level, total_tasks, success_count, failure_count, last_task_at, metrics,
          pr_approval_rate, rollback_count, security_incidents, promoted_at, demoted_at, time_at_level_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(agent_name) DO UPDATE SET
           current_level = excluded.current_level,
           total_tasks = excluded.total_tasks,
           success_count = excluded.success_count,
           failure_count = excluded.failure_count,
           last_task_at = excluded.last_task_at,
           metrics = excluded.metrics,
           pr_approval_rate = excluded.pr_approval_rate,
           rollback_count = excluded.rollback_count,
           security_incidents = excluded.security_incidents,
           promoted_at = excluded.promoted_at,
           demoted_at = excluded.demoted_at,
           time_at_level_ms = excluded.time_at_level_ms`,
      )
      .run(
        entry.agentName,
        entry.currentLevel,
        entry.totalTasks,
        entry.successCount,
        entry.failureCount,
        entry.lastTaskAt ?? null,
        entry.metrics ?? null,
        entry.prApprovalRate ?? 0,
        entry.rollbackCount ?? 0,
        entry.securityIncidents ?? 0,
        entry.promotedAt ?? null,
        entry.demotedAt ?? null,
        entry.timeAtLevelMs ?? 0,
      );
  }

  getAllAutonomyLedgerEntries(): AutonomyLedgerEntry[] {
    const rows = this.db
      .prepare('SELECT * FROM autonomy_ledger ORDER BY agent_name')
      .all() as Record<string, unknown>[];
    return rows.map((r) => this.mapAutonomyLedger(r));
  }

  private mapAutonomyLedger(row: Record<string, unknown>): AutonomyLedgerEntry {
    return {
      id: row.id as number,
      agentName: row.agent_name as string,
      currentLevel: row.current_level as number,
      totalTasks: row.total_tasks as number,
      successCount: row.success_count as number,
      failureCount: row.failure_count as number,
      lastTaskAt: row.last_task_at as string | undefined,
      metrics: row.metrics as string | undefined,
      prApprovalRate: row.pr_approval_rate as number | undefined,
      rollbackCount: row.rollback_count as number | undefined,
      securityIncidents: row.security_incidents as number | undefined,
      promotedAt: row.promoted_at as string | undefined,
      demotedAt: row.demoted_at as string | undefined,
      timeAtLevelMs: row.time_at_level_ms as number | undefined,
    };
  }

  // ── Pipeline Runs ────────────────────────────────────────────────

  savePipelineRun(run: PipelineRun): number {
    const stmt = this.db.prepare(`
      INSERT INTO pipeline_runs (run_id, issue_id, issue_number, pr_number, pipeline_type, status, current_stage, result, gate_results,
        cost_usd, tokens_used, model, agent_name, complexity_score)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      run.runId,
      run.issueId ?? null,
      run.issueNumber ?? null,
      run.prNumber ?? null,
      run.pipelineType,
      run.status,
      run.currentStage ?? null,
      run.result ?? null,
      run.gateResults ?? null,
      run.costUsd ?? 0,
      run.tokensUsed ?? 0,
      run.model ?? null,
      run.agentName ?? null,
      run.complexityScore ?? null,
    );
    return Number(result.lastInsertRowid);
  }

  updatePipelineRunStatus(
    runId: string,
    status: PipelineRunStatus,
    opts?: { currentStage?: string; result?: string; gateResults?: string },
  ): void {
    const isTerminal = status === 'completed' || status === 'failed';
    const sql = isTerminal
      ? `UPDATE pipeline_runs SET status = ?, current_stage = ?,
         completed_at = datetime('now'),
         result = COALESCE(?, result),
         gate_results = COALESCE(?, gate_results)
         WHERE run_id = ?`
      : `UPDATE pipeline_runs SET status = ?, current_stage = ?,
         result = COALESCE(?, result),
         gate_results = COALESCE(?, gate_results)
         WHERE run_id = ?`;
    this.db
      .prepare(sql)
      .run(
        status,
        opts?.currentStage ?? null,
        opts?.result ?? null,
        opts?.gateResults ?? null,
        runId,
      );
  }

  getPipelineRun(runId: string): PipelineRun | undefined {
    const row = this.db.prepare('SELECT * FROM pipeline_runs WHERE run_id = ?').get(runId) as
      | Record<string, unknown>
      | undefined;
    return row ? this.mapPipelineRun(row) : undefined;
  }

  getPipelineRuns(issueNumber?: number, limit = 50): PipelineRun[] {
    const sql = issueNumber
      ? 'SELECT * FROM pipeline_runs WHERE issue_number = ? ORDER BY started_at DESC LIMIT ?'
      : 'SELECT * FROM pipeline_runs ORDER BY started_at DESC LIMIT ?';
    const rows = (
      issueNumber ? this.db.prepare(sql).all(issueNumber, limit) : this.db.prepare(sql).all(limit)
    ) as Record<string, unknown>[];
    return rows.map((r) => this.mapPipelineRun(r));
  }

  private mapPipelineRun(row: Record<string, unknown>): PipelineRun {
    return {
      id: row.id as number,
      runId: row.run_id as string,
      issueId: row.issue_id as string | undefined,
      issueNumber: row.issue_number as number | undefined,
      prNumber: row.pr_number as number | undefined,
      pipelineType: row.pipeline_type as string,
      status: row.status as PipelineRunStatus,
      currentStage: row.current_stage as string | undefined,
      startedAt: row.started_at as string | undefined,
      completedAt: row.completed_at as string | undefined,
      result: row.result as string | undefined,
      gateResults: row.gate_results as string | undefined,
      costUsd: row.cost_usd as number | undefined,
      tokensUsed: row.tokens_used as number | undefined,
      model: row.model as string | undefined,
      agentName: row.agent_name as string | undefined,
      complexityScore: row.complexity_score as number | undefined,
    };
  }

  // ── Conventions ──────────────────────────────────────────────────

  saveConvention(convention: Convention): number {
    const stmt = this.db.prepare(`
      INSERT INTO conventions (category, pattern, confidence, examples)
      VALUES (?, ?, ?, ?)
    `);
    const result = stmt.run(
      convention.category,
      convention.pattern,
      convention.confidence ?? null,
      convention.examples ?? null,
    );
    return Number(result.lastInsertRowid);
  }

  getConventions(category?: string): Convention[] {
    const sql = category
      ? 'SELECT * FROM conventions WHERE category = ? ORDER BY detected_at DESC'
      : 'SELECT * FROM conventions ORDER BY detected_at DESC';
    const rows = (
      category ? this.db.prepare(sql).all(category) : this.db.prepare(sql).all()
    ) as Record<string, unknown>[];
    return rows.map((r) => this.mapConvention(r));
  }

  private mapConvention(row: Record<string, unknown>): Convention {
    return {
      id: row.id as number,
      category: row.category as string,
      pattern: row.pattern as string,
      confidence: row.confidence as number | undefined,
      examples: row.examples as string | undefined,
      detectedAt: row.detected_at as string | undefined,
    };
  }

  // ── Hotspots ───────────────────────────────────────────────────

  saveHotspot(record: HotspotRecord): number {
    const stmt = this.db.prepare(`
      INSERT INTO hotspots (repo_path, file_path, churn_rate, complexity, commit_count, last_modified, note)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      record.repoPath,
      record.filePath,
      record.churnRate,
      record.complexity,
      record.commitCount ?? null,
      record.lastModified ?? null,
      record.note ?? null,
    );
    return Number(result.lastInsertRowid);
  }

  getHotspots(repoPath: string, limit = 20): HotspotRecord[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM hotspots WHERE repo_path = ? ORDER BY churn_rate DESC, complexity DESC LIMIT ?',
      )
      .all(repoPath, limit) as Record<string, unknown>[];
    return rows.map((r) => this.mapHotspot(r));
  }

  private mapHotspot(row: Record<string, unknown>): HotspotRecord {
    return {
      id: row.id as number,
      repoPath: row.repo_path as string,
      filePath: row.file_path as string,
      churnRate: row.churn_rate as number,
      complexity: row.complexity as number,
      commitCount: row.commit_count as number | undefined,
      lastModified: row.last_modified as string | undefined,
      note: row.note as string | undefined,
      analyzedAt: row.analyzed_at as string | undefined,
    };
  }

  // ── Routing History ───────────────────────────────────────────

  saveRoutingDecision(decision: RoutingDecision): number {
    const stmt = this.db.prepare(`
      INSERT INTO routing_history (issue_id, issue_number, task_complexity, codebase_complexity, routing_strategy, agent_name, reason)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      decision.issueId ?? null,
      decision.issueNumber ?? null,
      decision.taskComplexity,
      decision.codebaseComplexity,
      decision.routingStrategy,
      decision.agentName ?? null,
      decision.reason ?? null,
    );
    return Number(result.lastInsertRowid);
  }

  getRoutingHistory(limit = 50): RoutingDecision[] {
    const rows = this.db
      .prepare('SELECT * FROM routing_history ORDER BY decided_at DESC LIMIT ?')
      .all(limit) as Record<string, unknown>[];
    return rows.map((r) => this.mapRoutingDecision(r));
  }

  private mapRoutingDecision(row: Record<string, unknown>): RoutingDecision {
    return {
      id: row.id as number,
      issueId: row.issue_id as string | undefined,
      issueNumber: row.issue_number as number | undefined,
      taskComplexity: row.task_complexity as number,
      codebaseComplexity: row.codebase_complexity as number,
      routingStrategy: row.routing_strategy as string,
      agentName: row.agent_name as string | undefined,
      reason: row.reason as string | undefined,
      decidedAt: row.decided_at as string | undefined,
    };
  }

  // ── Cost Ledger ────────────────────────────────────────────────

  saveCostEntry(entry: CostLedgerEntry): number {
    const stmt = this.db.prepare(`
      INSERT INTO cost_ledger (run_id, agent_name, pipeline_type, model, input_tokens, output_tokens, total_tokens, cost_usd, issue_id, issue_number, pr_number, stage_name, cache_read_tokens)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      entry.runId,
      entry.agentName,
      entry.pipelineType,
      entry.model ?? null,
      entry.inputTokens ?? 0,
      entry.outputTokens ?? 0,
      entry.totalTokens ?? 0,
      entry.costUsd ?? 0,
      entry.issueId ?? null,
      entry.issueNumber ?? null,
      entry.prNumber ?? null,
      entry.stageName ?? null,
      entry.cacheReadTokens ?? 0,
    );
    return Number(result.lastInsertRowid);
  }

  getCostEntries(opts?: {
    runId?: string;
    agentName?: string;
    since?: string;
    limit?: number;
  }): CostLedgerEntry[] {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (opts?.runId) {
      conditions.push('run_id = ?');
      params.push(opts.runId);
    }
    if (opts?.agentName) {
      conditions.push('agent_name = ?');
      params.push(opts.agentName);
    }
    if (opts?.since) {
      conditions.push('created_at >= ?');
      params.push(opts.since);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = opts?.limit ?? 1000;
    const sql = `SELECT * FROM cost_ledger ${where} ORDER BY created_at DESC LIMIT ?`;
    params.push(limit);

    const rows = this.db.prepare(sql).all(...params) as Record<string, unknown>[];
    return rows.map((r) => this.mapCostEntry(r));
  }

  getCostSummary(since?: string): {
    totalCostUsd: number;
    totalTokens: number;
    entryCount: number;
  } {
    const where = since ? 'WHERE created_at >= ?' : '';
    const sql = `SELECT COALESCE(SUM(cost_usd), 0) as total_cost, COALESCE(SUM(total_tokens), 0) as total_tokens, COUNT(*) as entry_count FROM cost_ledger ${where}`;
    const row = (since ? this.db.prepare(sql).get(since) : this.db.prepare(sql).get()) as Record<
      string,
      unknown
    >;
    return {
      totalCostUsd: row.total_cost as number,
      totalTokens: row.total_tokens as number,
      entryCount: row.entry_count as number,
    };
  }

  private mapCostEntry(row: Record<string, unknown>): CostLedgerEntry {
    return {
      id: row.id as number,
      runId: row.run_id as string,
      agentName: row.agent_name as string,
      pipelineType: row.pipeline_type as string,
      model: row.model as string | undefined,
      inputTokens: row.input_tokens as number | undefined,
      outputTokens: row.output_tokens as number | undefined,
      totalTokens: row.total_tokens as number | undefined,
      costUsd: row.cost_usd as number | undefined,
      issueId: row.issue_id as string | undefined,
      issueNumber: row.issue_number as number | undefined,
      prNumber: row.pr_number as number | undefined,
      stageName: row.stage_name as string | undefined,
      cacheReadTokens: row.cache_read_tokens as number | undefined,
      createdAt: row.created_at as string | undefined,
    };
  }

  // ── Gate Threshold Overrides ──────────────────────────────────

  saveGateThresholdOverride(override: GateThresholdOverride): number {
    const stmt = this.db.prepare(`
      INSERT INTO gate_threshold_overrides (gate_name, complexity_band, enforcement_level, threshold_overrides, active)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(gate_name, complexity_band) DO UPDATE SET
        enforcement_level = excluded.enforcement_level,
        threshold_overrides = excluded.threshold_overrides,
        active = excluded.active
    `);
    const result = stmt.run(
      override.gateName,
      override.complexityBand,
      override.enforcementLevel,
      override.thresholdOverrides ?? null,
      override.active ?? 1,
    );
    return Number(result.lastInsertRowid);
  }

  getGateThresholdOverrides(gateName?: string, complexityBand?: string): GateThresholdOverride[] {
    const conditions: string[] = ['active = 1'];
    const params: unknown[] = [];

    if (gateName) {
      conditions.push('gate_name = ?');
      params.push(gateName);
    }
    if (complexityBand) {
      conditions.push('complexity_band = ?');
      params.push(complexityBand);
    }

    const sql = `SELECT * FROM gate_threshold_overrides WHERE ${conditions.join(' AND ')} ORDER BY gate_name`;
    const rows = this.db.prepare(sql).all(...params) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: r.id as number,
      gateName: r.gate_name as string,
      complexityBand: r.complexity_band as string,
      enforcementLevel: r.enforcement_level as string,
      thresholdOverrides: r.threshold_overrides as string | undefined,
      active: r.active as number | undefined,
      createdAt: r.created_at as string | undefined,
    }));
  }

  // ── Autonomy Events ───────────────────────────────────────────

  saveAutonomyEvent(event: AutonomyEvent): number {
    const stmt = this.db.prepare(`
      INSERT INTO autonomy_events (agent_name, event_type, from_level, to_level, trigger, metrics_snapshot, unmet_conditions)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      event.agentName,
      event.eventType,
      event.fromLevel,
      event.toLevel,
      event.trigger ?? null,
      event.metricsSnapshot ?? null,
      event.unmetConditions ?? null,
    );
    return Number(result.lastInsertRowid);
  }

  getAutonomyEvents(agentName?: string, limit = 100): AutonomyEvent[] {
    const sql = agentName
      ? 'SELECT * FROM autonomy_events WHERE agent_name = ? ORDER BY created_at DESC LIMIT ?'
      : 'SELECT * FROM autonomy_events ORDER BY created_at DESC LIMIT ?';
    const rows = (
      agentName ? this.db.prepare(sql).all(agentName, limit) : this.db.prepare(sql).all(limit)
    ) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: r.id as number,
      agentName: r.agent_name as string,
      eventType: r.event_type as AutonomyEvent['eventType'],
      fromLevel: r.from_level as number,
      toLevel: r.to_level as number,
      trigger: r.trigger as string | undefined,
      metricsSnapshot: r.metrics_snapshot as string | undefined,
      unmetConditions: r.unmet_conditions as string | undefined,
      createdAt: r.created_at as string | undefined,
    }));
  }

  // ── Episodic Search ───────────────────────────────────────────

  searchEpisodicRecords(opts: {
    agentName?: string;
    outcome?: string;
    since?: string;
    files?: string;
    limit?: number;
  }): EpisodicRecord[] {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (opts.agentName) {
      conditions.push('agent_name = ?');
      params.push(opts.agentName);
    }
    if (opts.outcome) {
      conditions.push('outcome = ?');
      params.push(opts.outcome);
    }
    if (opts.since) {
      conditions.push('created_at >= ?');
      params.push(opts.since);
    }
    if (opts.files) {
      conditions.push('metadata LIKE ?');
      params.push(`%${opts.files}%`);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = opts.limit ?? 50;
    const sql = `SELECT * FROM episodic_memory ${where} ORDER BY created_at DESC LIMIT ?`;
    params.push(limit);

    const rows = this.db.prepare(sql).all(...params) as Record<string, unknown>[];
    return rows.map((r) => this.mapEpisodicRecord(r));
  }

  // ── Codebase Profile (full) ───────────────────────────────────

  /**
   * Save a full codebase profile with JSON-serialized analysis data.
   * Also saves individual hotspot records.
   */
  saveCodebaseProfile(profile: ComplexityProfile): number {
    return this.saveComplexityProfile(profile);
  }

  // ── Handoff Events ──────────────────────────────────────────────

  saveHandoffEvent(event: Omit<HandoffEvent, 'id' | 'createdAt'>): number {
    const stmt = this.db.prepare(`
      INSERT INTO handoff_events (run_id, from_agent, to_agent, payload_hash, validation_result, error_message)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      event.runId,
      event.fromAgent,
      event.toAgent,
      event.payloadHash ?? null,
      event.validationResult,
      event.errorMessage ?? null,
    );
    return Number(result.lastInsertRowid);
  }

  getHandoffEvents(runId?: string, limit = 100): HandoffEvent[] {
    const sql = runId
      ? 'SELECT * FROM handoff_events WHERE run_id = ? ORDER BY created_at DESC LIMIT ?'
      : 'SELECT * FROM handoff_events ORDER BY created_at DESC LIMIT ?';
    const rows = (
      runId ? this.db.prepare(sql).all(runId, limit) : this.db.prepare(sql).all(limit)
    ) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: r.id as number,
      runId: r.run_id as string,
      fromAgent: r.from_agent as string,
      toAgent: r.to_agent as string,
      payloadHash: r.payload_hash as string | undefined,
      validationResult: r.validation_result as string,
      errorMessage: r.error_message as string | undefined,
      createdAt: r.created_at as string | undefined,
    }));
  }

  // ── Deployments ─────────────────────────────────────────────────

  saveDeployment(record: Omit<DeploymentRecord, 'id'>): number {
    const stmt = this.db.prepare(`
      INSERT INTO deployments (deployment_id, target_name, provider, version, environment, state, url, error, started_at, completed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      record.deploymentId,
      record.targetName,
      record.provider,
      record.version,
      record.environment,
      record.state,
      record.url ?? null,
      record.error ?? null,
      record.startedAt ?? null,
      record.completedAt ?? null,
    );
    return Number(result.lastInsertRowid);
  }

  updateDeployment(
    deploymentId: string,
    update: { state: DeploymentRecordState; url?: string; error?: string; completedAt?: string },
  ): void {
    this.db
      .prepare(
        `
      UPDATE deployments SET state = ?, url = COALESCE(?, url), error = COALESCE(?, error), completed_at = COALESCE(?, completed_at)
      WHERE deployment_id = ?
    `,
      )
      .run(
        update.state,
        update.url ?? null,
        update.error ?? null,
        update.completedAt ?? null,
        deploymentId,
      );
  }

  getDeployment(deploymentId: string): DeploymentRecord | undefined {
    const row = this.db
      .prepare('SELECT * FROM deployments WHERE deployment_id = ?')
      .get(deploymentId) as Record<string, unknown> | undefined;
    return row ? this.mapDeployment(row) : undefined;
  }

  getDeployments(opts?: {
    targetName?: string;
    environment?: string;
    limit?: number;
  }): DeploymentRecord[] {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (opts?.targetName) {
      conditions.push('target_name = ?');
      params.push(opts.targetName);
    }
    if (opts?.environment) {
      conditions.push('environment = ?');
      params.push(opts.environment);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = opts?.limit ?? 50;
    params.push(limit);
    const rows = this.db
      .prepare(`SELECT * FROM deployments ${where} ORDER BY started_at DESC LIMIT ?`)
      .all(...params) as Record<string, unknown>[];
    return rows.map((r) => this.mapDeployment(r));
  }

  private mapDeployment(row: Record<string, unknown>): DeploymentRecord {
    return {
      id: row.id as number,
      deploymentId: row.deployment_id as string,
      targetName: row.target_name as string,
      provider: row.provider as string,
      version: row.version as string,
      environment: row.environment as string,
      state: row.state as DeploymentRecordState,
      url: row.url as string | undefined,
      error: row.error as string | undefined,
      startedAt: row.started_at as string | undefined,
      completedAt: row.completed_at as string | undefined,
    };
  }

  // ── Rollout Steps ──────────────────────────────────────────────

  saveRolloutStep(record: Omit<RolloutStepRecord, 'id'>): number {
    const stmt = this.db.prepare(`
      INSERT INTO rollout_steps (deployment_id, step_number, weight_percent, state, metrics_snapshot, started_at, completed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      record.deploymentId,
      record.stepNumber,
      record.weightPercent,
      record.state,
      record.metricsSnapshot ?? null,
      record.startedAt ?? null,
      record.completedAt ?? null,
    );
    return Number(result.lastInsertRowid);
  }

  getRolloutSteps(deploymentId: string): RolloutStepRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM rollout_steps WHERE deployment_id = ? ORDER BY step_number')
      .all(deploymentId) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: r.id as number,
      deploymentId: r.deployment_id as string,
      stepNumber: r.step_number as number,
      weightPercent: r.weight_percent as number,
      state: r.state as string,
      metricsSnapshot: r.metrics_snapshot as string | undefined,
      startedAt: r.started_at as string | undefined,
      completedAt: r.completed_at as string | undefined,
    }));
  }

  // ── Audit Entries ──────────────────────────────────────────────

  saveAuditEntry(record: Omit<AuditEntryRecord, 'id'>): number {
    const stmt = this.db.prepare(`
      INSERT INTO audit_entries (entry_id, actor, action, resource_type, resource_id, detail, hash, previous_hash, signature, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')))
    `);
    const result = stmt.run(
      record.entryId,
      record.actor,
      record.action,
      record.resourceType ?? null,
      record.resourceId ?? null,
      record.detail ?? null,
      record.hash ?? null,
      record.previousHash ?? null,
      record.signature ?? null,
      record.createdAt ?? null,
    );
    return Number(result.lastInsertRowid);
  }

  queryAuditEntries(opts?: {
    actor?: string;
    action?: string;
    resourceType?: string;
    resourceId?: string;
    since?: string;
    until?: string;
    limit?: number;
    offset?: number;
  }): AuditEntryRecord[] {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (opts?.actor) {
      conditions.push('actor = ?');
      params.push(opts.actor);
    }
    if (opts?.action) {
      conditions.push('action = ?');
      params.push(opts.action);
    }
    if (opts?.resourceType) {
      conditions.push('resource_type = ?');
      params.push(opts.resourceType);
    }
    if (opts?.resourceId) {
      conditions.push('resource_id = ?');
      params.push(opts.resourceId);
    }
    if (opts?.since) {
      conditions.push('created_at >= ?');
      params.push(opts.since);
    }
    if (opts?.until) {
      conditions.push('created_at <= ?');
      params.push(opts.until);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = opts?.limit ?? 100;
    const offset = opts?.offset ?? 0;
    params.push(limit, offset);
    const rows = this.db
      .prepare(`SELECT * FROM audit_entries ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
      .all(...params) as Record<string, unknown>[];
    return rows.map((r) => this.mapAuditEntry(r));
  }

  getAuditEntry(entryId: string): AuditEntryRecord | undefined {
    const row = this.db.prepare('SELECT * FROM audit_entries WHERE entry_id = ?').get(entryId) as
      | Record<string, unknown>
      | undefined;
    return row ? this.mapAuditEntry(row) : undefined;
  }

  private mapAuditEntry(row: Record<string, unknown>): AuditEntryRecord {
    return {
      id: row.id as number,
      entryId: row.entry_id as string,
      actor: row.actor as string,
      action: row.action as string,
      resourceType: row.resource_type as string | undefined,
      resourceId: row.resource_id as string | undefined,
      detail: row.detail as string | undefined,
      hash: row.hash as string | undefined,
      previousHash: row.previous_hash as string | undefined,
      signature: row.signature as string | undefined,
      createdAt: row.created_at as string | undefined,
    };
  }

  // ── Priority Calibration ──────────────────────────────────────────

  savePrioritySample(sample: PriorityCalibrationSample): number {
    const stmt = this.db.prepare(`
      INSERT INTO priority_calibration (issue_id, priority_composite, priority_confidence, priority_dimensions, actual_complexity, files_changed, outcome)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      sample.issueId,
      sample.priorityComposite,
      sample.priorityConfidence,
      sample.priorityDimensions ?? null,
      sample.actualComplexity ?? null,
      sample.filesChanged ?? null,
      sample.outcome ?? null,
    );
    return Number(result.lastInsertRowid);
  }

  getPrioritySamples(opts?: { since?: string; limit?: number }): PriorityCalibrationSample[] {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (opts?.since) {
      conditions.push('sampled_at >= ?');
      params.push(opts.since);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = opts?.limit ?? 500;
    params.push(limit);
    const rows = this.db
      .prepare(`SELECT * FROM priority_calibration ${where} ORDER BY sampled_at DESC LIMIT ?`)
      .all(...params) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: r.id as number,
      issueId: r.issue_id as string,
      priorityComposite: r.priority_composite as number,
      priorityConfidence: r.priority_confidence as number,
      priorityDimensions: r.priority_dimensions as string | undefined,
      actualComplexity: r.actual_complexity as number | undefined,
      filesChanged: r.files_changed as number | undefined,
      outcome: r.outcome as string | undefined,
      sampledAt: r.sampled_at as string | undefined,
    }));
  }

  /**
   * Compute a calibration coefficient from historical priority samples.
   * Returns 1.0 when no data is available.
   * When data exists, compares predicted priority ordering with actual outcomes
   * and adjusts the coefficient to correct systematic over/under-scoring.
   */
  computeCalibrationCoefficient(opts?: { since?: string }): number {
    const samples = this.getPrioritySamples({ since: opts?.since });
    if (samples.length === 0) return 1.0;

    // Filter to samples that have both predicted priority and actual outcome
    const scored = samples.filter((s) => s.outcome === 'success' || s.outcome === 'failure');
    if (scored.length === 0) return 1.0;

    // Compute average composite for successes vs failures
    const successes = scored.filter((s) => s.outcome === 'success');
    const failures = scored.filter((s) => s.outcome === 'failure');

    if (successes.length === 0 || failures.length === 0) return 1.0;

    const avgSuccess =
      successes.reduce((sum, s) => sum + s.priorityComposite, 0) / successes.length;
    const avgFailure = failures.reduce((sum, s) => sum + s.priorityComposite, 0) / failures.length;

    // If high-priority items are failing more than low-priority ones,
    // reduce the coefficient to dampen over-scoring; otherwise increase.
    // The ratio is clamped to [0.7, 1.3] per PPA spec.
    if (avgSuccess === 0 && avgFailure === 0) return 1.0;

    const ratio = avgSuccess > 0 ? avgFailure / avgSuccess : 1.0;
    // ratio > 1 means failures had higher scores → over-scoring → reduce
    // ratio < 1 means successes had higher scores → well-calibrated or under → increase slightly
    const coefficient = 1.0 / Math.max(ratio, 0.01);
    return Math.min(1.3, Math.max(0.7, coefficient));
  }

  // ── Utilities ────────────────────────────────────────────────────

  /** Expose the underlying database for direct queries (e.g. dashboard). */
  getDatabase(): BetterSqlite3.Database {
    return this.db;
  }

  // ── Workflow Pattern Detection ─────────────────────────────────────

  saveToolSequenceEvent(event: ToolSequenceEvent): number {
    const stmt = this.db.prepare(`
      INSERT INTO tool_sequence_events (session_id, tool_name, action_canonical, project_path, timestamp)
      VALUES (?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      event.sessionId,
      event.toolName,
      event.actionCanonical,
      event.projectPath ?? null,
      event.timestamp,
    );
    return Number(result.lastInsertRowid);
  }

  saveToolSequenceEvents(events: ToolSequenceEvent[]): number {
    const stmt = this.db.prepare(`
      INSERT INTO tool_sequence_events (session_id, tool_name, action_canonical, project_path, timestamp)
      VALUES (?, ?, ?, ?, ?)
    `);
    const tx = this.db.transaction((items: ToolSequenceEvent[]) => {
      for (const e of items) {
        stmt.run(e.sessionId, e.toolName, e.actionCanonical, e.projectPath ?? null, e.timestamp);
      }
      return items.length;
    });
    return tx(events);
  }

  getToolSequenceEvents(opts?: {
    sessionId?: string;
    since?: string;
    limit?: number;
  }): ToolSequenceEvent[] {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (opts?.sessionId) {
      conditions.push('session_id = ?');
      params.push(opts.sessionId);
    }
    if (opts?.since) {
      conditions.push('timestamp >= ?');
      params.push(opts.since);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = opts?.limit ?? 10000;
    params.push(limit);
    const rows = this.db
      .prepare(`SELECT * FROM tool_sequence_events ${where} ORDER BY timestamp ASC LIMIT ?`)
      .all(...params) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: r.id as number,
      sessionId: r.session_id as string,
      toolName: r.tool_name as string,
      actionCanonical: r.action_canonical as string,
      projectPath: r.project_path as string | undefined,
      timestamp: r.timestamp as string,
      ingestedAt: r.ingested_at as string | undefined,
    }));
  }

  saveWorkflowPattern(pattern: WorkflowPattern): number {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO workflow_patterns
        (pattern_hash, pattern_type, sequence_json, frequency, session_count, confidence, first_seen, last_seen, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      pattern.patternHash,
      pattern.patternType,
      pattern.sequenceJson,
      pattern.frequency,
      pattern.sessionCount,
      pattern.confidence,
      pattern.firstSeen ?? null,
      pattern.lastSeen ?? null,
      pattern.status,
    );
    return Number(result.lastInsertRowid);
  }

  getWorkflowPatterns(opts?: { status?: string }): WorkflowPattern[] {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (opts?.status) {
      conditions.push('status = ?');
      params.push(opts.status);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const rows = this.db
      .prepare(`SELECT * FROM workflow_patterns ${where} ORDER BY confidence DESC`)
      .all(...params) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: r.id as number,
      patternHash: r.pattern_hash as string,
      patternType: r.pattern_type as string,
      sequenceJson: r.sequence_json as string,
      frequency: r.frequency as number,
      sessionCount: r.session_count as number,
      confidence: r.confidence as number,
      firstSeen: r.first_seen as string | undefined,
      lastSeen: r.last_seen as string | undefined,
      status: r.status as string,
      detectedAt: r.detected_at as string | undefined,
    }));
  }

  savePatternProposal(proposal: PatternProposal): number {
    const stmt = this.db.prepare(`
      INSERT INTO pattern_proposals
        (pattern_id, proposal_type, artifact_type, artifact_path, draft_content, confidence, status)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      proposal.patternId,
      proposal.proposalType,
      proposal.artifactType,
      proposal.artifactPath ?? null,
      proposal.draftContent,
      proposal.confidence,
      proposal.status,
    );
    return Number(result.lastInsertRowid);
  }

  getPatternProposals(opts?: { status?: string }): PatternProposal[] {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (opts?.status) {
      conditions.push('status = ?');
      params.push(opts.status);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const rows = this.db
      .prepare(`SELECT * FROM pattern_proposals ${where} ORDER BY confidence DESC`)
      .all(...params) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: r.id as number,
      patternId: r.pattern_id as number,
      proposalType: r.proposal_type as string,
      artifactType: r.artifact_type as string,
      artifactPath: r.artifact_path as string | undefined,
      draftContent: r.draft_content as string,
      confidence: r.confidence as number,
      status: r.status as string,
      reviewedAt: r.reviewed_at as string | undefined,
      reviewerReason: r.reviewer_reason as string | undefined,
      createdAt: r.created_at as string | undefined,
    }));
  }

  updateProposalStatus(id: number, status: string, reason?: string): void {
    this.db
      .prepare(
        `UPDATE pattern_proposals SET status = ?, reviewed_at = datetime('now'), reviewer_reason = ? WHERE id = ?`,
      )
      .run(status, reason ?? null, id);
  }

  // ── Design System Governance (RFC-0006) ───────────────────────────

  insertDesignTokenEvent(record: DesignTokenEventRecord): number {
    const result = this.db
      .prepare(
        `INSERT INTO design_token_events (binding_name, event_type, tokens_affected, diff_json, actor, pipeline_run_id, design_review_decision)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.bindingName,
        record.eventType,
        record.tokensAffected ?? 0,
        record.diffJson ?? null,
        record.actor ?? null,
        record.pipelineRunId ?? null,
        record.designReviewDecision ?? null,
      );
    return result.lastInsertRowid as number;
  }

  getDesignTokenEvents(bindingName: string, limit = 50): DesignTokenEventRecord[] {
    return this.db
      .prepare(
        `SELECT * FROM design_token_events WHERE binding_name = ? ORDER BY created_at DESC LIMIT ?`,
      )
      .all(bindingName, limit) as DesignTokenEventRecord[];
  }

  insertDesignReviewEvent(record: DesignReviewEventRecord): number {
    const result = this.db
      .prepare(
        `INSERT INTO design_review_events (binding_name, pr_number, component_name, reviewer, decision, categories_json, actionable_notes)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.bindingName,
        record.prNumber ?? null,
        record.componentName ?? null,
        record.reviewer,
        record.decision,
        record.categoriesJson ?? null,
        record.actionableNotes ?? null,
      );
    return result.lastInsertRowid as number;
  }

  getDesignReviewEvents(bindingName: string, limit = 50): DesignReviewEventRecord[] {
    return this.db
      .prepare(
        `SELECT * FROM design_review_events WHERE binding_name = ? ORDER BY created_at DESC LIMIT ?`,
      )
      .all(bindingName, limit) as DesignReviewEventRecord[];
  }

  insertTokenComplianceSnapshot(record: TokenComplianceRecord): number {
    const result = this.db
      .prepare(
        `INSERT INTO token_compliance_history (binding_name, coverage_percent, violations_count) VALUES (?, ?, ?)`,
      )
      .run(record.bindingName, record.coveragePercent, record.violationsCount);
    return result.lastInsertRowid as number;
  }

  getTokenComplianceHistory(bindingName: string, limit = 50): TokenComplianceRecord[] {
    return this.db
      .prepare(
        `SELECT * FROM token_compliance_history WHERE binding_name = ? ORDER BY scanned_at DESC LIMIT ?`,
      )
      .all(bindingName, limit) as TokenComplianceRecord[];
  }

  insertVisualRegressionResult(record: VisualRegressionResultRecord): number {
    const result = this.db
      .prepare(
        `INSERT INTO visual_regression_results (binding_name, story_name, viewport, diff_percentage, approved, approver, baseline_url, current_url)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.bindingName,
        record.storyName,
        record.viewport ?? null,
        record.diffPercentage,
        record.approved ? 1 : 0,
        record.approver ?? null,
        record.baselineUrl ?? null,
        record.currentUrl ?? null,
      );
    return result.lastInsertRowid as number;
  }

  getVisualRegressionResults(bindingName: string, limit = 50): VisualRegressionResultRecord[] {
    return this.db
      .prepare(
        `SELECT * FROM visual_regression_results WHERE binding_name = ? ORDER BY created_at DESC LIMIT ?`,
      )
      .all(bindingName, limit) as VisualRegressionResultRecord[];
  }

  insertUsabilitySimulationResult(record: UsabilitySimulationResultRecord): number {
    const result = this.db
      .prepare(
        `INSERT INTO usability_simulation_results (binding_name, story_name, persona_id, task_id, completed, actions_taken, expected_actions, efficiency, findings_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.bindingName,
        record.storyName,
        record.personaId ?? null,
        record.taskId ?? null,
        record.completed ? 1 : 0,
        record.actionsTaken ?? null,
        record.expectedActions ?? null,
        record.efficiency ?? null,
        record.findingsJson ?? null,
      );
    return result.lastInsertRowid as number;
  }

  getUsabilitySimulationResults(
    bindingName: string,
    limit = 50,
  ): UsabilitySimulationResultRecord[] {
    return this.db
      .prepare(
        `SELECT * FROM usability_simulation_results WHERE binding_name = ? ORDER BY created_at DESC LIMIT ?`,
      )
      .all(bindingName, limit) as UsabilitySimulationResultRecord[];
  }

  // ── PPA Triad Integration (RFC-0008) ─────────────────────────────────

  insertDidCompiledArtifact(record: DidCompiledArtifactRecord): number {
    const result = this.db
      .prepare(
        `INSERT INTO did_compiled_artifacts (did_name, namespace, source_hash, scope_lists_json, constraint_rules_json, anti_pattern_lists_json, measurable_signals_json, bm25_corpus_blob, principle_corpora_blob)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.didName,
        record.namespace ?? null,
        record.sourceHash,
        record.scopeListsJson ?? null,
        record.constraintRulesJson ?? null,
        record.antiPatternListsJson ?? null,
        record.measurableSignalsJson ?? null,
        record.bm25CorpusBlob ?? null,
        record.principleCorporaBlob ?? null,
      );
    return Number(result.lastInsertRowid);
  }

  getLatestDidCompiledArtifact(didName: string): DidCompiledArtifactRecord | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM did_compiled_artifacts WHERE did_name = ? ORDER BY compiled_at DESC, id DESC LIMIT 1`,
      )
      .get(didName) as Record<string, unknown> | undefined;
    return row ? this.mapDidCompiledArtifact(row) : undefined;
  }

  getDidCompiledArtifactByHash(
    didName: string,
    sourceHash: string,
  ): DidCompiledArtifactRecord | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM did_compiled_artifacts WHERE did_name = ? AND source_hash = ? ORDER BY compiled_at DESC, id DESC LIMIT 1`,
      )
      .get(didName, sourceHash) as Record<string, unknown> | undefined;
    return row ? this.mapDidCompiledArtifact(row) : undefined;
  }

  private mapDidCompiledArtifact(row: Record<string, unknown>): DidCompiledArtifactRecord {
    return {
      id: row.id as number,
      didName: row.did_name as string,
      namespace: row.namespace as string | undefined,
      sourceHash: row.source_hash as string,
      scopeListsJson: row.scope_lists_json as string | undefined,
      constraintRulesJson: row.constraint_rules_json as string | undefined,
      antiPatternListsJson: row.anti_pattern_lists_json as string | undefined,
      measurableSignalsJson: row.measurable_signals_json as string | undefined,
      bm25CorpusBlob: row.bm25_corpus_blob as Buffer | undefined,
      principleCorporaBlob: row.principle_corpora_blob as Buffer | undefined,
      compiledAt: row.compiled_at as string | undefined,
    };
  }

  recordDidScoringEvent(record: DidScoringEventRecord): number {
    const result = this.db
      .prepare(
        `INSERT INTO did_scoring_events (did_name, issue_number, sa_dimension, phase, layer1_result_json, layer2_result_json, layer3_result_json, composite_score, phase_weights_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.didName,
        record.issueNumber,
        record.saDimension,
        record.phase,
        record.layer1ResultJson ?? null,
        record.layer2ResultJson ?? null,
        record.layer3ResultJson ?? null,
        record.compositeScore ?? null,
        record.phaseWeightsJson ?? null,
      );
    return Number(result.lastInsertRowid);
  }

  getDidScoringEvents(opts?: {
    didName?: string;
    issueNumber?: number;
    saDimension?: SaDimension;
    since?: string;
    limit?: number;
  }): DidScoringEventRecord[] {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (opts?.didName) {
      conditions.push('did_name = ?');
      params.push(opts.didName);
    }
    if (opts?.issueNumber !== undefined) {
      conditions.push('issue_number = ?');
      params.push(opts.issueNumber);
    }
    if (opts?.saDimension) {
      conditions.push('sa_dimension = ?');
      params.push(opts.saDimension);
    }
    if (opts?.since) {
      conditions.push('created_at >= ?');
      params.push(opts.since);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = opts?.limit ?? 100;
    params.push(limit);
    const rows = this.db
      .prepare(
        `SELECT * FROM did_scoring_events ${where} ORDER BY created_at DESC, id DESC LIMIT ?`,
      )
      .all(...params) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: r.id as number,
      didName: r.did_name as string,
      issueNumber: r.issue_number as number,
      saDimension: r.sa_dimension as SaDimension,
      phase: r.phase as SaPhase,
      layer1ResultJson: r.layer1_result_json as string | undefined,
      layer2ResultJson: r.layer2_result_json as string | undefined,
      layer3ResultJson: r.layer3_result_json as string | undefined,
      compositeScore: r.composite_score as number | undefined,
      phaseWeightsJson: r.phase_weights_json as string | undefined,
      createdAt: r.created_at as string | undefined,
    }));
  }

  recordDidFeedback(record: DidFeedbackEventRecord): number {
    const result = this.db
      .prepare(
        `INSERT INTO did_feedback_events (did_name, issue_number, dimension, signal, principal, category, structural_score, llm_score, composite_score, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.didName,
        record.issueNumber,
        record.dimension,
        record.signal,
        record.principal ?? null,
        record.category ?? null,
        record.structuralScore ?? null,
        record.llmScore ?? null,
        record.compositeScore ?? null,
        record.notes ?? null,
      );
    return Number(result.lastInsertRowid);
  }

  getDidFeedbackEvents(opts?: {
    didName?: string;
    issueNumber?: number;
    signal?: FeedbackSignal;
    dimension?: SaDimension;
    since?: string;
    limit?: number;
  }): DidFeedbackEventRecord[] {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (opts?.didName) {
      conditions.push('did_name = ?');
      params.push(opts.didName);
    }
    if (opts?.issueNumber !== undefined) {
      conditions.push('issue_number = ?');
      params.push(opts.issueNumber);
    }
    if (opts?.signal) {
      conditions.push('signal = ?');
      params.push(opts.signal);
    }
    if (opts?.dimension) {
      conditions.push('dimension = ?');
      params.push(opts.dimension);
    }
    if (opts?.since) {
      conditions.push('created_at >= ?');
      params.push(opts.since);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = opts?.limit ?? 500;
    params.push(limit);
    const rows = this.db
      .prepare(
        `SELECT * FROM did_feedback_events ${where} ORDER BY created_at DESC, id DESC LIMIT ?`,
      )
      .all(...params) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: r.id as number,
      didName: r.did_name as string,
      issueNumber: r.issue_number as number,
      dimension: r.dimension as SaDimension,
      signal: r.signal as FeedbackSignal,
      principal: r.principal as string | undefined,
      category: r.category as string | undefined,
      structuralScore: r.structural_score as number | undefined,
      llmScore: r.llm_score as number | undefined,
      compositeScore: r.composite_score as number | undefined,
      notes: r.notes as string | undefined,
      createdAt: r.created_at as string | undefined,
    }));
  }

  recordDesignChange(record: DesignChangeEventRecord): number {
    const result = this.db
      .prepare(
        `INSERT INTO design_change_events (did_name, change_id, change_type, status, payload_json)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(record.didName, record.changeId, record.changeType, record.status, record.payloadJson);
    return Number(result.lastInsertRowid);
  }

  getDesignChangeEvents(opts?: {
    didName?: string;
    changeId?: string;
    limit?: number;
  }): DesignChangeEventRecord[] {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (opts?.didName) {
      conditions.push('did_name = ?');
      params.push(opts.didName);
    }
    if (opts?.changeId) {
      conditions.push('change_id = ?');
      params.push(opts.changeId);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = opts?.limit ?? 100;
    params.push(limit);
    const rows = this.db
      .prepare(
        `SELECT * FROM design_change_events ${where} ORDER BY emitted_at DESC, id DESC LIMIT ?`,
      )
      .all(...params) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: r.id as number,
      didName: r.did_name as string,
      changeId: r.change_id as string,
      changeType: r.change_type as string,
      status: r.status as string,
      payloadJson: r.payload_json as string,
      emittedAt: r.emitted_at as string | undefined,
    }));
  }

  insertCodeAreaMetrics(record: CodeAreaMetricsRecord): number {
    const result = this.db
      .prepare(
        `INSERT INTO code_area_metrics (code_area, defect_density, churn_rate, pr_rejection_rate, code_acceptance_rate, has_frontend_components, design_metrics_json, data_point_count, window_start, window_end)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.codeArea,
        record.defectDensity ?? null,
        record.churnRate ?? null,
        record.prRejectionRate ?? null,
        record.codeAcceptanceRate ?? null,
        record.hasFrontendComponents ? 1 : 0,
        record.designMetricsJson ?? null,
        record.dataPointCount ?? 0,
        record.windowStart ?? null,
        record.windowEnd ?? null,
      );
    return Number(result.lastInsertRowid);
  }

  /**
   * Get the most recent metrics snapshot for a code area.
   * `since` filters to rows where `computed_at >= since`.
   */
  getCodeAreaMetrics(
    codeArea: string,
    opts?: { since?: string },
  ): CodeAreaMetricsRecord | undefined {
    const conditions: string[] = ['code_area = ?'];
    const params: unknown[] = [codeArea];
    if (opts?.since) {
      conditions.push('computed_at >= ?');
      params.push(opts.since);
    }
    const row = this.db
      .prepare(
        `SELECT * FROM code_area_metrics WHERE ${conditions.join(' AND ')} ORDER BY computed_at DESC, id DESC LIMIT 1`,
      )
      .get(...params) as Record<string, unknown> | undefined;
    return row ? this.mapCodeAreaMetrics(row) : undefined;
  }

  getCodeAreaMetricsHistory(
    codeArea: string,
    opts?: { since?: string; limit?: number },
  ): CodeAreaMetricsRecord[] {
    const conditions: string[] = ['code_area = ?'];
    const params: unknown[] = [codeArea];
    if (opts?.since) {
      conditions.push('computed_at >= ?');
      params.push(opts.since);
    }
    const limit = opts?.limit ?? 100;
    params.push(limit);
    const rows = this.db
      .prepare(
        `SELECT * FROM code_area_metrics WHERE ${conditions.join(' AND ')} ORDER BY computed_at DESC, id DESC LIMIT ?`,
      )
      .all(...params) as Record<string, unknown>[];
    return rows.map((r) => this.mapCodeAreaMetrics(r));
  }

  private mapCodeAreaMetrics(row: Record<string, unknown>): CodeAreaMetricsRecord {
    return {
      id: row.id as number,
      codeArea: row.code_area as string,
      defectDensity: row.defect_density as number | undefined,
      churnRate: row.churn_rate as number | undefined,
      prRejectionRate: row.pr_rejection_rate as number | undefined,
      codeAcceptanceRate: row.code_acceptance_rate as number | undefined,
      hasFrontendComponents: Boolean(row.has_frontend_components),
      designMetricsJson: row.design_metrics_json as string | undefined,
      dataPointCount: row.data_point_count as number | undefined,
      windowStart: row.window_start as string | undefined,
      windowEnd: row.window_end as string | undefined,
      computedAt: row.computed_at as string | undefined,
    };
  }

  upsertDesignLookaheadNotification(record: DesignLookaheadNotificationRecord): number {
    const result = this.db
      .prepare(
        `INSERT INTO design_lookahead_notifications (issue_number, pillar_breakdown_json)
         VALUES (?, ?)
         ON CONFLICT(issue_number) DO UPDATE SET
           last_notified_at = datetime('now'),
           pillar_breakdown_json = COALESCE(excluded.pillar_breakdown_json, pillar_breakdown_json)`,
      )
      .run(record.issueNumber, record.pillarBreakdownJson ?? null);
    return Number(result.lastInsertRowid);
  }

  getDesignLookaheadNotification(
    issueNumber: number,
  ): DesignLookaheadNotificationRecord | undefined {
    const row = this.db
      .prepare(`SELECT * FROM design_lookahead_notifications WHERE issue_number = ?`)
      .get(issueNumber) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return {
      id: row.id as number,
      issueNumber: row.issue_number as number,
      firstNotifiedAt: row.first_notified_at as string | undefined,
      lastNotifiedAt: row.last_notified_at as string | undefined,
      pillarBreakdownJson: row.pillar_breakdown_json as string | undefined,
    };
  }

  // ── SA Phase Weights (RFC-0008 §B.8 AISDLC-66) ──────────────────────

  upsertSaPhaseWeights(record: SaPhaseWeightsRecord): void {
    this.db
      .prepare(
        `INSERT INTO sa_phase_weights (dimension, w_structural, w_llm, calibrated_at)
         VALUES (?, ?, ?, datetime('now'))
         ON CONFLICT(dimension) DO UPDATE SET
           w_structural = excluded.w_structural,
           w_llm = excluded.w_llm,
           calibrated_at = excluded.calibrated_at`,
      )
      .run(record.dimension, record.wStructural, record.wLlm);
  }

  getSaPhaseWeights(dimension: SaDimension): SaPhaseWeightsRecord | undefined {
    const row = this.db
      .prepare(`SELECT * FROM sa_phase_weights WHERE dimension = ?`)
      .get(dimension) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return {
      id: row.id as number,
      dimension: row.dimension as SaDimension,
      wStructural: row.w_structural as number,
      wLlm: row.w_llm as number,
      calibratedAt: row.calibrated_at as string | undefined,
    };
  }

  close(): void {
    this.db.close();
  }
}
