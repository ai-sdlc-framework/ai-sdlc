/**
 * Tests — HC_cost channel (RFC-0009 §7.4 / AISDLC-318).
 *
 * Covers all 6 acceptance criteria:
 *  AC #1 — HC_cost in admission composite
 *  AC #2 — operator-tunable weight (calibration.yaml + env)
 *  AC #3 — RFC-0016 calibration tier detection
 *  AC #4 — admission line formatting for cli-admission output
 *  AC #5 — adopter opt-in gate (default off)
 *  AC #6 — each calibration tier produces sensible cost weights; opt-out short-circuits
 *
 * @module orchestrator/hc-cost.test
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  applyHcCost,
  extractMaxBudgetUsd,
  formatHcCostAdmissionLine,
  HC_COST_DEFAULT_WEIGHT,
  HC_COST_ENABLED_ENV,
  HC_COST_WEIGHT_ENV,
  loadHcCostConfig,
  readCalibrationTier,
} from './hc-cost.js';

// ── Test utilities ────────────────────────────────────────────────────

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'hc-cost-test-'));
}

function writeCalibrationYaml(workDir: string, content: string): void {
  const aiSdlcDir = join(workDir, '.ai-sdlc');
  mkdirSync(aiSdlcDir, { recursive: true });
  writeFileSync(join(aiSdlcDir, 'calibration.yaml'), content, 'utf8');
}

function writeEstimateLog(artifactsDir: string, content: string): void {
  const estimatesDir = join(artifactsDir, '_estimates');
  mkdirSync(estimatesDir, { recursive: true });
  writeFileSync(join(estimatesDir, 'log.jsonl'), content, 'utf8');
}

function writeCalibrationLog(artifactsDir: string, month: string, content: string): void {
  const estimatesDir = join(artifactsDir, '_estimates');
  mkdirSync(estimatesDir, { recursive: true });
  writeFileSync(join(estimatesDir, `calibration-${month}.jsonl`), content, 'utf8');
}

// ── AC #5 — opt-in gate (default off) ────────────────────────────────

describe('loadHcCostConfig — opt-in gate (AC #5)', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('is disabled by default (no env set)', () => {
    const config = loadHcCostConfig({ workDir: tempDir, env: {} });
    expect(config.enabled).toBe(false);
  });

  it('enables when AI_SDLC_HC_COST_ENABLED=1', () => {
    const config = loadHcCostConfig({
      workDir: tempDir,
      env: { [HC_COST_ENABLED_ENV]: '1' },
    });
    expect(config.enabled).toBe(true);
  });

  it('enables when AI_SDLC_HC_COST_ENABLED=true (case-insensitive)', () => {
    const config = loadHcCostConfig({
      workDir: tempDir,
      env: { [HC_COST_ENABLED_ENV]: 'TRUE' },
    });
    expect(config.enabled).toBe(true);
  });

  it('enables when AI_SDLC_HC_COST_ENABLED=yes', () => {
    const config = loadHcCostConfig({
      workDir: tempDir,
      env: { [HC_COST_ENABLED_ENV]: 'yes' },
    });
    expect(config.enabled).toBe(true);
  });

  it('remains disabled when AI_SDLC_HC_COST_ENABLED=0', () => {
    const config = loadHcCostConfig({
      workDir: tempDir,
      env: { [HC_COST_ENABLED_ENV]: '0' },
    });
    expect(config.enabled).toBe(false);
  });

  it('remains disabled when AI_SDLC_HC_COST_ENABLED=false', () => {
    const config = loadHcCostConfig({
      workDir: tempDir,
      env: { [HC_COST_ENABLED_ENV]: 'false' },
    });
    expect(config.enabled).toBe(false);
  });
});

// ── AC #2 — operator-tunable weight ──────────────────────────────────

describe('loadHcCostConfig — weight resolution (AC #2)', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('defaults to 1.0 when no env or file config', () => {
    const config = loadHcCostConfig({ workDir: tempDir, env: {} });
    expect(config.weight).toBe(HC_COST_DEFAULT_WEIGHT);
  });

  it('reads weight from env var AI_SDLC_HC_COST', () => {
    const config = loadHcCostConfig({
      workDir: tempDir,
      env: { [HC_COST_WEIGHT_ENV]: '0.5' },
    });
    expect(config.weight).toBe(0.5);
  });

  it('reads weight from .ai-sdlc/calibration.yaml hcCost.weight', () => {
    writeCalibrationYaml(tempDir, 'hcCost:\n  weight: 0.3\n');
    const config = loadHcCostConfig({ workDir: tempDir, env: {} });
    expect(config.weight).toBe(0.3);
  });

  it('env var takes priority over calibration.yaml', () => {
    writeCalibrationYaml(tempDir, 'hcCost:\n  weight: 0.3\n');
    const config = loadHcCostConfig({
      workDir: tempDir,
      env: { [HC_COST_WEIGHT_ENV]: '0.7' },
    });
    expect(config.weight).toBe(0.7);
  });

  it('clamps weight to [0, 1] — above 1.0', () => {
    const config = loadHcCostConfig({
      workDir: tempDir,
      env: { [HC_COST_WEIGHT_ENV]: '1.5' },
    });
    expect(config.weight).toBe(1.0);
  });

  it('clamps weight to [0, 1] — below 0.0', () => {
    const config = loadHcCostConfig({
      workDir: tempDir,
      env: { [HC_COST_WEIGHT_ENV]: '-0.5' },
    });
    expect(config.weight).toBe(0.0);
  });

  it('ignores malformed calibration.yaml and falls back to default', () => {
    writeCalibrationYaml(tempDir, 'not: valid: yaml: [[[');
    // No throw — degrades to default
    const config = loadHcCostConfig({ workDir: tempDir, env: {} });
    expect(config.weight).toBe(HC_COST_DEFAULT_WEIGHT);
  });

  it('ignores calibration.yaml without hcCost block', () => {
    writeCalibrationYaml(tempDir, 'confidenceThresholds:\n  highSampleSize: 20\n');
    const config = loadHcCostConfig({ workDir: tempDir, env: {} });
    expect(config.weight).toBe(HC_COST_DEFAULT_WEIGHT);
  });
});

// ── AC #3 — RFC-0016 calibration tier detection ───────────────────────

describe('readCalibrationTier — RFC-0016 tier (AC #3)', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns crude when no _estimates/ directory', () => {
    const tier = readCalibrationTier(tempDir);
    expect(tier).toBe('crude');
  });

  it('returns crude when _estimates/ exists but is empty', () => {
    mkdirSync(join(tempDir, '_estimates'), { recursive: true });
    const tier = readCalibrationTier(tempDir);
    expect(tier).toBe('crude');
  });

  it('returns moderate when log.jsonl exists with content (AC #6 — moderate tier)', () => {
    writeEstimateLog(tempDir, '{"ts":"2026-05-01T12:00:00Z","taskId":"AISDLC-100","bucket":"S"}\n');
    const tier = readCalibrationTier(tempDir);
    expect(tier).toBe('moderate');
  });

  it('returns crude when log.jsonl exists but is empty', () => {
    writeEstimateLog(tempDir, '');
    const tier = readCalibrationTier(tempDir);
    expect(tier).toBe('crude');
  });

  it('returns high when calibration-YYYY-MM.jsonl exists with content (AC #6 — high tier)', () => {
    writeCalibrationLog(
      tempDir,
      '2026-05',
      '{"ts":"2026-05-01T12:00:00Z","taskId":"AISDLC-100","predictedBucket":"S","actualBucket":"XS","bucketMiss":1}\n',
    );
    const tier = readCalibrationTier(tempDir);
    expect(tier).toBe('high');
  });

  it('returns moderate when calibration file exists but is empty (falls through to log)', () => {
    writeCalibrationLog(tempDir, '2026-05', '');
    writeEstimateLog(tempDir, '{"ts":"2026-05-01T12:00:00Z","taskId":"AISDLC-100","bucket":"S"}\n');
    const tier = readCalibrationTier(tempDir);
    // calibration file is empty → not high. log.jsonl has content → moderate.
    expect(tier).toBe('moderate');
  });
});

// ── AC #1 — applyHcCost in admission composite ────────────────────────

describe('applyHcCost — admission composite (AC #1)', () => {
  const enabledConfig = {
    enabled: true,
    weight: 0.5,
    calibrationTier: 'crude' as const,
  };

  const disabledConfig = {
    enabled: false,
    weight: 0.5,
    calibrationTier: 'crude' as const,
  };

  const neutralConfig = {
    enabled: true,
    weight: 1.0,
    calibrationTier: 'crude' as const,
  };

  it('returns unchanged priority when channel is disabled (opt-out short-circuits — AC #6)', () => {
    const result = applyHcCost(4.0, 10.0, disabledConfig);
    expect(result.adjustedPriority).toBe(4.0);
    expect(result.priorityDelta).toBe(0);
    expect(result.isCostSensitive).toBe(true);
  });

  it('returns unchanged priority when task is not cost-sensitive', () => {
    const result = applyHcCost(4.0, undefined, enabledConfig);
    expect(result.adjustedPriority).toBe(4.0);
    expect(result.priorityDelta).toBe(0);
    expect(result.isCostSensitive).toBe(false);
  });

  it('returns unchanged priority when weight is 1.0 (neutral)', () => {
    const result = applyHcCost(4.0, 10.0, neutralConfig);
    expect(result.adjustedPriority).toBe(4.0);
    expect(result.priorityDelta).toBe(0);
    expect(result.isCostSensitive).toBe(true);
  });

  it('de-prioritizes cost-sensitive tasks with weight < 1.0', () => {
    const result = applyHcCost(4.0, 10.0, enabledConfig);
    expect(result.originalPriority).toBe(4.0);
    expect(result.adjustedPriority).toBe(2.0); // 4.0 * 0.5
    expect(result.isCostSensitive).toBe(true);
    expect(result.priorityDelta).toBe(-2.0);
  });

  it('fully suppresses cost-sensitive tasks with weight === 0.0 (advisory)', () => {
    const zeroConfig = { enabled: true, weight: 0.0, calibrationTier: 'crude' as const };
    const result = applyHcCost(4.0, 10.0, zeroConfig);
    expect(result.adjustedPriority).toBe(0.0);
    expect(result.priorityDelta).toBe(-4.0);
  });
});

// ── AC #3 + #6 — calibration tier produces sensible cost weights ──────

describe('applyHcCost — sensible weights across calibration tiers (AC #3, AC #6)', () => {
  it('crude tier: weight still applies when maxBudgetUsd present', () => {
    const config = { enabled: true, weight: 0.5, calibrationTier: 'crude' as const };
    const result = applyHcCost(3.0, 5.0, config);
    expect(result.adjustedPriority).toBe(1.5);
    expect(result.isCostSensitive).toBe(true);
  });

  it('moderate tier: weight applies correctly', () => {
    const config = { enabled: true, weight: 0.7, calibrationTier: 'moderate' as const };
    const result = applyHcCost(3.0, 5.0, config);
    expect(result.adjustedPriority).toBeCloseTo(2.1, 4);
  });

  it('high tier: weight applies correctly', () => {
    const config = { enabled: true, weight: 0.9, calibrationTier: 'high' as const };
    const result = applyHcCost(3.0, 5.0, config);
    expect(result.adjustedPriority).toBeCloseTo(2.7, 4);
  });
});

// ── AC #4 — cli-admission output formatting ───────────────────────────

describe('formatHcCostAdmissionLine — cli-admission output (AC #4)', () => {
  it('shows disabled message when channel is off', () => {
    const config = { enabled: false, weight: 0.5, calibrationTier: 'crude' as const };
    const line = formatHcCostAdmissionLine(config, 0);
    expect(line).toContain('disabled');
    expect(line).toContain('AI_SDLC_HC_COST_ENABLED=1');
  });

  it('shows neutral message when weight is 1.0', () => {
    const config = { enabled: true, weight: 1.0, calibrationTier: 'moderate' as const };
    const line = formatHcCostAdmissionLine(config, 3);
    expect(line).toContain('weight=1.0');
    expect(line).toContain('neutral');
    expect(line).toContain('calibration=moderate');
  });

  it('shows active message with weight + calibration tier + affected count', () => {
    const config = { enabled: true, weight: 0.5, calibrationTier: 'high' as const };
    const line = formatHcCostAdmissionLine(config, 2);
    expect(line).toContain('weight=0.5');
    expect(line).toContain('calibration=high');
    expect(line).toContain('cost-sensitive-tasks-affected=2');
  });

  it('includes all three calibration tiers in the output vocabulary', () => {
    const tiers = ['crude', 'moderate', 'high'] as const;
    for (const tier of tiers) {
      const config = { enabled: true, weight: 0.5, calibrationTier: tier };
      const line = formatHcCostAdmissionLine(config, 1);
      expect(line).toContain(`calibration=${tier}`);
    }
  });
});

// ── extractMaxBudgetUsd ───────────────────────────────────────────────

describe('extractMaxBudgetUsd', () => {
  it('returns undefined when frontmatter is undefined', () => {
    expect(extractMaxBudgetUsd(undefined)).toBeUndefined();
  });

  it('returns undefined when maxBudgetUsd is absent', () => {
    expect(extractMaxBudgetUsd({ title: 'Task A' })).toBeUndefined();
  });

  it('returns the numeric value when present', () => {
    expect(extractMaxBudgetUsd({ maxBudgetUsd: 5.0 })).toBe(5.0);
  });

  it('returns undefined for non-numeric maxBudgetUsd', () => {
    expect(extractMaxBudgetUsd({ maxBudgetUsd: 'five' })).toBeUndefined();
  });

  it('returns undefined for zero maxBudgetUsd (not a positive cap)', () => {
    expect(extractMaxBudgetUsd({ maxBudgetUsd: 0 })).toBeUndefined();
  });

  it('returns undefined for negative maxBudgetUsd', () => {
    expect(extractMaxBudgetUsd({ maxBudgetUsd: -1 })).toBeUndefined();
  });
});
