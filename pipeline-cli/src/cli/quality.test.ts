/**
 * Tests for `cli-quality` (AISDLC-307 / RFC-0025 Phase 6).
 *
 * Focuses on the pure `runReportUpstream` entry point — the yargs router
 * is thin and exercised by integration. These tests verify the
 * config-fallback resolution + the error paths the operator will see.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runReportUpstream } from './quality.js';
import { UpstreamReportError } from '../tui/analytics/upstream-reporter.js';
import {
  FRAMEWORK_QUALITY_CAPTURES_FILE,
  FRAMEWORK_QUALITY_DIRNAME,
} from '../tui/analytics/quality-reader.js';
import type { FrameworkBugCaptureRecord } from '../tui/analytics/quality-classifier.js';
import { buildCaptureId } from '../tui/analytics/upstream-reporter.js';

let workdir: string;
let artifactsDir: string;

function makeRecord(): FrameworkBugCaptureRecord {
  return {
    ts: '2026-05-16T12:00:00.000Z',
    class: 'framework-misbehaved',
    subclass: 'framework-contract-violated',
    severity: {
      composite: 'high',
      axes: { operatorTimeCost: 'high', blastRadius: 'medium', frequency: 'low' },
    },
    triage: 'framework-bug',
    taskId: 'AISDLC-307',
    workerId: 'worker-1',
    source: 'step-6',
    auditTrail: {
      classificationResult: {
        class: 'framework-misbehaved',
        subclass: 'framework-contract-violated',
        severity: {
          composite: 'high',
          axes: { operatorTimeCost: 'high', blastRadius: 'medium', frequency: 'low' },
        },
        captureRecord: null,
        rationale: 'developer subagent returned prose instead of JSON envelope',
      },
      originalFailure: {
        stderr: 'SyntaxError: JSON.parse failed',
        exitCode: 1,
        source: 'step-6',
      },
    },
  };
}

function writeConfig(yaml: string): void {
  const dir = join(workdir, '.ai-sdlc');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'quality-monitoring.yaml'), yaml);
}

function writeCapture(rec: FrameworkBugCaptureRecord): void {
  const dir = join(artifactsDir, FRAMEWORK_QUALITY_DIRNAME);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, FRAMEWORK_QUALITY_CAPTURES_FILE), JSON.stringify(rec) + '\n');
}

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), 'cli-quality-'));
  artifactsDir = join(workdir, 'artifacts');
});

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
});

describe('runReportUpstream', () => {
  it('throws when repoUrl missing from both CLI arg and config', () => {
    writeCapture(makeRecord());
    expect(() =>
      runReportUpstream({
        bugId: buildCaptureId(makeRecord()),
        workDir: workdir,
        artifactsDir,
        print: true,
      }),
    ).toThrow(UpstreamReportError);
  });

  it('uses repoUrl from CLI arg when provided', () => {
    writeCapture(makeRecord());
    const result = runReportUpstream({
      bugId: buildCaptureId(makeRecord()),
      repoUrl: 'https://github.com/cli-arg/repo',
      workDir: workdir,
      artifactsDir,
      print: true,
    });
    expect(result.url).toContain('cli-arg/repo');
  });

  it('falls back to repoUrl from quality-monitoring.yaml when CLI arg absent', () => {
    writeConfig(
      [
        'quality:',
        '  upstream-reporting:',
        '    repoUrl: "https://github.com/config-fallback/repo"',
      ].join('\n'),
    );
    writeCapture(makeRecord());
    const result = runReportUpstream({
      bugId: buildCaptureId(makeRecord()),
      workDir: workdir,
      artifactsDir,
      print: true,
    });
    expect(result.url).toContain('config-fallback/repo');
  });

  it('CLI arg overrides config value', () => {
    writeConfig(
      [
        'quality:',
        '  upstream-reporting:',
        '    repoUrl: "https://github.com/config-fallback/repo"',
      ].join('\n'),
    );
    writeCapture(makeRecord());
    const result = runReportUpstream({
      bugId: buildCaptureId(makeRecord()),
      repoUrl: 'https://github.com/cli-arg/repo',
      workDir: workdir,
      artifactsDir,
      print: true,
    });
    expect(result.url).toContain('cli-arg/repo');
    expect(result.url).not.toContain('config-fallback');
  });

  it('renders title with subclass and severity', () => {
    writeCapture(makeRecord());
    const result = runReportUpstream({
      bugId: buildCaptureId(makeRecord()),
      repoUrl: 'https://github.com/org/repo',
      workDir: workdir,
      artifactsDir,
      print: true,
    });
    expect(result.title).toContain('framework-contract-violated');
    expect(result.title).toContain('high');
  });

  it('does not open browser when print=true', () => {
    writeCapture(makeRecord());
    const result = runReportUpstream({
      bugId: buildCaptureId(makeRecord()),
      repoUrl: 'https://github.com/org/repo',
      workDir: workdir,
      artifactsDir,
      print: true,
    });
    expect(result.browserOpened).toBe(false);
  });

  it('throws UpstreamReportError when capture id is missing', () => {
    writeCapture(makeRecord());
    expect(() =>
      runReportUpstream({
        bugId: 'framework-bug-no-such-thing-20260101T0000',
        repoUrl: 'https://github.com/org/repo',
        workDir: workdir,
        artifactsDir,
        print: true,
      }),
    ).toThrow(UpstreamReportError);
  });
});
