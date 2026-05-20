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
  DEFAULT_UPSTREAM_TEMPLATE_PATH,
  QUALITY_MONITORING_CONFIG_DEFAULTS,
  QualityMonitoringConfigError,
  enforceVendorNamespaceConfig,
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
    expect(() =>
      enforceVendorNamespaceConfig({
        recurrenceWindows: [],
        upstreamReporting: { repoUrl: '', prefilledIssueTemplate: '' },
        vendorNamespace: { enforce: 'reject' },
        customSubclasses: [],
      }),
    ).not.toThrow();
  });

  it('no-op when enforce: none, even with illegal subclass', () => {
    expect(() =>
      enforceVendorNamespaceConfig({
        recurrenceWindows: [],
        upstreamReporting: { repoUrl: '', prefilledIssueTemplate: '' },
        vendorNamespace: { enforce: 'none' },
        customSubclasses: ['un-namespaced-bad'],
      }),
    ).not.toThrow();
  });

  it('throws QualityMonitoringConfigError on reject mode with illegal subclass', () => {
    expect(() =>
      enforceVendorNamespaceConfig({
        recurrenceWindows: [],
        upstreamReporting: { repoUrl: '', prefilledIssueTemplate: '' },
        vendorNamespace: { enforce: 'reject' },
        customSubclasses: ['acme-corp:legit', 'un-namespaced-bad'],
      }),
    ).toThrow(QualityMonitoringConfigError);
  });

  it('logs to provided logger on warn mode with illegal subclass', () => {
    const warnings: string[] = [];
    const logger = { warn: (m: string): void => void warnings.push(m) };
    expect(() =>
      enforceVendorNamespaceConfig(
        {
          recurrenceWindows: [],
          upstreamReporting: { repoUrl: '', prefilledIssueTemplate: '' },
          vendorNamespace: { enforce: 'warn' },
          customSubclasses: ['un-namespaced-bad'],
        },
        { logger },
      ),
    ).not.toThrow();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/vendor-namespace/);
    expect(warnings[0]).toMatch(/un-namespaced-bad/);
  });

  it('does not throw on reject mode when all custom subclasses are valid', () => {
    expect(() =>
      enforceVendorNamespaceConfig({
        recurrenceWindows: [],
        upstreamReporting: { repoUrl: '', prefilledIssueTemplate: '' },
        vendorNamespace: { enforce: 'reject' },
        customSubclasses: ['acme-corp:custom-gate-faulty', 'my-company:billing-timeout'],
      }),
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
