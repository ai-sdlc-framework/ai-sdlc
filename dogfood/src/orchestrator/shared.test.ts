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
  parseDuration,
} from './shared.js';
import type { AutonomyPolicy, AuditLog, MetricStore } from '@ai-sdlc/reference';

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
      expect(config.org).toBe('ai-sdlc-framework');
      expect(config.repo).toBe('ai-sdlc');
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

describe('parseDuration()', () => {
  it('parses seconds correctly', () => {
    expect(parseDuration('30s')).toBe(30000);
    expect(parseDuration('1s')).toBe(1000);
    expect(parseDuration('60s')).toBe(60000);
  });

  it('parses minutes correctly', () => {
    expect(parseDuration('5m')).toBe(300000);
    expect(parseDuration('1m')).toBe(60000);
    expect(parseDuration('10m')).toBe(600000);
  });

  it('parses hours correctly', () => {
    expect(parseDuration('2h')).toBe(7200000);
    expect(parseDuration('1h')).toBe(3600000);
    expect(parseDuration('24h')).toBe(86400000);
  });

  it('parses days correctly', () => {
    expect(parseDuration('7d')).toBe(604800000);
    expect(parseDuration('1d')).toBe(86400000);
    expect(parseDuration('30d')).toBe(2592000000);
  });

  it('throws on invalid format without unit', () => {
    expect(() => parseDuration('30')).toThrow('Invalid duration format: 30');
  });

  it('throws on invalid format with invalid unit', () => {
    expect(() => parseDuration('30x')).toThrow('Invalid duration format: 30x');
  });

  it('throws on non-numeric value', () => {
    expect(() => parseDuration('abcs')).toThrow('Invalid duration format: abcs');
  });

  it('throws on empty string', () => {
    expect(() => parseDuration('')).toThrow('Invalid duration format: ');
  });

  it('throws on zero duration', () => {
    expect(() => parseDuration('0s')).toThrow('Invalid duration format: 0s');
    expect(() => parseDuration('0m')).toThrow('Invalid duration format: 0m');
  });

  it('throws on negative duration', () => {
    expect(() => parseDuration('-5s')).toThrow('Invalid duration format: -5s');
  });

  it('throws on decimal values', () => {
    expect(() => parseDuration('1.5s')).toThrow('Invalid duration format: 1.5s');
  });

  it('throws on multiple units', () => {
    expect(() => parseDuration('1h30m')).toThrow('Invalid duration format: 1h30m');
  });

  it('throws on whitespace', () => {
    expect(() => parseDuration('30 s')).toThrow('Invalid duration format: 30 s');
    expect(() => parseDuration(' 30s')).toThrow('Invalid duration format:  30s');
    expect(() => parseDuration('30s ')).toThrow('Invalid duration format: 30s ');
  });
});
