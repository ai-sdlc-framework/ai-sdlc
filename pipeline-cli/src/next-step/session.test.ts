import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeHarness, type Harness } from '../__test-helpers/next-step-fixtures.js';
import { ok } from '../__test-helpers/fake-runner.js';
import {
  UPDATE_SESSION_STATE_LIB,
  checkCancelSignal,
  recordSessionPr,
  updateSessionState,
} from './session.js';

let h: Harness;
let sessions: string;
beforeEach(() => {
  h = makeHarness();
  sessions = join(h.root, '.ai-sdlc', 'dispatch', 'sessions');
  mkdirSync(sessions, { recursive: true });
});
afterEach(() => h.cleanup());

const sessionFile = (): string => join(sessions, 'aisdlc-900.session.json');

describe('updateSessionState', () => {
  it('delegates to the canonical shell lib when a session file exists', async () => {
    writeFileSync(sessionFile(), '{}');
    h.present.add(join(h.ctx.pluginScriptsDir, UPDATE_SESSION_STATE_LIB));
    h.runner.on(/^bash -c/, ok(''));
    await updateSessionState(h.ctx, 'aisdlc-900', '05-dev-running');
    const call = h.runner.calls[0];
    expect(call.command).toBe('bash');
    expect(call.args.slice(-3)).toEqual([
      join(h.ctx.pluginScriptsDir, UPDATE_SESSION_STATE_LIB),
      'aisdlc-900',
      '05-dev-running',
    ]);
  });

  it('is a no-op for a standalone run (no session file)', async () => {
    h.present.add(join(h.ctx.pluginScriptsDir, UPDATE_SESSION_STATE_LIB));
    await updateSessionState(h.ctx, 'aisdlc-900', 'x');
    expect(h.runner.calls).toHaveLength(0);
  });

  it('is a no-op when the lib is not shipped', async () => {
    writeFileSync(sessionFile(), '{}');
    await updateSessionState(h.ctx, 'aisdlc-900', 'x');
    expect(h.runner.calls).toHaveLength(0);
  });
});

describe('checkCancelSignal (AISDLC-481)', () => {
  it('returns false and touches nothing without a signal', () => {
    expect(checkCancelSignal(h.ctx, 'aisdlc-900', 'AISDLC-900')).toBe(false);
  });

  it('marks the session cancelled, removes the signal and writes a board diagnostic', () => {
    writeFileSync(sessionFile(), JSON.stringify({ taskId: 'AISDLC-900', status: 'in-progress' }));
    const cancel = join(sessions, 'aisdlc-900.cancel.json');
    writeFileSync(cancel, JSON.stringify({ reason: 'operator said stop', decisionId: 'DEC-1' }));
    expect(checkCancelSignal(h.ctx, 'aisdlc-900', 'AISDLC-900')).toBe(true);
    expect(existsSync(cancel)).toBe(false);
    expect(JSON.parse(readFileSync(sessionFile(), 'utf8')).status).toBe('cancelled');
    const diag = JSON.parse(
      readFileSync(
        join(h.root, '.ai-sdlc', 'dispatch', 'failed', 'AISDLC-900.diagnostic.json'),
        'utf8',
      ),
    );
    expect(diag).toMatchObject({
      cause: 'operator-cancel',
      outcome: 'failed',
      taskId: 'AISDLC-900',
    });
    expect(diag.notes).toContain('operator said stop');
    expect(diag.notes).toContain('decision-id: DEC-1');
  });

  it('still cancels with an unreadable signal and no session file', () => {
    writeFileSync(join(sessions, 'aisdlc-900.cancel.json'), 'not json');
    expect(checkCancelSignal(h.ctx, 'aisdlc-900', 'AISDLC-900')).toBe(true);
  });
});

describe('recordSessionPr', () => {
  it('records the PR on an existing session file', () => {
    writeFileSync(sessionFile(), JSON.stringify({ status: 'starting' }));
    recordSessionPr(h.ctx, 'aisdlc-900', 'https://github.com/o/r/pull/42');
    const s = JSON.parse(readFileSync(sessionFile(), 'utf8'));
    expect(s).toMatchObject({
      prUrl: 'https://github.com/o/r/pull/42',
      prNumber: 42,
      currentStep: '11b-pr-opened',
      status: 'in-progress',
    });
  });

  it('is a no-op without a session file', () => {
    expect(() =>
      recordSessionPr(h.ctx, 'aisdlc-900', 'https://github.com/o/r/pull/42'),
    ).not.toThrow();
  });
});
