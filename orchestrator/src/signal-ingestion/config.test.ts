import { describe, expect, it } from 'vitest';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  loadSignalIngestionConfig,
  DEFAULT_SIGNAL_INGESTION_CONFIG,
  SignalIngestionConfigError,
} from './config.js';

// ── Test helpers ──────────────────────────────────────────────────────────────

function makeTmpDir(): string {
  const dir = join(tmpdir(), `signal-config-test-${process.pid}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeConfig(dir: string, content: string): string {
  const aiSdlcDir = join(dir, '.ai-sdlc');
  mkdirSync(aiSdlcDir, { recursive: true });
  const configPath = join(aiSdlcDir, 'signal-ingestion.yaml');
  writeFileSync(configPath, content, 'utf8');
  return configPath;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('loadSignalIngestionConfig', () => {
  it('returns defaults when config file is absent', () => {
    const dir = makeTmpDir();
    try {
      const config = loadSignalIngestionConfig({ projectRoot: dir });
      expect(config).toEqual(DEFAULT_SIGNAL_INGESTION_CONFIG);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('parses a minimal config file (enabled: true)', () => {
    const dir = makeTmpDir();
    try {
      writeConfig(
        dir,
        `
apiVersion: ai-sdlc.io/v1alpha1
kind: SignalIngestionConfig
spec:
  enabled: true
`,
      );
      const config = loadSignalIngestionConfig({ projectRoot: dir });
      expect(config.enabled).toBe(true);
      // Defaults fill in everything else
      expect(config.tierMultipliers).toEqual(DEFAULT_SIGNAL_INGESTION_CONFIG.tierMultipliers);
      expect(config.acceptedLanguages).toEqual(['en']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('parses custom tier multipliers', () => {
    const dir = makeTmpDir();
    try {
      writeConfig(
        dir,
        `
spec:
  tierMultipliers:
    enterprise: 5.0
    mid: 2.0
    smb: 1.0
    free: 0.1
    churned: 4.0
`,
      );
      const config = loadSignalIngestionConfig({ projectRoot: dir });
      expect(config.tierMultipliers).toEqual({
        enterprise: 5.0,
        mid: 2.0,
        smb: 1.0,
        free: 0.1,
        churned: 4.0,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('parses custom ICP resonance weights', () => {
    const dir = makeTmpDir();
    try {
      writeConfig(
        dir,
        `
spec:
  icpResonanceWeights:
    strong: 2.0
    partial: 1.0
    weak: 0.25
`,
      );
      const config = loadSignalIngestionConfig({ projectRoot: dir });
      expect(config.icpResonanceWeights).toEqual({
        strong: 2.0,
        partial: 1.0,
        weak: 0.25,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('parses recencyHalfLifeDays', () => {
    const dir = makeTmpDir();
    try {
      writeConfig(dir, 'spec:\n  recencyHalfLifeDays: 14\n');
      const config = loadSignalIngestionConfig({ projectRoot: dir });
      expect(config.recencyHalfLifeDays).toBe(14);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('parses acceptedLanguages', () => {
    const dir = makeTmpDir();
    try {
      writeConfig(
        dir,
        `
spec:
  acceptedLanguages:
    - en
    - fr
    - de
`,
      );
      const config = loadSignalIngestionConfig({ projectRoot: dir });
      expect(config.acceptedLanguages).toEqual(['en', 'fr', 'de']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('normalizes acceptedLanguages to lowercase', () => {
    const dir = makeTmpDir();
    try {
      writeConfig(dir, 'spec:\n  acceptedLanguages:\n    - EN\n    - FR\n');
      const config = loadSignalIngestionConfig({ projectRoot: dir });
      expect(config.acceptedLanguages).toEqual(['en', 'fr']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('parses clustering algorithm and threshold', () => {
    const dir = makeTmpDir();
    try {
      writeConfig(
        dir,
        `
spec:
  clustering:
    algorithm: embedding
    similarityThreshold: 0.75
`,
      );
      const config = loadSignalIngestionConfig({ projectRoot: dir });
      expect(config.clustering.algorithm).toBe('embedding');
      expect(config.clustering.similarityThreshold).toBe(0.75);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('parses adapters list', () => {
    const dir = makeTmpDir();
    try {
      writeConfig(
        dir,
        `
spec:
  adapters:
    - signal-source-support-ticket
    - signal-source-crm-note
`,
      );
      const config = loadSignalIngestionConfig({ projectRoot: dir });
      expect(config.adapters).toEqual(['signal-source-support-ticket', 'signal-source-crm-note']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('parses tier2SignificanceThreshold', () => {
    const dir = makeTmpDir();
    try {
      writeConfig(
        dir,
        `
spec:
  tier2SignificanceThreshold:
    minSignalCount: 10
    minUniqueSources: 5
    minTier1SignalCount: 2
    minClusterAgeDays: 14
`,
      );
      const config = loadSignalIngestionConfig({ projectRoot: dir });
      expect(config.tier2SignificanceThreshold).toEqual({
        minSignalCount: 10,
        minUniqueSources: 5,
        minTier1SignalCount: 2,
        minClusterAgeDays: 14,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('throws SignalIngestionConfigError on invalid YAML', () => {
    const dir = makeTmpDir();
    try {
      writeConfig(dir, ':::invalid yaml\n  - [malformed');
      expect(() => loadSignalIngestionConfig({ projectRoot: dir })).toThrow(
        SignalIngestionConfigError,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('throws SignalIngestionConfigError when clustering.algorithm is invalid', () => {
    const dir = makeTmpDir();
    try {
      writeConfig(dir, 'spec:\n  clustering:\n    algorithm: neural\n');
      expect(() => loadSignalIngestionConfig({ projectRoot: dir })).toThrow(
        SignalIngestionConfigError,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('throws SignalIngestionConfigError when root is not an object', () => {
    const dir = makeTmpDir();
    try {
      writeConfig(dir, '- just a list\n');
      expect(() => loadSignalIngestionConfig({ projectRoot: dir })).toThrow(
        SignalIngestionConfigError,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('accepts an explicit configPath option', () => {
    const dir = makeTmpDir();
    try {
      const customPath = join(dir, 'custom-signal-ingestion.yaml');
      writeFileSync(customPath, 'spec:\n  enabled: true\n', 'utf8');
      const config = loadSignalIngestionConfig({ configPath: customPath });
      expect(config.enabled).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('parses a flat config (no spec: wrapper)', () => {
    const dir = makeTmpDir();
    try {
      writeConfig(dir, 'enabled: true\nrecencyHalfLifeDays: 60\n');
      const config = loadSignalIngestionConfig({ projectRoot: dir });
      expect(config.enabled).toBe(true);
      expect(config.recencyHalfLifeDays).toBe(60);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // ── AISDLC-432: residencyEnforcement block (RFC-0030 v0.3 §11) ───────────

  it('defaults residencyEnforcement to all enforcement points ON with union behaviour', () => {
    const dir = makeTmpDir();
    try {
      writeConfig(dir, 'spec:\n  enabled: true\n');
      const config = loadSignalIngestionConfig({ projectRoot: dir });
      expect(config.residencyEnforcement).toEqual({
        sourceFromCompliancePosture: true,
        enforcementPoints: {
          fetchSignals: true,
          clustering: true,
          storage: true,
          unifiedCostReport: true,
        },
        multiPostureBehavior: 'union',
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('parses partial residencyEnforcement.enforcementPoints overrides with defaults for missing flags', () => {
    const dir = makeTmpDir();
    try {
      writeConfig(
        dir,
        'spec:\n  residencyEnforcement:\n    enforcementPoints:\n      clustering: false\n',
      );
      const config = loadSignalIngestionConfig({ projectRoot: dir });
      expect(config.residencyEnforcement.enforcementPoints.clustering).toBe(false);
      // Other points retain defaults.
      expect(config.residencyEnforcement.enforcementPoints.fetchSignals).toBe(true);
      expect(config.residencyEnforcement.enforcementPoints.storage).toBe(true);
      expect(config.residencyEnforcement.enforcementPoints.unifiedCostReport).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('parses sourceFromCompliancePosture override', () => {
    const dir = makeTmpDir();
    try {
      writeConfig(dir, 'spec:\n  residencyEnforcement:\n    sourceFromCompliancePosture: false\n');
      const config = loadSignalIngestionConfig({ projectRoot: dir });
      expect(config.residencyEnforcement.sourceFromCompliancePosture).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('throws when residencyEnforcement is not an object', () => {
    const dir = makeTmpDir();
    try {
      writeConfig(dir, 'spec:\n  residencyEnforcement: [list, not, object]\n');
      expect(() => loadSignalIngestionConfig({ projectRoot: dir })).toThrow(
        SignalIngestionConfigError,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('throws when enforcementPoints is not an object', () => {
    const dir = makeTmpDir();
    try {
      writeConfig(
        dir,
        'spec:\n  residencyEnforcement:\n    enforcementPoints: [not, an, object]\n',
      );
      expect(() => loadSignalIngestionConfig({ projectRoot: dir })).toThrow(
        SignalIngestionConfigError,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('throws when multiPostureBehavior is set to an unsupported value', () => {
    const dir = makeTmpDir();
    try {
      writeConfig(dir, 'spec:\n  residencyEnforcement:\n    multiPostureBehavior: intersection\n');
      expect(() => loadSignalIngestionConfig({ projectRoot: dir })).toThrow(
        SignalIngestionConfigError,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
