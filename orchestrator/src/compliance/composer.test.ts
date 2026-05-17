/**
 * Unit tests for the DerivedGates composer (RFC-0022 §9 Phase 2).
 *
 * Test matrix (AC #7):
 *  1. Per-regime DerivedGates — each regime in the §6 table produces expected gates
 *  2. Multi-regime composition — tightest-wins per axis (SOC2+HIPAA, GDPR alone, etc.)
 *  3. Operator-override precedence — operator gates always win when _notes present
 *  4. Adopter regimeOverrides — per-regime overrides apply before operator-override pass (OQ-1)
 *  5. UnknownRegime thrown for unrecognized regime IDs
 *  6. No regimes → BASELINE_DERIVED_GATES returned
 *  7. CompositionResult metadata (composedRegimes, regimesWithAdopterOverrides, operatorOverriddenFields)
 */

import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { composePostureDerivedGates } from './composer.js';
import { UnknownRegime } from './errors.js';
import { BASELINE_DERIVED_GATES } from './types.js';
import type { CompliancePosture } from './types.js';

// ── Resolve the canonical mappings file ───────────────────────────────────

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

function resolveRepoRoot(): string {
  let dir = fileURLToPath(new URL('.', import.meta.url));
  for (let i = 0; i < 10; i++) {
    const candidate = resolve(dir, 'spec/compliance/regime-mappings.yaml');
    if (existsSync(candidate)) return dir;
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('Could not find repo root with spec/compliance/regime-mappings.yaml');
}

const REPO_ROOT = resolveRepoRoot();
const CANONICAL_MAPPINGS = resolve(REPO_ROOT, 'spec/compliance/regime-mappings.yaml');

// ── Fixture helpers ───────────────────────────────────────────────────────

function makePosture(
  regimes: Array<{
    id: string;
    attestedBy?: string;
    attestedAt?: string;
    controls?: string[];
  }>,
  derivedGates?: CompliancePosture['spec']['derivedGates'],
  regimeOverrides?: Record<string, unknown>,
): CompliancePosture {
  const spec: CompliancePosture['spec'] & { regimeOverrides?: Record<string, unknown> } = {
    regimes: regimes.map((r) => ({
      id: r.id,
      attestedBy: r.attestedBy ?? 'test@example.com',
      attestedAt: r.attestedAt ?? '2026-05-16',
      controls: r.controls,
    })),
    auditExports: [],
  };
  if (derivedGates !== undefined) {
    spec.derivedGates = derivedGates;
  }
  if (regimeOverrides !== undefined) {
    spec.regimeOverrides = regimeOverrides;
  }
  return {
    apiVersion: 'ai-sdlc.io/v1alpha1',
    kind: 'CompliancePosture',
    metadata: { name: 'test-project' },
    spec,
  };
}

// ── Per-regime tests (AC #7, §6 table) ───────────────────────────────────

describe('composePostureDerivedGates() — per-regime DerivedGates', () => {
  it('SOC2-T2: per-shard, strict, attestation=true, 2555d, allowlist+role', () => {
    const posture = makePosture([{ id: 'SOC2-T2' }]);
    const { derivedGates } = composePostureDerivedGates(posture, {
      mappingsPath: CANONICAL_MAPPINGS,
    });
    expect(derivedGates.databaseBranchPool).toBe('per-shard');
    expect(derivedGates.secretScanStrictness).toBe('strict');
    expect(derivedGates.attestationRequired).toBe(true);
    expect(derivedGates.auditRetentionDays).toBe(2555);
    expect(derivedGates.reviewerAuthorityModel).toBe('allowlist+role');
  });

  it('HIPAA: per-shard, strict, attestation=true, 2190d, allowlist+role', () => {
    const posture = makePosture([{ id: 'HIPAA' }]);
    const { derivedGates } = composePostureDerivedGates(posture, {
      mappingsPath: CANONICAL_MAPPINGS,
    });
    expect(derivedGates.databaseBranchPool).toBe('per-shard');
    expect(derivedGates.secretScanStrictness).toBe('strict');
    expect(derivedGates.attestationRequired).toBe(true);
    expect(derivedGates.auditRetentionDays).toBe(2190);
    expect(derivedGates.reviewerAuthorityModel).toBe('allowlist+role');
  });

  it('PCI-DSS-L1: per-shard, strict, attestation=true, 365d, allowlist+role', () => {
    const posture = makePosture([{ id: 'PCI-DSS-L1' }]);
    const { derivedGates } = composePostureDerivedGates(posture, {
      mappingsPath: CANONICAL_MAPPINGS,
    });
    expect(derivedGates.databaseBranchPool).toBe('per-shard');
    expect(derivedGates.secretScanStrictness).toBe('strict');
    expect(derivedGates.attestationRequired).toBe(true);
    expect(derivedGates.auditRetentionDays).toBe(365);
    expect(derivedGates.reviewerAuthorityModel).toBe('allowlist+role');
  });

  it('GDPR: per-shard, standard, attestation=true, 365d, allowlist', () => {
    const posture = makePosture([{ id: 'GDPR' }]);
    const { derivedGates } = composePostureDerivedGates(posture, {
      mappingsPath: CANONICAL_MAPPINGS,
    });
    expect(derivedGates.databaseBranchPool).toBe('per-shard');
    expect(derivedGates.secretScanStrictness).toBe('standard');
    expect(derivedGates.attestationRequired).toBe(true);
    expect(derivedGates.auditRetentionDays).toBe(365);
    expect(derivedGates.reviewerAuthorityModel).toBe('allowlist');
  });

  it('FedRAMP-Moderate: per-shard, strict, attestation=true, 1095d, allowlist+role', () => {
    const posture = makePosture([{ id: 'FedRAMP-Moderate' }]);
    const { derivedGates } = composePostureDerivedGates(posture, {
      mappingsPath: CANONICAL_MAPPINGS,
    });
    expect(derivedGates.databaseBranchPool).toBe('per-shard');
    expect(derivedGates.secretScanStrictness).toBe('strict');
    expect(derivedGates.attestationRequired).toBe(true);
    expect(derivedGates.auditRetentionDays).toBe(1095);
    expect(derivedGates.reviewerAuthorityModel).toBe('allowlist+role');
  });

  it('ISO-27001:2022: per-shard, strict, attestation=true, 365d, allowlist+role', () => {
    const posture = makePosture([{ id: 'ISO-27001:2022' }]);
    const { derivedGates } = composePostureDerivedGates(posture, {
      mappingsPath: CANONICAL_MAPPINGS,
    });
    expect(derivedGates.databaseBranchPool).toBe('per-shard');
    expect(derivedGates.secretScanStrictness).toBe('strict');
    expect(derivedGates.attestationRequired).toBe(true);
    expect(derivedGates.auditRetentionDays).toBe(365);
    expect(derivedGates.reviewerAuthorityModel).toBe('allowlist+role');
  });
});

// ── Baseline (no regimes) ─────────────────────────────────────────────────

describe('composePostureDerivedGates() — no regimes → baseline', () => {
  it('returns BASELINE_DERIVED_GATES when no regimes declared', () => {
    const posture = makePosture([]);
    const { derivedGates, composedRegimes } = composePostureDerivedGates(posture, {
      mappingsPath: CANONICAL_MAPPINGS,
    });
    expect(derivedGates).toEqual(BASELINE_DERIVED_GATES);
    expect(composedRegimes).toEqual([]);
  });

  it('baseline: shared-with-rls, minimal, false, 90d, open', () => {
    const posture = makePosture([]);
    const { derivedGates } = composePostureDerivedGates(posture, {
      mappingsPath: CANONICAL_MAPPINGS,
    });
    expect(derivedGates.databaseBranchPool).toBe('shared-with-rls');
    expect(derivedGates.secretScanStrictness).toBe('minimal');
    expect(derivedGates.attestationRequired).toBe(false);
    expect(derivedGates.auditRetentionDays).toBe(90);
    expect(derivedGates.reviewerAuthorityModel).toBe('open');
  });
});

// ── Multi-regime composition (tightest-wins) ─────────────────────────────

describe('composePostureDerivedGates() — multi-regime tightest-wins', () => {
  it('SOC2-T2 + HIPAA: retention = max(2555, 2190) = 2555d', () => {
    const posture = makePosture([{ id: 'SOC2-T2' }, { id: 'HIPAA' }]);
    const { derivedGates } = composePostureDerivedGates(posture, {
      mappingsPath: CANONICAL_MAPPINGS,
    });
    expect(derivedGates.auditRetentionDays).toBe(2555); // SOC2-T2 wins
  });

  it('SOC2-T2 + HIPAA: databaseBranchPool = per-shard (both require it)', () => {
    const posture = makePosture([{ id: 'SOC2-T2' }, { id: 'HIPAA' }]);
    const { derivedGates } = composePostureDerivedGates(posture, {
      mappingsPath: CANONICAL_MAPPINGS,
    });
    expect(derivedGates.databaseBranchPool).toBe('per-shard');
  });

  it('SOC2-T2 + HIPAA: secretScanStrictness = strict (both require it)', () => {
    const posture = makePosture([{ id: 'SOC2-T2' }, { id: 'HIPAA' }]);
    const { derivedGates } = composePostureDerivedGates(posture, {
      mappingsPath: CANONICAL_MAPPINGS,
    });
    expect(derivedGates.secretScanStrictness).toBe('strict');
  });

  it('SOC2-T2 + HIPAA: reviewerAuthorityModel = allowlist+role (both)', () => {
    const posture = makePosture([{ id: 'SOC2-T2' }, { id: 'HIPAA' }]);
    const { derivedGates } = composePostureDerivedGates(posture, {
      mappingsPath: CANONICAL_MAPPINGS,
    });
    expect(derivedGates.reviewerAuthorityModel).toBe('allowlist+role');
  });

  it('GDPR alone: secretScanStrictness = standard, reviewerAuthorityModel = allowlist', () => {
    const posture = makePosture([{ id: 'GDPR' }]);
    const { derivedGates } = composePostureDerivedGates(posture, {
      mappingsPath: CANONICAL_MAPPINGS,
    });
    expect(derivedGates.secretScanStrictness).toBe('standard');
    expect(derivedGates.reviewerAuthorityModel).toBe('allowlist');
  });

  it('GDPR + SOC2-T2: secretScanStrictness = strict (SOC2 wins over GDPR standard)', () => {
    const posture = makePosture([{ id: 'GDPR' }, { id: 'SOC2-T2' }]);
    const { derivedGates } = composePostureDerivedGates(posture, {
      mappingsPath: CANONICAL_MAPPINGS,
    });
    expect(derivedGates.secretScanStrictness).toBe('strict');
  });

  it('GDPR + SOC2-T2: reviewerAuthorityModel = allowlist+role (SOC2 wins over GDPR allowlist)', () => {
    const posture = makePosture([{ id: 'GDPR' }, { id: 'SOC2-T2' }]);
    const { derivedGates } = composePostureDerivedGates(posture, {
      mappingsPath: CANONICAL_MAPPINGS,
    });
    expect(derivedGates.reviewerAuthorityModel).toBe('allowlist+role');
  });

  it('GDPR + SOC2-T2: auditRetentionDays = max(365, 2555) = 2555', () => {
    const posture = makePosture([{ id: 'GDPR' }, { id: 'SOC2-T2' }]);
    const { derivedGates } = composePostureDerivedGates(posture, {
      mappingsPath: CANONICAL_MAPPINGS,
    });
    expect(derivedGates.auditRetentionDays).toBe(2555);
  });

  it('PCI-DSS-L1 + FedRAMP-Moderate: auditRetentionDays = max(365, 1095) = 1095', () => {
    const posture = makePosture([{ id: 'PCI-DSS-L1' }, { id: 'FedRAMP-Moderate' }]);
    const { derivedGates } = composePostureDerivedGates(posture, {
      mappingsPath: CANONICAL_MAPPINGS,
    });
    expect(derivedGates.auditRetentionDays).toBe(1095);
  });

  it('attestationRequired: any regime requiring true wins (boolean OR)', () => {
    // All 6 regimes require attestation=true; test via a custom mapping with a false entry
    const tmpDir = join(tmpdir(), `composer-test-${Date.now()}`);
    mkdirSync(join(tmpDir, 'spec/compliance'), { recursive: true });
    const customMappings = join(tmpDir, 'spec/compliance/regime-mappings.yaml');
    writeFileSync(
      customMappings,
      `
regimes:
  NO-ATTEST:
    databaseBranchPool: shared-with-rls
    secretScanStrictness: minimal
    attestationRequired: false
    auditRetentionDays: 90
    reviewerAuthorityModel: open
  YES-ATTEST:
    databaseBranchPool: shared-with-rls
    secretScanStrictness: minimal
    attestationRequired: true
    auditRetentionDays: 90
    reviewerAuthorityModel: open
`.trim(),
      'utf-8',
    );
    try {
      const posture = makePosture([{ id: 'NO-ATTEST' }, { id: 'YES-ATTEST' }]);
      const { derivedGates } = composePostureDerivedGates(posture, {
        mappingsPath: customMappings,
      });
      expect(derivedGates.attestationRequired).toBe(true);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('composedRegimes includes all regime IDs in declaration order', () => {
    const posture = makePosture([{ id: 'SOC2-T2' }, { id: 'HIPAA' }, { id: 'GDPR' }]);
    const { composedRegimes } = composePostureDerivedGates(posture, {
      mappingsPath: CANONICAL_MAPPINGS,
    });
    expect(composedRegimes).toEqual(['SOC2-T2', 'HIPAA', 'GDPR']);
  });
});

// ── Operator-override precedence (AC #3) ─────────────────────────────────

describe('composePostureDerivedGates() — operator-override always wins', () => {
  it('operator override wins over regime composition for databaseBranchPool', () => {
    const posture = makePosture([{ id: 'HIPAA' }], {
      databaseBranchPool: 'shared-with-rls',
      _notes: {
        databaseBranchPool: 'Our auditor accepts shared-with-rls with quarterly policy review',
      },
    });
    const { derivedGates } = composePostureDerivedGates(posture, {
      mappingsPath: CANONICAL_MAPPINGS,
    });
    expect(derivedGates.databaseBranchPool).toBe('shared-with-rls');
  });

  it('operator override wins over regime composition for secretScanStrictness', () => {
    const posture = makePosture([{ id: 'SOC2-T2' }], {
      secretScanStrictness: 'minimal',
      _notes: {
        secretScanStrictness: 'Audit accepted minimal scan with external tooling in scope',
      },
    });
    const { derivedGates } = composePostureDerivedGates(posture, {
      mappingsPath: CANONICAL_MAPPINGS,
    });
    expect(derivedGates.secretScanStrictness).toBe('minimal');
  });

  it('operator override wins over multi-regime composition', () => {
    const posture = makePosture([{ id: 'SOC2-T2' }, { id: 'HIPAA' }], {
      auditRetentionDays: 730,
      _notes: { auditRetentionDays: 'Negotiated 2-year retention with auditor (case #123)' },
    });
    const { derivedGates } = composePostureDerivedGates(posture, {
      mappingsPath: CANONICAL_MAPPINGS,
    });
    // SOC2+HIPAA would give 2555, but operator override wins
    expect(derivedGates.auditRetentionDays).toBe(730);
  });

  it('operatorOverriddenFields lists all overridden gate fields', () => {
    const posture = makePosture([{ id: 'SOC2-T2' }], {
      databaseBranchPool: 'shared-with-rls',
      secretScanStrictness: 'standard',
      _notes: {
        databaseBranchPool: 'Auditor note A',
        secretScanStrictness: 'Auditor note B',
      },
    });
    const { operatorOverriddenFields } = composePostureDerivedGates(posture, {
      mappingsPath: CANONICAL_MAPPINGS,
    });
    expect(operatorOverriddenFields).toContain('databaseBranchPool');
    expect(operatorOverriddenFields).toContain('secretScanStrictness');
    expect(operatorOverriddenFields).not.toContain('attestationRequired');
  });

  it('operatorOverriddenFields is empty when no derivedGates overrides', () => {
    const posture = makePosture([{ id: 'SOC2-T2' }]);
    const { operatorOverriddenFields } = composePostureDerivedGates(posture, {
      mappingsPath: CANONICAL_MAPPINGS,
    });
    expect(operatorOverriddenFields).toEqual([]);
  });
});

// ── Adopter regimeOverrides precedence (AC #4, OQ-1) ─────────────────────

describe('composePostureDerivedGates() — adopter regimeOverrides (OQ-1)', () => {
  it('adopter regimeOverride for HIPAA databaseBranchPool overrides mapping default', () => {
    const posture = makePosture([{ id: 'HIPAA' }], undefined, {
      HIPAA: {
        databaseBranchPool: 'shared-with-rls',
        _notes: {
          databaseBranchPool:
            'Auditor accepted shared-with-rls for dev/staging environment (case #ABC)',
        },
      },
    });
    const { derivedGates, regimesWithAdopterOverrides } = composePostureDerivedGates(posture, {
      mappingsPath: CANONICAL_MAPPINGS,
    });
    // Override applied before tightest-wins; other fields (strict, 2190d, etc.) unchanged
    expect(derivedGates.databaseBranchPool).toBe('shared-with-rls');
    expect(derivedGates.secretScanStrictness).toBe('strict'); // not overridden
    expect(regimesWithAdopterOverrides).toContain('HIPAA');
  });

  it('adopter regimeOverride applies only to the target regime — other regimes unaffected', () => {
    // HIPAA override databaseBranchPool → shared-with-rls
    // SOC2-T2 still requires per-shard → tightest-wins brings it back to per-shard
    const posture = makePosture([{ id: 'HIPAA' }, { id: 'SOC2-T2' }], undefined, {
      HIPAA: {
        databaseBranchPool: 'shared-with-rls',
        _notes: {
          databaseBranchPool: 'Adopter note for HIPAA dev env',
        },
      },
    });
    const { derivedGates } = composePostureDerivedGates(posture, {
      mappingsPath: CANONICAL_MAPPINGS,
    });
    // After HIPAA override: HIPAA contributes shared-with-rls
    // SOC2-T2 contributes per-shard
    // Tightest-wins: per-shard wins
    expect(derivedGates.databaseBranchPool).toBe('per-shard');
  });

  it('adopter regimeOverride for GDPR secretScanStrictness → strict (upgrade from standard)', () => {
    const posture = makePosture([{ id: 'GDPR' }], undefined, {
      GDPR: {
        secretScanStrictness: 'strict',
        _notes: {
          secretScanStrictness: 'Internal policy requires strict scanning for all EU-data projects',
        },
      },
    });
    const { derivedGates } = composePostureDerivedGates(posture, {
      mappingsPath: CANONICAL_MAPPINGS,
    });
    expect(derivedGates.secretScanStrictness).toBe('strict');
  });

  it('regimesWithAdopterOverrides is empty when no regimeOverrides declared', () => {
    const posture = makePosture([{ id: 'SOC2-T2' }]);
    const { regimesWithAdopterOverrides } = composePostureDerivedGates(posture, {
      mappingsPath: CANONICAL_MAPPINGS,
    });
    expect(regimesWithAdopterOverrides).toEqual([]);
  });

  it('adopter regimeOverride + operator derivedGates override: operator wins last', () => {
    // Adopter overrides HIPAA databaseBranchPool → shared-with-rls
    // Operator then overrides databaseBranchPool → per-shard
    // Expected: per-shard (operator wins)
    const posture = makePosture(
      [{ id: 'HIPAA' }],
      {
        databaseBranchPool: 'per-shard',
        _notes: { databaseBranchPool: 'Operator re-asserts per-shard for production' },
      },
      {
        HIPAA: {
          databaseBranchPool: 'shared-with-rls',
          _notes: { databaseBranchPool: 'Dev env adopter note' },
        },
      },
    );
    const { derivedGates } = composePostureDerivedGates(posture, {
      mappingsPath: CANONICAL_MAPPINGS,
    });
    expect(derivedGates.databaseBranchPool).toBe('per-shard');
  });
});

// ── UnknownRegime (AC #7) ─────────────────────────────────────────────────

describe('composePostureDerivedGates() — UnknownRegime', () => {
  it('throws UnknownRegime for an unrecognized regime ID', () => {
    const posture = makePosture([{ id: 'NOT-A-REAL-REGIME' }]);
    expect(() => composePostureDerivedGates(posture, { mappingsPath: CANONICAL_MAPPINGS })).toThrow(
      UnknownRegime,
    );
  });

  it('UnknownRegime carries the regime ID', () => {
    const posture = makePosture([{ id: 'CUSTOM-INTERNAL-V2' }]);
    try {
      composePostureDerivedGates(posture, { mappingsPath: CANONICAL_MAPPINGS });
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(UnknownRegime);
      expect((err as UnknownRegime).regimeId).toBe('CUSTOM-INTERNAL-V2');
    }
  });

  it('throws on first unknown regime even when others are valid', () => {
    const posture = makePosture([{ id: 'SOC2-T2' }, { id: 'UNKNOWN-REGIME' }, { id: 'HIPAA' }]);
    expect(() => composePostureDerivedGates(posture, { mappingsPath: CANONICAL_MAPPINGS })).toThrow(
      UnknownRegime,
    );
  });
});

// ── Custom mappings path ──────────────────────────────────────────────────

describe('composePostureDerivedGates() — custom mappings path', () => {
  it('uses a custom fixture mapping file', () => {
    const tmpDir = join(tmpdir(), `composer-custom-${Date.now()}`);
    mkdirSync(join(tmpDir, 'spec/compliance'), { recursive: true });
    const customMappings = join(tmpDir, 'spec/compliance/regime-mappings.yaml');
    writeFileSync(
      customMappings,
      `
regimes:
  CUSTOM-STRICT:
    databaseBranchPool: per-shard
    secretScanStrictness: strict
    attestationRequired: true
    auditRetentionDays: 3650
    reviewerAuthorityModel: allowlist+role
`.trim(),
      'utf-8',
    );
    try {
      const posture = makePosture([{ id: 'CUSTOM-STRICT' }]);
      const { derivedGates } = composePostureDerivedGates(posture, {
        mappingsPath: customMappings,
      });
      expect(derivedGates.auditRetentionDays).toBe(3650);
      expect(derivedGates.reviewerAuthorityModel).toBe('allowlist+role');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
