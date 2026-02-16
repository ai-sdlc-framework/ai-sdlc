import { describe, it, expect, vi } from 'vitest';
import {
  BRANCH_PATTERN,
  extractIssueNumber,
  getGitHubConfig,
  resolveAutonomyLevel,
  mergeBlockedPaths,
  resolveConstraints,
  isAutonomousStrategy,
  recordMetric,
  validateAndAuditOutput,
  evaluatePipelineCompliance,
  authorizeFilesChanged,
  interpolateBranchPattern,
  interpolatePRTitle,
  createPipelineAuthorizationChain,
  createAbacPermissionHook,
  createBlockedPathsHook,
  createAuditLoggingHook,
} from './shared.js';
import type { AutonomyPolicy, AuditLog, MetricStore, AuthorizationHook } from '@ai-sdlc/reference';

// ── Fixtures ─────────────────────────────────────────────────────────

function makePolicy(levels: Array<{ level: number; blockedPaths?: string[] }>): AutonomyPolicy {
  return {
    apiVersion: 'ai-sdlc.io/v1alpha1',
    kind: 'AutonomyPolicy',
    metadata: { name: 'test-policy' },
    spec: {
      levels: levels.map((l) => ({
        level: l.level,
        name: `Level ${l.level}`,
        permissions: { read: ['**'], write: ['src/**', 'tests/**'], execute: ['npm'] },
        guardrails: {
          requireApproval: 'none' as const,
          blockedPaths: l.blockedPaths ?? ['.github/workflows/**'],
        },
        monitoring: 'audit-log' as const,
      })),
      promotionCriteria: {},
      demotionTriggers: [],
    },
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

function makeSilentLogger() {
  return {
    stage: vi.fn(),
    stageEnd: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    summary: vi.fn(),
  };
}

// ── Tests ────────────────────────────────────────────────────────────

describe('BRANCH_PATTERN', () => {
  it('matches ai-sdlc/issue-42', () => {
    expect(BRANCH_PATTERN.test('ai-sdlc/issue-42')).toBe(true);
  });

  it('rejects feature/something', () => {
    expect(BRANCH_PATTERN.test('feature/something')).toBe(false);
  });
});

describe('extractIssueNumber()', () => {
  it('returns the issue number for valid branch', () => {
    expect(extractIssueNumber('ai-sdlc/issue-42')).toBe(42);
  });

  it('returns null for non-matching branch', () => {
    expect(extractIssueNumber('feature/something')).toBeNull();
  });

  it('returns null for partial match', () => {
    expect(extractIssueNumber('ai-sdlc/issue-')).toBeNull();
  });
});

describe('getGitHubConfig()', () => {
  it('reads from environment variables', () => {
    const origOwner = process.env.GITHUB_REPOSITORY_OWNER;
    const origRepo = process.env.GITHUB_REPOSITORY;
    const origToken = process.env.GITHUB_TOKEN;

    process.env.GITHUB_REPOSITORY_OWNER = 'test-org';
    process.env.GITHUB_REPOSITORY = 'test-org/test-repo';
    process.env.GITHUB_TOKEN = 'ghp_test123';

    try {
      const config = getGitHubConfig();
      expect(config.org).toBe('test-org');
      expect(config.repo).toBe('test-repo');
      expect(config.token).toBe('ghp_test123');
    } finally {
      process.env.GITHUB_REPOSITORY_OWNER = origOwner;
      process.env.GITHUB_REPOSITORY = origRepo;
      process.env.GITHUB_TOKEN = origToken;
    }
  });

  it('returns defaults when env vars are missing', () => {
    const origOwner = process.env.GITHUB_REPOSITORY_OWNER;
    const origRepo = process.env.GITHUB_REPOSITORY;
    const origToken = process.env.GITHUB_TOKEN;

    delete process.env.GITHUB_REPOSITORY_OWNER;
    delete process.env.GITHUB_REPOSITORY;
    delete process.env.GITHUB_TOKEN;

    try {
      const config = getGitHubConfig();
      expect(config.org).toBe('');
      expect(config.repo).toBe('');
      expect(config.token).toBeUndefined();
    } finally {
      process.env.GITHUB_REPOSITORY_OWNER = origOwner;
      process.env.GITHUB_REPOSITORY = origRepo;
      process.env.GITHUB_TOKEN = origToken;
    }
  });
});

describe('resolveAutonomyLevel()', () => {
  it('finds level 0', () => {
    const policy = makePolicy([{ level: 0 }, { level: 1 }, { level: 2 }]);
    const level = resolveAutonomyLevel(policy, 1);
    expect(level.level).toBe(0);
  });

  it('throws when no matching level exists', () => {
    const policy = makePolicy([{ level: 5 }]);
    expect(() => resolveAutonomyLevel(policy, 1)).toThrow('No autonomy level');
  });
});

describe('mergeBlockedPaths()', () => {
  it('deduplicates blocked paths', () => {
    const merged = mergeBlockedPaths(
      { blockedPaths: ['.github/**', '.ai-sdlc/**'] },
      { blockedPaths: ['.github/**', 'secrets/**'] },
    );
    expect(merged).toEqual(['.github/**', '.ai-sdlc/**', 'secrets/**']);
  });

  it('handles missing arrays', () => {
    const merged = mergeBlockedPaths({}, {});
    expect(merged).toEqual([]);
  });
});

describe('resolveConstraints()', () => {
  it('merges with defaults when no constraints provided', () => {
    const policy = makePolicy([{ level: 1, blockedPaths: ['.github/**'] }]);
    const level = resolveAutonomyLevel(policy);
    const resolved = resolveConstraints(undefined, level);
    expect(resolved.maxFiles).toBe(15);
    expect(resolved.requireTests).toBe(true);
    expect(resolved.blockedPaths).toContain('.github/**');
  });

  it('uses agent constraints when provided', () => {
    const policy = makePolicy([{ level: 1, blockedPaths: ['.github/**'] }]);
    const level = resolveAutonomyLevel(policy);
    const resolved = resolveConstraints(
      { maxFilesPerChange: 5, requireTests: false, blockedPaths: ['.ai-sdlc/**'] },
      level,
    );
    expect(resolved.maxFiles).toBe(5);
    expect(resolved.requireTests).toBe(false);
    expect(resolved.blockedPaths).toContain('.ai-sdlc/**');
    expect(resolved.blockedPaths).toContain('.github/**');
  });
});

describe('isAutonomousStrategy()', () => {
  it('returns true for fully-autonomous', () => {
    expect(isAutonomousStrategy('fully-autonomous')).toBe(true);
  });

  it('returns true for ai-with-review', () => {
    expect(isAutonomousStrategy('ai-with-review')).toBe(true);
  });

  it('returns false for human-led', () => {
    expect(isAutonomousStrategy('human-led')).toBe(false);
  });

  it('returns false for ai-assisted', () => {
    expect(isAutonomousStrategy('ai-assisted')).toBe(false);
  });
});

describe('recordMetric()', () => {
  it('records to store when provided', () => {
    const store = { record: vi.fn() } as unknown as MetricStore;
    recordMetric(store, 'test.metric', 42);
    expect(store.record).toHaveBeenCalledWith({ metric: 'test.metric', value: 42 });
  });

  it('no-ops when store is undefined', () => {
    // Should not throw
    recordMetric(undefined, 'test.metric', 42);
  });
});

describe('validateAndAuditOutput()', () => {
  it('records allowed when validation passes', async () => {
    const auditLog = makeMockAuditLog();
    await validateAndAuditOutput({
      filesChanged: ['src/fix.ts', 'src/fix.test.ts'],
      workDir: '/tmp/test',
      constraints: { maxFilesPerChange: 15, requireTests: true, blockedPaths: [] },
      guardrails: {},
      auditLog,
      log: makeSilentLogger(),
    });
    expect(auditLog.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'check', decision: 'allowed' }),
    );
  });

  it('throws and calls onViolation when validation fails', async () => {
    const auditLog = makeMockAuditLog();
    const onViolation = vi.fn();
    await expect(
      validateAndAuditOutput({
        filesChanged: ['.github/workflows/ci.yml', 'src/fix.test.ts'],
        workDir: '/tmp/test',
        constraints: {
          maxFilesPerChange: 15,
          requireTests: true,
          blockedPaths: ['.github/workflows/**'],
        },
        guardrails: {},
        auditLog,
        log: makeSilentLogger(),
        onViolation,
      }),
    ).rejects.toThrow('guardrail validation');
    expect(onViolation).toHaveBeenCalled();
  });
});

describe('evaluatePipelineCompliance()', () => {
  it('returns compliance reports for all frameworks', () => {
    const reports = evaluatePipelineCompliance(false);
    expect(reports.length).toBeGreaterThan(0);
    for (const report of reports) {
      expect(report).toHaveProperty('framework');
      expect(report).toHaveProperty('coveragePercent');
    }
  });

  it('includes agent-memory control when hasMemory is true', () => {
    const reports = evaluatePipelineCompliance(true);
    // Coverage should be equal or higher with memory
    const reportsWithout = evaluatePipelineCompliance(false);
    const avgWith = reports.reduce((s, r) => s + r.coveragePercent, 0) / reports.length;
    const avgWithout =
      reportsWithout.reduce((s, r) => s + r.coveragePercent, 0) / reportsWithout.length;
    expect(avgWith).toBeGreaterThanOrEqual(avgWithout);
  });
});

describe('interpolateBranchPattern()', () => {
  it('interpolates pattern with variables', () => {
    expect(interpolateBranchPattern('ai-sdlc/issue-{issueNumber}', { issueNumber: '42' })).toBe(
      'ai-sdlc/issue-42',
    );
  });

  it('uses default pattern when none provided', () => {
    expect(interpolateBranchPattern(undefined, { issueNumber: '7' })).toBe('ai-sdlc/issue-7');
  });

  it('leaves unknown placeholders intact', () => {
    expect(interpolateBranchPattern('feat/{unknown}', {})).toBe('feat/{unknown}');
  });
});

describe('interpolatePRTitle()', () => {
  it('interpolates template with variables', () => {
    expect(
      interpolatePRTitle('fix: {issueTitle} (#{issueNumber})', {
        issueTitle: 'Fix bug',
        issueNumber: '42',
      }),
    ).toBe('fix: Fix bug (#42)');
  });

  it('uses default template when none provided', () => {
    expect(interpolatePRTitle(undefined, { issueTitle: 'Add feature', issueNumber: '10' })).toBe(
      'fix: Add feature (#10)',
    );
  });
});

describe('authorizeFilesChanged()', () => {
  it('allows files matching write permissions', () => {
    const auditLog = makeMockAuditLog();
    expect(() =>
      authorizeFilesChanged(
        ['src/foo.ts', 'tests/foo.test.ts'],
        { read: ['**'], write: ['src/**', 'tests/**'], execute: [] },
        undefined,
        auditLog,
        'test-agent',
      ),
    ).not.toThrow();
  });

  it('throws for files outside write permissions', () => {
    const auditLog = makeMockAuditLog();
    expect(() =>
      authorizeFilesChanged(
        ['.github/workflows/ci.yml'],
        { read: ['**'], write: ['src/**'], execute: [] },
        undefined,
        auditLog,
        'test-agent',
      ),
    ).toThrow('Authorization denied');
    expect(auditLog.record).toHaveBeenCalledWith(expect.objectContaining({ decision: 'denied' }));
  });

  it('throws for files matching blocked paths', () => {
    const auditLog = makeMockAuditLog();
    expect(() =>
      authorizeFilesChanged(
        ['src/secret.ts'],
        { read: ['**'], write: ['src/**'], execute: [] },
        { blockedPaths: ['src/secret.ts'] },
        auditLog,
        'test-agent',
      ),
    ).toThrow('Authorization denied');
  });
});

describe('createPipelineAuthorizationChain()', () => {
  it('allows when all hooks pass', () => {
    const allowAll: AuthorizationHook = () => ({ allowed: true });
    const chain = createPipelineAuthorizationChain([allowAll, allowAll]);
    const result = chain({ agent: 'test', action: 'write', target: 'src/foo.ts' });
    expect(result.allowed).toBe(true);
  });

  it('denies on first failing hook (short-circuits)', () => {
    const allow: AuthorizationHook = () => ({ allowed: true });
    const deny: AuthorizationHook = () => ({
      allowed: false,
      reason: 'denied by hook',
      layer: 'permissions',
    });
    const shouldNotRun = vi.fn(() => ({ allowed: true })) as AuthorizationHook;

    const chain = createPipelineAuthorizationChain([allow, deny, shouldNotRun]);
    const result = chain({ agent: 'test', action: 'write', target: 'src/foo.ts' });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('denied by hook');
    expect(shouldNotRun).not.toHaveBeenCalled();
  });

  it('preserves hook execution order', () => {
    const order: number[] = [];
    const hook1: AuthorizationHook = () => {
      order.push(1);
      return { allowed: true };
    };
    const hook2: AuthorizationHook = () => {
      order.push(2);
      return { allowed: true };
    };
    const hook3: AuthorizationHook = () => {
      order.push(3);
      return { allowed: true };
    };

    const chain = createPipelineAuthorizationChain([hook1, hook2, hook3]);
    chain({ agent: 'test', action: 'write', target: 'src/foo.ts' });
    expect(order).toEqual([1, 2, 3]);
  });

  it('works with empty hook list', () => {
    const chain = createPipelineAuthorizationChain([]);
    const result = chain({ agent: 'test', action: 'write', target: 'src/foo.ts' });
    expect(result.allowed).toBe(true);
  });
});

describe('createAbacPermissionHook()', () => {
  it('allows when permissions match', () => {
    const hook = createAbacPermissionHook(
      { read: ['**'], write: ['src/**'], execute: [] },
      undefined,
    );
    const result = hook({ agent: 'test', action: 'write', target: 'src/foo.ts' });
    expect(result.allowed).toBe(true);
  });

  it('denies when permissions do not match', () => {
    const hook = createAbacPermissionHook(
      { read: ['**'], write: ['src/**'], execute: [] },
      undefined,
    );
    const result = hook({ agent: 'test', action: 'write', target: '.github/ci.yml' });
    expect(result.allowed).toBe(false);
  });
});

describe('createBlockedPathsHook()', () => {
  it('allows non-blocked paths', () => {
    const hook = createBlockedPathsHook(['.github/**']);
    const result = hook({ agent: 'test', action: 'write', target: 'src/foo.ts' });
    expect(result.allowed).toBe(true);
  });

  it('denies blocked paths', () => {
    const hook = createBlockedPathsHook(['.github/**', '.ai-sdlc/**']);
    const result = hook({ agent: 'test', action: 'write', target: '.github/workflows/ci.yml' });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('.github');
  });
});

describe('createAuditLoggingHook()', () => {
  it('records audit entry and always allows', () => {
    const auditLog = makeMockAuditLog();
    const hook = createAuditLoggingHook(auditLog);
    const result = hook({ agent: 'test-agent', action: 'write', target: 'src/foo.ts' });
    expect(result.allowed).toBe(true);
    expect(auditLog.record).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: 'test-agent',
        action: 'write',
        resource: 'src/foo.ts',
        decision: 'allowed',
      }),
    );
  });
});

describe('authorization chain composition', () => {
  it('composes ABAC + blocked-paths + audit into a working chain', () => {
    const auditLog = makeMockAuditLog();
    const chain = createPipelineAuthorizationChain([
      createAbacPermissionHook({ read: ['**'], write: ['src/**'], execute: [] }, undefined),
      createBlockedPathsHook(['.github/**']),
      createAuditLoggingHook(auditLog),
    ]);

    // Allowed path
    const allowed = chain({ agent: 'coder', action: 'write', target: 'src/index.ts' });
    expect(allowed.allowed).toBe(true);

    // Blocked by ABAC (no write permission)
    const deniedAbac = chain({ agent: 'coder', action: 'write', target: '.env' });
    expect(deniedAbac.allowed).toBe(false);
  });
});
