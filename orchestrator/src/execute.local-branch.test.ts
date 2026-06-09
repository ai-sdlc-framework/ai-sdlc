/**
 * Real-git-repo integration test for local-only branch creation (AISDLC-530 review fix).
 *
 * This file is intentionally kept separate from execute.source-control.test.ts because
 * that file uses a module-level vi.mock('node:child_process') that suppresses all real
 * git calls. This file does NOT mock child_process — it uses a real tmp git repo so that
 * the `git checkout -b <name>` fix is actually exercised.
 *
 * MAJOR fix verified here:
 *   In local-only mode (no 'origin' remote), the pipeline must use `git checkout -b <name>`
 *   to CREATE the branch, not `git checkout <name>` (which assumes the branch already exists).
 *   Prior to the fix, every real local-only run crashed at the checkout step with
 *   "pathspec did not match any file(s)".
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resolve } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';
import { createLocalSourceControl } from './adapters.js';
import { executePipeline } from './execute.js';
import type { AgentRunner, AgentResult } from './runners/types.js';
import type { IssueTracker, Issue, AuditLog } from '@ai-sdlc/reference';
import type { Logger } from './logger.js';

// ── Shared helpers ────────────────────────────────────────────────────

const CONFIG_DIR = resolve(import.meta.dirname, '../../.ai-sdlc');

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: '530',
    title: 'Local-only pipeline test',
    description: [
      '## Description',
      'Local-only mode test for AISDLC-530.',
      '',
      '## Acceptance Criteria',
      '- Pipeline must not crash in local-only mode',
      '',
      '### Complexity',
      '2',
    ].join('\n'),
    status: 'open',
    labels: ['ai-eligible', 'test'],
    url: 'https://example.local/issues/530',
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

function makeMockRunner(result?: Partial<AgentResult>): AgentRunner {
  return {
    run: vi.fn().mockResolvedValue({
      success: true,
      filesChanged: ['src/local.ts', 'src/local.test.ts'],
      summary: 'Local-only pipeline test',
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

// ── Real git repo integration test ────────────────────────────────────

describe('local-only branch creation in real git repo (AISDLC-530 review fix)', () => {
  let tmpDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.GITHUB_TOKEN = 'dummy-test-token';
    process.env.GITLAB_TOKEN = 'dummy-gitlab-token';

    // Create a temporary git repo with an initial commit so `git checkout -b` works.
    // The repo has no 'origin' remote — this is a true local-only repo.
    tmpDir = mkdtempSync(`${tmpdir()}/aisdlc-530-test-`);
    execSync('git init', { cwd: tmpDir, stdio: 'pipe' });
    execSync('git config user.email "test@test.example"', { cwd: tmpDir, stdio: 'pipe' });
    execSync('git config user.name "Test"', { cwd: tmpDir, stdio: 'pipe' });
    // Use --allow-empty so we don't need to create a file first.
    execSync('git commit --allow-empty -m "init"', { cwd: tmpDir, stdio: 'pipe' });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.GITHUB_TOKEN;
    delete process.env.GITLAB_TOKEN;
  });

  it('creates the branch with git checkout -b in a local-only repo without crashing', async () => {
    // Use a local SourceControl adapter — this is the path that was broken.
    // The SC adapter's createBranch is a no-op; execute.ts must create the branch
    // itself using `git checkout -b <name>` (not the bare `git checkout <name>`).
    const sc = createLocalSourceControl();
    const issue = makeIssue();
    const tracker = makeMockTracker(issue);
    const runner = makeMockRunner();
    const auditLog = makeMockAuditLog();
    const log = makeSilentLogger();

    // Prior to the fix, this call would crash with:
    //   "error: pathspec '<branch>' did not match any file(s) known to git"
    // because the branch was never created (createBranch is a no-op) and
    // `git checkout <name>` was used instead of `git checkout -b <name>`.
    const result = await executePipeline('530', {
      configDir: CONFIG_DIR,
      workDir: tmpDir,
      tracker,
      sourceControl: sc,
      runner,
      auditLog,
      logger: log,
    });

    expect(result).toBeDefined();
    expect(result.prUrl).toBe('local');

    // Verify the branch was actually created in the real git repo.
    const branches = execSync('git branch', { cwd: tmpDir, encoding: 'utf8' });
    // The branch pattern interpolated from the pipeline config resolves to something
    // like 'ai-sdlc/issue-530-...' — we just check at least one non-HEAD branch exists.
    expect(branches).toMatch(/ai-sdlc\//);
  });
});
