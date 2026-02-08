import { describe, it, expect } from 'vitest';
import { buildPrompt } from './github-actions.js';
import type { AgentContext } from './types.js';

function makeContext(overrides: Partial<AgentContext> = {}): AgentContext {
  return {
    issueNumber: 42,
    issueTitle: 'Fix test flakiness',
    issueBody: 'Tests are flaky due to timing issues.',
    workDir: '/tmp/test-repo',
    branch: 'ai-sdlc/issue-42',
    constraints: {
      maxFilesPerChange: 15,
      requireTests: true,
      blockedPaths: ['.github/workflows/**'],
    },
    ...overrides,
  };
}

describe('buildPrompt()', () => {
  it('without ciErrors: prompt has standard instructions', () => {
    const prompt = buildPrompt(makeContext());

    expect(prompt).toContain('## Issue Description');
    expect(prompt).toContain('## Instructions');
    expect(prompt).toContain('Implement the fix or feature');
    expect(prompt).not.toContain('CI Failure Logs');
  });

  it('with ciErrors: prompt contains CI Failure Logs in code fence', () => {
    const ctx = makeContext({ ciErrors: 'Error: test failed\n  at foo.ts:10' });
    const prompt = buildPrompt(ctx);

    expect(prompt).toContain('## CI Failure Logs');
    expect(prompt).toContain('```\nError: test failed\n  at foo.ts:10\n```');
  });

  it('with ciErrors: prompt still includes constraints', () => {
    const ctx = makeContext({ ciErrors: 'some error' });
    const prompt = buildPrompt(ctx);

    expect(prompt).toContain('## Constraints');
    expect(prompt).toContain('Maximum files to change: 15');
    expect(prompt).toContain('.github/workflows/**');
  });

  it('with ciErrors: instructions focus on analyzing/fixing errors', () => {
    const ctx = makeContext({ ciErrors: 'lint error' });
    const prompt = buildPrompt(ctx);

    expect(prompt).toContain('Analyze the CI failure logs');
    expect(prompt).toContain('Fix the errors that caused CI to fail');
    expect(prompt).not.toContain('Implement the fix or feature');
  });
});
