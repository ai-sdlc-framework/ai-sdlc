/**
 * Tests for `loadSubstrateConfig()` — per-org config resolution
 * (AISDLC-321 AC-3).
 */

import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DEFAULT_CONFIDENCE_THRESHOLD,
  DEFAULT_DAILY_TOKEN_CAP,
  DEFAULT_HAIKU_MODEL,
  loadSubstrateConfig,
} from './config.js';

function makeRepoRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'aisdlc-321-config-'));
  mkdirSync(join(dir, '.ai-sdlc'), { recursive: true });
  return dir;
}

function writeYaml(
  repoRoot: string,
  name: 'capture-config.yaml' | 'decisions-config.yaml',
  body: string,
): void {
  writeFileSync(join(repoRoot, '.ai-sdlc', name), body, 'utf8');
}

describe('loadSubstrateConfig — defaults', () => {
  it('returns 0.7 / haiku / 1M when no file exists', () => {
    const repoRoot = makeRepoRoot();
    try {
      const cfg = loadSubstrateConfig('capture-triage', repoRoot);
      expect(cfg.threshold).toBe(DEFAULT_CONFIDENCE_THRESHOLD);
      expect(cfg.model).toBe(DEFAULT_HAIKU_MODEL);
      expect(cfg.dailyTokenCap).toBe(DEFAULT_DAILY_TOKEN_CAP);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it('falls back to defaults on yaml parse error', () => {
    const repoRoot = makeRepoRoot();
    try {
      writeYaml(repoRoot, 'capture-config.yaml', 'not: valid: yaml:::');
      const cfg = loadSubstrateConfig('capture-triage', repoRoot);
      expect(cfg.threshold).toBe(DEFAULT_CONFIDENCE_THRESHOLD);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it('falls back to defaults when classifier block missing', () => {
    const repoRoot = makeRepoRoot();
    try {
      writeYaml(
        repoRoot,
        'capture-config.yaml',
        'capture:\n  lifecycle:\n    draftAutoSubmitDays: 7\n',
      );
      const cfg = loadSubstrateConfig('capture-triage', repoRoot);
      expect(cfg.threshold).toBe(DEFAULT_CONFIDENCE_THRESHOLD);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});

describe('loadSubstrateConfig — global overrides', () => {
  it('honours classifier.threshold for capture task types', () => {
    const repoRoot = makeRepoRoot();
    try {
      writeYaml(
        repoRoot,
        'capture-config.yaml',
        'classifier:\n  threshold: 0.85\n  model: claude-sonnet-4-5\n',
      );
      const cfg = loadSubstrateConfig('capture-triage', repoRoot);
      expect(cfg.threshold).toBe(0.85);
      expect(cfg.model).toBe('claude-sonnet-4-5');
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it('routes decision-recommendation to decisions-config.yaml', () => {
    const repoRoot = makeRepoRoot();
    try {
      writeYaml(repoRoot, 'capture-config.yaml', 'classifier:\n  threshold: 0.6\n');
      writeYaml(
        repoRoot,
        'decisions-config.yaml',
        'classifier:\n  threshold: 0.9\n  model: claude-opus-4-7\n',
      );
      const captureCfg = loadSubstrateConfig('capture-triage', repoRoot);
      const decisionCfg = loadSubstrateConfig('decision-recommendation', repoRoot);
      expect(captureCfg.threshold).toBe(0.6);
      expect(decisionCfg.threshold).toBe(0.9);
      expect(decisionCfg.model).toBe('claude-opus-4-7');
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});

describe('loadSubstrateConfig — per-task overrides', () => {
  it('overrides global with per-task threshold/model', () => {
    const repoRoot = makeRepoRoot();
    try {
      writeYaml(
        repoRoot,
        'capture-config.yaml',
        [
          'classifier:',
          '  threshold: 0.7',
          '  model: claude-haiku-4-5',
          '  perTaskType:',
          '    capture-severity:',
          '      threshold: 0.85',
          '      model: claude-sonnet-4-5',
          '',
        ].join('\n'),
      );
      const triage = loadSubstrateConfig('capture-triage', repoRoot);
      const severity = loadSubstrateConfig('capture-severity', repoRoot);
      expect(triage.threshold).toBe(0.7);
      expect(triage.model).toBe('claude-haiku-4-5');
      expect(severity.threshold).toBe(0.85);
      expect(severity.model).toBe('claude-sonnet-4-5');
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});

describe('loadSubstrateConfig — clamping', () => {
  it('clamps thresholds to [0, 1]', () => {
    const repoRoot = makeRepoRoot();
    try {
      writeYaml(repoRoot, 'capture-config.yaml', 'classifier:\n  threshold: 2.5\n');
      expect(loadSubstrateConfig('capture-triage', repoRoot).threshold).toBe(1);
      writeYaml(repoRoot, 'capture-config.yaml', 'classifier:\n  threshold: -0.5\n');
      expect(loadSubstrateConfig('capture-triage', repoRoot).threshold).toBe(0);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it('ignores non-numeric threshold', () => {
    const repoRoot = makeRepoRoot();
    try {
      writeYaml(repoRoot, 'capture-config.yaml', 'classifier:\n  threshold: "high"\n');
      expect(loadSubstrateConfig('capture-triage', repoRoot).threshold).toBe(
        DEFAULT_CONFIDENCE_THRESHOLD,
      );
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it('falls back to default for negative or non-numeric dailyTokenCap', () => {
    const repoRoot = makeRepoRoot();
    try {
      writeYaml(repoRoot, 'capture-config.yaml', 'classifier:\n  dailyTokenCap: -1\n');
      expect(loadSubstrateConfig('capture-triage', repoRoot).dailyTokenCap).toBe(
        DEFAULT_DAILY_TOKEN_CAP,
      );
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});

// ── AISDLC-275 AC-4: per-agent threshold overrides ──────────────────────────

describe('loadSubstrateConfig — per-agent overrides (AISDLC-275 AC-4)', () => {
  it('per-agent threshold trumps per-task + global', () => {
    const repoRoot = makeRepoRoot();
    try {
      writeYaml(
        repoRoot,
        'capture-config.yaml',
        [
          'classifier:',
          '  threshold: 0.7',
          '  perTaskType:',
          '    capture-triage:',
          '      threshold: 0.6',
          '  perAgentRole:',
          '    security-reviewer:',
          '      threshold: 0.9',
          '    code-reviewer:',
          '      threshold: 0.5',
          '',
        ].join('\n'),
      );
      // No agentRole → falls back to per-task (0.6).
      expect(loadSubstrateConfig('capture-triage', repoRoot).threshold).toBe(0.6);
      // security-reviewer → per-agent override wins.
      expect(loadSubstrateConfig('capture-triage', repoRoot, 'security-reviewer').threshold).toBe(
        0.9,
      );
      // code-reviewer → per-agent override wins (looser).
      expect(loadSubstrateConfig('capture-triage', repoRoot, 'code-reviewer').threshold).toBe(0.5);
      // Unknown agentRole → falls back to per-task.
      expect(loadSubstrateConfig('capture-triage', repoRoot, 'never-heard-of').threshold).toBe(0.6);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it('per-agent threshold falls back to global when per-task is absent', () => {
    const repoRoot = makeRepoRoot();
    try {
      writeYaml(
        repoRoot,
        'capture-config.yaml',
        [
          'classifier:',
          '  threshold: 0.7',
          '  perAgentRole:',
          '    security-reviewer:',
          '      threshold: 0.85',
          '',
        ].join('\n'),
      );
      expect(loadSubstrateConfig('capture-severity', repoRoot).threshold).toBe(0.7);
      expect(loadSubstrateConfig('capture-severity', repoRoot, 'security-reviewer').threshold).toBe(
        0.85,
      );
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it('clamps per-agent threshold to [0, 1]', () => {
    const repoRoot = makeRepoRoot();
    try {
      writeYaml(
        repoRoot,
        'capture-config.yaml',
        ['classifier:', '  perAgentRole:', '    rogue: { threshold: 5 }', ''].join('\n'),
      );
      expect(loadSubstrateConfig('capture-triage', repoRoot, 'rogue').threshold).toBe(1);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it('missing perAgentRole block falls back without throwing', () => {
    const repoRoot = makeRepoRoot();
    try {
      writeYaml(repoRoot, 'capture-config.yaml', 'classifier:\n  threshold: 0.7\n');
      expect(loadSubstrateConfig('capture-triage', repoRoot, 'security-reviewer').threshold).toBe(
        0.7,
      );
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});
