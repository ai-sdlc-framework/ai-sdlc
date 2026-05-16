/**
 * cli-estimate tests — RFC-0016 Phase 1 (AISDLC-279).
 *
 * Covers AC #5 (degrade-open when the feature flag is disabled) +
 * the JSON / table output shapes.
 *
 * Each test snapshots `process.env`, mutates the flag, runs the CLI
 * via the `buildEstimateCli()` factory (no subprocess spawn), and
 * restores env in afterEach.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildEstimateCli } from './estimate.js';
import { ESTIMATION_FLAG } from '../estimation/feature-flag.js';
import { cleanupTmpProject, makeTmpProject, writeTaskFile } from '../__test-helpers/make-task.js';

const SAVED_ENV = { ...process.env };

let tmp: string;
// `vi.spyOn` return types vary by target signature; cast-to-any is the
// idiomatic shape for "spy on a stream/exit hook with custom impl".
/* eslint-disable @typescript-eslint/no-explicit-any */
let stdoutSpy: any;
let stderrSpy: any;
let exitSpy: any;
/* eslint-enable @typescript-eslint/no-explicit-any */
let stdoutBuf = '';
let stderrBuf = '';

beforeEach(() => {
  tmp = makeTmpProject();
  stdoutBuf = '';
  stderrBuf = '';
  stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
    stdoutBuf += String(chunk);
    return true;
  }) as never);
  stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => {
    stderrBuf += String(chunk);
    return true;
  }) as never);
  // yargs calls process.exit on parse errors — stub to a no-op so the
  // tests don't kill the test runner.
  exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
});

afterEach(() => {
  cleanupTmpProject(tmp);
  stdoutSpy.mockRestore();
  stderrSpy.mockRestore();
  exitSpy.mockRestore();
  process.env = { ...SAVED_ENV };
});

describe('cli-estimate stage-a — degrade-open (AC #5)', () => {
  it('exits 0 with a structured "disabled" JSON when the flag is unset', async () => {
    delete process.env[ESTIMATION_FLAG];
    writeTaskFile(tmp, { id: 'AISDLC-279', title: 'feat: x', references: ['a.ts'] });
    const cli = buildEstimateCli();
    await cli.parseAsync(['stage-a', 'AISDLC-279', '--workdir', tmp]);
    const out = JSON.parse(stdoutBuf.trim()) as {
      ok: boolean;
      disabled: boolean;
      flag: string;
      message: string;
    };
    expect(out.ok).toBe(false);
    expect(out.disabled).toBe(true);
    expect(out.flag).toBe(ESTIMATION_FLAG);
    expect(stderrBuf).toContain('disabled');
    // process.exit MUST NOT have been called with non-zero — the CLI
    // degrades open (exit 0) so scripted callers don't crash.
    const nonZeroExits = (exitSpy.mock.calls as unknown[][]).filter(
      (call) => call[0] !== undefined && call[0] !== 0,
    );
    expect(nonZeroExits).toHaveLength(0);
  });

  it('exits 0 + emits JSON when the flag is "experimental" + a valid task', async () => {
    process.env[ESTIMATION_FLAG] = 'experimental';
    writeTaskFile(tmp, { id: 'AISDLC-280', title: 'feat: x', references: ['a.ts'] });
    const cli = buildEstimateCli();
    await cli.parseAsync(['stage-a', 'AISDLC-280', '--workdir', tmp]);
    const out = JSON.parse(stdoutBuf.trim()) as {
      taskId: string;
      taskClass: string;
      signals: { id: number }[];
      candidateBucket: string;
    };
    expect(out.taskId).toBe('AISDLC-280');
    expect(out.taskClass).toBe('feature');
    expect(out.signals).toHaveLength(9);
    expect(typeof out.candidateBucket).toBe('string');
  });

  it('emits the table format when --format table is passed', async () => {
    process.env[ESTIMATION_FLAG] = 'experimental';
    writeTaskFile(tmp, { id: 'AISDLC-281', title: 'fix: y', references: ['a.ts'] });
    const cli = buildEstimateCli();
    await cli.parseAsync(['stage-a', 'AISDLC-281', '--workdir', tmp, '--format', 'table']);
    expect(stdoutBuf).toContain('Task:');
    expect(stdoutBuf).toContain('Class:');
    expect(stdoutBuf).toContain('Bucket:');
    expect(stdoutBuf).toContain('file scope count');
    expect(stdoutBuf).toContain('class-default fallback');
  });

  it('fails with a non-zero exit when the task does not exist (flag enabled)', async () => {
    process.env[ESTIMATION_FLAG] = 'experimental';
    const cli = buildEstimateCli();
    await cli.parseAsync(['stage-a', 'AISDLC-NOPE', '--workdir', tmp]);
    expect(stderrBuf).toMatch(/task file not found/);
    const nonZeroExits = (exitSpy.mock.calls as unknown[][]).filter(
      (call) => call[0] !== undefined && call[0] !== 0,
    );
    expect(nonZeroExits.length).toBeGreaterThan(0);
  });
});
