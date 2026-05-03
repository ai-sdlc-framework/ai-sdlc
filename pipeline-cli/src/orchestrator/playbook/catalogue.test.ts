/**
 * Catalogue loader tests (RFC-0015 Phase 2 / AISDLC-169.2 — Q9).
 *
 * Covers:
 *   - Default catalogue (returned when YAML missing) carries all 9 modes.
 *   - YAML parser accepts the canonical shipped shape.
 *   - Schema-violating inputs throw `CatalogueParseError` (Q9 strict).
 *   - `effectiveBudgets` overlays operator overrides on top of defaults.
 *   - Real on-disk shipped catalogue parses cleanly.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  CATALOGUED_MODES,
  CatalogueParseError,
  DEFAULT_CATALOGUE,
  effectiveBudgets,
  loadFailurePatternCatalogue,
  parseCatalogueYaml,
} from './index.js';

const REPO_ROOT = (() => {
  // Walk up from this file until we find the worktree root (CLAUDE.md).
  let dir = process.cwd();
  for (let i = 0; i < 10; i++) {
    try {
      readFileSync(join(dir, 'CLAUDE.md'), 'utf8');
      return dir;
    } catch {
      dir = join(dir, '..');
    }
  }
  return process.cwd();
})();

describe('DEFAULT_CATALOGUE', () => {
  it('covers all 9 catalogued modes', () => {
    expect(DEFAULT_CATALOGUE.patterns).toHaveLength(CATALOGUED_MODES.length);
    expect(DEFAULT_CATALOGUE.patterns.map((p) => p.mode).sort()).toEqual(
      [...CATALOGUED_MODES].sort(),
    );
  });

  it('every default budget is a positive integer', () => {
    for (const p of DEFAULT_CATALOGUE.patterns) {
      expect(p.budget).toBeGreaterThan(0);
      expect(Number.isInteger(p.budget)).toBe(true);
    }
  });
});

describe('parseCatalogueYaml', () => {
  it('parses the canonical shape', () => {
    const yaml = `version: v1
patterns:
  - mode: SecretScanBlocked
    budget: 2
    escalateImmediately: false
    description: 'reformat literal secrets'
  - mode: PushRaceWithMergeQueue
    budget: 3
    description: 'sleep + retry'
`;
    const c = parseCatalogueYaml(yaml);
    expect(c.version).toBe('v1');
    expect(c.patterns).toHaveLength(2);
    expect(c.patterns[0]!.mode).toBe('SecretScanBlocked');
    expect(c.patterns[1]!.budget).toBe(3);
    expect(c.patterns[1]!.escalateImmediately).toBe(false);
  });

  it('rejects unknown mode (Q9 strict)', () => {
    expect(() =>
      parseCatalogueYaml(`version: v1\npatterns:\n  - mode: BogusMode\n    budget: 1`),
    ).toThrow(CatalogueParseError);
  });

  it('rejects non-v1 version', () => {
    expect(() =>
      parseCatalogueYaml(`version: v0\npatterns:\n  - mode: SecretScanBlocked\n    budget: 1`),
    ).toThrow(CatalogueParseError);
  });

  it('rejects negative budget', () => {
    expect(() =>
      parseCatalogueYaml(`version: v1\npatterns:\n  - mode: SecretScanBlocked\n    budget: -1`),
    ).toThrow(CatalogueParseError);
  });

  it('rejects unknown pattern key', () => {
    expect(() =>
      parseCatalogueYaml(
        `version: v1\npatterns:\n  - mode: SecretScanBlocked\n    budget: 2\n    bogusKey: x`,
      ),
    ).toThrow(CatalogueParseError);
  });

  it('rejects duplicate mode entry', () => {
    expect(() =>
      parseCatalogueYaml(
        `version: v1\npatterns:\n  - mode: SecretScanBlocked\n    budget: 2\n  - mode: SecretScanBlocked\n    budget: 1`,
      ),
    ).toThrow(CatalogueParseError);
  });

  it('rejects pattern entry missing required mode field', () => {
    expect(() => parseCatalogueYaml(`version: v1\npatterns:\n  - budget: 2`)).toThrow(
      CatalogueParseError,
    );
  });
});

describe('loadFailurePatternCatalogue', () => {
  it('returns DEFAULT_CATALOGUE when file absent', () => {
    const c = loadFailurePatternCatalogue({ filePath: '/tmp/nonexistent-catalogue.yaml' });
    expect(c).toEqual(DEFAULT_CATALOGUE);
  });

  it('parses the shipped on-disk catalogue at .ai-sdlc/orchestrator-failure-patterns.yaml', () => {
    const c = loadFailurePatternCatalogue({ workDir: REPO_ROOT });
    // Whatever the shipped catalogue is, it MUST cover all 9 modes — this
    // is Q9's "default catalogue ships with all 9" invariant.
    expect(c.patterns.map((p) => p.mode).sort()).toEqual([...CATALOGUED_MODES].sort());
  });
});

describe('effectiveBudgets', () => {
  it('returns default budgets when catalogue matches defaults', () => {
    const b = effectiveBudgets(DEFAULT_CATALOGUE);
    expect(b.SecretScanBlocked).toBe(2);
    expect(b.PushRaceWithMergeQueue).toBe(3);
    expect(b.UnknownFailureMode).toBe(0);
  });

  it('overrides specific modes from operator catalogue', () => {
    const c = parseCatalogueYaml(
      `version: v1\npatterns:\n  - mode: SecretScanBlocked\n    budget: 0\n    escalateImmediately: true`,
    );
    const b = effectiveBudgets(c);
    expect(b.SecretScanBlocked).toBe(0);
    // Other modes still keep the default budget (effectiveBudgets seeds
    // the table from DEFAULT_CATALOGUE then overlays).
    expect(b.PushRaceWithMergeQueue).toBe(3);
  });
});
