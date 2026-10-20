import { describe, expect, it } from 'vitest';

import { gateRunListArgs, parseGateRunId, resolveGateRunId } from './gate-run.js';
import type { CommandRunner } from './types.js';

describe('gate-run (AISDLC-983)', () => {
  it('lists the gate workflow for the commit', () => {
    expect(gateRunListArgs('abc')).toEqual(
      expect.arrayContaining(['--commit', 'abc', '--workflow', 'ai-sdlc-gate.yml']),
    );
  });

  it('accepts only a numeric run id', () => {
    expect(parseGateRunId('123\n')).toBe('123');
    expect(parseGateRunId('null')).toBeUndefined();
    expect(parseGateRunId('')).toBeUndefined();
    expect(parseGateRunId(undefined)).toBeUndefined();
  });

  it('resolves the id through the runner and fails closed', () => {
    const ok: CommandRunner = () => ({ status: 0, stdout: '77\n', stderr: '' });
    const bad: CommandRunner = () => ({ status: 1, stdout: '77', stderr: 'x' });
    expect(resolveGateRunId(ok, '/w', 'abc')).toBe('77');
    expect(resolveGateRunId(bad, '/w', 'abc')).toBeUndefined();
  });
});
