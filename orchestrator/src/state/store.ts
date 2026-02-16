/**
 * SQLite-backed state store for the AI-SDLC orchestrator.
 *
 * Uses better-sqlite3 for synchronous operations. The state store is
 * optional — the orchestrator works without it.
 */

import type BetterSqlite3 from 'better-sqlite3';
import { CURRENT_SCHEMA_VERSION, MIGRATIONS } from './schema.js';
import type {
  ComplexityProfile,
  EpisodicRecord,
  AutonomyLedgerEntry,
  PipelineRun,
  PipelineRunStatus,
  Convention,
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
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const SqliteConstructor = require('better-sqlite3') as typeof BetterSqlite3;
      const db = new SqliteConstructor(pathOrDb);
      db.pragma('journal_mode = WAL');
      return new StateStore(db);
    }
    return new StateStore(pathOrDb);
  }

  private migrate(): void {
    // Check current schema version
    try {
      const row = this.db
        .prepare('SELECT MAX(version) as v FROM schema_version')
        .get() as { v: number | null } | undefined;
      const current = row?.v ?? 0;
      if (current >= CURRENT_SCHEMA_VERSION) return;

      for (const migration of MIGRATIONS) {
        if (migration.version > (current ?? 0)) {
          this.db.exec(migration.sql);
          this.db
            .prepare('INSERT INTO schema_version (version) VALUES (?)')
            .run(migration.version);
        }
      }
    } catch {
      // Table doesn't exist yet — run all migrations
      for (const migration of MIGRATIONS) {
        this.db.exec(migration.sql);
        this.db
          .prepare('INSERT INTO schema_version (version) VALUES (?)')
          .run(migration.version);
      }
    }
  }

  // ── Complexity Profiles ──────────────────────────────────────────

  saveComplexityProfile(profile: ComplexityProfile): number {
    const stmt = this.db.prepare(`
      INSERT INTO complexity_profile (repo_path, score, files_count, modules_count, dependency_count, raw_data)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      profile.repoPath,
      profile.score,
      profile.filesCount ?? null,
      profile.modulesCount ?? null,
      profile.dependencyCount ?? null,
      profile.rawData ?? null,
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
    };
  }

  // ── Episodic Memory ──────────────────────────────────────────────

  saveEpisodicRecord(record: EpisodicRecord): number {
    const stmt = this.db.prepare(`
      INSERT INTO episodic_memory (issue_number, pr_number, pipeline_type, outcome, duration_ms, files_changed, error_message, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      record.issueNumber ?? null,
      record.prNumber ?? null,
      record.pipelineType,
      record.outcome,
      record.durationMs ?? null,
      record.filesChanged ?? null,
      record.errorMessage ?? null,
      record.metadata ?? null,
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
      issueNumber: row.issue_number as number | undefined,
      prNumber: row.pr_number as number | undefined,
      pipelineType: row.pipeline_type as string,
      outcome: row.outcome as string,
      durationMs: row.duration_ms as number | undefined,
      filesChanged: row.files_changed as number | undefined,
      errorMessage: row.error_message as string | undefined,
      metadata: row.metadata as string | undefined,
      createdAt: row.created_at as string | undefined,
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
        `INSERT INTO autonomy_ledger (agent_name, current_level, total_tasks, success_count, failure_count, last_task_at, metrics)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(agent_name) DO UPDATE SET
           current_level = excluded.current_level,
           total_tasks = excluded.total_tasks,
           success_count = excluded.success_count,
           failure_count = excluded.failure_count,
           last_task_at = excluded.last_task_at,
           metrics = excluded.metrics`,
      )
      .run(
        entry.agentName,
        entry.currentLevel,
        entry.totalTasks,
        entry.successCount,
        entry.failureCount,
        entry.lastTaskAt ?? null,
        entry.metrics ?? null,
      );
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
    };
  }

  // ── Pipeline Runs ────────────────────────────────────────────────

  savePipelineRun(run: PipelineRun): number {
    const stmt = this.db.prepare(`
      INSERT INTO pipeline_runs (run_id, issue_number, pr_number, pipeline_type, status, current_stage, result, gate_results)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      run.runId,
      run.issueNumber ?? null,
      run.prNumber ?? null,
      run.pipelineType,
      run.status,
      run.currentStage ?? null,
      run.result ?? null,
      run.gateResults ?? null,
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
    this.db.prepare(sql).run(
      status,
      opts?.currentStage ?? null,
      opts?.result ?? null,
      opts?.gateResults ?? null,
      runId,
    );
  }

  getPipelineRun(runId: string): PipelineRun | undefined {
    const row = this.db
      .prepare('SELECT * FROM pipeline_runs WHERE run_id = ?')
      .get(runId) as Record<string, unknown> | undefined;
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
      issueNumber: row.issue_number as number | undefined,
      prNumber: row.pr_number as number | undefined,
      pipelineType: row.pipeline_type as string,
      status: row.status as PipelineRunStatus,
      currentStage: row.current_stage as string | undefined,
      startedAt: row.started_at as string | undefined,
      completedAt: row.completed_at as string | undefined,
      result: row.result as string | undefined,
      gateResults: row.gate_results as string | undefined,
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

  // ── Utilities ────────────────────────────────────────────────────

  close(): void {
    this.db.close();
  }
}
