import { describe, expect, it } from 'vitest';
import { renderTextOutcome } from './import-spec.js';

describe('renderTextOutcome', () => {
  it('renders an imported outcome as a summary + per-task line', () => {
    const text = renderTextOutcome({
      workDir: '/tmp/x',
      outcome: {
        kind: 'imported',
        featureId: 'auth',
        strictness: 'strict',
        tasksMdPath: '/tmp/x/.specify/specs/auth/tasks.md',
        writtenTasks: [
          {
            id: 'IMP-1',
            filePath: '/tmp/x/backlog/tasks/imp-1 - foo.md',
            fileName: 'imp-1 - foo.md',
            upstreamTaskId: 'T-001',
          },
        ],
        perTaskDor: [
          {
            upstreamTaskId: 'T-001',
            title: 'foo',
            outcome: {
              kind: 'admitted',
              verdict: stubVerdict('admit'),
              autoResolvedDecisionIds: [],
            },
          },
        ],
        refusedTasks: [],
      },
    });
    expect(text).toContain('Imported 1 task(s)');
    expect(text).toContain('rubric: strict');
    expect(text).toContain('IMP-1 (upstream T-001)');
  });

  it('surfaces admitted-with-warnings tasks separately under --rubric warn', () => {
    const text = renderTextOutcome({
      workDir: '/tmp/x',
      outcome: {
        kind: 'imported',
        featureId: 'auth',
        strictness: 'warn',
        tasksMdPath: '/tmp/x/.specify/specs/auth/tasks.md',
        writtenTasks: [
          {
            id: 'IMP-1',
            filePath: '/tmp/x/backlog/tasks/imp-1 - foo.md',
            fileName: 'imp-1 - foo.md',
            upstreamTaskId: 'T-001',
          },
        ],
        perTaskDor: [
          {
            upstreamTaskId: 'T-001',
            title: 'foo',
            outcome: {
              kind: 'admitted-with-warnings',
              verdict: stubVerdict('needs-clarification'),
              failedGates: [3, 5],
              autoResolvedDecisionIds: [],
            },
          },
        ],
        refusedTasks: [],
      },
    });
    expect(text).toContain('Admitted with warnings (1)');
    expect(text).toContain('Gate 3');
    expect(text).toContain('Gate 5');
  });

  it('lists refused-strict tasks with their Decision id + clarification task path', () => {
    const text = renderTextOutcome({
      workDir: '/tmp/x',
      outcome: {
        kind: 'imported',
        featureId: 'auth',
        strictness: 'strict',
        tasksMdPath: '/tmp/x/.specify/specs/auth/tasks.md',
        writtenTasks: [],
        perTaskDor: [
          {
            upstreamTaskId: 'T-007',
            title: 'bar',
            outcome: {
              kind: 'refused-strict',
              verdict: stubVerdict('needs-clarification'),
              decisionId: 'DEC-0099',
              clarificationTaskFile: '/tmp/x/backlog/tasks/impclarify-1 - bar.md',
              failedGates: [3],
              autoResolvedDecisionIds: [],
            },
          },
        ],
        refusedTasks: [
          {
            upstreamTaskId: 'T-007',
            title: 'bar',
            outcome: {
              kind: 'refused-strict',
              verdict: stubVerdict('needs-clarification'),
              decisionId: 'DEC-0099',
              clarificationTaskFile: '/tmp/x/backlog/tasks/impclarify-1 - bar.md',
              failedGates: [3],
              autoResolvedDecisionIds: [],
            },
          },
        ],
      },
    });
    expect(text).toContain('Refused (strict DoR');
    expect(text).toContain('T-007');
    expect(text).toContain('DEC-0099');
    expect(text).toContain('impclarify-1 - bar.md');
  });

  it('reports analyze auto-resolved decisions when any were emitted', () => {
    const text = renderTextOutcome({
      workDir: '/tmp/x',
      outcome: {
        kind: 'imported',
        featureId: 'auth',
        strictness: 'strict',
        tasksMdPath: '/tmp/x/.specify/specs/auth/tasks.md',
        writtenTasks: [
          {
            id: 'IMP-1',
            filePath: '/tmp/x/backlog/tasks/imp-1 - foo.md',
            fileName: 'imp-1 - foo.md',
            upstreamTaskId: 'T-001',
          },
        ],
        perTaskDor: [
          {
            upstreamTaskId: 'T-001',
            title: 'foo',
            outcome: {
              kind: 'admitted',
              verdict: stubVerdict('admit'),
              autoResolvedDecisionIds: ['DEC-1001', 'DEC-1002'],
            },
          },
        ],
        refusedTasks: [],
      },
    });
    expect(text).toContain('Auto-resolved by analyze metadata: 2 decision(s)');
  });

  it('renders an incomplete-spec outcome with the Decision id + clarification task', () => {
    const text = renderTextOutcome({
      workDir: '/tmp/x',
      outcome: {
        kind: 'incomplete-spec',
        reason: 'tasks.md missing',
        decision: {
          decisionId: 'DEC-0042',
          clarificationTaskFile: '/tmp/x/backlog/tasks/impclarify-1 - x.md',
        },
      },
    });
    expect(text).toContain('incomplete-spec-detected');
    expect(text).toContain('DEC-0042');
    expect(text).toContain('impclarify-1');
  });

  it('renders an unknown-schema outcome', () => {
    const text = renderTextOutcome({
      workDir: '/tmp/x',
      outcome: {
        kind: 'unknown-schema',
        tasksMdPath: '/tmp/x/.specify/specs/x/tasks.md',
        decision: {
          decisionId: null,
          clarificationTaskFile: '/tmp/x/backlog/tasks/impclarify-1 - x.md',
        },
      },
    });
    expect(text).toContain('upstream-schema-unknown');
    expect(text).toContain('impclarify-1');
  });
});

function stubVerdict(overall: 'admit' | 'needs-clarification') {
  return {
    issueId: 'STUB',
    rubricVersion: 'v1' as const,
    overallVerdict: overall,
    gates: [],
    signedAt: '2026-05-24T00:00:00.000Z',
    evaluatorVersion: 'test-stub',
  };
}
