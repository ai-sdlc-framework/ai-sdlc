/**
 * Hermetic tests for the `--spawner claude-cli` deprecation warning helper.
 *
 * RFC-0041 Phase 3.1 (AISDLC-377.4) — AC #6.
 *
 * Two required cases:
 *   (a) `AI_SDLC_SUPPRESS_DEPRECATION_WARNING` unset → warning written to stream.
 *   (b) `AI_SDLC_SUPPRESS_DEPRECATION_WARNING=1` → nothing written.
 *
 * Plus a third case: verify the helper is NOT called for non-deprecated spawner
 * kinds (enforced at the call site in cli/orchestrator.ts, not in the helper
 * itself — this test simply documents the contract that the helper is unaware
 * of spawner kind).
 */

import { describe, it, expect } from 'vitest';
import {
  emitClaudeCliDeprecationWarning,
  CLAUDE_CLI_DEPRECATION_WARNING_LINES,
  CLAUDE_CLI_DEPRECATION_SUPPRESS_ENV,
} from './deprecation-warnings.js';

/** Minimal in-memory stream that captures what was written. */
function makeCapture(): { write: (s: string) => void; output: string } {
  let output = '';
  return {
    write(s: string) {
      output += s;
    },
    get output() {
      return output;
    },
  };
}

describe('emitClaudeCliDeprecationWarning', () => {
  it('(a) emits warning to stream when suppression env var is absent', () => {
    const capture = makeCapture();
    emitClaudeCliDeprecationWarning(capture, {});

    expect(capture.output).not.toBe('');
    // All three warning lines should be present
    for (const line of CLAUDE_CLI_DEPRECATION_WARNING_LINES) {
      expect(capture.output).toContain(line);
    }
  });

  it('(a) emits warning when suppression env var is set to something other than "1"', () => {
    const capture = makeCapture();
    emitClaudeCliDeprecationWarning(capture, { [CLAUDE_CLI_DEPRECATION_SUPPRESS_ENV]: '0' });

    expect(capture.output).not.toBe('');
    expect(capture.output).toContain('[deprecated]');
  });

  it('(b) does NOT emit warning when AI_SDLC_SUPPRESS_DEPRECATION_WARNING=1', () => {
    const capture = makeCapture();
    emitClaudeCliDeprecationWarning(capture, { [CLAUDE_CLI_DEPRECATION_SUPPRESS_ENV]: '1' });

    expect(capture.output).toBe('');
  });

  it('(b) suppresses when env var is "1" with surrounding whitespace', () => {
    const capture = makeCapture();
    emitClaudeCliDeprecationWarning(capture, { [CLAUDE_CLI_DEPRECATION_SUPPRESS_ENV]: '  1  ' });

    expect(capture.output).toBe('');
  });

  it('warning mentions the removal version v0.11', () => {
    const capture = makeCapture();
    emitClaudeCliDeprecationWarning(capture, {});

    expect(capture.output).toContain('v0.11');
  });

  it('warning mentions dispatch-worker migration path', () => {
    const capture = makeCapture();
    emitClaudeCliDeprecationWarning(capture, {});

    expect(capture.output).toContain('dispatch-worker');
    expect(capture.output).toContain('dispatch-supervisor-install.md');
  });

  it('warning lines constant matches expected shape', () => {
    expect(CLAUDE_CLI_DEPRECATION_WARNING_LINES).toHaveLength(3);
    expect(CLAUDE_CLI_DEPRECATION_WARNING_LINES[0]).toMatch(/^\[deprecated\]/);
  });
});
