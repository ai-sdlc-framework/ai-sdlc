/**
 * Tests for the DoR config loader / parser.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DOR_CONFIG_DEFAULTS,
  loadDorConfig,
  parseDorConfigYaml,
  resolveDorConfigPath,
  validateDorConfig,
} from './dor-config.js';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'dor-config-'));
});

afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

describe('resolveDorConfigPath', () => {
  it('honors explicit filePath override', () => {
    expect(resolveDorConfigPath({ filePath: '/abs/x.yaml' })).toBe('/abs/x.yaml');
  });

  it('resolves <workDir>/.ai-sdlc/dor-config.yaml when no override', () => {
    const p = resolveDorConfigPath({ workDir: '/proj' });
    expect(p).toBe('/proj/.ai-sdlc/dor-config.yaml');
  });
});

describe('loadDorConfig', () => {
  it('returns defaults when the file does not exist', () => {
    const cfg = loadDorConfig({ workDir: tmp });
    expect(cfg).toEqual(DOR_CONFIG_DEFAULTS);
  });

  it('parses a full config file', () => {
    const yaml = `apiVersion: ai-sdlc.io/v1alpha1
kind: DorConfig
spec:
  rubricVersion: v1
  evaluationMode: enforce
  notifications:
    authorChannel: true
    dedicatedChannel:
      slack: '#ai-sdlc-dor'
      github_team: '@org/triage'
  staleness:
    warnAfterDays: 7
    closeAfterDays: 21
    closedLabel: 'closed-as-stale'
`;
    mkdirSync(join(tmp, '.ai-sdlc'), { recursive: true });
    writeFileSync(join(tmp, '.ai-sdlc', 'dor-config.yaml'), yaml);
    const cfg = loadDorConfig({ workDir: tmp });
    expect(cfg.evaluationMode).toBe('enforce');
    expect(cfg.notifications.authorChannel).toBe(true);
    expect(cfg.notifications.dedicatedChannel?.slack).toBe('#ai-sdlc-dor');
    expect(cfg.notifications.dedicatedChannel?.github_team).toBe('@org/triage');
    expect(cfg.staleness.warnAfterDays).toBe(7);
    expect(cfg.staleness.closeAfterDays).toBe(21);
    expect(cfg.staleness.closedLabel).toBe('closed-as-stale');
  });
});

describe('parseDorConfigYaml', () => {
  it('preserves defaults when the file is empty', () => {
    const cfg = parseDorConfigYaml('');
    expect(cfg).toEqual(DOR_CONFIG_DEFAULTS);
  });

  it('ignores comment-only lines', () => {
    const cfg = parseDorConfigYaml('# hello\n# world\n');
    expect(cfg).toEqual(DOR_CONFIG_DEFAULTS);
  });

  it('parses authorChannel false', () => {
    const cfg = parseDorConfigYaml('spec:\n  notifications:\n    authorChannel: false\n');
    expect(cfg.notifications.authorChannel).toBe(false);
  });

  it('handles double-quoted strings', () => {
    const cfg = parseDorConfigYaml(
      'spec:\n  staleness:\n    warnAfterDays: 14\n    closeAfterDays: 28\n    closedLabel: "stale"\n',
    );
    expect(cfg.staleness.closedLabel).toBe('stale');
  });

  it('rejects unknown evaluationMode silently (keeps default)', () => {
    const cfg = parseDorConfigYaml('spec:\n  evaluationMode: nonsense\n');
    expect(cfg.evaluationMode).toBe(DOR_CONFIG_DEFAULTS.evaluationMode);
  });
});

describe('validateDorConfig', () => {
  it('accepts the defaults', () => {
    expect(validateDorConfig(DOR_CONFIG_DEFAULTS)).toEqual([]);
  });

  it('rejects close <= warn', () => {
    const cfg = {
      ...DOR_CONFIG_DEFAULTS,
      staleness: { warnAfterDays: 30, closeAfterDays: 15, closedLabel: 'x' },
    };
    const violations = validateDorConfig(cfg);
    expect(violations.length).toBe(1);
    expect(violations[0]).toContain('closeAfterDays');
  });
});
