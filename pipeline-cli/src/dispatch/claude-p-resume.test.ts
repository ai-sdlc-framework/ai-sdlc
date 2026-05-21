/**
 * Tests for the `claude -p` session-resume helpers (RFC-0041 OQ-4 /
 * AISDLC-377.2). These are the primitives the supervisor (Phase 2 /
 * AISDLC-377.3) will compose into its actual subprocess spawn loop.
 */

import { describe, expect, it } from 'vitest';

import {
  buildClaudePInitialArgv,
  buildClaudePResumeArgv,
  DEFAULT_RESUME_AGENT,
  extractSessionIdFromClaudeOutput,
} from './claude-p-resume.js';

describe('buildClaudePInitialArgv', () => {
  it('includes --session-id, --agent, --print, --output-format json, --permission-mode', () => {
    const { argv, sessionId } = buildClaudePInitialArgv({
      sessionId: 'abc-123-uuid',
      prompt: 'implement task AISDLC-X',
    });
    expect(sessionId).toBe('abc-123-uuid');
    expect(argv).toEqual([
      '--print',
      '--output-format',
      'json',
      '--permission-mode',
      'bypassPermissions',
      '--session-id',
      'abc-123-uuid',
      '--agent',
      DEFAULT_RESUME_AGENT,
      'implement task AISDLC-X',
    ]);
  });

  it('mints a fresh UUID when no sessionId is provided', () => {
    const { sessionId } = buildClaudePInitialArgv({
      prompt: 'p',
    });
    // RFC-4122 v4 UUIDs look like 8-4-4-4-12 hex chars.
    expect(sessionId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('threads --model when provided', () => {
    const { argv } = buildClaudePInitialArgv({
      sessionId: 'sid',
      prompt: 'p',
      model: 'claude-sonnet-4-6',
    });
    expect(argv).toContain('--model');
    expect(argv).toContain('claude-sonnet-4-6');
    // --model must appear BEFORE the positional prompt at the end.
    expect(argv[argv.length - 1]).toBe('p');
  });

  it('threads --agent override', () => {
    const { argv } = buildClaudePInitialArgv({
      sessionId: 'sid',
      prompt: 'p',
      agent: 'test-reviewer',
    });
    expect(argv).toContain('--agent');
    const agentIdx = argv.indexOf('--agent');
    expect(argv[agentIdx + 1]).toBe('test-reviewer');
  });

  it('threads extraArgs BEFORE the positional prompt', () => {
    const { argv } = buildClaudePInitialArgv({
      sessionId: 'sid',
      prompt: 'p',
      extraArgs: ['--max-turns', '50'],
    });
    expect(argv).toContain('--max-turns');
    expect(argv[argv.length - 1]).toBe('p');
    expect(argv.indexOf('--max-turns')).toBeLessThan(argv.indexOf('p'));
  });

  it('keeps the prompt as the LAST positional argv entry (shell-safe)', () => {
    const { argv } = buildClaudePInitialArgv({
      sessionId: 'sid',
      prompt: 'a multi-word prompt with "quotes" and spaces',
    });
    expect(argv[argv.length - 1]).toBe('a multi-word prompt with "quotes" and spaces');
  });
});

describe('buildClaudePResumeArgv', () => {
  it('uses --resume <sessionId> + feedback as positional', () => {
    const argv = buildClaudePResumeArgv({
      sessionId: 'abc-123-uuid',
      feedback: 'reviewer wants edge-case coverage on path P',
    });
    expect(argv).toEqual([
      '--print',
      '--output-format',
      'json',
      '--permission-mode',
      'bypassPermissions',
      '--resume',
      'abc-123-uuid',
      'reviewer wants edge-case coverage on path P',
    ]);
  });

  it('does NOT pass --agent on resume (the prior session pinned it)', () => {
    const argv = buildClaudePResumeArgv({
      sessionId: 'sid',
      feedback: 'fb',
    });
    expect(argv).not.toContain('--agent');
  });

  it('threads extraArgs BEFORE the positional feedback', () => {
    const argv = buildClaudePResumeArgv({
      sessionId: 'sid',
      feedback: 'fb',
      extraArgs: ['--model', 'opus'],
    });
    expect(argv).toContain('--model');
    expect(argv[argv.length - 1]).toBe('fb');
  });

  it('keeps feedback as the LAST positional argv entry (shell-safe)', () => {
    const argv = buildClaudePResumeArgv({
      sessionId: 'sid',
      feedback: 'a multi-word feedback string',
    });
    expect(argv[argv.length - 1]).toBe('a multi-word feedback string');
  });
});

describe('extractSessionIdFromClaudeOutput', () => {
  it('returns session_id from snake_case envelope', () => {
    const parsed = { type: 'result', session_id: 'sid-snake', result: '{}' };
    expect(extractSessionIdFromClaudeOutput(parsed)).toBe('sid-snake');
  });

  it('returns sessionId from camelCase envelope (defensive fallback)', () => {
    const parsed = { type: 'result', sessionId: 'sid-camel', result: '{}' };
    expect(extractSessionIdFromClaudeOutput(parsed)).toBe('sid-camel');
  });

  it('prefers session_id over sessionId when both present', () => {
    const parsed = {
      type: 'result',
      session_id: 'sid-snake',
      sessionId: 'sid-camel',
      result: '{}',
    };
    expect(extractSessionIdFromClaudeOutput(parsed)).toBe('sid-snake');
  });

  it('returns undefined when neither field is present', () => {
    expect(extractSessionIdFromClaudeOutput({ type: 'result', result: '{}' })).toBeUndefined();
  });

  it('returns undefined on non-object input (null, string, number, undefined)', () => {
    expect(extractSessionIdFromClaudeOutput(null)).toBeUndefined();
    expect(extractSessionIdFromClaudeOutput('string')).toBeUndefined();
    expect(extractSessionIdFromClaudeOutput(42)).toBeUndefined();
    expect(extractSessionIdFromClaudeOutput(undefined)).toBeUndefined();
  });

  it('returns undefined when the session_id field is an empty string', () => {
    expect(extractSessionIdFromClaudeOutput({ session_id: '' })).toBeUndefined();
  });

  it('returns undefined when the session_id field is non-string', () => {
    expect(extractSessionIdFromClaudeOutput({ session_id: 42 })).toBeUndefined();
    expect(extractSessionIdFromClaudeOutput({ session_id: null })).toBeUndefined();
  });
});
