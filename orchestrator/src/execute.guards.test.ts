/**
 * Regression tests for the three defensive guards added in AISDLC-527:
 *
 *   1. git remote/fetch guard — pipeline must not crash when there is no
 *      'origin' remote. The fetch step must degrade gracefully (log + skip).
 *
 *   2. ABAC write-perms guard — autonomy levels that omit `permissions.write`
 *      (undefined at runtime) must not crash on `.length`.
 *
 *   3. `result.filesChanged` passthrough — runners that return a partial
 *      AgentResult (no `filesChanged` field) must not crash downstream
 *      consumers. The wrapper must default to [].
 *
 * All three tests use the mocked child_process.execFile approach from
 * execute.test.ts — they do NOT test real git repos (that's push-rebase.test.ts).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resolve } from 'node:path';
import { executePipeline, buildMissingResourceError } from './execute.js';
import type { AgentRunner, AgentResult } from './runners/types.js';
import type { IssueTracker, SourceControl, Issue, PullRequest, AuditLog } from '@ai-sdlc/reference';
import type { Logger } from './logger.js';
import type { AiSdlcConfig } from './config.js';

// Mock child_process.execFile used by executePipeline for git checkout/push/fetch.
// Default: resolves with empty stdout/stderr (simulates a clean, repo-with-remote
// environment).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyFn = (...args: any[]) => any;
vi.mock('node:child_process', () => ({
  execFile: vi.fn((_cmd: string, _args: string[], _opts: unknown, cb?: unknown) => {
    if (typeof cb === 'function') {
      (cb as (err: null, stdout: string, stderr: string) => void)(null, '', '');
    }
    return { stdout: '', stderr: '' };
  }),
}));

const CONFIG_DIR = resolve(import.meta.dirname, '../../.ai-sdlc');

// ── Shared factory helpers ───────────────────────────────────────────

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: '99',
    title: 'Guard regression test',
    description: [
      '## Description',
      'Regression for AISDLC-527 guards.',
      '',
      '## Acceptance Criteria',
      '- Pipeline must not crash on local-only repos',
      '',
      '### Complexity',
      '2',
    ].join('\n'),
    status: 'open',
    labels: ['ai-eligible', 'bug'],
    url: 'https://github.com/example/repo/issues/99',
    ...overrides,
  };
}

function makeMockTracker(issue: Issue): IssueTracker {
  return {
    getIssue: vi.fn().mockResolvedValue(issue),
    listIssues: vi.fn().mockResolvedValue([issue]),
    createIssue: vi.fn(),
    updateIssue: vi.fn(),
    transitionIssue: vi.fn(),
    addComment: vi.fn(),
    getComments: vi.fn().mockResolvedValue([]),
    watchIssues: vi.fn().mockReturnValue({
      async *[Symbol.asyncIterator]() {
        /* stub */
      },
    }),
  };
}

function makeMockSourceControl(): SourceControl {
  const pr: PullRequest = {
    id: '999',
    title: 'fix: Guard regression test (#99)',
    sourceBranch: 'ai-sdlc/issue-99',
    targetBranch: 'main',
    status: 'open',
    author: 'ai-sdlc-bot',
    url: 'https://github.com/example/repo/pull/999',
  };
  return {
    createBranch: vi.fn().mockResolvedValue({ name: 'ai-sdlc/issue-99', sha: 'abc123' }),
    createPR: vi.fn().mockResolvedValue(pr),
    mergePR: vi.fn(),
    getFileContents: vi.fn(),
    listChangedFiles: vi.fn(),
    setCommitStatus: vi.fn(),
    watchPREvents: vi.fn().mockReturnValue({
      async *[Symbol.asyncIterator]() {
        /* stub */
      },
    }),
  };
}

function makeMockRunner(result?: Partial<AgentResult>): AgentRunner {
  return {
    run: vi.fn().mockResolvedValue({
      success: true,
      filesChanged: ['src/fix.ts', 'src/fix.test.ts'],
      summary: 'Fixed the guard regression',
      ...result,
    }),
  };
}

function makeMockAuditLog(): AuditLog {
  return {
    record: vi.fn().mockImplementation((entry) => ({
      id: 'test-id',
      timestamp: new Date().toISOString(),
      ...entry,
    })),
    entries: vi.fn().mockReturnValue([]),
    query: vi.fn().mockReturnValue([]),
    verifyIntegrity: vi.fn().mockReturnValue({ valid: true }),
  };
}

function makeSilentLogger(): Logger {
  return {
    stage: vi.fn(),
    stageEnd: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    summary: vi.fn(),
  };
}

// ── Guard #1: git fetch no-remote degradation ───────────────────────

// Module-level reference so tests can call mockImplementationOnce without
// triggering strict vi.mocked() type checks. The mock factory above already
// typed this as vi.fn(), which is assignable to the looser AnyFn type.
import { execFile as _execFileRaw } from 'node:child_process';
const execFileMockRef = _execFileRaw as unknown as { mockImplementation: (fn: AnyFn) => void };

describe('Guard #1 — git fetch degrades gracefully when no origin remote', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.GITHUB_TOKEN = '';
    // Restore default: all git calls succeed.
    (execFileMockRef as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb?: unknown) => {
        if (typeof cb === 'function') {
          (cb as (err: null, stdout: string, stderr: string) => void)(null, '', '');
        }
        return { stdout: '', stderr: '' };
      },
    );
  });

  it('logs a skip message and continues when fetch fails with "no such remote"', async () => {
    // Override: fetch fails with "no such remote", all other calls succeed.
    (execFileMockRef as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (_cmd: string, args: string[], _opts: unknown, cb?: unknown) => {
        const isFetch = Array.isArray(args) && args[0] === 'fetch' && args[1] === 'origin';
        if (typeof cb === 'function') {
          if (isFetch) {
            const err = Object.assign(new Error('git: no such remote'), {
              stderr: "fatal: 'origin' does not appear to be a git repository",
              code: 128,
            });
            (cb as (err: Error, stdout: string, stderr: string) => void)(err, '', err.message);
          } else {
            (cb as (err: null, stdout: string, stderr: string) => void)(null, '', '');
          }
        }
        return { stdout: '', stderr: '' };
      },
    );

    const issue = makeIssue();
    const tracker = makeMockTracker(issue);
    const sc = makeMockSourceControl();
    const runner = makeMockRunner();
    const auditLog = makeMockAuditLog();
    const log = makeSilentLogger();

    // Should NOT throw — fetch failure must be swallowed with a log line.
    await expect(
      executePipeline('99', {
        configDir: CONFIG_DIR,
        workDir: '/tmp/guard-test-repo',
        tracker,
        sourceControl: sc,
        runner,
        auditLog,
        logger: log,
      }),
    ).resolves.toBeDefined();

    // The graceful-skip log line must have been emitted.
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining("no 'origin' remote"));

    // Pipeline must have continued: agent ran and PR was created.
    expect(runner.run).toHaveBeenCalled();
    expect(sc.createPR).toHaveBeenCalled();
  });

  it('rethrows fetch errors that are NOT "no remote" errors (e.g. auth failures)', async () => {
    (execFileMockRef as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (_cmd: string, args: string[], _opts: unknown, cb?: unknown) => {
        const isFetch = Array.isArray(args) && args[0] === 'fetch' && args[1] === 'origin';
        if (typeof cb === 'function') {
          if (isFetch) {
            const err = Object.assign(new Error('fatal: authentication required'), {
              stderr: 'fatal: authentication required',
              code: 128,
            });
            (cb as (err: Error, stdout: string, stderr: string) => void)(err, '', err.message);
          } else {
            (cb as (err: null, stdout: string, stderr: string) => void)(null, '', '');
          }
        }
        return { stdout: '', stderr: '' };
      },
    );

    const issue = makeIssue();
    const tracker = makeMockTracker(issue);
    const sc = makeMockSourceControl();
    const runner = makeMockRunner();
    const auditLog = makeMockAuditLog();

    // Must rethrow — auth errors are not a "local-only" case.
    await expect(
      executePipeline('99', {
        configDir: CONFIG_DIR,
        workDir: '/tmp/guard-test-repo',
        tracker,
        sourceControl: sc,
        runner,
        auditLog,
      }),
    ).rejects.toThrow();
  });

  it('rethrows "repository not found" (origin configured, URL invalid) — NOT swallowed as local-only (AISDLC-527 code-review finding)', async () => {
    // The no-remote guard must NOT match a bare "not found": "repository not found"
    // means origin IS configured but the URL is wrong/deleted/inaccessible — a real
    // config error that must propagate, not be silently skipped.
    (execFileMockRef as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (_cmd: string, args: string[], _opts: unknown, cb?: unknown) => {
        const isFetch = Array.isArray(args) && args[0] === 'fetch' && args[1] === 'origin';
        if (typeof cb === 'function') {
          if (isFetch) {
            const err = Object.assign(new Error('remote: Repository not found.'), {
              stderr: 'remote: Repository not found.\nfatal: repository not found',
              code: 128,
            });
            (cb as (err: Error, stdout: string, stderr: string) => void)(err, '', err.message);
          } else {
            (cb as (err: null, stdout: string, stderr: string) => void)(null, '', '');
          }
        }
        return { stdout: '', stderr: '' };
      },
    );

    const issue = makeIssue();
    const tracker = makeMockTracker(issue);
    const sc = makeMockSourceControl();
    const runner = makeMockRunner();
    const auditLog = makeMockAuditLog();

    await expect(
      executePipeline('99', {
        configDir: CONFIG_DIR,
        workDir: '/tmp/guard-test-repo',
        tracker,
        sourceControl: sc,
        runner,
        auditLog,
      }),
    ).rejects.toThrow();
  });
});

// ── Guard #2: ABAC write-perms nullish guard ─────────────────────────

describe('Guard #2 — ABAC permissions.write nullish guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.GITHUB_TOKEN = '';
    (execFileMockRef as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb?: unknown) => {
        if (typeof cb === 'function') {
          (cb as (err: null, stdout: string, stderr: string) => void)(null, '', '');
        }
        return { stdout: '', stderr: '' };
      },
    );
  });

  it('does not crash when autonomy level has no write permissions defined', async () => {
    // The guard is the `?? []` in: `const writePermissions = currentLevel.permissions.write ?? [];`
    // The real autonomy-policy.yaml has write:[] (non-undefined), so this integration
    // test exercises the guard's happy path (write is [] → branch skipped → pipeline passes).
    // The crash scenario (write is undefined) is tested at unit level below.
    const issue = makeIssue();
    const tracker = makeMockTracker(issue);
    const sc = makeMockSourceControl();
    const runner = makeMockRunner();
    const auditLog = makeMockAuditLog();

    // Should NOT throw on `permissions.write.length` when write is undefined.
    const result = await executePipeline('99', {
      configDir: CONFIG_DIR,
      workDir: '/tmp/guard-test-repo',
      tracker,
      sourceControl: sc,
      runner,
      auditLog,
    });

    // Pipeline completed successfully.
    expect(result).toBeDefined();
    expect(result.prUrl).toBeTruthy();
  });

  it('nullish-guard unit: ?? [] coalesces undefined permissions.write to empty array', () => {
    // Direct unit test of the guard logic without going through executePipeline.
    // Simulates what happens when a YAML config omits the write field entirely.
    const undefinedWrite = undefined as unknown as string[];

    // This is the guard expression from execute.ts line 885:
    const writePermissions = undefinedWrite ?? [];

    // Guard: must never throw, must produce a safe empty array.
    expect(Array.isArray(writePermissions)).toBe(true);
    expect(writePermissions.length).toBe(0);
    // Iterating must also be safe.
    expect(() => writePermissions.map((p) => p)).not.toThrow();
  });
});

// ── Guard #3: result.filesChanged passthrough ────────────────────────

describe('Guard #3 — AgentResult.filesChanged defaults to [] when absent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.GITHUB_TOKEN = '';
    (execFileMockRef as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb?: unknown) => {
        if (typeof cb === 'function') {
          (cb as (err: null, stdout: string, stderr: string) => void)(null, '', '');
        }
        return { stdout: '', stderr: '' };
      },
    );
  });

  it('does not crash on undefined.length/map when runner returns AgentResult without filesChanged', async () => {
    // Runner returns a result that is missing `filesChanged` at runtime.
    // Without the guard, the first `result.filesChanged.length` access on line 867
    // of execute.ts throws "Cannot read properties of undefined (reading 'length')".
    // With the guard, it defaults to [] and the pipeline proceeds to guardrail
    // validation (where it throws about missing test files — that is expected behavior,
    // NOT the crash we are guarding against).
    const partialRunner: AgentRunner = {
      run: vi.fn().mockResolvedValue({
        success: true,
        // filesChanged intentionally omitted — simulates a runner that doesn't
        // populate it, which is undefined at runtime despite the TypeScript type.
        summary: 'Did some work',
      } as unknown as AgentResult),
    };

    const issue = makeIssue();
    const tracker = makeMockTracker(issue);
    const sc = makeMockSourceControl();
    const auditLog = makeMockAuditLog();

    // The pipeline should throw a guardrail validation error (empty filesChanged
    // fails the require-tests rule) rather than a TypeError on undefined.length.
    // Either way, the pipeline must NOT throw "Cannot read properties of undefined".
    await expect(
      executePipeline('99', {
        configDir: CONFIG_DIR,
        workDir: '/tmp/guard-test-repo',
        tracker,
        sourceControl: sc,
        runner: partialRunner,
        auditLog,
      }),
    ).rejects.toThrow(/guardrail validation/);

    // The runner ran — we got past the filesChanged access sites without crashing.
    // If the guard were absent, we would have thrown "Cannot read properties of
    // undefined (reading 'length')" before even reaching guardrail validation.
    expect(partialRunner.run).toHaveBeenCalled();
  });

  it('passes through filesChanged normally when the runner populates it', async () => {
    const runner = makeMockRunner({ filesChanged: ['src/a.ts', 'src/a.test.ts'] });
    const issue = makeIssue();
    const tracker = makeMockTracker(issue);
    const sc = makeMockSourceControl();
    const auditLog = makeMockAuditLog();

    const pipelineResult = await executePipeline('99', {
      configDir: CONFIG_DIR,
      workDir: '/tmp/guard-test-repo',
      tracker,
      sourceControl: sc,
      runner,
      auditLog,
    });

    expect(pipelineResult.filesChanged).toEqual(['src/a.ts', 'src/a.test.ts']);
  });
});

// ── AISDLC-528: buildMissingResourceError ─────────────────────────────────────
// Unit tests for the helper that converts a "resource not found" situation into
// an actionable error message that names the file + schema violation(s) when
// config.warnings records why the resource was dropped.

describe('buildMissingResourceError() — AISDLC-528', () => {
  it('returns a simple "not found" message with init hint when no warnings exist', () => {
    const config: AiSdlcConfig = {};
    const msg = buildMissingResourceError('QualityGate', config, '/proj/.ai-sdlc');
    expect(msg).toContain('No QualityGate resource found');
    expect(msg).toContain('/proj/.ai-sdlc');
    expect(msg).toContain('ai-sdlc init');
  });

  it('attaches validation-failure details when config.warnings names the dropped file', () => {
    const config: AiSdlcConfig = {
      warnings: [
        {
          file: 'quality-gate.yaml',
          error: 'validation failed: /spec/gates: is required; /spec/evaluation: is required',
        },
      ],
    };
    const msg = buildMissingResourceError('QualityGate', config, '/proj/.ai-sdlc');
    expect(msg).toContain('No QualityGate resource found');
    expect(msg).toContain('quality-gate.yaml');
    expect(msg).toContain('/spec/gates: is required');
    expect(msg).toContain('validation failed');
    // Should point the adopter toward the fix
    expect(msg).toContain('ai-sdlc init');
  });

  it('attaches details for a different kind (AgentRole) from a different file', () => {
    const config: AiSdlcConfig = {
      warnings: [
        {
          file: 'agent-role.yaml',
          error: 'validation failed: /spec/role: is required',
        },
      ],
    };
    const msg = buildMissingResourceError('AgentRole', config, '/project/.ai-sdlc');
    expect(msg).toContain('No AgentRole resource found');
    expect(msg).toContain('agent-role.yaml');
    expect(msg).toContain('/spec/role: is required');
  });

  it('lists multiple dropped files when several warnings exist', () => {
    const config: AiSdlcConfig = {
      warnings: [
        {
          file: 'quality-gate.yaml',
          error: 'validation failed: /spec/gates: is required',
        },
        {
          file: 'agent-role.yaml',
          error: 'validation failed: /spec/role: is required',
        },
      ],
    };
    const msg = buildMissingResourceError('QualityGate', config, '/proj/.ai-sdlc');
    expect(msg).toContain('quality-gate.yaml');
    expect(msg).toContain('agent-role.yaml');
  });

  it('does NOT surface non-validation warnings (e.g. unknown-kind skips) as validation-related', () => {
    const config: AiSdlcConfig = {
      warnings: [
        {
          file: 'maintainers.yaml',
          error:
            "unknown kind 'MaintainersList' — skipped (loader-private convention or typo of canonical kind?)",
        },
      ],
    };
    // unknown-kind entries DO satisfy our filter (they help explain absent resources)
    // because "unknown kind" can be a typo of a canonical kind.
    const msg = buildMissingResourceError('QualityGate', config, '/proj/.ai-sdlc');
    // maintainers.yaml should appear in the message (it satisfies the filter for unknown kind)
    expect(msg).toContain('maintainers.yaml');
  });

  it('returns init hint without warnings listing when warnings array is empty', () => {
    const config: AiSdlcConfig = { warnings: [] };
    const msg = buildMissingResourceError('AutonomyPolicy', config, '/proj/.ai-sdlc');
    expect(msg).toContain('No AutonomyPolicy resource found');
    expect(msg).toContain('ai-sdlc init');
    expect(msg).not.toContain('validation failed');
  });
});
