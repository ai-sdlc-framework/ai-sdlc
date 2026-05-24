/**
 * Tests for the RFC-0025 auto-router.
 *
 * Covers:
 *   - appendFrameworkCapture always writes to captures.jsonl
 *   - routeFrameworkBug writes a backlog task when flag is on
 *   - routeFrameworkBug skips task write when flag is off
 *   - CODEOWNERS heuristic (OQ-4 attribution backend)
 *   - resolveAttributionCandidates dedup + suggestionCount cap
 *   - OQ-4 suggest-only default: assignee left empty, candidates surfaced
 *   - OQ-4 autoAttribute: true: assignees force-written
 *   - Task body always renders the suggested-investigators section
 *   - Task file content structure
 */

import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  appendFrameworkCapture,
  resolveAttributionCandidates,
  resolveCodeownersAssignee,
  routeFrameworkBug,
} from './quality-router.js';
import type { FrameworkBugCaptureRecord } from './quality-classifier.js';
import {
  QUALITY_MONITORING_CONFIG_DEFAULTS,
  type FrameworkBugAttributionConfig,
  type QualityMonitoringConfig,
} from './quality-monitoring-config.js';

// Helper: a fresh, complete config the test can mutate without aliasing
// the frozen defaults map. Phase 4 router tests rely on opts.qualityMonitoringConfig
// to drive the OQ-4 branches hermetically.
function freshConfig(overrides?: {
  frameworkBug?: Partial<FrameworkBugAttributionConfig>;
}): QualityMonitoringConfig {
  const base = QUALITY_MONITORING_CONFIG_DEFAULTS;
  return {
    classifier: {
      confidenceThresholds: { ...base.classifier.confidenceThresholds },
    },
    recurrenceWindows: [...base.recurrenceWindows],
    upstreamReporting: { ...base.upstreamReporting },
    vendorNamespace: { ...base.vendorNamespace },
    customSubclasses: [...base.customSubclasses],
    coverageGap: { ...base.coverageGap },
    determinismDetection: { ...base.determinismDetection },
    operatorTimeCost: { ...base.operatorTimeCost },
    severityWeights: { ...base.severityWeights },
    frameworkBug: {
      ...base.frameworkBug,
      attributionSources: [...base.frameworkBug.attributionSources],
      ...overrides?.frameworkBug,
    },
  };
}

let workdir: string;

const MOCK_RECORD: FrameworkBugCaptureRecord = {
  ts: '2026-05-13T12:00:00.000Z',
  class: 'framework-misbehaved',
  subclass: 'framework-contract-violated',
  severity: {
    composite: 'high',
    axes: { operatorTimeCost: 'high', blastRadius: 'high', frequency: 'low' },
  },
  triage: 'framework-bug',
  taskId: 'AISDLC-270',
  workerId: 'worker-test',
  source: 'pipeline-cli',
  auditTrail: {
    classificationResult: {
      class: 'framework-misbehaved',
      subclass: 'framework-contract-violated',
      severity: {
        composite: 'high',
        axes: { operatorTimeCost: 'high', blastRadius: 'high', frequency: 'low' },
      },
      captureRecord: null,
      rationale: 'developer subagent returned prose instead of JSON envelope',
      confidence: 0.8,
      bucket: 'auto-classify',
      effectiveThresholds: { autoClassify: 0.7, ambiguous: 0.3 },
    },
    originalFailure: {
      stderr: 'developer returned prose instead of JSON envelope — expected JSON',
      exitCode: 1,
      source: 'pipeline-cli',
    },
  },
};

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), 'quality-router-'));
});

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
  // Clean up env vars
  delete process.env.AI_SDLC_FRAMEWORK_QUALITY_MONITORING;
  vi.restoreAllMocks();
});

describe('appendFrameworkCapture', () => {
  it('writes a JSONL line to the captures file', () => {
    appendFrameworkCapture(MOCK_RECORD, { artifactsDir: workdir });
    const capturesPath = join(workdir, '_quality', 'captures.jsonl');
    const content = readFileSync(capturesPath, 'utf8');
    const parsed = JSON.parse(content.trim());
    expect(parsed.class).toBe('framework-misbehaved');
    expect(parsed.subclass).toBe('framework-contract-violated');
    expect(parsed.triage).toBe('framework-bug');
  });

  it('appends multiple records without overwriting', () => {
    appendFrameworkCapture(MOCK_RECORD, { artifactsDir: workdir });
    appendFrameworkCapture(
      { ...MOCK_RECORD, ts: '2026-05-13T13:00:00.000Z' },
      { artifactsDir: workdir },
    );
    const capturesPath = join(workdir, '_quality', 'captures.jsonl');
    const lines = readFileSync(capturesPath, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
  });

  it('does not throw on write failure (best-effort)', () => {
    // Create a read-only directory so mkdirSync inside _quality fails with EACCES.
    // We use chmodSync (0o444 = r--r--r--) to make it unwritable on all POSIX
    // platforms. The /proc approach used previously could block indefinitely on
    // Linux CI where /proc has special kernel-level semantics (AISDLC-375 fix).
    const readonlyDir = mkdtempSync(join(tmpdir(), 'quality-router-ro-'));
    chmodSync(readonlyDir, 0o444);
    const warnings: string[] = [];
    try {
      expect(() =>
        appendFrameworkCapture(MOCK_RECORD, {
          artifactsDir: readonlyDir,
          logger: { warn: (m) => warnings.push(m) },
        }),
      ).not.toThrow();
      expect(warnings.some((w) => w.includes('non-fatal'))).toBe(true);
    } finally {
      // Restore write permissions so rmSync in afterEach can clean up.
      try {
        chmodSync(readonlyDir, 0o755);
      } catch {
        // best-effort; ignore if already removed
      }
      rmSync(readonlyDir, { recursive: true, force: true });
    }
  });
});

describe('routeFrameworkBug', () => {
  it('always appends capture regardless of feature flag', () => {
    // Flag OFF
    delete process.env.AI_SDLC_FRAMEWORK_QUALITY_MONITORING;
    const result = routeFrameworkBug(MOCK_RECORD, { artifactsDir: workdir, workDir: workdir });
    const capturesPath = join(workdir, '_quality', 'captures.jsonl');
    expect(readFileSync(capturesPath, 'utf8').trim()).toBeTruthy();
    expect(result.taskFileWritten).toBe(false);
    expect(result.featureFlagEnabled).toBe(false);
    expect(result.assigneesAutoApplied).toBe(false);
  });

  it('writes a backlog task when flag is experimental', () => {
    process.env.AI_SDLC_FRAMEWORK_QUALITY_MONITORING = 'experimental';
    const result = routeFrameworkBug(MOCK_RECORD, {
      artifactsDir: workdir,
      workDir: workdir,
      qualityMonitoringConfig: freshConfig(),
    });
    expect(result.taskFileWritten).toBe(true);
    expect(result.featureFlagEnabled).toBe(true);
    expect(result.taskFilePath).toBeDefined();

    const taskContent = readFileSync(result.taskFilePath!, 'utf8');
    expect(taskContent).toContain('triage: framework-bug');
    expect(taskContent).toContain('framework-contract-violated');
    expect(taskContent).toContain('dispatchable: false');
    expect(taskContent).toContain('priority: high');
  });

  it('task file contains audit trail information', () => {
    process.env.AI_SDLC_FRAMEWORK_QUALITY_MONITORING = 'experimental';
    const result = routeFrameworkBug(MOCK_RECORD, {
      artifactsDir: workdir,
      workDir: workdir,
      qualityMonitoringConfig: freshConfig(),
    });
    const taskContent = readFileSync(result.taskFilePath!, 'utf8');
    expect(taskContent).toContain('developer subagent returned prose');
    expect(taskContent).toContain('AISDLC-270');
  });

  // ── OQ-4 attribution branches (Phase 4 / AISDLC-305) ────────────────

  it('OQ-4 default suggest-only: leaves assignee empty + surfaces candidates', () => {
    process.env.AI_SDLC_FRAMEWORK_QUALITY_MONITORING = 'experimental';
    // CODEOWNERS so a candidate resolves
    const githubDir = join(workdir, '.github');
    mkdirSync(githubDir, { recursive: true });
    writeFileSync(join(githubDir, 'CODEOWNERS'), '* @suggested-owner\n');

    const result = routeFrameworkBug(MOCK_RECORD, {
      artifactsDir: workdir,
      workDir: workdir,
      qualityMonitoringConfig: freshConfig(), // default autoAttribute: false
    });

    expect(result.assignees).toContain('@suggested-owner');
    expect(result.assigneesAutoApplied).toBe(false);

    const taskContent = readFileSync(result.taskFilePath!, 'utf8');
    // Frontmatter `assignee:` is the EMPTY list (suggest-only does not force-assign)
    expect(taskContent).toMatch(/^assignee: \[\]$/m);
    // Body still surfaces the suggestion for operator confirmation
    expect(taskContent).toContain('### Suggested investigators (OQ-4 attribution)');
    expect(taskContent).toContain('- @suggested-owner');
    expect(taskContent).toContain('Suggest-only mode');
  });

  it('OQ-4 autoAttribute: true force-writes top candidates to assignee:', () => {
    process.env.AI_SDLC_FRAMEWORK_QUALITY_MONITORING = 'experimental';
    const githubDir = join(workdir, '.github');
    mkdirSync(githubDir, { recursive: true });
    writeFileSync(join(githubDir, 'CODEOWNERS'), '* @force-owner @second-owner\n');

    const result = routeFrameworkBug(MOCK_RECORD, {
      artifactsDir: workdir,
      workDir: workdir,
      qualityMonitoringConfig: freshConfig({
        frameworkBug: { autoAttribute: true },
      }),
    });

    expect(result.assigneesAutoApplied).toBe(true);
    expect(result.assignees).toEqual(['@force-owner', '@second-owner']);

    const taskContent = readFileSync(result.taskFilePath!, 'utf8');
    // Force-assign path writes `assignee:` as a YAML list, NOT `[]`
    expect(taskContent).toMatch(/^assignee:\n {2}- @force-owner\n {2}- @second-owner$/m);
    // Body still renders the audit trail
    expect(taskContent).toContain('force-written to `assignee:`');
  });

  it('OQ-4 suggestionCount caps the candidate list', () => {
    process.env.AI_SDLC_FRAMEWORK_QUALITY_MONITORING = 'experimental';
    const githubDir = join(workdir, '.github');
    mkdirSync(githubDir, { recursive: true });
    writeFileSync(join(githubDir, 'CODEOWNERS'), '* @a @b @c @d @e\n');

    const result = routeFrameworkBug(MOCK_RECORD, {
      artifactsDir: workdir,
      workDir: workdir,
      qualityMonitoringConfig: freshConfig({
        frameworkBug: { suggestionCount: 2, autoAttribute: true },
      }),
    });
    expect(result.assignees).toEqual(['@a', '@b']);
  });

  it('OQ-4 renders the no-candidates message when nothing resolves', () => {
    process.env.AI_SDLC_FRAMEWORK_QUALITY_MONITORING = 'experimental';
    // No CODEOWNERS file at all
    const result = routeFrameworkBug(MOCK_RECORD, {
      artifactsDir: workdir,
      workDir: workdir,
      qualityMonitoringConfig: freshConfig(),
    });
    expect(result.assignees).toEqual([]);
    expect(result.assigneesAutoApplied).toBe(false);
    const taskContent = readFileSync(result.taskFilePath!, 'utf8');
    expect(taskContent).toContain('No candidates resolved');
    expect(taskContent).toMatch(/^assignee: \[\]$/m);
  });
});

describe('resolveAttributionCandidates', () => {
  it('returns codeowners results capped at suggestionCount', () => {
    const githubDir = join(workdir, '.github');
    mkdirSync(githubDir, { recursive: true });
    writeFileSync(join(githubDir, 'CODEOWNERS'), '* @a @b @c @d\n');
    const candidates = resolveAttributionCandidates(workdir, 'src/foo.ts', {
      autoAttribute: false,
      attributionSources: ['codeowners'],
      suggestionCount: 2,
    });
    expect(candidates).toEqual(['@a', '@b']);
  });

  it('silently skips unknown backends (forward-compat for git-blame / recent-pr)', () => {
    const githubDir = join(workdir, '.github');
    mkdirSync(githubDir, { recursive: true });
    writeFileSync(join(githubDir, 'CODEOWNERS'), '* @from-codeowners\n');
    const candidates = resolveAttributionCandidates(workdir, 'src/foo.ts', {
      autoAttribute: false,
      attributionSources: ['git-blame', 'codeowners', 'recent-pr'],
      suggestionCount: 3,
    });
    // git-blame + recent-pr are silently skipped; codeowners populates
    expect(candidates).toEqual(['@from-codeowners']);
  });

  it('returns empty when no source hint and no backends', () => {
    const candidates = resolveAttributionCandidates(workdir, undefined, {
      autoAttribute: false,
      attributionSources: ['codeowners'],
      suggestionCount: 3,
    });
    expect(candidates).toEqual([]);
  });

  it('dedupes candidates across backends', () => {
    const githubDir = join(workdir, '.github');
    mkdirSync(githubDir, { recursive: true });
    // CODEOWNERS lines are matched in order, last match wins per GitHub semantics.
    // With a single ` * @dupe @dupe @other` line, the parser already dedupes via Set.
    writeFileSync(join(githubDir, 'CODEOWNERS'), '* @dupe @dupe @other\n');
    const candidates = resolveAttributionCandidates(workdir, 'src/foo.ts', {
      autoAttribute: false,
      attributionSources: ['codeowners'],
      suggestionCount: 5,
    });
    // Set-dedup ensures `@dupe` only appears once
    expect(candidates.filter((c) => c === '@dupe')).toHaveLength(1);
    expect(candidates).toContain('@other');
  });
});

describe('resolveCodeownersAssignee', () => {
  it('returns empty array when no CODEOWNERS exists', () => {
    expect(resolveCodeownersAssignee(workdir, 'pipeline-cli/src/foo.ts')).toEqual([]);
  });

  it('returns matching owner from .github/CODEOWNERS', () => {
    const githubDir = join(workdir, '.github');
    mkdirSync(githubDir, { recursive: true });
    writeFileSync(
      join(githubDir, 'CODEOWNERS'),
      '# CODEOWNERS\npipeline-cli/ @dominique\n* @default-owner\n',
    );
    const owners = resolveCodeownersAssignee(workdir, 'pipeline-cli/src/foo.ts');
    // Last match wins (GitHub semantics) — `* @default-owner` comes last
    expect(owners).toContain('@default-owner');
  });

  it('returns empty array when no source hint is provided', () => {
    const githubDir = join(workdir, '.github');
    mkdirSync(githubDir, { recursive: true });
    writeFileSync(join(githubDir, 'CODEOWNERS'), '* @owner\n');
    expect(resolveCodeownersAssignee(workdir, undefined)).toEqual([]);
  });
});
