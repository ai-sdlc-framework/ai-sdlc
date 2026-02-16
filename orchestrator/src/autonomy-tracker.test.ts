import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { StateStore } from './state/store.js';
import { AutonomyTracker } from './autonomy-tracker.js';

describe('AutonomyTracker', () => {
  let store: StateStore;
  let tracker: AutonomyTracker;

  beforeEach(() => {
    const db = new Database(':memory:');
    store = StateStore.open(db);
    tracker = new AutonomyTracker(store);
  });

  describe('recordTaskOutcome', () => {
    it('creates a new ledger entry for unknown agent', () => {
      tracker.recordTaskOutcome('new-agent', true);
      const ledger = store.getAutonomyLedger('new-agent');
      expect(ledger).toBeDefined();
      expect(ledger!.totalTasks).toBe(1);
      expect(ledger!.successCount).toBe(1);
      expect(ledger!.failureCount).toBe(0);
    });

    it('increments counters on success', () => {
      tracker.recordTaskOutcome('agent-a', true);
      tracker.recordTaskOutcome('agent-a', true);
      tracker.recordTaskOutcome('agent-a', false);

      const ledger = store.getAutonomyLedger('agent-a');
      expect(ledger!.totalTasks).toBe(3);
      expect(ledger!.successCount).toBe(2);
      expect(ledger!.failureCount).toBe(1);
    });

    it('tracks rollbacks', () => {
      tracker.recordTaskOutcome('agent-a', false, { rollback: true });
      const ledger = store.getAutonomyLedger('agent-a');
      expect(ledger!.rollbackCount).toBe(1);
    });

    it('tracks security incidents', () => {
      tracker.recordTaskOutcome('agent-a', false, { securityIncident: true });
      const ledger = store.getAutonomyLedger('agent-a');
      expect(ledger!.securityIncidents).toBe(1);
    });
  });

  describe('getAgentMetrics', () => {
    it('returns zero metrics for unknown agent', () => {
      const metrics = tracker.getAgentMetrics('nonexistent');
      expect(metrics.totalTasks).toBe(0);
      expect(metrics.successRate).toBe(0);
    });

    it('computes real success rate', () => {
      tracker.recordTaskOutcome('agent-a', true);
      tracker.recordTaskOutcome('agent-a', true);
      tracker.recordTaskOutcome('agent-a', false);

      const metrics = tracker.getAgentMetrics('agent-a');
      expect(metrics.totalTasks).toBe(3);
      expect(metrics.successRate).toBeCloseTo(2 / 3, 2);
    });

    it('includes rollback and security counts', () => {
      tracker.recordTaskOutcome('agent-a', false, { rollback: true, securityIncident: true });
      const metrics = tracker.getAgentMetrics('agent-a');
      expect(metrics.rollbackCount).toBe(1);
      expect(metrics.securityIncidents).toBe(1);
    });
  });

  describe('evaluateAndPersistPromotion', () => {
    it('denies promotion with insufficient tasks', () => {
      tracker.recordTaskOutcome('agent-a', true);
      const result = tracker.evaluateAndPersistPromotion('agent-a');
      expect(result.eligible).toBe(false);
      expect(result.unmetConditions.length).toBeGreaterThan(0);
    });

    it('denies promotion at max level', () => {
      // Manually set level to 4
      store.upsertAutonomyLedger({
        agentName: 'agent-a',
        currentLevel: 4,
        totalTasks: 100,
        successCount: 95,
        failureCount: 5,
      });
      const result = tracker.evaluateAndPersistPromotion('agent-a');
      expect(result.eligible).toBe(false);
      expect(result.unmetConditions).toContain('Already at maximum level');
    });

    it('denies promotion with security incidents', () => {
      // Set up enough tasks but with security incident
      store.upsertAutonomyLedger({
        agentName: 'agent-a',
        currentLevel: 0,
        totalTasks: 10,
        successCount: 10,
        failureCount: 0,
        securityIncidents: 1,
        timeAtLevelMs: 8 * 24 * 60 * 60 * 1000,
      });
      const result = tracker.evaluateAndPersistPromotion('agent-a');
      expect(result.eligible).toBe(false);
      expect(result.unmetConditions.some((c) => c.includes('security'))).toBe(true);
    });

    it('promotes when all conditions met', () => {
      store.upsertAutonomyLedger({
        agentName: 'agent-a',
        currentLevel: 0,
        totalTasks: 5,
        successCount: 5,
        failureCount: 0,
        securityIncidents: 0,
        timeAtLevelMs: 8 * 24 * 60 * 60 * 1000,
      });
      const result = tracker.evaluateAndPersistPromotion('agent-a');
      expect(result.eligible).toBe(true);
      expect(result.fromLevel).toBe(0);
      expect(result.toLevel).toBe(1);

      // Verify persisted
      const ledger = store.getAutonomyLedger('agent-a');
      expect(ledger!.currentLevel).toBe(1);
      expect(ledger!.promotedAt).toBeTruthy();

      // Verify event recorded
      const events = store.getAutonomyEvents('agent-a');
      expect(events).toHaveLength(1);
      expect(events[0].eventType).toBe('promotion');
    });
  });

  describe('evaluateAndPersistDemotion', () => {
    it('does not demote at level 0', () => {
      store.upsertAutonomyLedger({
        agentName: 'agent-a',
        currentLevel: 0,
        totalTasks: 5,
        successCount: 1,
        failureCount: 4,
      });
      const result = tracker.evaluateAndPersistDemotion('agent-a');
      expect(result.shouldDemote).toBe(false);
    });

    it('demotes on security incident', () => {
      store.upsertAutonomyLedger({
        agentName: 'agent-a',
        currentLevel: 2,
        totalTasks: 20,
        successCount: 18,
        failureCount: 2,
        securityIncidents: 1,
      });
      const result = tracker.evaluateAndPersistDemotion('agent-a');
      expect(result.shouldDemote).toBe(true);
      expect(result.toLevel).toBe(1);
      expect(result.reasons.some((r) => r.includes('security'))).toBe(true);

      // Verify persisted
      const ledger = store.getAutonomyLedger('agent-a');
      expect(ledger!.currentLevel).toBe(1);

      const events = store.getAutonomyEvents('agent-a');
      expect(events[0].eventType).toBe('demotion');
    });

    it('demotes on low success rate', () => {
      store.upsertAutonomyLedger({
        agentName: 'agent-a',
        currentLevel: 1,
        totalTasks: 10,
        successCount: 4,
        failureCount: 6,
      });
      const result = tracker.evaluateAndPersistDemotion('agent-a');
      expect(result.shouldDemote).toBe(true);
      expect(result.reasons.some((r) => r.includes('Success rate'))).toBe(true);
    });

    it('demotes on multiple rollbacks', () => {
      store.upsertAutonomyLedger({
        agentName: 'agent-a',
        currentLevel: 2,
        totalTasks: 20,
        successCount: 18,
        failureCount: 2,
        rollbackCount: 3,
      });
      const result = tracker.evaluateAndPersistDemotion('agent-a');
      expect(result.shouldDemote).toBe(true);
      expect(result.reasons.some((r) => r.includes('rollback'))).toBe(true);
    });
  });

  describe('getPromotionProximity', () => {
    it('returns progress for each condition', () => {
      store.upsertAutonomyLedger({
        agentName: 'agent-a',
        currentLevel: 0,
        totalTasks: 2,
        successCount: 2,
        failureCount: 0,
        timeAtLevelMs: 3 * 24 * 60 * 60 * 1000,
      });

      const proximity = tracker.getPromotionProximity('agent-a');
      expect(proximity.currentLevel).toBe(0);
      expect(proximity.nextLevel).toBe(1);
      expect(proximity.conditionProgress).toHaveLength(4);

      const tasksCondition = proximity.conditionProgress.find((c) => c.condition === 'Tasks completed');
      expect(tasksCondition).toBeDefined();
      expect(tasksCondition!.current).toBe(2);
      expect(tasksCondition!.required).toBe(3);
      expect(tasksCondition!.met).toBe(false);
    });

    it('returns all conditions met when ready', () => {
      store.upsertAutonomyLedger({
        agentName: 'agent-a',
        currentLevel: 0,
        totalTasks: 5,
        successCount: 5,
        failureCount: 0,
        timeAtLevelMs: 8 * 24 * 60 * 60 * 1000,
      });

      const proximity = tracker.getPromotionProximity('agent-a');
      expect(proximity.conditionProgress.every((c) => c.met)).toBe(true);
    });
  });
});
