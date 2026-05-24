import { describe, expect, it } from 'vitest';
import { renderTextOutcome } from './import-spec.js';

describe('renderTextOutcome', () => {
  it('renders an imported outcome as a summary + per-task line', () => {
    const text = renderTextOutcome({
      workDir: '/tmp/x',
      outcome: {
        kind: 'imported',
        featureId: 'auth',
        tasksMdPath: '/tmp/x/.specify/specs/auth/tasks.md',
        writtenTasks: [
          {
            id: 'IMP-1',
            filePath: '/tmp/x/backlog/tasks/imp-1 - foo.md',
            fileName: 'imp-1 - foo.md',
            upstreamTaskId: 'T-001',
          },
        ],
      },
    });
    expect(text).toContain('Imported 1 task(s)');
    expect(text).toContain('IMP-1 (upstream T-001)');
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
