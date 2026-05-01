/**
 * Calibration log writer tests.
 *
 * RFC-0011 §5.5 — every verdict is appended as one JSONL line to
 * `$ARTIFACTS_DIR/_dor/calibration.jsonl`. Tests assert:
 *   - Append-only behavior (re-running the writer keeps prior lines)
 *   - Path resolution honors explicit override → opts → env → default
 *   - Issue body truncation switches to a short checksum for large bodies
 *   - The entry shape is JSON-round-trippable
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendCalibrationEntry,
  buildEntry,
  resolveCalibrationLogPath,
  type CalibrationEntry,
} from './calibration-log.js';
import type { RefinementVerdict } from './types.js';

function verdict(over: Partial<RefinementVerdict> = {}): RefinementVerdict {
  return {
    issueId: 'AISDLC-test',
    rubricVersion: 'v1',
    overallVerdict: 'admit',
    overallConfidence: 'medium',
    gates: [
      { gateId: 1, verdict: 'pass', severity: 'block', stage: 'A', confidence: 'high' },
      { gateId: 2, verdict: 'pass', severity: 'block', stage: 'A', confidence: 'high' },
    ],
    signedAt: '2026-05-01T12:00:00.000Z',
    evaluatorVersion: 'test',
    summary: 'all good',
    questions: [],
    ...over,
  };
}

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'dor-calib-'));
});

afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

describe('resolveCalibrationLogPath', () => {
  it('honors an explicit filePath', () => {
    expect(resolveCalibrationLogPath({ filePath: '/tmp/abc.jsonl' })).toBe('/tmp/abc.jsonl');
  });

  it('uses opts.artifactsDir when provided', () => {
    const p = resolveCalibrationLogPath({ artifactsDir: '/var/x' });
    expect(p).toBe('/var/x/_dor/calibration.jsonl');
  });

  it('falls back to ARTIFACTS_DIR env var', () => {
    const prior = process.env.ARTIFACTS_DIR;
    process.env.ARTIFACTS_DIR = '/env/artifacts';
    try {
      expect(resolveCalibrationLogPath()).toBe('/env/artifacts/_dor/calibration.jsonl');
    } finally {
      if (prior === undefined) delete process.env.ARTIFACTS_DIR;
      else process.env.ARTIFACTS_DIR = prior;
    }
  });

  it('falls back to ./artifacts/_dor/calibration.jsonl', () => {
    const prior = process.env.ARTIFACTS_DIR;
    delete process.env.ARTIFACTS_DIR;
    try {
      const p = resolveCalibrationLogPath();
      expect(p).toContain('artifacts/_dor/calibration.jsonl');
    } finally {
      if (prior !== undefined) process.env.ARTIFACTS_DIR = prior;
    }
  });
});

describe('buildEntry', () => {
  it('captures the verdict and derives failedGates', () => {
    const v = verdict({
      gates: [
        { gateId: 1, verdict: 'fail', severity: 'block', stage: 'A', confidence: 'high' },
        { gateId: 2, verdict: 'pass', severity: 'block', stage: 'A', confidence: 'high' },
        { gateId: 4, verdict: 'fail', severity: 'block', stage: 'B', confidence: 'high' },
      ],
      overallVerdict: 'needs-clarification',
    });
    const e = buildEntry({ verdict: v }, { now: () => new Date('2026-05-01T00:00:00.000Z') });
    expect(e.failedGates).toEqual([1, 4]);
    expect(e.overallVerdict).toBe('needs-clarification');
    expect(e.outcome).toBe('');
    expect(e.ts).toBe('2026-05-01T00:00:00.000Z');
  });

  it('inlines short bodies, replaces long bodies with bodySha', () => {
    const issueShort = {
      id: 'i1',
      source: 'github' as const,
      title: 't',
      body: 'short body',
    };
    const eShort = buildEntry({ verdict: verdict(), issue: issueShort });
    expect(eShort.issue?.bodyPreview).toBe('short body');
    expect(eShort.issue?.bodySha).toBeUndefined();

    const issueLong = {
      id: 'i2',
      source: 'github' as const,
      title: 't',
      body: 'x'.repeat(2000),
    };
    const eLong = buildEntry({ verdict: verdict(), issue: issueLong });
    expect(eLong.issue?.bodySha).toMatch(/^cs_[0-9a-f]{8}$/);
    expect(eLong.issue?.bodyPreview).toBeUndefined();
  });

  it('passes outcome through', () => {
    const e = buildEntry({ verdict: verdict(), outcome: 'override', notes: 'maintainer overrode' });
    expect(e.outcome).toBe('override');
    expect(e.notes).toBe('maintainer overrode');
  });

  it('omits issue snapshot when no issue provided', () => {
    const e = buildEntry({ verdict: verdict() });
    expect(e.issue).toBeUndefined();
  });
});

describe('appendCalibrationEntry', () => {
  it('writes a JSONL line and creates parent directories', () => {
    const target = join(tmp, 'sub1', 'sub2', '_dor', 'calibration.jsonl');
    const { path, entry } = appendCalibrationEntry({ verdict: verdict() }, { filePath: target });
    expect(path).toBe(target);
    expect(existsSync(target)).toBe(true);
    const lines = readFileSync(target, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]) as CalibrationEntry;
    expect(parsed.issueId).toBe(entry.issueId);
  });

  it('appends multiple entries without truncating prior ones', () => {
    const target = join(tmp, 'cal.jsonl');
    appendCalibrationEntry({ verdict: verdict({ issueId: 'one' }) }, { filePath: target });
    appendCalibrationEntry({ verdict: verdict({ issueId: 'two' }) }, { filePath: target });
    appendCalibrationEntry({ verdict: verdict({ issueId: 'three' }) }, { filePath: target });
    const lines = readFileSync(target, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[0]).issueId).toBe('one');
    expect(JSON.parse(lines[1]).issueId).toBe('two');
    expect(JSON.parse(lines[2]).issueId).toBe('three');
  });

  it('persists the full verdict object so consumers can replay', () => {
    const target = join(tmp, 'cal.jsonl');
    const v = verdict({ overallVerdict: 'needs-clarification', overallConfidence: 'low' });
    appendCalibrationEntry({ verdict: v }, { filePath: target });
    const parsed = JSON.parse(readFileSync(target, 'utf8').trim()) as CalibrationEntry;
    expect(parsed.verdict.overallVerdict).toBe('needs-clarification');
    expect(parsed.verdict.overallConfidence).toBe('low');
    expect(parsed.verdict.gates).toHaveLength(2);
  });

  it('uses the conventional path under artifactsDir when filePath omitted', () => {
    const { path } = appendCalibrationEntry({ verdict: verdict() }, { artifactsDir: tmp });
    expect(path).toBe(join(tmp, '_dor', 'calibration.jsonl'));
    expect(existsSync(path)).toBe(true);
  });
});
