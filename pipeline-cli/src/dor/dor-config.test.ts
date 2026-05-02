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

describe('parseDorConfigYaml — autoPassRules (RFC-0011 Phase 4)', () => {
  it('defaults autoPassRules to []', () => {
    expect(DOR_CONFIG_DEFAULTS.autoPassRules).toEqual([]);
  });

  it('parses a single signal-pipeline-generated rule', () => {
    const yaml = `spec:
  evaluationMode: enforce
  autoPassRules:
    - kind: signal-pipeline-generated
      sources: ['ai-sdlc/signal-pipeline']
      gatesSkipped: [1, 4, 5, 6]
      gatesRetained: [2, 3, 7]
`;
    const cfg = parseDorConfigYaml(yaml);
    expect(cfg.autoPassRules).toHaveLength(1);
    const r = cfg.autoPassRules[0]!;
    expect(r.kind).toBe('signal-pipeline-generated');
    expect(r.sources).toEqual(['ai-sdlc/signal-pipeline']);
    expect(r.gatesSkipped).toEqual([1, 4, 5, 6]);
    expect(r.gatesRetained).toEqual([2, 3, 7]);
  });

  it('parses multiple rules in declared order', () => {
    const yaml = `spec:
  autoPassRules:
    - kind: dependency-bump
      sources: ['dependabot[bot]']
      titlePattern: '^bump'
      gatesSkipped: []
      gatesRetained: []
    - kind: doc-typo
      sources: ['somebot']
      maxBodyDiffLines: 50
      gatesSkipped: [1, 4, 5]
      gatesRetained: []
`;
    const cfg = parseDorConfigYaml(yaml);
    expect(cfg.autoPassRules).toHaveLength(2);
    expect(cfg.autoPassRules[0]!.kind).toBe('dependency-bump');
    expect(cfg.autoPassRules[0]!.titlePattern).toBe('^bump');
    expect(cfg.autoPassRules[1]!.kind).toBe('doc-typo');
    expect(cfg.autoPassRules[1]!.maxBodyDiffLines).toBe(50);
    expect(cfg.autoPassRules[1]!.gatesSkipped).toEqual([1, 4, 5]);
  });

  it('preserves staleness + autoPassRules when both present', () => {
    const yaml = `spec:
  evaluationMode: enforce
  autoPassRules:
    - kind: signal-pipeline-generated
      sources: ['ai-sdlc/signal-pipeline']
      gatesSkipped: [1, 4, 5, 6]
      gatesRetained: [2, 3, 7]
  staleness:
    warnAfterDays: 7
    closeAfterDays: 14
    closedLabel: 'stale'
`;
    const cfg = parseDorConfigYaml(yaml);
    expect(cfg.autoPassRules).toHaveLength(1);
    expect(cfg.staleness.warnAfterDays).toBe(7);
    expect(cfg.staleness.closeAfterDays).toBe(14);
    expect(cfg.evaluationMode).toBe('enforce');
  });

  it('handles empty inline arrays', () => {
    const yaml = `spec:
  autoPassRules:
    - kind: full-skip
      sources: ['allbot']
      gatesSkipped: []
      gatesRetained: []
`;
    const cfg = parseDorConfigYaml(yaml);
    expect(cfg.autoPassRules[0]!.gatesSkipped).toEqual([]);
    expect(cfg.autoPassRules[0]!.gatesRetained).toEqual([]);
  });

  it('ignores unknown autoPassRules fields silently', () => {
    const yaml = `spec:
  autoPassRules:
    - kind: x
      sources: ['s']
      somethingNew: blah
      gatesSkipped: [3]
      gatesRetained: []
`;
    const cfg = parseDorConfigYaml(yaml);
    expect(cfg.autoPassRules).toHaveLength(1);
    expect(cfg.autoPassRules[0]!.kind).toBe('x');
    expect(cfg.autoPassRules[0]!.gatesSkipped).toEqual([3]);
  });
});
