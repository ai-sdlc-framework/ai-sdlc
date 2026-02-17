import { describe, it, expect, beforeEach } from 'vitest';
import { SessionManager, type SessionState } from './session.js';

describe('SessionManager', () => {
  let mgr: SessionManager;

  beforeEach(() => {
    mgr = new SessionManager();
  });

  it('creates a session with a unique id', () => {
    const s = mgr.create({ developer: 'alice', tool: 'claude-code' });
    expect(s.sessionId).toBeTruthy();
    expect(s.developer).toBe('alice');
    expect(s.tool).toBe('claude-code');
    expect(s.active).toBe(true);
    expect(s.linkedIssue).toBeNull();
    expect(s.accumulatedCost.totalCostUsd).toBe(0);
  });

  it('retrieves session by id', () => {
    const s = mgr.create({ developer: 'bob', tool: 'copilot' });
    expect(mgr.get(s.sessionId)).toBe(s);
    expect(mgr.get('nonexistent')).toBeUndefined();
  });

  it('returns the most recent active session', () => {
    const s1 = mgr.create({ developer: 'a', tool: 'cursor' });
    mgr.end(s1.sessionId);
    const s2 = mgr.create({ developer: 'b', tool: 'claude-code' });
    expect(mgr.getActive()?.sessionId).toBe(s2.sessionId);
  });

  it('returns undefined when no active sessions', () => {
    expect(mgr.getActive()).toBeUndefined();
    const s = mgr.create({ developer: 'a', tool: 'other' });
    mgr.end(s.sessionId);
    expect(mgr.getActive()).toBeUndefined();
  });

  it('accumulates usage entries', () => {
    const s = mgr.create({ developer: 'a', tool: 'claude-code' });
    mgr.addUsage(s.sessionId, { model: 'claude-opus-4-6', inputTokens: 1000, outputTokens: 500, costUsd: 0.05 });
    mgr.addUsage(s.sessionId, { model: 'claude-opus-4-6', inputTokens: 2000, outputTokens: 1000, costUsd: 0.10 });
    mgr.addUsage(s.sessionId, { model: 'claude-haiku-4-5-20251001', inputTokens: 500, outputTokens: 200, costUsd: 0.01 });

    expect(s.accumulatedCost.totalInputTokens).toBe(3500);
    expect(s.accumulatedCost.totalOutputTokens).toBe(1700);
    expect(s.accumulatedCost.totalCostUsd).toBeCloseTo(0.16);
    expect(s.accumulatedCost.byModel['claude-opus-4-6'].inputTokens).toBe(3000);
    expect(s.accumulatedCost.byModel['claude-haiku-4-5-20251001'].costUsd).toBeCloseTo(0.01);
  });

  it('ignores usage for nonexistent session', () => {
    // Should not throw
    mgr.addUsage('no-such-id', { model: 'x', inputTokens: 1, outputTokens: 1, costUsd: 0 });
  });

  it('links an issue', () => {
    const s = mgr.create({ developer: 'a', tool: 'claude-code' });
    mgr.linkIssue(s.sessionId, 42, 'branch');
    expect(s.linkedIssue).toBe(42);
    expect(s.linkMethod).toBe('branch');
  });

  it('ends a session and marks it inactive', () => {
    const s = mgr.create({ developer: 'a', tool: 'claude-code' });
    const ended = mgr.end(s.sessionId);
    expect(ended?.active).toBe(false);
    expect(mgr.getActive()).toBeUndefined();
  });

  it('returns undefined when ending nonexistent session', () => {
    expect(mgr.end('nonexistent')).toBeUndefined();
  });

  it('handles multiple sessions', () => {
    const s1 = mgr.create({ developer: 'a', tool: 'claude-code' });
    const s2 = mgr.create({ developer: 'b', tool: 'copilot' });
    expect(mgr.get(s1.sessionId)?.developer).toBe('a');
    expect(mgr.get(s2.sessionId)?.developer).toBe('b');
  });
});
