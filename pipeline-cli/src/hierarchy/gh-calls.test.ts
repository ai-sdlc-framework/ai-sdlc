import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, chmodSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultRunner } from '../runtime/exec.js';
import {
  appendGhCall,
  callsPerSession,
  ghCallsPath,
  installGhShim,
  lowestRemaining,
  parseQuota,
  parseRemaining,
  pruneGhCalls,
  readGhCalls,
} from './gh-calls.js';

const tmp = () => mkdtempSync(path.join(tmpdir(), 'gh-calls-'));

describe('gh call log (AISDLC-963)', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('a runner gh call writes one line with session, argv and exit', async () => {
    const dir = tmp();
    const bin = path.join(dir, 'bin');
    mkdirSync(bin);
    writeFileSync(path.join(bin, 'gh'), '#!/bin/sh\nprintf "x-ratelimit-remaining: 42\\n"\n');
    chmodSync(path.join(bin, 'gh'), 0o755);
    const log = ghCallsPath(dir);
    vi.stubEnv('AI_SDLC_GH_CALL_LOG', log);
    vi.stubEnv('AI_SDLC_HIERARCHY_SESSION', 's1');
    vi.stubEnv('PATH', `${bin}:${process.env.PATH}`);
    await defaultRunner('gh', ['api', '-i', 'x']);
    const calls = readGhCalls(log);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      session: 's1',
      argv: ['api', '-i', 'x'],
      exit: 0,
      remaining: 42,
    });
  });

  it('logs a failing gh call with its exit status and ignores non-gh commands', async () => {
    const dir = tmp();
    const bin = path.join(dir, 'bin');
    mkdirSync(bin);
    writeFileSync(path.join(bin, 'gh'), '#!/bin/sh\necho boom >&2\nexit 4\n');
    chmodSync(path.join(bin, 'gh'), 0o755);
    const log = ghCallsPath(dir);
    vi.stubEnv('AI_SDLC_GH_CALL_LOG', log);
    vi.stubEnv('AI_SDLC_HIERARCHY_SESSION', 's2');
    vi.stubEnv('PATH', `${bin}:${process.env.PATH}`);
    await defaultRunner('git', ['--version']);
    expect(readGhCalls(log)).toHaveLength(0);
    await expect(defaultRunner('gh', ['pr', 'view'])).rejects.toThrow(/boom/);
    const r = await defaultRunner('gh', ['issue', 'list'], { allowFailure: true });
    expect(r.code).toBe(4);
    const calls = readGhCalls(log);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ session: 's2', argv: ['pr', 'view'], exit: 4 });
    expect(calls[1]).toMatchObject({ argv: ['issue', 'list'], exit: 4 });
  });

  it('the shim logs a direct call once and passes output and exit through', () => {
    const dir = tmp();
    const real = path.join(dir, 'real');
    mkdirSync(real);
    writeFileSync(
      path.join(real, 'gh'),
      '#!/bin/sh\nprintf "x-ratelimit-remaining: 7\\nhi\\n"\nexit 3\n',
    );
    chmodSync(path.join(real, 'gh'), 0o755);
    const shim = installGhShim(dir);
    const log = ghCallsPath(dir);
    const env = {
      ...process.env,
      PATH: `${shim}:${real}:${process.env.PATH}`,
      AI_SDLC_GH_CALL_LOG: log,
      AI_SDLC_HIERARCHY_SESSION: 'ex1',
    };
    let status = 0;
    let out: string;
    try {
      out = execFileSync('gh', ['api', '-i', 'z'], { env, encoding: 'utf-8' });
    } catch (e) {
      status = (e as { status: number }).status;
      out = (e as { stdout: string }).stdout;
    }
    expect(status).toBe(3);
    expect(out).toContain('hi');
    expect(readGhCalls(log)).toEqual([
      expect.objectContaining({ session: 'ex1', argv: ['api', '-i', 'z'], exit: 3, remaining: 7 }),
    ]);
    // A call already logged by the runner is not logged again.
    try {
      execFileSync('gh', ['x'], { env: { ...env, AI_SDLC_GH_CALL_LOGGED: '1' }, stdio: 'pipe' });
    } catch {
      /* exit 3 */
    }
    expect(readGhCalls(log)).toHaveLength(1);
  });

  it('prunes to 24 hours and counts the last hour per session', () => {
    const dir = tmp();
    const log = ghCallsPath(dir);
    const now = new Date('2026-10-20T12:00:00Z');
    const at = (h: number) => new Date(now.getTime() - h * 3_600_000).toISOString();
    appendGhCall(log, { at: at(30), session: 'a', argv: [], exit: 0 });
    appendGhCall(log, { at: at(0.5), session: 'a', argv: [], exit: 0 });
    appendGhCall(log, { at: at(0.2), session: 'b', argv: [], exit: 0 });
    appendGhCall(log, { at: at(5), session: 'b', argv: [], exit: 0 });
    writeFileSync(log, `${readFileSync(log, 'utf-8')}garbage\n`);
    expect(pruneGhCalls(log, now)).toBe(1);
    expect(callsPerSession(readGhCalls(log), now)).toEqual({ a: 1, b: 1 });
  });

  it('parses headers and quota', () => {
    expect(parseRemaining('HTTP/2 200\nX-RateLimit-Remaining: 99\n')).toBe(99);
    expect(parseRemaining('nothing')).toBeUndefined();
    const q = parseQuota('{"resources":{"core":{"remaining":10},"graphql":{"remaining":4}}}');
    expect(q).toEqual({ core: 10, graphql: 4 });
    expect(lowestRemaining(q)).toBe(4);
    expect(lowestRemaining(undefined)).toBeUndefined();
    expect(parseQuota('nope')).toBeUndefined();
    expect(parseQuota('{}')).toBeUndefined();
  });
});
