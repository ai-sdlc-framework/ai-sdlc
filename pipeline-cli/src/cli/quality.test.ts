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

import { buildQualityCli, runReportUpstream, runSeverityWeights } from './quality.js';
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
        confidence: 0.8,
        bucket: 'auto-classify',
        effectiveThresholds: { autoClassify: 0.7, ambiguous: 0.3 },
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

// ── severity-weights (AISDLC-305 / Phase 4) ──────────────────────────

describe('runSeverityWeights (OQ-2)', () => {
  it('returns shipping defaults with no overrides + no YAML', () => {
    const result = runSeverityWeights({ workDir: workdir });
    expect(result.resolved).toEqual({
      operatorTimeCost: 1.0,
      frameworkRecurrence: 1.0,
      blastRadius: 1.0,
    });
    expect(result.warnings).toEqual([]);
  });

  it('applies CLI overrides on top of YAML', () => {
    const dir = join(workdir, '.ai-sdlc');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'quality-monitoring.yaml'),
      ['quality:', '  severity-weights:', '    operator-time-cost: 1.5'].join('\n'),
    );
    const result = runSeverityWeights({
      workDir: workdir,
      severityWeight: ['blast-radius=2.5'],
    });
    expect(result.resolved.operatorTimeCost).toBeCloseTo(1.5); // YAML
    expect(result.resolved.blastRadius).toBeCloseTo(2.5); // CLI
    expect(result.resolved.frameworkRecurrence).toBe(1.0); // default
  });

  it('surfaces a warning for malformed override (continues with rest)', () => {
    const result = runSeverityWeights({
      workDir: workdir,
      severityWeight: ['blast-radius=2.0', 'unknown-axis=5'],
    });
    expect(result.resolved.blastRadius).toBeCloseTo(2.0);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/unknown severity-weight axis/);
  });
});

// ── CLI wrapper (yargs router) integration tests ──────────────────────
// These exercise the `severity-weights` subcommand through `buildQualityCli()`
// to cover the handler body (warnings stderr emit + JSON/text branches)
// that the pure runSeverityWeights() tests don't reach.

describe('cli-quality severity-weights subcommand', () => {
  let savedArgv: string[];
  let savedStdoutWrite: typeof process.stdout.write;
  let savedStderrWrite: typeof process.stderr.write;
  let stdoutChunks: string[];
  let stderrChunks: string[];

  beforeEach(() => {
    savedArgv = process.argv;
    savedStdoutWrite = process.stdout.write.bind(process.stdout);
    savedStderrWrite = process.stderr.write.bind(process.stderr);
    stdoutChunks = [];
    stderrChunks = [];
    process.stdout.write = ((chunk: string | Uint8Array) => {
      stdoutChunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderrChunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return true;
    }) as typeof process.stderr.write;
  });

  afterEach(() => {
    process.argv = savedArgv;
    process.stdout.write = savedStdoutWrite;
    process.stderr.write = savedStderrWrite;
  });

  function setArgv(...args: string[]): void {
    process.argv = ['node', 'cli-quality', ...args];
  }

  it('text format prints all three axes from defaults', async () => {
    setArgv('severity-weights', '--work-dir', workdir);
    await buildQualityCli().parseAsync();
    const out = stdoutChunks.join('');
    expect(out).toMatch(/operator-time-cost:\s+1/);
    expect(out).toMatch(/framework-recurrence:\s+1/);
    expect(out).toMatch(/blast-radius:\s+1/);
  });

  it('json format emits the resolved object', async () => {
    setArgv('severity-weights', '--work-dir', workdir, '--format', 'json');
    await buildQualityCli().parseAsync();
    const out = stdoutChunks.join('').trim();
    const parsed = JSON.parse(out);
    expect(parsed.operatorTimeCost).toBe(1);
    expect(parsed.frameworkRecurrence).toBe(1);
    expect(parsed.blastRadius).toBe(1);
  });

  it('layers CLI --severity-weight overrides on top of YAML', async () => {
    const dir = join(workdir, '.ai-sdlc');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'quality-monitoring.yaml'),
      ['quality:', '  severity-weights:', '    operator-time-cost: 1.5'].join('\n'),
    );
    setArgv(
      'severity-weights',
      '--work-dir',
      workdir,
      '--severity-weight',
      'blast-radius=2.5',
      '--format',
      'json',
    );
    await buildQualityCli().parseAsync();
    const out = stdoutChunks.join('').trim();
    const parsed = JSON.parse(out);
    expect(parsed.operatorTimeCost).toBeCloseTo(1.5);
    expect(parsed.blastRadius).toBeCloseTo(2.5);
    expect(parsed.frameworkRecurrence).toBe(1);
  });

  it('emits warnings on stderr for unknown axes (and continues with valid overrides)', async () => {
    setArgv(
      'severity-weights',
      '--work-dir',
      workdir,
      '--severity-weight',
      'blast-radius=2.0',
      '--severity-weight',
      'unknown-axis=5',
      '--format',
      'json',
    );
    await buildQualityCli().parseAsync();
    const err = stderrChunks.join('');
    expect(err).toMatch(/unknown severity-weight axis/);
    const out = stdoutChunks.join('').trim();
    const parsed = JSON.parse(out);
    expect(parsed.blastRadius).toBeCloseTo(2.0);
  });

  it('accepts repeated --severity-weight flags for multiple axes', async () => {
    setArgv(
      'severity-weights',
      '--work-dir',
      workdir,
      '--severity-weight',
      'operator-time-cost=2.0',
      '--severity-weight',
      'blast-radius=3.0',
      '--format',
      'json',
    );
    await buildQualityCli().parseAsync();
    const out = stdoutChunks.join('').trim();
    const parsed = JSON.parse(out);
    expect(parsed.operatorTimeCost).toBeCloseTo(2.0);
    expect(parsed.blastRadius).toBeCloseTo(3.0);
  });
});
