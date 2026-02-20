import { describe, it, expect } from 'vitest';
import { buildPrompt, parseTokenUsage } from './copilot.js';
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

describe('CopilotRunner', () => {
  describe('buildPrompt (re-exported from claude-code)', () => {
    it('produces a valid prompt', () => {
      const prompt = buildPrompt(makeCtx());
      expect(prompt).toContain('issue #42');
      expect(prompt).toContain('Fix the widget');
    });
  });

  describe('parseTokenUsage', () => {
    it('parses input/output token counts', () => {
      const result = parseTokenUsage('Input tokens: 1,234\nOutput tokens: 5,678', 'copilot-model');
      expect(result).toEqual({
        inputTokens: 1234,
        outputTokens: 5678,
        model: 'copilot-model',
      });
    });

    it('parses total tokens and estimates split', () => {
      const result = parseTokenUsage('Total tokens: 10000', 'copilot-model');
      expect(result).toBeDefined();
      expect(result!.inputTokens).toBe(7000);
      expect(result!.outputTokens).toBe(3000);
    });

    it('returns undefined when no token info', () => {
      expect(parseTokenUsage('some random output', 'model')).toBeUndefined();
    });

    it('returns undefined for empty string', () => {
      expect(parseTokenUsage('', 'model')).toBeUndefined();
    });
  });
});
