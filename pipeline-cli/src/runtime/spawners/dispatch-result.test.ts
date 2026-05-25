/**
 * `dispatch-result` — unit tests (AISDLC-225).
 *
 * Tests the consumer-bridge helpers that allow the `/ai-sdlc orchestrator-tick`
 * slash command body to hand off Agent results to the orchestrator tick loop.
 *
 * All tests use a tmp directory so they don't touch real filesystem paths.
 * Tests that exercise `writeDispatchResult` inject a deterministic `now`
 * function so results are comparable.
 */

import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  DISPATCH_RESULT_VERSION,
  dispatchResultToSubagentResult,
  isDispatchResult,
  readDispatchResult,
  resolveResultPath,
  writeDispatchResult,
  type DispatchResult,
} from './dispatch-result.js';

const FIXED_NOW = '2026-05-06T00:00:00.000Z';
const fixedNow = () => FIXED_NOW;

function makeTmpDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'aisdlc-225-dispatch-result-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// ── resolveResultPath ─────────────────────────────────────────────────

describe('resolveResultPath', () => {
  it('returns the overridePath when provided', () => {
    expect(resolveResultPath('/custom/path/result.json')).toBe('/custom/path/result.json');
  });

  it('falls back to ARTIFACTS_DIR env + default name', () => {
    const original = process.env.ARTIFACTS_DIR;
    try {
      process.env.ARTIFACTS_DIR = '/custom/artifacts';
      expect(resolveResultPath()).toBe('/custom/artifacts/_orchestrator/dispatch-result.json');
    } finally {
      if (original === undefined) {
        delete process.env.ARTIFACTS_DIR;
      } else {
        process.env.ARTIFACTS_DIR = original;
      }
    }
  });

  it('falls back to <cwd>/artifacts when ARTIFACTS_DIR is unset', () => {
    const original = process.env.ARTIFACTS_DIR;
    try {
      delete process.env.ARTIFACTS_DIR;
      const result = resolveResultPath();
      expect(result).toContain('/_orchestrator/dispatch-result.json');
      expect(result).toContain('artifacts');
    } finally {
      if (original !== undefined) {
        process.env.ARTIFACTS_DIR = original;
      }
    }
  });
});

// ── isDispatchResult ──────────────────────────────────────────────────

describe('isDispatchResult', () => {
  it('returns true for a valid success result', () => {
    const result: DispatchResult = {
      version: 1,
      taskId: 'AISDLC-123',
      subagentType: 'developer',
      status: 'success',
      output: '{"summary": "done"}',
      parsed: { summary: 'done' },
      durationMs: 5000,
      writtenAt: FIXED_NOW,
    };
    expect(isDispatchResult(result)).toBe(true);
  });

  it('returns true for a valid error result', () => {
    const result: DispatchResult = {
      version: 1,
      taskId: 'AISDLC-123',
      subagentType: 'developer',
      status: 'error',
      output: '',
      error: 'session timeout',
      durationMs: 600000,
      writtenAt: FIXED_NOW,
    };
    expect(isDispatchResult(result)).toBe(true);
  });

  it('returns false for null', () => {
    expect(isDispatchResult(null)).toBe(false);
  });

  it('returns false for non-object', () => {
    expect(isDispatchResult('string')).toBe(false);
    expect(isDispatchResult(42)).toBe(false);
  });

  it('returns false when version is wrong', () => {
    expect(
      isDispatchResult({
        version: 2,
        taskId: 'X',
        subagentType: 'developer',
        status: 'success',
        output: '',
        durationMs: 0,
        writtenAt: FIXED_NOW,
      }),
    ).toBe(false);
  });

  it('returns false when status is invalid', () => {
    expect(
      isDispatchResult({
        version: 1,
        taskId: 'X',
        subagentType: 'developer',
        // Anything other than 'success' | 'error' must be rejected; the
        // legacy `'manifest-emitted'` value (emitted only by the removed
        // ClaudeCliInlineSpawner, RFC-0041 Phase 3.3 / AISDLC-377.6) is one
        // such case but the type-guard rejects any non-listed string.
        status: 'pending',
        output: '',
        durationMs: 0,
        writtenAt: FIXED_NOW,
      }),
    ).toBe(false);
  });

  it('returns false when taskId is missing', () => {
    expect(
      isDispatchResult({
        version: 1,
        subagentType: 'developer',
        status: 'success',
        output: '',
        durationMs: 0,
        writtenAt: FIXED_NOW,
      }),
    ).toBe(false);
  });

  it('returns false when durationMs is not a number', () => {
    expect(
      isDispatchResult({
        version: 1,
        taskId: 'X',
        subagentType: 'developer',
        status: 'success',
        output: '',
        durationMs: 'long',
        writtenAt: FIXED_NOW,
      }),
    ).toBe(false);
  });
});

// ── writeDispatchResult ───────────────────────────────────────────────

describe('writeDispatchResult', () => {
  it('writes a success result and returns the envelope', () => {
    const { dir, cleanup } = makeTmpDir();
    try {
      const resultPath = join(dir, '_orchestrator', 'dispatch-result.json');

      const envelope = writeDispatchResult(
        {
          taskId: 'AISDLC-123',
          subagentType: 'developer',
          status: 'success',
          output: '{"summary": "done"}',
          parsed: { summary: 'done' },
          durationMs: 42000,
        },
        { resultPath, now: fixedNow },
      );

      expect(envelope.version).toBe(DISPATCH_RESULT_VERSION);
      expect(envelope.taskId).toBe('AISDLC-123');
      expect(envelope.subagentType).toBe('developer');
      expect(envelope.status).toBe('success');
      expect(envelope.durationMs).toBe(42000);
      expect(envelope.writtenAt).toBe(FIXED_NOW);
    } finally {
      cleanup();
    }
  });

  it('creates parent directories automatically', () => {
    const { dir, cleanup } = makeTmpDir();
    try {
      // Deep nested path — directories don't exist yet
      const resultPath = join(dir, 'a', 'b', 'c', 'result.json');

      const envelope = writeDispatchResult(
        {
          taskId: 'AISDLC-456',
          subagentType: 'code-reviewer',
          status: 'success',
          output: 'LGTM',
          durationMs: 10000,
        },
        { resultPath, now: fixedNow },
      );

      expect(envelope.taskId).toBe('AISDLC-456');
    } finally {
      cleanup();
    }
  });

  it('writes an error result with the error field', () => {
    const { dir, cleanup } = makeTmpDir();
    try {
      const resultPath = join(dir, 'result.json');

      const envelope = writeDispatchResult(
        {
          taskId: 'AISDLC-789',
          subagentType: 'security-reviewer',
          status: 'error',
          output: '',
          error: 'Agent session timed out after 600s',
          durationMs: 600000,
        },
        { resultPath, now: fixedNow },
      );

      expect(envelope.status).toBe('error');
      expect(envelope.error).toBe('Agent session timed out after 600s');
    } finally {
      cleanup();
    }
  });

  it('the written file is parseable JSON matching the envelope', () => {
    const { dir, cleanup } = makeTmpDir();
    try {
      const resultPath = join(dir, 'result.json');

      const envelope = writeDispatchResult(
        {
          taskId: 'AISDLC-123',
          subagentType: 'developer',
          status: 'success',
          output: '{"commitSha": "abc1234"}',
          parsed: { commitSha: 'abc1234' },
          durationMs: 30000,
        },
        { resultPath, now: fixedNow },
      );

      const onDisk = JSON.parse(readFileSync(resultPath, 'utf8')) as DispatchResult;
      expect(onDisk).toEqual(envelope);
    } finally {
      cleanup();
    }
  });
});

// ── readDispatchResult ────────────────────────────────────────────────

describe('readDispatchResult', () => {
  it('returns null when the file does not exist', () => {
    const { dir, cleanup } = makeTmpDir();
    try {
      const resultPath = join(dir, 'nonexistent.json');
      expect(readDispatchResult({ resultPath })).toBeNull();
    } finally {
      cleanup();
    }
  });

  it('returns null when the file contains invalid JSON', () => {
    const { dir, cleanup } = makeTmpDir();
    try {
      const resultPath = join(dir, 'result.json');
      writeFileSync(resultPath, 'not-json', 'utf8');
      expect(readDispatchResult({ resultPath })).toBeNull();
    } finally {
      cleanup();
    }
  });

  it('returns null when the JSON does not match DispatchResult shape', () => {
    const { dir, cleanup } = makeTmpDir();
    try {
      const resultPath = join(dir, 'result.json');
      writeFileSync(resultPath, JSON.stringify({ foo: 'bar' }), 'utf8');
      expect(readDispatchResult({ resultPath })).toBeNull();
    } finally {
      cleanup();
    }
  });

  it('round-trips: write then read returns the original envelope', () => {
    const { dir, cleanup } = makeTmpDir();
    try {
      const resultPath = join(dir, 'result.json');

      const written = writeDispatchResult(
        {
          taskId: 'AISDLC-225',
          subagentType: 'developer',
          status: 'success',
          output: '{"prUrl": "https://github.com/org/repo/pull/99"}',
          parsed: { prUrl: 'https://github.com/org/repo/pull/99' },
          durationMs: 55000,
        },
        { resultPath, now: fixedNow },
      );

      const read = readDispatchResult({ resultPath });
      expect(read).not.toBeNull();
      expect(read).toEqual(written);
    } finally {
      cleanup();
    }
  });
});

// ── dispatchResultToSubagentResult ────────────────────────────────────

describe('dispatchResultToSubagentResult', () => {
  it('converts a success result to a SubagentResult with parsed field', () => {
    const dispatchResult: DispatchResult = {
      version: 1,
      taskId: 'AISDLC-123',
      subagentType: 'developer',
      status: 'success',
      output: '{"commitSha": "abc1234", "prUrl": "https://github.com/org/repo/pull/42"}',
      parsed: { commitSha: 'abc1234', prUrl: 'https://github.com/org/repo/pull/42' },
      durationMs: 30000,
      writtenAt: FIXED_NOW,
    };

    const subagentResult = dispatchResultToSubagentResult(dispatchResult);

    expect(subagentResult.type).toBe('developer');
    expect(subagentResult.status).toBe('success');
    expect(subagentResult.output).toBe(dispatchResult.output);
    expect(subagentResult.parsed).toEqual({
      commitSha: 'abc1234',
      prUrl: 'https://github.com/org/repo/pull/42',
    });
    expect(subagentResult.durationMs).toBe(30000);
    expect(subagentResult.error).toBeUndefined();
  });

  it('converts an error result to a SubagentResult with error field', () => {
    const dispatchResult: DispatchResult = {
      version: 1,
      taskId: 'AISDLC-123',
      subagentType: 'developer',
      status: 'error',
      output: '',
      error: 'Agent session timed out',
      durationMs: 600000,
      writtenAt: FIXED_NOW,
    };

    const subagentResult = dispatchResultToSubagentResult(dispatchResult);

    expect(subagentResult.type).toBe('developer');
    expect(subagentResult.status).toBe('error');
    expect(subagentResult.error).toBe('Agent session timed out');
    expect(subagentResult.parsed).toBeUndefined();
    expect(subagentResult.durationMs).toBe(600000);
  });

  it('uses fallback error message when error field is missing on error status', () => {
    const dispatchResult: DispatchResult = {
      version: 1,
      taskId: 'AISDLC-123',
      subagentType: 'test-reviewer',
      status: 'error',
      output: '',
      durationMs: 1000,
      writtenAt: FIXED_NOW,
    };

    const subagentResult = dispatchResultToSubagentResult(dispatchResult);

    expect(subagentResult.status).toBe('error');
    expect(subagentResult.error).toContain('dispatch-result: error status with no error message');
  });

  it('preserves subagentType for reviewer types', () => {
    const dispatchResult: DispatchResult = {
      version: 1,
      taskId: 'AISDLC-123',
      subagentType: 'security-reviewer',
      status: 'success',
      output: 'APPROVED',
      durationMs: 8000,
      writtenAt: FIXED_NOW,
    };

    const subagentResult = dispatchResultToSubagentResult(dispatchResult);
    expect(subagentResult.type).toBe('security-reviewer');
  });

  it('success result with no parsed field does not add parsed key', () => {
    const dispatchResult: DispatchResult = {
      version: 1,
      taskId: 'AISDLC-123',
      subagentType: 'code-reviewer',
      status: 'success',
      output: 'Looks good to me',
      // no parsed field
      durationMs: 3000,
      writtenAt: FIXED_NOW,
    };

    const subagentResult = dispatchResultToSubagentResult(dispatchResult);
    expect(subagentResult.parsed).toBeUndefined();
  });
});

// ── round-trip integration ────────────────────────────────────────────

describe('full bridge round-trip (write → read → convert)', () => {
  it('bridges a developer dispatch result to a SubagentResult end-to-end', () => {
    const { dir, cleanup } = makeTmpDir();
    try {
      const resultPath = join(dir, 'result.json');

      // Slash command body writes the result after Agent call
      writeDispatchResult(
        {
          taskId: 'AISDLC-225',
          subagentType: 'developer',
          status: 'success',
          output: JSON.stringify({
            summary: 'Implemented consumer bridge',
            commitSha: 'abc1234',
            prUrl: 'https://github.com/org/repo/pull/333',
            filesChanged: ['ai-sdlc-plugin/commands/orchestrator-tick.md'],
            verifications: { build: 'passed', test: 'passed', lint: 'passed', format: 'passed' },
            acceptanceCriteriaMet: [1, 2, 3, 4, 5, 6, 7, 8],
          }),
          parsed: {
            summary: 'Implemented consumer bridge',
            commitSha: 'abc1234',
            prUrl: 'https://github.com/org/repo/pull/333',
          },
          durationMs: 120000,
        },
        { resultPath, now: fixedNow },
      );

      // Orchestrator tick loop reads the result
      const read = readDispatchResult({ resultPath });
      expect(read).not.toBeNull();

      // Convert to SubagentResult for executePipeline()
      const subagentResult = dispatchResultToSubagentResult(read!);

      expect(subagentResult.type).toBe('developer');
      expect(subagentResult.status).toBe('success');
      expect((subagentResult.parsed as { commitSha: string }).commitSha).toBe('abc1234');
      expect(subagentResult.durationMs).toBe(120000);
    } finally {
      cleanup();
    }
  });
});
