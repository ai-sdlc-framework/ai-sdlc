import { describe, expect, it } from 'vitest';
import { buildDeveloperPrompt } from './05-build-dev-prompt.js';
import type { TaskSpec } from '../types.js';

const task: TaskSpec = {
  id: 'AISDLC-1',
  title: 'demo',
  status: 'To Do',
  acceptanceCriteria: ['Do thing A', 'Do thing B'],
  acceptanceCriteriaChecked: [false, false],
  description: 'Demo description.',
  references: ['ref/a.md', 'ref/b.md'],
  permittedExternalPaths: ['../sib/'],
  rawBody: '',
  filePath: '',
};

describe('Step 5 — buildDeveloperPrompt', () => {
  it('includes title, description, ACs, refs, externalPaths, branch', async () => {
    const r = await buildDeveloperPrompt({
      taskId: 'AISDLC-1',
      task,
      branch: 'ai-sdlc/aisdlc-1-demo',
      worktreePath: '/tmp/wt',
    });
    expect(r.prompt).toContain('AISDLC-1');
    expect(r.prompt).toContain('demo');
    expect(r.prompt).toContain('Demo description.');
    expect(r.prompt).toContain('1. Do thing A');
    expect(r.prompt).toContain('2. Do thing B');
    expect(r.prompt).toContain('ref/a.md');
    expect(r.prompt).toContain('../sib/');
    expect(r.prompt).toContain('ai-sdlc/aisdlc-1-demo');
    expect(r.prompt).toContain('/tmp/wt');
    expect(r.prompt).toContain('Co-Authored-By: Claude Opus');
  });

  it('omits feedback section on iteration 1', async () => {
    const r = await buildDeveloperPrompt({
      taskId: 'AISDLC-1',
      task,
      branch: 'b',
      worktreePath: '/tmp/wt',
      iteration: 1,
      reviewerFeedback: 'should be ignored',
    });
    expect(r.prompt).not.toContain('Reviewer feedback');
    expect(r.prompt).not.toContain('should be ignored');
  });

  it('injects feedback section on iteration > 1', async () => {
    const r = await buildDeveloperPrompt({
      taskId: 'AISDLC-1',
      task,
      branch: 'b',
      worktreePath: '/tmp/wt',
      iteration: 2,
      reviewerFeedback: '- [critical] foo.ts:1 — missing thing',
    });
    expect(r.prompt).toContain('## Reviewer feedback (round 1)');
    expect(r.prompt).toContain('- [critical] foo.ts:1 — missing thing');
  });

  it('handles tasks with no references / no external paths', async () => {
    const t: TaskSpec = { ...task, references: undefined, permittedExternalPaths: undefined };
    const r = await buildDeveloperPrompt({
      taskId: 'AISDLC-1',
      task: t,
      branch: 'b',
      worktreePath: '/tmp/wt',
    });
    expect(r.prompt).toContain('## References\n(none)');
    expect(r.prompt).toContain('## Permitted external paths (cross-repo writes)\nnone');
  });
});
