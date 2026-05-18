/**
 * Tests for the RFC-0025 auto-router — SUBSTRATE (AISDLC-302 Phase 1).
 *
 * Covers:
 *   - appendFrameworkCapture always writes to captures.jsonl
 *   - routeFrameworkBug writes a backlog task when flag is on
 *   - routeFrameworkBug skips task write when flag is off
 *   - CODEOWNERS heuristic (OQ-4 suggestion helper)
 *   - Task file content structure
 *
 * NOTE: OQ-4 attribution is suggest-only in the operator-affirmed resolution.
 * Phase 4 (AISDLC-305) will switch routeFrameworkBug() to suggest-only.
 * Until then, assignees are written directly when resolved from CODEOWNERS.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  appendFrameworkCapture,
  routeFrameworkBug,
  resolveCodeownersAssignee,
} from './quality-router.js';
import type { FrameworkBugCaptureRecord } from './quality-classifier.js';

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
    // Pass a read-only path that will fail
    const warnings: string[] = [];
    expect(() =>
      appendFrameworkCapture(MOCK_RECORD, {
        artifactsDir: '/proc/read-only-nonexistent-path',
        logger: { warn: (m) => warnings.push(m) },
      }),
    ).not.toThrow();
    expect(warnings.some((w) => w.includes('non-fatal'))).toBe(true);
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
  });

  it('writes a backlog task when flag is experimental', () => {
    process.env.AI_SDLC_FRAMEWORK_QUALITY_MONITORING = 'experimental';
    const result = routeFrameworkBug(MOCK_RECORD, { artifactsDir: workdir, workDir: workdir });
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
    const result = routeFrameworkBug(MOCK_RECORD, { artifactsDir: workdir, workDir: workdir });
    const taskContent = readFileSync(result.taskFilePath!, 'utf8');
    expect(taskContent).toContain('developer subagent returned prose');
    expect(taskContent).toContain('AISDLC-270');
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
