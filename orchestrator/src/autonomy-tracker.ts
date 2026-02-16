/**
 * AutonomyTracker — computes real agent metrics from pipeline run history,
 * evaluates promotion/demotion eligibility, and persists state changes.
 *
 * Replaces the hardcoded `totalTasksCompleted: 1` in execute.ts.
 * RFC reference: Lines 264-280 (autonomy metrics).
 */

import type { StateStore } from './state/store.js';
import type { AutonomyLedgerEntry, AutonomyEvent } from './state/types.js';

export interface AgentPerformanceMetrics {
  totalTasks: number;
  successCount: number;
  failureCount: number;
  successRate: number;
  prApprovalRate: number;
  rollbackCount: number;
  securityIncidents: number;
  avgDurationMs: number;
  avgCostUsd: number;
  recentFailures: number;
  timeAtLevelMs: number;
}

export interface PromotionEvaluation {
  eligible: boolean;
  fromLevel: number;
  toLevel: number;
  unmetConditions: string[];
  metrics: AgentPerformanceMetrics;
}

export interface DemotionEvaluation {
  shouldDemote: boolean;
  fromLevel: number;
  toLevel: number;
  reasons: string[];
  metrics: AgentPerformanceMetrics;
}

export interface PromotionProximity {
  currentLevel: number;
  nextLevel: number;
  conditionProgress: Array<{
    condition: string;
    current: number;
    required: number;
    met: boolean;
  }>;
}

/** Minimum tasks required per level for promotion. */
const PROMOTION_TASK_THRESHOLDS: Record<number, number> = {
  0: 3,
  1: 10,
  2: 25,
  3: 50,
};

/** Minimum success rate required per level for promotion. */
const PROMOTION_SUCCESS_RATE: Record<number, number> = {
  0: 0.8,
  1: 0.85,
  2: 0.9,
  3: 0.95,
};

/** Minimum time at level (ms) before promotion. */
const MIN_TIME_AT_LEVEL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export class AutonomyTracker {
  constructor(private store: StateStore) {}

  /**
   * Record a task outcome and update the autonomy ledger.
   */
  recordTaskOutcome(
    agentName: string,
    success: boolean,
    opts?: { durationMs?: number; costUsd?: number; prApproved?: boolean; rollback?: boolean; securityIncident?: boolean },
  ): void {
    const existing = this.store.getAutonomyLedger(agentName);
    const now = new Date().toISOString();

    const entry: AutonomyLedgerEntry = {
      agentName,
      currentLevel: existing?.currentLevel ?? 0,
      totalTasks: (existing?.totalTasks ?? 0) + 1,
      successCount: (existing?.successCount ?? 0) + (success ? 1 : 0),
      failureCount: (existing?.failureCount ?? 0) + (success ? 0 : 1),
      lastTaskAt: now,
      metrics: existing?.metrics,
      prApprovalRate: existing?.prApprovalRate ?? 0,
      rollbackCount: (existing?.rollbackCount ?? 0) + (opts?.rollback ? 1 : 0),
      securityIncidents: (existing?.securityIncidents ?? 0) + (opts?.securityIncident ? 1 : 0),
      promotedAt: existing?.promotedAt,
      demotedAt: existing?.demotedAt,
      timeAtLevelMs: existing?.timeAtLevelMs ?? 0,
    };

    // Update PR approval rate (running average)
    if (opts?.prApproved !== undefined) {
      const totalPRs = entry.totalTasks;
      const prevApproved = Math.round((existing?.prApprovalRate ?? 0) * ((existing?.totalTasks ?? 0)));
      const newApproved = prevApproved + (opts.prApproved ? 1 : 0);
      entry.prApprovalRate = totalPRs > 0 ? newApproved / totalPRs : 0;
    }

    // Update time at level
    if (existing?.lastTaskAt) {
      const elapsed = new Date(now).getTime() - new Date(existing.lastTaskAt).getTime();
      entry.timeAtLevelMs = (existing.timeAtLevelMs ?? 0) + elapsed;
    }

    this.store.upsertAutonomyLedger(entry);
  }

  /**
   * Get computed performance metrics for an agent.
   */
  getAgentMetrics(agentName: string): AgentPerformanceMetrics {
    const ledger = this.store.getAutonomyLedger(agentName);
    if (!ledger) {
      return {
        totalTasks: 0,
        successCount: 0,
        failureCount: 0,
        successRate: 0,
        prApprovalRate: 0,
        rollbackCount: 0,
        securityIncidents: 0,
        avgDurationMs: 0,
        avgCostUsd: 0,
        recentFailures: 0,
        timeAtLevelMs: 0,
      };
    }

    // Get recent pipeline runs for duration/cost stats
    const runs = this.store.getPipelineRuns(undefined, 100)
      .filter((r) => r.agentName === agentName);

    const durations = runs
      .filter((r) => r.startedAt && r.completedAt)
      .map((r) => new Date(r.completedAt!).getTime() - new Date(r.startedAt!).getTime());

    const costs = runs
      .filter((r) => r.costUsd != null && r.costUsd > 0)
      .map((r) => r.costUsd!);

    // Count recent failures (last 7 days)
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const recentFailures = runs
      .filter((r) => r.status === 'failed' && r.startedAt && r.startedAt >= sevenDaysAgo)
      .length;

    return {
      totalTasks: ledger.totalTasks,
      successCount: ledger.successCount,
      failureCount: ledger.failureCount,
      successRate: ledger.totalTasks > 0 ? ledger.successCount / ledger.totalTasks : 0,
      prApprovalRate: ledger.prApprovalRate ?? 0,
      rollbackCount: ledger.rollbackCount ?? 0,
      securityIncidents: ledger.securityIncidents ?? 0,
      avgDurationMs: durations.length > 0 ? durations.reduce((a, b) => a + b, 0) / durations.length : 0,
      avgCostUsd: costs.length > 0 ? costs.reduce((a, b) => a + b, 0) / costs.length : 0,
      recentFailures,
      timeAtLevelMs: ledger.timeAtLevelMs ?? 0,
    };
  }

  /**
   * Evaluate promotion eligibility and persist if promoted.
   */
  evaluateAndPersistPromotion(agentName: string): PromotionEvaluation {
    const metrics = this.getAgentMetrics(agentName);
    const ledger = this.store.getAutonomyLedger(agentName);
    const currentLevel = ledger?.currentLevel ?? 0;
    const nextLevel = currentLevel + 1;

    if (nextLevel > 4) {
      return {
        eligible: false,
        fromLevel: currentLevel,
        toLevel: currentLevel,
        unmetConditions: ['Already at maximum level'],
        metrics,
      };
    }

    const unmetConditions: string[] = [];

    // Check task threshold
    const taskThreshold = PROMOTION_TASK_THRESHOLDS[currentLevel] ?? 50;
    if (metrics.totalTasks < taskThreshold) {
      unmetConditions.push(`Need ${taskThreshold} tasks, have ${metrics.totalTasks}`);
    }

    // Check success rate
    const rateThreshold = PROMOTION_SUCCESS_RATE[currentLevel] ?? 0.9;
    if (metrics.successRate < rateThreshold) {
      unmetConditions.push(`Need ${Math.round(rateThreshold * 100)}% success rate, have ${Math.round(metrics.successRate * 100)}%`);
    }

    // Check no recent security incidents
    if (metrics.securityIncidents > 0) {
      unmetConditions.push(`${metrics.securityIncidents} security incidents must be resolved`);
    }

    // Check time at level
    if (metrics.timeAtLevelMs < MIN_TIME_AT_LEVEL_MS) {
      const daysNeeded = Math.ceil(MIN_TIME_AT_LEVEL_MS / (24 * 60 * 60 * 1000));
      const daysAt = Math.floor(metrics.timeAtLevelMs / (24 * 60 * 60 * 1000));
      unmetConditions.push(`Need ${daysNeeded}d at level, have ${daysAt}d`);
    }

    const eligible = unmetConditions.length === 0;

    if (eligible && ledger) {
      // Persist promotion
      const now = new Date().toISOString();
      this.store.upsertAutonomyLedger({
        ...ledger,
        currentLevel: nextLevel,
        promotedAt: now,
        timeAtLevelMs: 0, // Reset time at level
      });

      // Record autonomy event
      this.store.saveAutonomyEvent({
        agentName,
        eventType: 'promotion',
        fromLevel: currentLevel,
        toLevel: nextLevel,
        trigger: 'auto-promotion',
        metricsSnapshot: JSON.stringify(metrics),
      });
    }

    return {
      eligible,
      fromLevel: currentLevel,
      toLevel: eligible ? nextLevel : currentLevel,
      unmetConditions,
      metrics,
    };
  }

  /**
   * Evaluate demotion triggers and persist if demoted.
   */
  evaluateAndPersistDemotion(agentName: string): DemotionEvaluation {
    const metrics = this.getAgentMetrics(agentName);
    const ledger = this.store.getAutonomyLedger(agentName);
    const currentLevel = ledger?.currentLevel ?? 0;

    if (currentLevel === 0) {
      return {
        shouldDemote: false,
        fromLevel: 0,
        toLevel: 0,
        reasons: [],
        metrics,
      };
    }

    const reasons: string[] = [];

    // Demotion trigger: high recent failure rate
    if (metrics.recentFailures >= 3) {
      reasons.push(`${metrics.recentFailures} recent failures in 7 days`);
    }

    // Demotion trigger: security incident
    if (metrics.securityIncidents > 0) {
      reasons.push(`${metrics.securityIncidents} security incident(s)`);
    }

    // Demotion trigger: rollbacks
    if (metrics.rollbackCount >= 2) {
      reasons.push(`${metrics.rollbackCount} rollbacks`);
    }

    // Demotion trigger: success rate dropped below threshold
    if (metrics.totalTasks >= 5 && metrics.successRate < 0.6) {
      reasons.push(`Success rate dropped to ${Math.round(metrics.successRate * 100)}%`);
    }

    const shouldDemote = reasons.length > 0;
    const toLevel = shouldDemote ? Math.max(0, currentLevel - 1) : currentLevel;

    if (shouldDemote && ledger) {
      const now = new Date().toISOString();
      this.store.upsertAutonomyLedger({
        ...ledger,
        currentLevel: toLevel,
        demotedAt: now,
        timeAtLevelMs: 0,
      });

      this.store.saveAutonomyEvent({
        agentName,
        eventType: 'demotion',
        fromLevel: currentLevel,
        toLevel,
        trigger: reasons.join('; '),
        metricsSnapshot: JSON.stringify(metrics),
      });
    }

    return {
      shouldDemote,
      fromLevel: currentLevel,
      toLevel,
      reasons,
      metrics,
    };
  }

  /**
   * Get proximity to next promotion (for dashboard/reporting).
   */
  getPromotionProximity(agentName: string): PromotionProximity {
    const metrics = this.getAgentMetrics(agentName);
    const ledger = this.store.getAutonomyLedger(agentName);
    const currentLevel = ledger?.currentLevel ?? 0;
    const nextLevel = Math.min(currentLevel + 1, 4);

    const taskThreshold = PROMOTION_TASK_THRESHOLDS[currentLevel] ?? 50;
    const rateThreshold = PROMOTION_SUCCESS_RATE[currentLevel] ?? 0.9;

    return {
      currentLevel,
      nextLevel,
      conditionProgress: [
        {
          condition: 'Tasks completed',
          current: metrics.totalTasks,
          required: taskThreshold,
          met: metrics.totalTasks >= taskThreshold,
        },
        {
          condition: 'Success rate',
          current: Math.round(metrics.successRate * 100),
          required: Math.round(rateThreshold * 100),
          met: metrics.successRate >= rateThreshold,
        },
        {
          condition: 'No security incidents',
          current: metrics.securityIncidents,
          required: 0,
          met: metrics.securityIncidents === 0,
        },
        {
          condition: 'Time at level (days)',
          current: Math.floor(metrics.timeAtLevelMs / (24 * 60 * 60 * 1000)),
          required: Math.ceil(MIN_TIME_AT_LEVEL_MS / (24 * 60 * 60 * 1000)),
          met: metrics.timeAtLevelMs >= MIN_TIME_AT_LEVEL_MS,
        },
      ],
    };
  }
}
