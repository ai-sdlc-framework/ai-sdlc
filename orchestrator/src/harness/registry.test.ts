import { describe, it, expect } from 'vitest';
import { HarnessRegistry, UnknownHarnessError } from './registry.js';
import { ClaudeCodeAdapter } from './adapters/claude-code.js';
import { CodexAdapter } from './adapters/codex.js';
import { createDefaultHarnessRegistry } from './index.js';

describe('HarnessRegistry', () => {
  it('register + get round-trips', () => {
    const reg = new HarnessRegistry();
    const adapter = new ClaudeCodeAdapter();
    reg.register(adapter);
    expect(reg.get('claude-code')).toBe(adapter);
  });

  it('has() reflects registration state', () => {
    const reg = new HarnessRegistry();
    expect(reg.has('claude-code')).toBe(false);
    reg.register(new ClaudeCodeAdapter());
    expect(reg.has('claude-code')).toBe(true);
  });

  it('get throws UnknownHarnessError for unregistered names', () => {
    const reg = new HarnessRegistry();
    expect(() => reg.get('mystery-harness')).toThrow(UnknownHarnessError);
  });

  it('list returns registered harness names', () => {
    const reg = new HarnessRegistry();
    reg.register(new ClaudeCodeAdapter());
    reg.register(new CodexAdapter());
    expect(reg.list().sort()).toEqual(['claude-code', 'codex'].sort());
  });
});

describe('createDefaultHarnessRegistry', () => {
  it('ships with claude-code and codex adapters', () => {
    const reg = createDefaultHarnessRegistry();
    expect(reg.has('claude-code')).toBe(true);
    expect(reg.has('codex')).toBe(true);
  });
});
