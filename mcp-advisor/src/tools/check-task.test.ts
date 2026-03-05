import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { StateStore } from '@ai-sdlc/orchestrator/state';
import { CostTracker } from '@ai-sdlc/orchestrator';
import { SessionManager } from '../session.js';
import { handleCheckTask } from './check-task.js';
import type { ServerDeps } from '../types.js';

describe('handleCheckTask', () => {
  let deps: ServerDeps;

  beforeEach(() => {
    const db = new Database(':memory:');
    const store = StateStore.open(db);
    deps = {
      store,
      costTracker: new CostTracker(store),
      sessions: new SessionManager(),
      repoPath: '/test/repo',
    };
  });

  it('returns advisory when no issue is linked', () => {
    const result = handleCheckTask(deps, {});
    expect(result.issueNumber).toBeNull();
    expect(result.advisoryNotes).toContain(
      'No issue linked to this session — work will be unattributed.',
    );
  });

  it('uses explicit issue number', () => {
    const result = handleCheckTask(deps, { issueNumber: 42 });
    expect(result.issueNumber).toBe(42);
  });

  it('reports pipeline run status', () => {
    deps.store.savePipelineRun({
      runId: 'run-1',
      issueNumber: 10,
      pipelineType: 'execute',
      status: 'failed',
      result: 'lint errors',
    });

    const result = handleCheckTask(deps, { issueNumber: 10 });
    expect(result.pipelineRuns).toBe(1);
    expect(result.advisoryNotes.some((n) => n.includes('failed'))).toBe(true);
  });

  it('reads autonomy level from ledger', () => {
    deps.store.upsertAutonomyLedger({
      agentName: 'interactive',
      currentLevel: 1,
      totalTasks: 5,
      successCount: 3,
      failureCount: 2,
    });

    const result = handleCheckTask(deps, {});
    expect(result.autonomyLevel).toBe(1);
    expect(result.advisoryNotes.some((n) => n.includes('Low autonomy'))).toBe(true);
  });

  it('uses session linked issue when available', () => {
    const session = deps.sessions.create({ developer: 'a', tool: 'claude-code' });
    deps.sessions.linkIssue(session.sessionId, 55, 'branch');
    const result = handleCheckTask(deps, { sessionId: session.sessionId });
    expect(result.issueNumber).toBe(55);
  });

  it('populates constraints from autonomy policy config', () => {
    deps.config = {
      autonomyPolicy: {
        apiVersion: 'ai-sdlc.io/v1alpha1',
        kind: 'AutonomyPolicy' as const,
        metadata: { name: 'test' },
        spec: {
          levels: [
            {
              level: 0,
              name: 'supervised',
              permissions: { read: ['**'], write: [] },
              guardrails: {
                requireApproval: true,
                blockedPaths: ['.github/**', 'infra/**'],
                maxLinesPerPR: 500,
              },
            },
          ],
          promotion: { criteria: [] },
        },
      } as ServerDeps['config'] extends { autonomyPolicy?: infer T } ? T : never,
    };

    const result = handleCheckTask(deps, { issueNumber: 1 });
    expect(result.constraints).toContain('Blocked paths: .github/**, infra/**');
    expect(result.constraints).toContain('Max lines per PR: 500');
    expect(result.constraints).toContain('Approval required: true');
  });

  it('populates constraints from quality gate config', () => {
    deps.config = {
      qualityGate: {
        apiVersion: 'ai-sdlc.io/v1alpha1',
        kind: 'QualityGate' as const,
        metadata: { name: 'test-gate' },
        spec: {
          gates: [
            {
              name: 'coverage',
              enforcement: 'required',
              rule: { metric: 'coverage', operator: '>=', threshold: 80 },
            },
            {
              name: 'review',
              enforcement: 'advisory',
              rule: { reviewer: { minApprovals: 1 } },
            },
          ],
        },
      } as ServerDeps['config'] extends { qualityGate?: infer T } ? T : never,
    };

    const result = handleCheckTask(deps, { issueNumber: 1 });
    expect(result.constraints).toContain('Quality gate: coverage (required)');
    expect(result.constraints).toContain('Quality gate: review (advisory)');
  });

  it('returns empty constraints when no config is loaded', () => {
    // No config set on deps
    const result = handleCheckTask(deps, { issueNumber: 1 });
    expect(result.constraints).toEqual([]);
  });
});
