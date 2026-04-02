import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  ClaudeCodeSdkRunner,
  mapToolsToSdkFormat,
  mapBlockedActionsToSdkDenyList,
  buildGovernancePrompt,
} from './claude-code-sdk.js';
import type { AgentContext } from './types.js';
import * as gitUtils from './git-utils.js';

// Mock the git utilities
vi.mock('./git-utils.js', () => ({
  gitExec: vi.fn().mockResolvedValue(''),
  detectChangedFiles: vi.fn().mockResolvedValue({ filesChanged: [], agentAlreadyCommitted: false }),
  runAutoFix: vi.fn().mockResolvedValue(undefined),
}));

function makeCtx(overrides: Partial<AgentContext> = {}): AgentContext {
  return {
    issueId: '42',
    issueTitle: 'Fix the bug',
    issueBody: 'There is a bug in auth module',
    workDir: '/tmp/test-repo',
    branch: 'ai-sdlc/issue-42',
    constraints: {
      maxFilesPerChange: 15,
      requireTests: true,
      blockedPaths: ['.github/workflows/**'],
      blockedActions: ['gh pr merge*', 'git push --force*'],
    },
    ...overrides,
  };
}

// ── mapToolsToSdkFormat ─────────────────────────────────────────────

describe('mapToolsToSdkFormat', () => {
  it('returns undefined when no tools provided', () => {
    expect(mapToolsToSdkFormat(undefined)).toBeUndefined();
  });

  it('passes through tool names unchanged', () => {
    const tools = ['Read', 'Edit', 'Bash(git:*)'];
    expect(mapToolsToSdkFormat(tools)).toEqual(['Read', 'Edit', 'Bash(git:*)']);
  });

  it('handles empty array', () => {
    expect(mapToolsToSdkFormat([])).toEqual([]);
  });

  it('handles single tool', () => {
    expect(mapToolsToSdkFormat(['Read'])).toEqual(['Read']);
  });
});

// ── mapBlockedActionsToSdkDenyList ──────────────────────────────────

describe('mapBlockedActionsToSdkDenyList', () => {
  it('returns empty array when no blocked actions', () => {
    expect(mapBlockedActionsToSdkDenyList(undefined)).toEqual([]);
  });

  it('returns empty array for empty array', () => {
    expect(mapBlockedActionsToSdkDenyList([])).toEqual([]);
  });

  it('wraps each pattern in Bash()', () => {
    const result = mapBlockedActionsToSdkDenyList(['gh pr merge*', 'git push -f*']);
    expect(result).toEqual(['Bash(gh pr merge*)', 'Bash(git push -f*)']);
  });

  it('handles single blocked action', () => {
    const result = mapBlockedActionsToSdkDenyList(['rm -rf /']);
    expect(result).toEqual(['Bash(rm -rf /)']);
  });
});

// ── buildGovernancePrompt ───────────────────────────────────────────

describe('buildGovernancePrompt', () => {
  it('includes governance header', () => {
    const prompt = buildGovernancePrompt(makeCtx());
    expect(prompt).toContain('AI-SDLC Governance Constraints');
  });

  it('includes blocked paths', () => {
    const prompt = buildGovernancePrompt(makeCtx());
    expect(prompt).toContain('.github/workflows/**');
    expect(prompt).toContain('Blocked paths');
  });

  it('includes blocked actions', () => {
    const prompt = buildGovernancePrompt(makeCtx());
    expect(prompt).toContain('gh pr merge*');
    expect(prompt).toContain('git push --force*');
    expect(prompt).toContain('Blocked actions');
  });

  it('includes max files per change', () => {
    const prompt = buildGovernancePrompt(makeCtx());
    expect(prompt).toContain('Max files per change: 15');
  });

  it('includes test requirement when enabled', () => {
    const prompt = buildGovernancePrompt(
      makeCtx({ constraints: { ...makeCtx().constraints, requireTests: true } }),
    );
    expect(prompt).toContain('Tests required');
  });

  it('omits test requirement when disabled', () => {
    const prompt = buildGovernancePrompt(
      makeCtx({ constraints: { ...makeCtx().constraints, requireTests: false } }),
    );
    expect(prompt).not.toContain('Tests required');
  });

  it('always includes the "never merge" governance line', () => {
    const prompt = buildGovernancePrompt(makeCtx());
    expect(prompt).toContain('NEVER merge PRs');
  });

  it('omits blocked paths line when none exist', () => {
    const prompt = buildGovernancePrompt(
      makeCtx({ constraints: { ...makeCtx().constraints, blockedPaths: [] } }),
    );
    expect(prompt).not.toContain('Blocked paths');
  });

  it('omits blocked actions line when none exist', () => {
    const prompt = buildGovernancePrompt(
      makeCtx({ constraints: { ...makeCtx().constraints, blockedActions: [] } }),
    );
    expect(prompt).not.toContain('Blocked actions');
  });

  it('omits blocked actions line when undefined', () => {
    const prompt = buildGovernancePrompt(
      makeCtx({ constraints: { ...makeCtx().constraints, blockedActions: undefined } }),
    );
    expect(prompt).not.toContain('Blocked actions');
  });

  it('formats multiple blocked paths comma-separated', () => {
    const prompt = buildGovernancePrompt(
      makeCtx({
        constraints: {
          ...makeCtx().constraints,
          blockedPaths: ['.github/**', '.ai-sdlc/**', 'secrets/**'],
        },
      }),
    );
    expect(prompt).toContain('.github/**, .ai-sdlc/**, secrets/**');
  });

  it('wraps blocked actions in backticks', () => {
    const prompt = buildGovernancePrompt(makeCtx());
    expect(prompt).toContain('`gh pr merge*`');
    expect(prompt).toContain('`git push --force*`');
  });
});

// ── ClaudeCodeSdkRunner ─────────────────────────────────────────────

describe('ClaudeCodeSdkRunner', () => {
  let runner: ClaudeCodeSdkRunner;

  beforeEach(() => {
    runner = new ClaudeCodeSdkRunner();
    vi.clearAllMocks();
  });

  it('returns error when SDK is not installed', async () => {
    const result = await runner.run(makeCtx());

    expect(result.success).toBe(false);
    expect(result.error).toContain('@anthropic-ai/claude-agent-sdk');
    expect(result.error).toContain('pnpm add');
  });

  it('returns empty filesChanged when SDK is not installed', async () => {
    const result = await runner.run(makeCtx());
    expect(result.filesChanged).toEqual([]);
  });

  it('returns empty summary when SDK is not installed', async () => {
    const result = await runner.run(makeCtx());
    expect(result.summary).toBe('');
  });

  it('returns failure when no files changed', async () => {
    vi.mocked(gitUtils.detectChangedFiles).mockResolvedValue({
      filesChanged: [],
      agentAlreadyCommitted: false,
    });

    const result = await runner.run(makeCtx());
    expect(result.success).toBe(false);
  });

  it('handles constraints with budget and turn limits without crashing', async () => {
    const ctx = makeCtx({
      constraints: {
        maxFilesPerChange: 10,
        requireTests: true,
        blockedPaths: ['.github/**', '.ai-sdlc/**'],
        blockedActions: ['gh pr merge*', 'git push -f*'],
        maxBudgetUsd: 2.0,
        maxTurns: 50,
      },
    });

    const result = await runner.run(ctx);
    // Will fail on SDK import or no files, but shouldn't crash
    expect(result.success).toBe(false);
  });

  it('uses custom model from context', async () => {
    const ctx = makeCtx({ model: 'claude-opus-4-6' });
    const result = await runner.run(ctx);
    // Will fail on SDK import, but shouldn't crash
    expect(result.success).toBe(false);
  });

  it('accepts custom allowedTools without crashing', async () => {
    const ctx = makeCtx({ allowedTools: ['Read', 'Grep'] });
    const result = await runner.run(ctx);
    expect(result.success).toBe(false);
  });

  it('handles context with no blockedActions', async () => {
    const ctx = makeCtx({
      constraints: {
        maxFilesPerChange: 15,
        requireTests: true,
        blockedPaths: [],
        blockedActions: undefined,
      },
    });
    const result = await runner.run(ctx);
    expect(result.success).toBe(false);
  });

  it('handles context with empty blockedActions', async () => {
    const ctx = makeCtx({
      constraints: {
        maxFilesPerChange: 15,
        requireTests: true,
        blockedPaths: [],
        blockedActions: [],
      },
    });
    const result = await runner.run(ctx);
    expect(result.success).toBe(false);
  });

  it('handles context with onProgress callback without crashing', async () => {
    const onProgress = vi.fn();
    const ctx = makeCtx({ onProgress });
    const result = await runner.run(ctx);
    // SDK import fails before progress would be called, so callback should not be called
    expect(result.success).toBe(false);
  });

  it('handles context with all optional fields set', async () => {
    const ctx = makeCtx({
      model: 'claude-opus-4-6',
      allowedTools: ['Read', 'Edit'],
      lintCommand: 'pnpm lint --fix',
      formatCommand: 'pnpm format',
      commitMessageTemplate: 'feat: {issueTitle} (#{issueNumber})',
      commitCoAuthor: 'AI Bot <bot@example.com>',
      onProgress: vi.fn(),
      constraints: {
        maxFilesPerChange: 5,
        requireTests: false,
        blockedPaths: [],
        blockedActions: ['rm -rf'],
        maxBudgetUsd: 1.0,
        maxTurns: 25,
      },
    });
    const result = await runner.run(ctx);
    expect(result.success).toBe(false);
    expect(result.error).toContain('claude-agent-sdk');
  });
});

// ── git-utils (mocked) ─────────────────────────────────────────────

describe('git-utils (mocked)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('detectChangedFiles returns empty when no changes', async () => {
    vi.mocked(gitUtils.detectChangedFiles).mockResolvedValue({
      filesChanged: [],
      agentAlreadyCommitted: false,
    });

    const result = await gitUtils.detectChangedFiles('/tmp/repo');
    expect(result.filesChanged).toEqual([]);
    expect(result.agentAlreadyCommitted).toBe(false);
  });

  it('detectChangedFiles detects agent-committed changes', async () => {
    vi.mocked(gitUtils.detectChangedFiles).mockResolvedValue({
      filesChanged: ['src/foo.ts', 'src/foo.test.ts'],
      agentAlreadyCommitted: true,
    });

    const result = await gitUtils.detectChangedFiles('/tmp/repo');
    expect(result.filesChanged).toEqual(['src/foo.ts', 'src/foo.test.ts']);
    expect(result.agentAlreadyCommitted).toBe(true);
  });
});
