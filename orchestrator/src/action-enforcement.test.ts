import { describe, it, expect } from 'vitest';
import { checkAction, DEFAULT_BLOCKED_ACTIONS } from './action-enforcement.js';

describe('checkAction', () => {
  it('allows normal commands', () => {
    const result = checkAction('git add -A', DEFAULT_BLOCKED_ACTIONS);
    expect(result.allowed).toBe(true);
  });

  it('allows git commit', () => {
    const result = checkAction('git commit -m "fix: something"', DEFAULT_BLOCKED_ACTIONS);
    expect(result.allowed).toBe(true);
  });

  it('allows git push (non-force)', () => {
    const result = checkAction('git push origin ai-sdlc/issue-42', DEFAULT_BLOCKED_ACTIONS);
    expect(result.allowed).toBe(true);
  });

  it('allows gh pr create', () => {
    const result = checkAction('gh pr create --title "test"', DEFAULT_BLOCKED_ACTIONS);
    expect(result.allowed).toBe(true);
  });

  it('blocks gh pr merge', () => {
    const result = checkAction('gh pr merge 42 --squash', DEFAULT_BLOCKED_ACTIONS);
    expect(result.allowed).toBe(false);
    expect(result.matchedPattern).toBe('gh pr merge*');
  });

  it('blocks gh pr merge with flags', () => {
    const result = checkAction('gh pr merge 42 --squash --delete-branch', DEFAULT_BLOCKED_ACTIONS);
    expect(result.allowed).toBe(false);
  });

  it('blocks gh pr merge with --admin', () => {
    const result = checkAction('gh pr merge 42 --admin', DEFAULT_BLOCKED_ACTIONS);
    expect(result.allowed).toBe(false);
  });

  it('blocks git merge', () => {
    const result = checkAction('git merge feature-branch', DEFAULT_BLOCKED_ACTIONS);
    expect(result.allowed).toBe(false);
    expect(result.matchedPattern).toBe('git merge*');
  });

  it('blocks git push --force', () => {
    const result = checkAction('git push --force origin main', DEFAULT_BLOCKED_ACTIONS);
    expect(result.allowed).toBe(false);
    expect(result.matchedPattern).toBe('git push --force*');
  });

  it('blocks git push -f', () => {
    const result = checkAction('git push -f origin main', DEFAULT_BLOCKED_ACTIONS);
    expect(result.allowed).toBe(false);
    expect(result.matchedPattern).toBe('git push -f*');
  });

  it('blocks gh pr close', () => {
    const result = checkAction('gh pr close 42', DEFAULT_BLOCKED_ACTIONS);
    expect(result.allowed).toBe(false);
  });

  it('blocks gh issue close', () => {
    const result = checkAction('gh issue close 42 --comment "done"', DEFAULT_BLOCKED_ACTIONS);
    expect(result.allowed).toBe(false);
  });

  it('blocks gh api review dismissals', () => {
    const result = checkAction(
      'gh api repos/owner/repo/pulls/42/reviews/123/dismissals --method PUT',
      DEFAULT_BLOCKED_ACTIONS,
    );
    expect(result.allowed).toBe(false);
  });

  it('blocks git branch -D', () => {
    const result = checkAction('git branch -D feature-branch', DEFAULT_BLOCKED_ACTIONS);
    expect(result.allowed).toBe(false);
  });

  it('blocks git reset --hard', () => {
    const result = checkAction('git reset --hard HEAD~1', DEFAULT_BLOCKED_ACTIONS);
    expect(result.allowed).toBe(false);
  });

  it('blocks git checkout -- .', () => {
    const result = checkAction('git checkout -- .', DEFAULT_BLOCKED_ACTIONS);
    expect(result.allowed).toBe(false);
  });

  it('blocks git restore .', () => {
    const result = checkAction('git restore .', DEFAULT_BLOCKED_ACTIONS);
    expect(result.allowed).toBe(false);
  });

  it('works with custom blocked actions', () => {
    const result = checkAction('npm publish', ['npm publish*']);
    expect(result.allowed).toBe(false);
    expect(result.matchedPattern).toBe('npm publish*');
  });

  it('allows commands not in blocked list', () => {
    const result = checkAction('echo hello', ['rm -rf*']);
    expect(result.allowed).toBe(true);
  });

  it('returns the command in result', () => {
    const result = checkAction('  git add .  ', DEFAULT_BLOCKED_ACTIONS);
    expect(result.command).toBe('git add .');
  });
});
