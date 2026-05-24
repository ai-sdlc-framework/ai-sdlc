/**
 * Tests for RFC-0025 §13.1 quality-monitoring.yaml config loader.
 * Phase 2 (AISDLC-303 / OQ-1): classifier.confidenceThresholds.
 * Phase 3 (AISDLC-304 / OQ-3): recurrence-windows.
 * Phase 5 (AISDLC-306 / OQ-6/7/9).
 * Phase 6 (AISDLC-307 / OQ-5/10).
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_CLASSIFIER_AMBIGUOUS_THRESHOLD,
  DEFAULT_CLASSIFIER_AUTO_CLASSIFY_THRESHOLD,
  DEFAULT_RECURRENCE_WINDOWS,
  DEFAULT_UPSTREAM_TEMPLATE_PATH,
  DEFAULT_COVERAGE_GAP_AUTO_QUARANTINE,
  DEFAULT_COVERAGE_GAP_FILE_CAPTURE,
  DEFAULT_DETERMINISM_SAMPLE_RATE,
  DEFAULT_OPERATOR_TIME_COST_AFK_MINUTES,
  QUALITY_MONITORING_CONFIG_DEFAULTS,
  QualityMonitoringConfigError,
  enforceVendorNamespaceConfig,
  loadQualityMonitoringConfig,
  parseDurationDays,
  parseQualityMonitoringConfigYaml,
  resolveClassifierConfidenceThresholds,
  type QualityMonitoringConfig,
  type VendorNamespaceEnforce,
} from './quality-monitoring-config.js';

// Helper: build a complete QualityMonitoringConfig from a partial; tests
// only override the bits they care about. Phase 5 added required fields
// (`coverageGap`, `determinismDetection`, `operatorTimeCost`) so older
// tests need a base to spread from.
function baseConfig(
  enforce: VendorNamespaceEnforce,
  customSubclasses: string[] = [],
): QualityMonitoringConfig {
  return {
    classifier: {
      confidenceThresholds: {
        ...QUALITY_MONITORING_CONFIG_DEFAULTS.classifier.confidenceThresholds,
      },
    },
    recurrenceWindows: [],
    upstreamReporting: { repoUrl: '', prefilledIssueTemplate: '' },
    vendorNamespace: { enforce },
    customSubclasses,
    coverageGap: { ...QUALITY_MONITORING_CONFIG_DEFAULTS.coverageGap },
    determinismDetection: { ...QUALITY_MONITORING_CONFIG_DEFAULTS.determinismDetection },
    operatorTimeCost: { ...QUALITY_MONITORING_CONFIG_DEFAULTS.operatorTimeCost },
  };
}

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

// ── Phase 6 (AISDLC-307) — upstream-reporting (OQ-5) ─────────────────

describe('parseQualityMonitoringConfigYaml — upstream-reporting (OQ-5)', () => {
  it('ships empty repoUrl + default template path', () => {
    const cfg = parseQualityMonitoringConfigYaml('');
    expect(cfg.upstreamReporting.repoUrl).toBe('');
    expect(cfg.upstreamReporting.prefilledIssueTemplate).toBe(DEFAULT_UPSTREAM_TEMPLATE_PATH);
  });

  it('parses upstream-reporting.repoUrl and prefilledIssueTemplate', () => {
    const yaml = [
      'quality:',
      '  upstream-reporting:',
      '    repoUrl: "https://github.com/example/repo"',
      '    prefilledIssueTemplate: ".ai-sdlc/templates/custom-bug.md"',
    ].join('\n');
    const cfg = parseQualityMonitoringConfigYaml(yaml);
    expect(cfg.upstreamReporting.repoUrl).toBe('https://github.com/example/repo');
    expect(cfg.upstreamReporting.prefilledIssueTemplate).toBe('.ai-sdlc/templates/custom-bug.md');
  });

  it('handles unquoted repoUrl', () => {
    const yaml = ['upstream-reporting:', '  repoUrl: https://github.com/example/repo'].join('\n');
    const cfg = parseQualityMonitoringConfigYaml(yaml);
    expect(cfg.upstreamReporting.repoUrl).toBe('https://github.com/example/repo');
  });
});

// ── Phase 6 (AISDLC-307) — vendor-namespace + customSubclasses (OQ-10)

describe('parseQualityMonitoringConfigYaml — vendor-namespace (OQ-10)', () => {
  it('defaults to enforce: reject', () => {
    const cfg = parseQualityMonitoringConfigYaml('');
    expect(cfg.vendorNamespace.enforce).toBe('reject');
  });

  it('parses enforce: warn', () => {
    const yaml = ['quality:', '  vendor-namespace:', '    enforce: warn'].join('\n');
    const cfg = parseQualityMonitoringConfigYaml(yaml);
    expect(cfg.vendorNamespace.enforce).toBe('warn');
  });

  it('parses enforce: none', () => {
    const yaml = ['vendor-namespace:', '  enforce: none'].join('\n');
    const cfg = parseQualityMonitoringConfigYaml(yaml);
    expect(cfg.vendorNamespace.enforce).toBe('none');
  });

  it('ignores unknown enforce values (keeps default)', () => {
    const yaml = ['vendor-namespace:', '  enforce: panic-and-quit'].join('\n');
    const cfg = parseQualityMonitoringConfigYaml(yaml);
    expect(cfg.vendorNamespace.enforce).toBe('reject');
  });

  it('parses customSubclasses list', () => {
    const yaml = [
      'quality:',
      '  customSubclasses:',
      '    - acme-corp:custom-gate-faulty',
      '    - acme-corp:billing-timeout',
    ].join('\n');
    const cfg = parseQualityMonitoringConfigYaml(yaml);
    expect(cfg.customSubclasses).toEqual([
      'acme-corp:custom-gate-faulty',
      'acme-corp:billing-timeout',
    ]);
  });
});

describe('enforceVendorNamespaceConfig (OQ-10)', () => {
  it('no-op when customSubclasses is empty', () => {
    expect(() => enforceVendorNamespaceConfig(baseConfig('reject', []))).not.toThrow();
  });

  it('no-op when enforce: none, even with illegal subclass', () => {
    expect(() =>
      enforceVendorNamespaceConfig(baseConfig('none', ['un-namespaced-bad'])),
    ).not.toThrow();
  });

  it('throws QualityMonitoringConfigError on reject mode with illegal subclass', () => {
    expect(() =>
      enforceVendorNamespaceConfig(baseConfig('reject', ['acme-corp:legit', 'un-namespaced-bad'])),
    ).toThrow(QualityMonitoringConfigError);
  });

  it('logs to provided logger on warn mode with illegal subclass', () => {
    const warnings: string[] = [];
    const logger = { warn: (m: string): void => void warnings.push(m) };
    expect(() =>
      enforceVendorNamespaceConfig(baseConfig('warn', ['un-namespaced-bad']), { logger }),
    ).not.toThrow();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/vendor-namespace/);
    expect(warnings[0]).toMatch(/un-namespaced-bad/);
  });

  it('does not throw on reject mode when all custom subclasses are valid', () => {
    expect(() =>
      enforceVendorNamespaceConfig(
        baseConfig('reject', ['acme-corp:custom-gate-faulty', 'my-company:billing-timeout']),
      ),
    ).not.toThrow();
  });
});

describe('loadQualityMonitoringConfig — OQ-10 enforcement at load time', () => {
  it('throws QualityMonitoringConfigError when illegal customSubclass under default reject', () => {
    const dir = join(workdir, '.ai-sdlc');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'quality-monitoring.yaml'),
      ['customSubclasses:', '  - un-namespaced-bad'].join('\n'),
    );
    expect(() => loadQualityMonitoringConfig({ workDir: workdir })).toThrow(
      QualityMonitoringConfigError,
    );
  });

  it('loads cleanly when illegal subclass + enforce: none', () => {
    const dir = join(workdir, '.ai-sdlc');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'quality-monitoring.yaml'),
      ['vendor-namespace:', '  enforce: none', 'customSubclasses:', '  - un-namespaced-bad'].join(
        '\n',
      ),
    );
    const cfg = loadQualityMonitoringConfig({ workDir: workdir });
    expect(cfg.customSubclasses).toEqual(['un-namespaced-bad']);
    expect(cfg.vendorNamespace.enforce).toBe('none');
  });
});

// ── Phase 5 (AISDLC-306) — coverage-gap / determinism / operator-time-cost ──

describe('Phase 5 defaults (AISDLC-306 / OQ-6, OQ-7, OQ-9)', () => {
  it('exposes shipping defaults from QUALITY_MONITORING_CONFIG_DEFAULTS', () => {
    expect(QUALITY_MONITORING_CONFIG_DEFAULTS.coverageGap.autoQuarantine).toBe(
      DEFAULT_COVERAGE_GAP_AUTO_QUARANTINE,
    );
    expect(QUALITY_MONITORING_CONFIG_DEFAULTS.coverageGap.fileCapture).toBe(
      DEFAULT_COVERAGE_GAP_FILE_CAPTURE,
    );
    expect(QUALITY_MONITORING_CONFIG_DEFAULTS.determinismDetection.defaultSampleRate).toBe(
      DEFAULT_DETERMINISM_SAMPLE_RATE,
    );
    expect(
      QUALITY_MONITORING_CONFIG_DEFAULTS.determinismDetection.alwaysOnRequiresDeterminism,
    ).toBe(true);
    expect(
      QUALITY_MONITORING_CONFIG_DEFAULTS.determinismDetection.alwaysOnTopBlastRadiusDecile,
    ).toBe(true);
    expect(QUALITY_MONITORING_CONFIG_DEFAULTS.operatorTimeCost.afkInactivityMinutes).toBe(
      DEFAULT_OPERATOR_TIME_COST_AFK_MINUTES,
    );
  });

  it('shipping defaults are: auto-quarantine ON, file-capture ON, 1-in-50, 30 min AFK', () => {
    expect(DEFAULT_COVERAGE_GAP_AUTO_QUARANTINE).toBe(true);
    expect(DEFAULT_COVERAGE_GAP_FILE_CAPTURE).toBe(true);
    expect(DEFAULT_DETERMINISM_SAMPLE_RATE).toBeCloseTo(0.02);
    expect(DEFAULT_OPERATOR_TIME_COST_AFK_MINUTES).toBe(30);
  });
});

describe('parseQualityMonitoringConfigYaml — Phase 5 blocks', () => {
  it('parses coverage-gap block (OQ-6)', () => {
    const yaml = [
      'quality:',
      '  coverage-gap:',
      '    autoQuarantine: false',
      '    fileCapture: false',
    ].join('\n');
    const cfg = parseQualityMonitoringConfigYaml(yaml);
    expect(cfg.coverageGap.autoQuarantine).toBe(false);
    expect(cfg.coverageGap.fileCapture).toBe(false);
  });

  it('coverage-gap defaults preserved when only one key is overridden', () => {
    const yaml = ['coverage-gap:', '  autoQuarantine: false'].join('\n');
    const cfg = parseQualityMonitoringConfigYaml(yaml);
    expect(cfg.coverageGap.autoQuarantine).toBe(false);
    expect(cfg.coverageGap.fileCapture).toBe(DEFAULT_COVERAGE_GAP_FILE_CAPTURE);
  });

  it('parses determinism-detection block (OQ-7)', () => {
    const yaml = [
      'quality:',
      '  determinism-detection:',
      '    defaultSampleRate: 0.1',
      '    alwaysOnRequiresDeterminism: false',
      '    alwaysOnTopBlastRadiusDecile: false',
    ].join('\n');
    const cfg = parseQualityMonitoringConfigYaml(yaml);
    expect(cfg.determinismDetection.defaultSampleRate).toBeCloseTo(0.1);
    expect(cfg.determinismDetection.alwaysOnRequiresDeterminism).toBe(false);
    expect(cfg.determinismDetection.alwaysOnTopBlastRadiusDecile).toBe(false);
  });

  it('rejects out-of-range determinism sample rates', () => {
    const yaml = ['determinism-detection:', '  defaultSampleRate: 2.5'].join('\n');
    const cfg = parseQualityMonitoringConfigYaml(yaml);
    // Out-of-range silently rejected → fall back to default.
    expect(cfg.determinismDetection.defaultSampleRate).toBe(DEFAULT_DETERMINISM_SAMPLE_RATE);
  });

  it('parses operator-time-cost block (OQ-9)', () => {
    const yaml = ['quality:', '  operator-time-cost:', '    afkInactivityMinutes: 60'].join('\n');
    const cfg = parseQualityMonitoringConfigYaml(yaml);
    expect(cfg.operatorTimeCost.afkInactivityMinutes).toBe(60);
  });

  it('rejects negative AFK minutes (falls back to default)', () => {
    const yaml = ['operator-time-cost:', '  afkInactivityMinutes: -5'].join('\n');
    const cfg = parseQualityMonitoringConfigYaml(yaml);
    expect(cfg.operatorTimeCost.afkInactivityMinutes).toBe(DEFAULT_OPERATOR_TIME_COST_AFK_MINUTES);
  });

  it('parses all Phase 5 blocks plus existing ones in one file', () => {
    const yaml = [
      'quality:',
      '  recurrence-windows:',
      '    - 14d',
      '  coverage-gap:',
      '    autoQuarantine: false',
      '  determinism-detection:',
      '    defaultSampleRate: 0.05',
      '  operator-time-cost:',
      '    afkInactivityMinutes: 45',
      '  vendor-namespace:',
      '    enforce: warn',
    ].join('\n');
    const cfg = parseQualityMonitoringConfigYaml(yaml);
    expect(cfg.recurrenceWindows).toEqual(['14d']);
    expect(cfg.coverageGap.autoQuarantine).toBe(false);
    expect(cfg.coverageGap.fileCapture).toBe(DEFAULT_COVERAGE_GAP_FILE_CAPTURE);
    expect(cfg.determinismDetection.defaultSampleRate).toBeCloseTo(0.05);
    expect(cfg.operatorTimeCost.afkInactivityMinutes).toBe(45);
    expect(cfg.vendorNamespace.enforce).toBe('warn');
  });
});

// ── Phase 2 (AISDLC-303) — OQ-1 confidence-bucketed classifier ────────

describe('Phase 2 defaults (AISDLC-303 / OQ-1 classifier thresholds)', () => {
  it('exposes shipping defaults from QUALITY_MONITORING_CONFIG_DEFAULTS', () => {
    expect(QUALITY_MONITORING_CONFIG_DEFAULTS.classifier.confidenceThresholds.autoClassify).toBe(
      DEFAULT_CLASSIFIER_AUTO_CLASSIFY_THRESHOLD,
    );
    expect(QUALITY_MONITORING_CONFIG_DEFAULTS.classifier.confidenceThresholds.ambiguous).toBe(
      DEFAULT_CLASSIFIER_AMBIGUOUS_THRESHOLD,
    );
  });

  it('shipping defaults match §13.1 (0.7 / 0.3)', () => {
    expect(DEFAULT_CLASSIFIER_AUTO_CLASSIFY_THRESHOLD).toBe(0.7);
    expect(DEFAULT_CLASSIFIER_AMBIGUOUS_THRESHOLD).toBe(0.3);
  });
});

describe('parseQualityMonitoringConfigYaml — classifier block (OQ-1)', () => {
  it('parses nested classifier.confidenceThresholds', () => {
    const yaml = [
      'quality:',
      '  classifier:',
      '    confidenceThresholds:',
      '      autoClassify: 0.85',
      '      ambiguous: 0.4',
    ].join('\n');
    const cfg = parseQualityMonitoringConfigYaml(yaml);
    expect(cfg.classifier.confidenceThresholds.autoClassify).toBeCloseTo(0.85);
    expect(cfg.classifier.confidenceThresholds.ambiguous).toBeCloseTo(0.4);
  });

  it('preserves the other threshold when only one is overridden', () => {
    const yaml = ['classifier:', '  confidenceThresholds:', '    autoClassify: 0.9'].join('\n');
    const cfg = parseQualityMonitoringConfigYaml(yaml);
    expect(cfg.classifier.confidenceThresholds.autoClassify).toBeCloseTo(0.9);
    expect(cfg.classifier.confidenceThresholds.ambiguous).toBe(
      DEFAULT_CLASSIFIER_AMBIGUOUS_THRESHOLD,
    );
  });

  it('rejects out-of-range threshold values (falls back to default)', () => {
    const yaml = [
      'classifier:',
      '  confidenceThresholds:',
      '    autoClassify: 1.5',
      '    ambiguous: -0.2',
    ].join('\n');
    const cfg = parseQualityMonitoringConfigYaml(yaml);
    expect(cfg.classifier.confidenceThresholds.autoClassify).toBe(
      DEFAULT_CLASSIFIER_AUTO_CLASSIFY_THRESHOLD,
    );
    expect(cfg.classifier.confidenceThresholds.ambiguous).toBe(
      DEFAULT_CLASSIFIER_AMBIGUOUS_THRESHOLD,
    );
  });

  it('silently swaps reversed thresholds (ambiguous > autoClassify)', () => {
    const yaml = [
      'classifier:',
      '  confidenceThresholds:',
      '    autoClassify: 0.3',
      '    ambiguous: 0.7',
    ].join('\n');
    const cfg = parseQualityMonitoringConfigYaml(yaml);
    expect(cfg.classifier.confidenceThresholds.autoClassify).toBeCloseTo(0.7);
    expect(cfg.classifier.confidenceThresholds.ambiguous).toBeCloseTo(0.3);
  });

  it('accepts boundary values (0 and 1)', () => {
    const yaml = [
      'classifier:',
      '  confidenceThresholds:',
      '    autoClassify: 1',
      '    ambiguous: 0',
    ].join('\n');
    const cfg = parseQualityMonitoringConfigYaml(yaml);
    expect(cfg.classifier.confidenceThresholds.autoClassify).toBe(1);
    expect(cfg.classifier.confidenceThresholds.ambiguous).toBe(0);
  });

  it('returns defaults when classifier block is absent', () => {
    const cfg = parseQualityMonitoringConfigYaml('');
    expect(cfg.classifier.confidenceThresholds).toEqual(
      QUALITY_MONITORING_CONFIG_DEFAULTS.classifier.confidenceThresholds,
    );
  });
});

describe('resolveClassifierConfidenceThresholds', () => {
  it('returns shipping defaults when config file is missing', () => {
    const thresholds = resolveClassifierConfidenceThresholds({ workDir: workdir });
    expect(thresholds).toEqual(QUALITY_MONITORING_CONFIG_DEFAULTS.classifier.confidenceThresholds);
  });

  it('returns per-org thresholds from quality-monitoring.yaml on disk', () => {
    const dir = join(workdir, '.ai-sdlc');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'quality-monitoring.yaml'),
      [
        'classifier:',
        '  confidenceThresholds:',
        '    autoClassify: 0.85',
        '    ambiguous: 0.4',
      ].join('\n'),
    );
    const thresholds = resolveClassifierConfidenceThresholds({ workDir: workdir });
    expect(thresholds.autoClassify).toBeCloseTo(0.85);
    expect(thresholds.ambiguous).toBeCloseTo(0.4);
  });

  it('returns defaults even when an unrelated block (vendor-namespace) is malformed', () => {
    // Force a quality-monitoring.yaml that would throw via OQ-10
    // enforcement; the classifier-resolver helper shields the consumer
    // from that.
    const dir = join(workdir, '.ai-sdlc');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'quality-monitoring.yaml'),
      ['customSubclasses:', '  - un-namespaced-bad'].join('\n'),
    );
    const thresholds = resolveClassifierConfidenceThresholds({ workDir: workdir });
    expect(thresholds).toEqual(QUALITY_MONITORING_CONFIG_DEFAULTS.classifier.confidenceThresholds);
  });
});

describe('loadQualityMonitoringConfig — Phase 5 round-trip', () => {
  it('loads coverage-gap + determinism-detection + operator-time-cost from yaml on disk', () => {
    const dir = join(workdir, '.ai-sdlc');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'quality-monitoring.yaml'),
      [
        'quality:',
        '  coverage-gap:',
        '    autoQuarantine: false',
        '    fileCapture: true',
        '  determinism-detection:',
        '    defaultSampleRate: 0.05',
        '    alwaysOnRequiresDeterminism: false',
        '  operator-time-cost:',
        '    afkInactivityMinutes: 15',
      ].join('\n'),
    );
    const cfg = loadQualityMonitoringConfig({ workDir: workdir });
    expect(cfg.coverageGap.autoQuarantine).toBe(false);
    expect(cfg.coverageGap.fileCapture).toBe(true);
    expect(cfg.determinismDetection.defaultSampleRate).toBeCloseTo(0.05);
    expect(cfg.determinismDetection.alwaysOnRequiresDeterminism).toBe(false);
    expect(cfg.determinismDetection.alwaysOnTopBlastRadiusDecile).toBe(true); // default preserved
    expect(cfg.operatorTimeCost.afkInactivityMinutes).toBe(15);
  });

  it('returns shipping defaults when yaml is missing', () => {
    const cfg = loadQualityMonitoringConfig({ workDir: workdir });
    expect(cfg.coverageGap).toEqual(QUALITY_MONITORING_CONFIG_DEFAULTS.coverageGap);
    expect(cfg.determinismDetection).toEqual(
      QUALITY_MONITORING_CONFIG_DEFAULTS.determinismDetection,
    );
    expect(cfg.operatorTimeCost).toEqual(QUALITY_MONITORING_CONFIG_DEFAULTS.operatorTimeCost);
  });
});
