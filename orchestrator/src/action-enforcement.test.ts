import { describe, it, expect, vi } from 'vitest';
import { checkAction, enforceAction, DEFAULT_BLOCKED_ACTIONS } from './action-enforcement.js';
import type { AuditLog } from '@ai-sdlc/reference';

function makeMockAuditLog(): AuditLog {
  return {
    record: vi.fn().mockImplementation((entry) => ({
      id: 'test-id',
      timestamp: new Date().toISOString(),
      ...entry,
    })),
    entries: vi.fn().mockReturnValue([]),
    query: vi.fn().mockReturnValue([]),
    verifyIntegrity: vi.fn().mockReturnValue({ valid: true }),
  };
}

describe('checkAction', () => {
  it('allows normal commands', () => {
    expect(checkAction('git add -A', DEFAULT_BLOCKED_ACTIONS).allowed).toBe(true);
  });

  it('allows git commit', () => {
    expect(checkAction('git commit -m "fix: something"', DEFAULT_BLOCKED_ACTIONS).allowed).toBe(
      true,
    );
  });

  it('allows git push (non-force)', () => {
    expect(checkAction('git push origin ai-sdlc/issue-42', DEFAULT_BLOCKED_ACTIONS).allowed).toBe(
      true,
    );
  });

  it('allows gh pr create', () => {
    expect(checkAction('gh pr create --title "test"', DEFAULT_BLOCKED_ACTIONS).allowed).toBe(true);
  });

  it('allows empty command', () => {
    expect(checkAction('', DEFAULT_BLOCKED_ACTIONS).allowed).toBe(true);
  });

  it('allows whitespace-only command', () => {
    expect(checkAction('   ', DEFAULT_BLOCKED_ACTIONS).allowed).toBe(true);
  });

  it('allows all commands with empty blocked list', () => {
    expect(checkAction('gh pr merge 42', []).allowed).toBe(true);
  });

  it('blocks gh pr merge', () => {
    const result = checkAction('gh pr merge 42 --squash', DEFAULT_BLOCKED_ACTIONS);
    expect(result.allowed).toBe(false);
    expect(result.matchedPattern).toBe('gh pr merge*');
  });

  it('blocks gh pr merge with --admin', () => {
    expect(checkAction('gh pr merge 42 --admin', DEFAULT_BLOCKED_ACTIONS).allowed).toBe(false);
  });

  it('blocks git merge', () => {
    const result = checkAction('git merge feature-branch', DEFAULT_BLOCKED_ACTIONS);
    expect(result.allowed).toBe(false);
    expect(result.matchedPattern).toBe('git merge*');
  });

  it('blocks git push --force', () => {
    expect(checkAction('git push --force origin main', DEFAULT_BLOCKED_ACTIONS).allowed).toBe(
      false,
    );
  });

  it('blocks git push -f', () => {
    expect(checkAction('git push -f origin main', DEFAULT_BLOCKED_ACTIONS).allowed).toBe(false);
  });

  it('blocks gh pr close', () => {
    expect(checkAction('gh pr close 42', DEFAULT_BLOCKED_ACTIONS).allowed).toBe(false);
  });

  it('blocks gh issue close', () => {
    expect(checkAction('gh issue close 42 --comment "done"', DEFAULT_BLOCKED_ACTIONS).allowed).toBe(
      false,
    );
  });

  it('blocks gh api review dismissals', () => {
    expect(
      checkAction(
        'gh api repos/owner/repo/pulls/42/reviews/123/dismissals --method PUT',
        DEFAULT_BLOCKED_ACTIONS,
      ).allowed,
    ).toBe(false);
  });

  it('blocks git branch -D', () => {
    expect(checkAction('git branch -D feature-branch', DEFAULT_BLOCKED_ACTIONS).allowed).toBe(
      false,
    );
  });

  it('blocks git reset --hard', () => {
    expect(checkAction('git reset --hard HEAD~1', DEFAULT_BLOCKED_ACTIONS).allowed).toBe(false);
  });

  it('blocks git checkout -- .', () => {
    expect(checkAction('git checkout -- .', DEFAULT_BLOCKED_ACTIONS).allowed).toBe(false);
  });

  it('blocks git restore .', () => {
    expect(checkAction('git restore .', DEFAULT_BLOCKED_ACTIONS).allowed).toBe(false);
  });

  it('works with custom blocked actions', () => {
    const result = checkAction('npm publish', ['npm publish*']);
    expect(result.allowed).toBe(false);
    expect(result.matchedPattern).toBe('npm publish*');
  });

  it('trims command whitespace', () => {
    const result = checkAction('  git add .  ', DEFAULT_BLOCKED_ACTIONS);
    expect(result.command).toBe('git add .');
  });
});

describe('enforceAction', () => {
  it('records blocked action in audit log', () => {
    const auditLog = makeMockAuditLog();
    const result = enforceAction(
      'gh pr merge 42',
      DEFAULT_BLOCKED_ACTIONS,
      auditLog,
      'coding-agent',
    );

    expect(result.allowed).toBe(false);
    expect(auditLog.record).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: 'coding-agent',
        action: 'execute',
        decision: 'denied',
        details: expect.objectContaining({
          reason: 'blocked-action',
          pattern: 'gh pr merge*',
        }),
      }),
    );
  });

  it('does not record allowed actions in audit log', () => {
    const auditLog = makeMockAuditLog();
    enforceAction('git add .', DEFAULT_BLOCKED_ACTIONS, auditLog);

    expect(auditLog.record).not.toHaveBeenCalled();
  });

  it('works without audit log', () => {
    const result = enforceAction('gh pr merge 42', DEFAULT_BLOCKED_ACTIONS);
    expect(result.allowed).toBe(false);
  });

  it('uses default actor name when agentName not provided', () => {
    const auditLog = makeMockAuditLog();
    enforceAction('gh pr merge 42', DEFAULT_BLOCKED_ACTIONS, auditLog);

    expect(auditLog.record).toHaveBeenCalledWith(expect.objectContaining({ actor: 'agent' }));
  });

  it('truncates long commands in audit resource field', () => {
    const auditLog = makeMockAuditLog();
    const longCommand = 'gh pr merge ' + 'a'.repeat(200);
    enforceAction(longCommand, DEFAULT_BLOCKED_ACTIONS, auditLog);

    const recordCall = (auditLog.record as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(recordCall.resource.length).toBeLessThanOrEqual(108); // "command/" + 100 chars
  });
});

describe('hook equivalence — checkAction matches hook enforcement patterns', () => {
  // These tests verify that the orchestrator's checkAction() produces the same
  // results as the Claude Code hook (.claude/hooks/enforce-blocked-actions.js)
  // for the default blockedActions from .ai-sdlc/agent-role.yaml.
  // This ensures both enforcement points are consistent.

  const blockedCommands = [
    'gh pr merge 42 --squash',
    'gh pr merge 42 --admin',
    'git merge feature-branch',
    'git push --force origin main',
    'git push -f origin main',
    'gh pr close 42',
    'gh issue close 42 --comment "done"',
    'gh api repos/o/r/pulls/1/reviews/2/dismissals --method PUT',
    'git branch -D feature',
    'git branch -d feature',
    'git reset --hard HEAD~1',
    'git checkout -- .',
    'git restore .',
  ];

  const allowedCommands = [
    'git push origin ai-sdlc/issue-42',
    'git commit -m "fix: something"',
    'git add -A',
    'gh pr create --title "test"',
    'pnpm test',
    'pnpm lint',
    'pnpm build',
    'echo hello',
  ];

  for (const cmd of blockedCommands) {
    it(`blocks: ${cmd}`, () => {
      expect(checkAction(cmd, DEFAULT_BLOCKED_ACTIONS).allowed).toBe(false);
    });
  }

  for (const cmd of allowedCommands) {
    it(`allows: ${cmd}`, () => {
      expect(checkAction(cmd, DEFAULT_BLOCKED_ACTIONS).allowed).toBe(true);
    });
  }
});
