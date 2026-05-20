/**
 * Tests for RFC-0025 §13.1 quality-monitoring.yaml config loader.
 * Phase 3 (AISDLC-304 / OQ-3).
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_RECURRENCE_WINDOWS,
  QUALITY_MONITORING_CONFIG_DEFAULTS,
  loadQualityMonitoringConfig,
  parseDurationDays,
  parseQualityMonitoringConfigYaml,
} from './quality-monitoring-config.js';

let workdir: string;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), 'qm-config-'));
});

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
});

describe('parseDurationDays', () => {
  it('parses valid day strings', () => {
    expect(parseDurationDays('7d')).toBe(7);
    expect(parseDurationDays('30d')).toBe(30);
    expect(parseDurationDays('90d')).toBe(90);
    expect(parseDurationDays('14d')).toBe(14);
  });

  it('is case-insensitive', () => {
    expect(parseDurationDays('7D')).toBe(7);
    expect(parseDurationDays('30D')).toBe(30);
  });

  it('trims whitespace', () => {
    expect(parseDurationDays('  7d  ')).toBe(7);
  });

  it('returns null for unrecognized formats', () => {
    expect(parseDurationDays('7')).toBeNull();
    expect(parseDurationDays('7w')).toBeNull();
    expect(parseDurationDays('d7')).toBeNull();
    expect(parseDurationDays('')).toBeNull();
    expect(parseDurationDays('abc')).toBeNull();
  });
});

describe('parseQualityMonitoringConfigYaml', () => {
  it('returns defaults for empty YAML', () => {
    const cfg = parseQualityMonitoringConfigYaml('');
    expect(cfg.recurrenceWindows).toEqual([...DEFAULT_RECURRENCE_WINDOWS]);
  });

  it('parses recurrence-windows list', () => {
    const yaml = ['quality:', '  recurrence-windows:', '    - 7d', '    - 30d', '    - 90d'].join(
      '\n',
    );
    const cfg = parseQualityMonitoringConfigYaml(yaml);
    expect(cfg.recurrenceWindows).toEqual(['7d', '30d', '90d']);
  });

  it('parses top-level recurrence-windows (without quality: wrapper)', () => {
    const yaml = ['recurrence-windows:', '  - 14d', '  - 60d'].join('\n');
    const cfg = parseQualityMonitoringConfigYaml(yaml);
    expect(cfg.recurrenceWindows).toEqual(['14d', '60d']);
  });

  it('handles quoted window values', () => {
    const yaml = ['recurrence-windows:', "  - '7d'", '  - "30d"'].join('\n');
    const cfg = parseQualityMonitoringConfigYaml(yaml);
    expect(cfg.recurrenceWindows).toEqual(['7d', '30d']);
  });

  it('ignores comment lines', () => {
    const yaml = [
      '# Quality monitoring config',
      'recurrence-windows:',
      '  # flap detection',
      '  - 7d',
      '  - 30d',
    ].join('\n');
    const cfg = parseQualityMonitoringConfigYaml(yaml);
    expect(cfg.recurrenceWindows).toEqual(['7d', '30d']);
  });

  it('skips invalid window strings and keeps valid ones', () => {
    const yaml = ['recurrence-windows:', '  - 7d', '  - not-a-window', '  - 30d'].join('\n');
    const cfg = parseQualityMonitoringConfigYaml(yaml);
    expect(cfg.recurrenceWindows).toEqual(['7d', '30d']);
  });

  it('returns defaults when no recurrence-windows key is found', () => {
    const yaml = [
      'quality:',
      '  classifier:',
      '    confidenceThresholds:',
      '      autoClassify: 0.7',
    ].join('\n');
    const cfg = parseQualityMonitoringConfigYaml(yaml);
    expect(cfg.recurrenceWindows).toEqual([...DEFAULT_RECURRENCE_WINDOWS]);
  });

  it('falls back to defaults when parsed list is empty (all invalid strings)', () => {
    const yaml = ['recurrence-windows:', '  - not-valid', '  - also-bad'].join('\n');
    const cfg = parseQualityMonitoringConfigYaml(yaml);
    // All invalid → no parsedWindows → default
    expect(cfg.recurrenceWindows).toEqual([...DEFAULT_RECURRENCE_WINDOWS]);
  });
});

describe('loadQualityMonitoringConfig', () => {
  it('returns defaults when config file does not exist', () => {
    const cfg = loadQualityMonitoringConfig({ workDir: workdir });
    expect(cfg).toEqual(QUALITY_MONITORING_CONFIG_DEFAULTS);
  });

  it('loads config from .ai-sdlc/quality-monitoring.yaml', () => {
    const dir = join(workdir, '.ai-sdlc');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'quality-monitoring.yaml'),
      ['recurrence-windows:', '  - 14d', '  - 60d'].join('\n'),
    );
    const cfg = loadQualityMonitoringConfig({ workDir: workdir });
    expect(cfg.recurrenceWindows).toEqual(['14d', '60d']);
  });

  it('supports explicit filePath override', () => {
    const filePath = join(workdir, 'custom-config.yaml');
    writeFileSync(filePath, ['recurrence-windows:', '  - 21d'].join('\n'));
    const cfg = loadQualityMonitoringConfig({ filePath });
    expect(cfg.recurrenceWindows).toEqual(['21d']);
  });

  it('returns defaults when file is unreadable', () => {
    const cfg = loadQualityMonitoringConfig({ filePath: '/nonexistent/path/config.yaml' });
    expect(cfg).toEqual(QUALITY_MONITORING_CONFIG_DEFAULTS);
  });
});
