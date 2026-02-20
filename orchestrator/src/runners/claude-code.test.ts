import { describe, it, expect } from 'vitest';
import { buildPrompt, parseTokenUsage } from './claude-code.js';
import type { AgentContext } from './types.js';

function makeCtx(overrides?: Partial<AgentContext>): AgentContext {
  return {
    issueNumber: 42,
    issueTitle: 'Fix the widget',
    issueBody: 'The widget is broken.',
    workDir: '/tmp/repo',
    branch: 'ai-sdlc/issue-42',
    constraints: {
      maxFilesPerChange: 10,
      requireTests: true,
      blockedPaths: ['.github/workflows/**'],
    },
    ...overrides,
  };
}

describe('buildPrompt', () => {
  it('omits lint/format instructions when no commands configured', () => {
    const prompt = buildPrompt(makeCtx());
    expect(prompt).not.toContain('pnpm lint');
    expect(prompt).not.toContain('pnpm format');
    expect(prompt).not.toContain('run `undefined`');
    // Should still have basic instructions
    expect(prompt).toContain('Read the relevant source files');
    expect(prompt).toContain('Implement the fix or feature');
  });

  it('includes lint/format when ctx.lintCommand and ctx.formatCommand set', () => {
    const prompt = buildPrompt(
      makeCtx({
        lintCommand: 'npm run lint',
        formatCommand: 'npm run format',
      }),
    );
    expect(prompt).toContain('`npm run lint`');
    expect(prompt).toContain('`npm run format`');
  });

  it('includes lint/format in CI error branch when commands set', () => {
    const prompt = buildPrompt(
      makeCtx({
        lintCommand: 'pnpm lint',
        formatCommand: 'pnpm format',
        ciErrors: 'Error: test failed',
      }),
    );
    expect(prompt).toContain('CI Failure Logs');
    expect(prompt).toContain('`pnpm lint`');
    expect(prompt).toContain('`pnpm format`');
  });

  it('includes only lintCommand when formatCommand is not set', () => {
    const prompt = buildPrompt(
      makeCtx({
        lintCommand: 'eslint .',
      }),
    );
    expect(prompt).toContain('`eslint .`');
    expect(prompt).not.toContain('format');
  });

  it('includes only formatCommand when lintCommand is not set', () => {
    const prompt = buildPrompt(
      makeCtx({
        formatCommand: 'prettier --write .',
      }),
    );
    expect(prompt).toContain('`prettier --write .`');
    // Should not mention lint
    expect(prompt).not.toMatch(/run `.*lint/);
  });

  it('uses dynamic step numbering (steps adjust when instructions omitted)', () => {
    const promptWithCmds = buildPrompt(
      makeCtx({
        lintCommand: 'npm run lint',
        formatCommand: 'npm run format',
      }),
    );
    const promptWithout = buildPrompt(makeCtx());

    // With commands: should have more steps
    const stepsWithCmds = promptWithCmds.match(/^\d+\./gm) ?? [];
    const stepsWithout = promptWithout.match(/^\d+\./gm) ?? [];
    expect(stepsWithCmds.length).toBeGreaterThan(stepsWithout.length);
  });

  it('CI branch with only lintCommand omits format instructions', () => {
    const prompt = buildPrompt(
      makeCtx({
        lintCommand: 'eslint .',
        ciErrors: 'lint error',
      }),
    );
    expect(prompt).toContain('`eslint .`');
    // Should not have the "If the failure is a formatting/prettier error" step
    expect(prompt).not.toContain('formatting/prettier');
  });
});

describe('parseTokenUsage', () => {
  it('parses input/output token counts', () => {
    const result = parseTokenUsage('Input tokens: 1,234\nOutput tokens: 5,678', 'test-model');
    expect(result).toEqual({
      inputTokens: 1234,
      outputTokens: 5678,
      model: 'test-model',
    });
  });

  it('returns undefined when no token info in stderr', () => {
    expect(parseTokenUsage('some random output', 'model')).toBeUndefined();
  });

  it('parses total tokens and estimates split', () => {
    const result = parseTokenUsage('Total tokens: 10000', 'model');
    expect(result).toBeDefined();
    expect(result!.inputTokens).toBe(7000);
    expect(result!.outputTokens).toBe(3000);
  });

  it('handles input-only match', () => {
    const result = parseTokenUsage('Input tokens: 500', 'model');
    expect(result).toEqual({
      inputTokens: 500,
      outputTokens: 0,
      model: 'model',
    });
  });
});
