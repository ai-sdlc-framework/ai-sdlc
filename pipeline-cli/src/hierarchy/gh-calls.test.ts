import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, chmodSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultRunner } from '../runtime/exec.js';
import {
  appendGhCall,
  callsPerSession,
  claimQuotaSnapshot,
  failureFields,
  isRateLimitError,
  parseQuotaSnapshot,
  parseResource,
  quotaStampPath,
  ghCallsPath,
  installGhShim,
  lowestRemaining,
  parseQuota,
  parseQuotaFloor,
  parseRemaining,
  redactArgv,
  pruneGhCalls,
  readGhCalls,
  readGhCallsTail,
  ledgerQuota,
  type GhCall,
} from './gh-calls.js';

const tmp = () => mkdtempSync(path.join(tmpdir(), 'gh-calls-'));
/** Ledger lines without the hourly `gh api rate_limit` snapshots. */
const metered = (log: string) => readGhCalls(log).filter((c) => c.argv[1] !== 'rate_limit');
const RATE_LIMIT_JSON =
  '{"resources":{"core":{"limit":5000,"remaining":4321,"reset":1790000000},"graphql":{"limit":5000,"remaining":77,"reset":1790000001}}}';

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
    const calls = metered(log);
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
    const calls = metered(log);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({
      session: 's2',
      argv: ['pr', 'view'],
      exit: 4,
      error: 'boom',
      rateLimited: false,
    });
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
    expect(metered(log)).toEqual([
      expect.objectContaining({ session: 'ex1', argv: ['api', '-i', 'z'], exit: 3, remaining: 7 }),
    ]);
    // A call already logged by the runner is not logged again.
    try {
      execFileSync('gh', ['x'], { env: { ...env, AI_SDLC_GH_CALL_LOGGED: '1' }, stdio: 'pipe' });
    } catch {
      /* exit 3 */
    }
    expect(metered(log)).toHaveLength(1);
    // auth subcommands are logged too.
    try {
      execFileSync('gh', ['auth', 'status'], { env, stdio: 'pipe' });
    } catch {
      /* exit 3 */
    }
    expect(metered(log)[1]).toMatchObject({ argv: ['auth', 'status'], exit: 3 });
  });

  it('a canned rate-limit stderr sets rateLimited and keeps the first line (AISDLC-1439)', async () => {
    const dir = tmp();
    const bin = path.join(dir, 'bin');
    mkdirSync(bin);
    writeFileSync(
      path.join(bin, 'gh'),
      `#!/bin/sh\nif [ "$2" = rate_limit ]; then echo '${RATE_LIMIT_JSON}'; exit 0; fi\n` +
        'printf "\\ngh: API rate limit exceeded for user ID 1.\\nmore\\n" >&2\nexit 1\n',
    );
    chmodSync(path.join(bin, 'gh'), 0o755);
    const log = ghCallsPath(dir);
    vi.stubEnv('AI_SDLC_GH_CALL_LOG', log);
    vi.stubEnv('AI_SDLC_HIERARCHY_SESSION', 'rl');
    vi.stubEnv('PATH', `${bin}:${process.env.PATH}`);
    await defaultRunner('gh', ['pr', 'list'], { allowFailure: true });
    await defaultRunner('gh', ['pr', 'list'], { allowFailure: true });
    const calls = readGhCalls(log);
    expect(calls[0]).toMatchObject({
      argv: ['pr', 'list'],
      exit: 1,
      error: 'gh: API rate limit exceeded for user ID 1.',
      rateLimited: true,
    });
    // One hourly snapshot after the first call, none after the second.
    expect(calls.map((c) => c.argv.join(' '))).toEqual(['pr list', 'api rate_limit', 'pr list']);
    expect(calls[1]!.quota).toEqual({
      core: { remaining: 4321, limit: 5000, reset: 1790000000 },
      graphql: { remaining: 77, limit: 5000, reset: 1790000001 },
    });
    // An explicit rate_limit read is recorded with its quota and renews the stamp.
    await defaultRunner('gh', ['api', 'rate_limit']);
    expect(readGhCalls(log)[3]).toMatchObject({
      argv: ['api', 'rate_limit'],
      quota: { core: { remaining: 4321 } },
    });
  });

  it('the shim records error, rateLimited and one hourly snapshot (AISDLC-1439)', () => {
    const dir = tmp();
    const real = path.join(dir, 'real');
    mkdirSync(real);
    writeFileSync(
      path.join(real, 'gh'),
      `#!/bin/sh\nif [ "$2" = rate_limit ]; then echo '${RATE_LIMIT_JSON}'; exit 0; fi\n` +
        'echo "API rate limit exceeded for installation" >&2\nexit 1\n',
    );
    chmodSync(path.join(real, 'gh'), 0o755);
    const shim = installGhShim(dir);
    const log = ghCallsPath(dir);
    const env = {
      ...process.env,
      PATH: `${shim}:${real}:${process.env.PATH}`,
      AI_SDLC_GH_CALL_LOG: log,
      AI_SDLC_HIERARCHY_SESSION: 'ex/2',
    };
    let stderr = '';
    for (let i = 0; i < 2; i++) {
      try {
        execFileSync('gh', ['issue', 'list'], { env, stdio: 'pipe' });
      } catch (e) {
        stderr = String((e as { stderr: Buffer }).stderr);
      }
    }
    expect(stderr).toContain('API rate limit exceeded');
    const calls = readGhCalls(log);
    expect(calls.map((c) => c.argv.join(' '))).toEqual([
      'issue list',
      'api rate_limit',
      'issue list',
    ]);
    expect(calls[0]).toMatchObject({
      exit: 1,
      error: 'API rate limit exceeded for installation',
      rateLimited: true,
    });
    expect(calls[1]!.quota?.graphql).toEqual({ remaining: 77, limit: 5000, reset: 1790000001 });
    expect(readFileSync(quotaStampPath(log, 'ex/2'), 'utf-8')).toMatch(/^\d{4}-/);
    // A direct rate_limit read through the shim carries its quota.
    execFileSync('gh', ['api', 'rate_limit'], { env, stdio: 'pipe' });
    expect(readGhCalls(log)[3]?.quota?.core?.remaining).toBe(4321);
  });

  it('failure fields, rate-limit text, resource header and snapshot parsing', () => {
    expect(failureFields(0, 'whatever')).toEqual({});
    expect(failureFields(1, '')).toEqual({ rateLimited: false });
    expect(failureFields(1, 'x'.repeat(400)).error).toHaveLength(300);
    expect(isRateLimitError('You have exceeded a secondary rate limit')).toBe(true);
    expect(isRateLimitError('HTTP 404: Not Found')).toBe(false);
    expect(parseResource('X-RateLimit-Resource: graphql\n')).toBe('graphql');
    expect(parseResource('none')).toBeUndefined();
    expect(parseQuotaSnapshot('nope')).toBeUndefined();
    expect(parseQuotaSnapshot('{}')).toBeUndefined();
    expect(parseQuotaSnapshot('{"resources":{"core":{"limit":1}}}')).toBeUndefined();
    expect(parseQuotaSnapshot('{"resources":{"search":{"remaining":3}}}')).toEqual({
      search: { remaining: 3 },
    });
  });

  it('claims the quota snapshot at most once per hour per session', () => {
    const log = ghCallsPath(tmp());
    const t0 = new Date('2026-11-26T10:00:00Z');
    expect(claimQuotaSnapshot(log, 'a', t0)).toBe(true);
    expect(claimQuotaSnapshot(log, 'a', new Date(t0.getTime() + 59 * 60_000))).toBe(false);
    expect(claimQuotaSnapshot(log, 'b', t0)).toBe(true);
    expect(claimQuotaSnapshot(log, 'a', new Date(t0.getTime() + 60 * 60_000))).toBe(true);
    // A stamp from the future (clock skew) does not block forever.
    expect(claimQuotaSnapshot(log, 'b', new Date(t0.getTime() - 60_000))).toBe(true);
    // An unwritable location never throws.
    expect(claimQuotaSnapshot('/dev/null/x/gh-calls.jsonl', 'a', t0)).toBe(false);
  });

  it('prunes to 8 days and counts the last hour per session', () => {
    const dir = tmp();
    const log = ghCallsPath(dir);
    const now = new Date('2026-10-20T12:00:00Z');
    const at = (h: number) => new Date(now.getTime() - h * 3_600_000).toISOString();
    appendGhCall(log, { at: at(200), session: 'a', argv: [], exit: 0 });
    appendGhCall(log, { at: at(30), session: 'c', argv: [], exit: 0 });
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

  it('quota floor: valid override is used, invalid or empty falls back to 300', () => {
    expect(parseQuotaFloor('50')).toBe(50);
    expect(parseQuotaFloor('0')).toBe(0);
    expect(parseQuotaFloor(undefined)).toBe(300);
    expect(parseQuotaFloor('')).toBe(300);
    expect(parseQuotaFloor('abc')).toBe(300);
    expect(parseQuotaFloor('-5')).toBe(300);
    expect(parseQuotaFloor('Infinity')).toBe(300);
  });

  it('redacts header, field and body values from logged argv', () => {
    expect(
      redactArgv(['api', 'x', '-H', 'Authorization: tok', '-f', 'a=b', '--body=hi', '--jq', '.a']),
    ).toEqual(['api', 'x', '-H', '***', '-f', '***', '--body=***', '--jq', '.a']);
  });
});

describe('ledgerQuota (AISDLC-1440)', () => {
  const now = new Date('2026-11-26T12:00:00Z');
  const at = (minAgo: number) => new Date(now.getTime() - minAgo * 60_000).toISOString();
  const line = (c: Partial<GhCall>): GhCall => ({
    at: at(10),
    session: 's',
    argv: ['pr', 'list'],
    exit: 0,
    ...c,
  });
  const reset = now.getTime() / 1000 + 600;

  it('takes the newest snapshot, then newer -i readings in the same window', () => {
    const calls = [
      line({
        at: at(50),
        quota: { core: { remaining: 4000, reset }, graphql: { remaining: 4900 } },
      }),
      line({ at: at(30), remaining: 3500, resource: 'core' }),
      line({ at: at(20), token: 'actions', quota: { core: { remaining: 10 } } }),
      line({ at: at(25), remaining: 9, resource: 'search' }),
    ];
    expect(ledgerQuota(calls, now)).toEqual({ core: 3500, graphql: 4900 });
  });

  it('forgets a bucket whose window has ended and ignores out-of-order or future lines', () => {
    const calls = [
      line({ at: at(5), remaining: 100, resource: 'core' }),
      line({ at: at(90), quota: { core: { remaining: 1 }, graphql: { remaining: 2, reset: 1 } } }),
      line({ at: 'bad', remaining: 1, resource: 'core' }),
      line({
        at: new Date(now.getTime() + 60_000).toISOString(),
        quota: { graphql: { remaining: 7 } },
      }),
    ];
    expect(ledgerQuota(calls, now)).toEqual({ core: 100 });
    expect(ledgerQuota([], now)).toBeUndefined();
    expect(
      ledgerQuota([line({ at: at(90), remaining: 5, resource: 'core' })], now),
    ).toBeUndefined();
  });

  it('reads only the tail of a long log', () => {
    const log = path.join(tmp(), 'gh-calls.jsonl');
    expect(readGhCallsTail(log)).toEqual([]);
    for (let i = 0; i < 50; i++) appendGhCall(log, line({ argv: ['n', String(i)] }));
    const tail = readGhCallsTail(log, 300);
    expect(tail.length).toBeGreaterThan(0);
    expect(tail.length).toBeLessThan(50);
    expect(tail.at(-1)?.argv).toEqual(['n', '49']);
    expect(readGhCallsTail(log)).toHaveLength(50);
  });
});
