/**
 * RFC-0009 Phase 4.1 — Eρ₅ Compliance Clearance tests.
 *
 * Covers acceptance criteria:
 *   AC #1: Souls can declare `complianceRegimes` with the hard-regulatory whitelist (OQ-5)
 *   AC #2: Eρ₅ sub-dimension evaluates clearance against declared regimes during admission
 *   AC #3: Adopter opt-in gate respected (default off)
 *   AC #4: RFC-0022 consumption surface wired
 *   AC #5: Test coverage — hard-regime opt-in / opt-out / soft-regime
 *          (rejected at declaration time per OQ-5 scope)
 */

import { describe, it, expect } from 'vitest';

import {
  HARD_REGULATORY_REGIME_PREFIXES,
  isHardRegulatoryRegime,
  validateComplianceRegimes,
  computeComplianceClearance,
  type ComplianceClearanceContext,
  type ComplianceViolationEntry,
} from './compliance-clearance.js';
import type { CompliancePosture } from './compliance/types.js';

import { computeAdmissionComposite } from './admission-composite.js';
import type { AdmissionInput } from './admission-score.js';

// ── Fixture factories ──────────────────────────────────────────────────

function makeAdmissionInput(taskId = 'AISDLC-316'): AdmissionInput {
  return {
    issueNumber: 316,
    workItemId: taskId,
    title: 'feat: handle PHI payload',
    body: '### Complexity\n5\n\n### Acceptance Criteria\n- Works',
    labels: ['spec'],
    reactionCount: 0,
    commentCount: 0,
    createdAt: '2026-05-25T00:00:00Z',
    authorAssociation: 'OWNER',
  };
}

function makePosture(regimeIds: string[]): CompliancePosture {
  return {
    apiVersion: 'ai-sdlc.io/v1alpha1',
    kind: 'CompliancePosture',
    metadata: { name: 'test-platform' },
    spec: {
      regimes: regimeIds.map((id) => ({
        id,
        attestedBy: 'operator@example.com',
        attestedAt: '2026-05-25T00:00:00Z',
      })),
      auditExports: [],
    },
  };
}

// ── AC #1 + AC #5 (soft-regime rejection at declaration time) ──────────

describe('AC #1: hard-regulatory whitelist (OQ-5 scope)', () => {
  it('accepts the explicit core frameworks from RFC-0009 §7.1', () => {
    // The headline whitelist documented in §7.1.
    for (const id of ['GDPR', 'HIPAA', 'SOC2', 'PCI-DSS', 'FedRAMP']) {
      expect(isHardRegulatoryRegime(id), `${id} should be hard-regulatory`).toBe(true);
    }
  });

  it('accepts tier / version variants via prefix matching', () => {
    expect(isHardRegulatoryRegime('SOC2-T2')).toBe(true);
    expect(isHardRegulatoryRegime('SOC2-T1')).toBe(true);
    expect(isHardRegulatoryRegime('PCI-DSS-L1')).toBe(true);
    expect(isHardRegulatoryRegime('PCI-DSS-L4')).toBe(true);
    expect(isHardRegulatoryRegime('FedRAMP-Moderate')).toBe(true);
    expect(isHardRegulatoryRegime('FedRAMP-High')).toBe(true);
    expect(isHardRegulatoryRegime('ISO-27001:2022')).toBe(true);
  });

  it('accepts regional data-residency frameworks (Schrems II / PIPL / PIPEDA)', () => {
    expect(isHardRegulatoryRegime('PIPL')).toBe(true);
    expect(isHardRegulatoryRegime('PIPEDA')).toBe(true);
    expect(isHardRegulatoryRegime('SCHREMS-II')).toBe(true);
    expect(isHardRegulatoryRegime('DATA-RESIDENCY-EU')).toBe(true);
    expect(isHardRegulatoryRegime('DATA-RESIDENCY-CA')).toBe(true);
  });

  it('accepts regulated-industry rules (KYC / AML / GLBA / SOX / NERC-CIP)', () => {
    expect(isHardRegulatoryRegime('KYC')).toBe(true);
    expect(isHardRegulatoryRegime('AML')).toBe(true);
    expect(isHardRegulatoryRegime('GLBA')).toBe(true);
    expect(isHardRegulatoryRegime('SOX')).toBe(true);
    expect(isHardRegulatoryRegime('NERC-CIP')).toBe(true);
    expect(isHardRegulatoryRegime('FDA-21CFR11')).toBe(true);
  });

  it('AC #5: rejects soft regimes (internal best-practices, code style, team conventions)', () => {
    const softRegimes = [
      'clean-code',
      'team-style',
      'house-style',
      'eslint-recommended',
      'prettier-standard',
      'hexagonal',
      'ddd-strict',
      'our-conventions',
      'internal-coding-standard',
      'architectural-preference',
      'best-practices',
      'code-quality-gate',
    ];
    for (const id of softRegimes) {
      expect(isHardRegulatoryRegime(id), `${id} should NOT be hard-regulatory`).toBe(false);
    }
  });

  it('rejects empty / non-string inputs defensively', () => {
    expect(isHardRegulatoryRegime('')).toBe(false);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(isHardRegulatoryRegime(undefined as any)).toBe(false);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(isHardRegulatoryRegime(null as any)).toBe(false);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(isHardRegulatoryRegime(123 as any)).toBe(false);
  });

  it('matches case-insensitively on regime ID', () => {
    expect(isHardRegulatoryRegime('hipaa')).toBe(true);
    expect(isHardRegulatoryRegime('Hipaa')).toBe(true);
    expect(isHardRegulatoryRegime('pci-dss-l1')).toBe(true);
    expect(isHardRegulatoryRegime('fedramp-moderate')).toBe(true);
  });

  it('AISDLC-316 round-2 MAJOR #2 fix: rejects prefix-collision soft regimes', () => {
    // Pre-fix bug: `startsWith('SOX')` would match `SOXophone` because there
    // was no boundary check between the prefix and the next character. A soft
    // adopter-named regime with a collision-prone suffix would get silently
    // accepted as hard-regulatory by BOTH validateComplianceRegimes (declaration
    // time) AND the defense-in-depth filter at scoring time. Tighten the prefix
    // check so the boundary char must be a separator (`-`, `_`, `:`, `.`) or a
    // digit (tier-variant pattern); letters following the prefix must reject.
    expect(isHardRegulatoryRegime('SOXophone')).toBe(false);
    expect(isHardRegulatoryRegime('AMLET')).toBe(false);
    expect(isHardRegulatoryRegime('KYCS-internal')).toBe(false);
    expect(isHardRegulatoryRegime('KYCS-internal-team-style')).toBe(false);
    expect(isHardRegulatoryRegime('HIPAAphobia')).toBe(false);
    // Additional collision candidates worth covering.
    expect(isHardRegulatoryRegime('GDPReport')).toBe(false);
    expect(isHardRegulatoryRegime('SOC2alpha')).toBe(false); // letter after digit-bearing prefix
    expect(isHardRegulatoryRegime('PIPLine')).toBe(false);
    expect(isHardRegulatoryRegime('PIPEDAtable')).toBe(false);
    expect(isHardRegulatoryRegime('CCPAdjacent')).toBe(false);
  });

  it('AISDLC-316 round-2 MAJOR #2 fix: still accepts canonical positives after tightening', () => {
    // Whole-id matches.
    expect(isHardRegulatoryRegime('SOX')).toBe(true);
    expect(isHardRegulatoryRegime('AML')).toBe(true);
    expect(isHardRegulatoryRegime('KYC')).toBe(true);
    expect(isHardRegulatoryRegime('HIPAA')).toBe(true);
    expect(isHardRegulatoryRegime('SOC2')).toBe(true);
    // Separator-bounded variants (the original positive contract).
    expect(isHardRegulatoryRegime('SOC2-T2')).toBe(true);
    expect(isHardRegulatoryRegime('PCI-DSS-L1')).toBe(true);
    expect(isHardRegulatoryRegime('FedRAMP-Moderate')).toBe(true);
    expect(isHardRegulatoryRegime('FedRAMP-High')).toBe(true);
    expect(isHardRegulatoryRegime('ISO-27001:2022')).toBe(true);
    expect(isHardRegulatoryRegime('DATA-RESIDENCY-EU')).toBe(true);
    expect(isHardRegulatoryRegime('SOX_internal')).toBe(true); // underscore is a separator
    expect(isHardRegulatoryRegime('SOX.amendment')).toBe(true); // dot is a separator
  });

  it('exposes the canonical prefix list (frozen) for adopter introspection', () => {
    // The whitelist is used by adopter-side tooling (init wizards, lint rules);
    // expose it as a readonly array so consumers can build their own UIs around it.
    expect(HARD_REGULATORY_REGIME_PREFIXES.length).toBeGreaterThan(10);
    expect(HARD_REGULATORY_REGIME_PREFIXES).toContain('HIPAA');
    expect(HARD_REGULATORY_REGIME_PREFIXES).toContain('GDPR');
    expect(HARD_REGULATORY_REGIME_PREFIXES).toContain('SOC2');
    expect(HARD_REGULATORY_REGIME_PREFIXES).toContain('PCI-DSS');
    expect(HARD_REGULATORY_REGIME_PREFIXES).toContain('FedRAMP');
    expect(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (HARD_REGULATORY_REGIME_PREFIXES as any).push('REJECTED');
    }).toThrow();
  });
});

describe('AC #5: validateComplianceRegimes splits accepted vs rejected', () => {
  it('treats empty / undefined as trivially valid', () => {
    expect(validateComplianceRegimes(undefined)).toEqual({
      valid: true,
      accepted: [],
      rejected: [],
    });
    expect(validateComplianceRegimes([])).toEqual({
      valid: true,
      accepted: [],
      rejected: [],
    });
  });

  it('accepts a list of pure hard-regulatory regimes', () => {
    const result = validateComplianceRegimes(['HIPAA', 'SOC2-T2']);
    expect(result.valid).toBe(true);
    expect(result.accepted).toEqual(['HIPAA', 'SOC2-T2']);
    expect(result.rejected).toEqual([]);
  });

  it('rejects when ANY soft regime is mixed in (forces declaration-time fix)', () => {
    const result = validateComplianceRegimes(['HIPAA', 'clean-code', 'GDPR', 'house-style']);
    expect(result.valid).toBe(false);
    expect(result.accepted).toEqual(['HIPAA', 'GDPR']);
    expect(result.rejected).toEqual(['clean-code', 'house-style']);
  });

  it('rejects an all-soft list', () => {
    const result = validateComplianceRegimes(['clean-code', 'team-style']);
    expect(result.valid).toBe(false);
    expect(result.accepted).toEqual([]);
    expect(result.rejected).toEqual(['clean-code', 'team-style']);
  });
});

// ── AC #3: Adopter opt-in gate (default off) ────────────────────────────

describe('AC #3: adopter opt-in gate', () => {
  it('returns Eρ₅ = 1 when context is undefined (default-off path)', () => {
    const result = computeComplianceClearance('AISDLC-316', ['soul-a'], undefined);
    expect(result.er5).toBe(1);
    expect(result.routingPath).toBe('disabled');
    expect(result.checkedRegimes).toEqual([]);
    expect(result.violations).toEqual([]);
  });

  it('returns Eρ₅ = 1 when context is present but enabled=false (explicit opt-out)', () => {
    const ctx: ComplianceClearanceContext = {
      enabled: false,
      perSoulRegimes: [{ soulId: 'soul-a', regimes: ['HIPAA'] }],
      violations: [
        {
          id: 'AISDLC-316',
          violations: [{ regimeId: 'HIPAA', reason: 'PHI leak to non-BAA pipe' }],
        },
      ],
    };
    const result = computeComplianceClearance('AISDLC-316', ['soul-a'], ctx);
    // Even though a violation exists, the opt-out gate keeps Eρ₅ at 1.
    expect(result.er5).toBe(1);
    expect(result.routingPath).toBe('disabled');
  });

  it('admission composite does NOT include complianceClearance breakdown when opted out', () => {
    const input = makeAdmissionInput();
    // Disabled context — breakdown field should be elided.
    const resultDisabled = computeAdmissionComposite(input, undefined, {
      complianceClearanceContext: {
        enabled: false,
        perSoulRegimes: [{ soulId: '__platform', regimes: ['HIPAA'] }],
      },
    });
    expect(resultDisabled.breakdown.complianceClearance).toBeUndefined();

    // Omitted context — breakdown also elided.
    const resultOmitted = computeAdmissionComposite(input);
    expect(resultOmitted.breakdown.complianceClearance).toBeUndefined();
  });

  it('admission composite does NOT zero the composite when opted out (backward-compat)', () => {
    const input = makeAdmissionInput();
    const result = computeAdmissionComposite(input, undefined, {
      complianceClearanceContext: {
        enabled: false,
        perSoulRegimes: [{ soulId: '__platform', regimes: ['HIPAA'] }],
        violations: [
          {
            id: 'AISDLC-316',
            violations: [{ regimeId: 'HIPAA', reason: 'PHI leak' }],
          },
        ],
      },
    });
    // Composite is computed without the Eρ₅ multiplier (er5 default 1).
    expect(result.score.composite).toBeGreaterThan(0);
  });
});

// ── AC #2: Eρ₅ evaluates clearance during admission ─────────────────────

describe('AC #2: Eρ₅ clearance evaluation during admission', () => {
  it('returns Eρ₅ = 1 when adopter opted in but no regimes declared anywhere', () => {
    const ctx: ComplianceClearanceContext = {
      enabled: true,
      perSoulRegimes: [{ soulId: 'soul-a', regimes: [] }],
    };
    const result = computeComplianceClearance('AISDLC-316', ['soul-a'], ctx);
    expect(result.er5).toBe(1);
    expect(result.routingPath).toBe('no-regimes');
    expect(result.checkedRegimes).toEqual([]);
  });

  it('returns Eρ₅ = 1 when regimes declared but no violations for the work item', () => {
    const ctx: ComplianceClearanceContext = {
      enabled: true,
      perSoulRegimes: [{ soulId: 'soul-a', regimes: ['HIPAA'] }],
      violations: [], // none asserted
    };
    const result = computeComplianceClearance('AISDLC-316', ['soul-a'], ctx);
    expect(result.er5).toBe(1);
    expect(result.routingPath).toBe('clearance-holds');
    expect(result.checkedRegimes).toEqual(['HIPAA']);
    expect(result.violations).toEqual([]);
  });

  it('returns Eρ₅ = 0 when a declared regime asserts a violation', () => {
    const ctx: ComplianceClearanceContext = {
      enabled: true,
      perSoulRegimes: [{ soulId: 'soul-a', regimes: ['HIPAA'] }],
      violations: [
        {
          id: 'AISDLC-316',
          violations: [
            {
              regimeId: 'HIPAA',
              control: '§164.312(a)',
              reason: 'PHI fields routed to platform analytics without BAA',
              severity: 'critical',
            },
          ],
        },
      ],
    };
    const result = computeComplianceClearance('AISDLC-316', ['soul-a'], ctx);
    expect(result.er5).toBe(0);
    expect(result.routingPath).toBe('clearance-violated');
    expect(result.checkedRegimes).toEqual(['HIPAA']);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].regimeId).toBe('HIPAA');
    expect(result.violations[0].control).toBe('§164.312(a)');
  });

  it('ignores violations against regimes that are NOT declared (audit-only)', () => {
    const ctx: ComplianceClearanceContext = {
      enabled: true,
      perSoulRegimes: [{ soulId: 'soul-a', regimes: ['HIPAA'] }],
      violations: [
        {
          id: 'AISDLC-316',
          violations: [{ regimeId: 'GDPR', reason: 'Right-to-erasure not implemented' }],
        },
      ],
    };
    const result = computeComplianceClearance('AISDLC-316', ['soul-a'], ctx);
    // GDPR not declared → not in regime set → violation ignored for clearance.
    expect(result.er5).toBe(1);
    expect(result.routingPath).toBe('clearance-holds');
  });

  it('filters soft regimes from the regime set even if they slip past validation', () => {
    const ctx: ComplianceClearanceContext = {
      enabled: true,
      perSoulRegimes: [{ soulId: 'soul-a', regimes: ['HIPAA', 'clean-code', 'team-style'] }],
      violations: [
        {
          id: 'AISDLC-316',
          violations: [{ regimeId: 'clean-code', reason: 'Function too long' }],
        },
      ],
    };
    const result = computeComplianceClearance('AISDLC-316', ['soul-a'], ctx);
    // Defense-in-depth: soft regimes filtered → clearance holds.
    expect(result.er5).toBe(1);
    expect(result.checkedRegimes).toEqual(['HIPAA']);
  });

  it('handles substrate-only work via __platform sentinel', () => {
    const ctx: ComplianceClearanceContext = {
      enabled: true,
      perSoulRegimes: [{ soulId: '__platform', regimes: ['GDPR'] }],
      violations: [
        {
          id: 'AISDLC-316',
          violations: [{ regimeId: 'GDPR', reason: 'Substrate change leaks data cross-border' }],
        },
      ],
    };
    // affectedSoulIds = [] → falls through to __platform sentinel lookup.
    const result = computeComplianceClearance('AISDLC-316', [], ctx);
    expect(result.er5).toBe(0);
    expect(result.routingPath).toBe('clearance-violated');
  });

  it('AISDLC-316 round-2 MAJOR #1 fix: case-collision between soul-declared and violation regimeId still gates', () => {
    // Pre-fix bug: regimeSet stored the literal declared casing (`'hipaa'`)
    // and `Set.has(v.regimeId)` was case-sensitive, so a violation reporting
    // `regimeId: 'HIPAA'` (canonical uppercase) silently missed the lookup
    // and the composite was NOT gated. Both sides of the comparison now
    // normalise to uppercase.
    const ctx: ComplianceClearanceContext = {
      enabled: true,
      perSoulRegimes: [{ soulId: 'soul-a', regimes: ['hipaa'] }], // lowercase declaration
      violations: [
        {
          id: 'AISDLC-316',
          violations: [
            {
              regimeId: 'HIPAA', // uppercase violation report
              control: '§164.312(a)',
              reason: 'PHI fields routed to platform analytics without BAA',
              severity: 'critical',
            },
          ],
        },
      ],
    };
    const result = computeComplianceClearance('AISDLC-316', ['soul-a'], ctx);
    expect(result.er5).toBe(0);
    expect(result.routingPath).toBe('clearance-violated');
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].regimeId).toBe('HIPAA');
  });

  it('AISDLC-316 round-2 MAJOR #1 fix: opposite case-collision also gates (uppercase decl + lowercase violation)', () => {
    const ctx: ComplianceClearanceContext = {
      enabled: true,
      perSoulRegimes: [{ soulId: 'soul-a', regimes: ['HIPAA'] }], // uppercase decl
      violations: [
        {
          id: 'AISDLC-316',
          violations: [
            { regimeId: 'hipaa', reason: 'PHI leak' }, // lowercase violation
          ],
        },
      ],
    };
    const result = computeComplianceClearance('AISDLC-316', ['soul-a'], ctx);
    expect(result.er5).toBe(0);
    expect(result.routingPath).toBe('clearance-violated');
  });

  it('AISDLC-316 round-2 MAJOR #1 fix: case-collision via RFC-0022 posture also gates', () => {
    const ctx: ComplianceClearanceContext = {
      enabled: true,
      perSoulRegimes: [{ soulId: 'soul-a', regimes: [] }],
      posture: [makePosture(['hipaa'])], // posture in lowercase
      violations: [
        {
          id: 'AISDLC-316',
          violations: [{ regimeId: 'HIPAA', reason: 'PHI leak via posture-declared regime' }],
        },
      ],
    };
    const result = computeComplianceClearance('AISDLC-316', ['soul-a'], ctx);
    expect(result.er5).toBe(0);
  });

  it('matches work item IDs case-insensitively (mirrors tessellation algorithm)', () => {
    const ctx: ComplianceClearanceContext = {
      enabled: true,
      perSoulRegimes: [{ soulId: 'soul-a', regimes: ['HIPAA'] }],
      violations: [
        {
          id: 'aisdlc-316', // lowercase
          violations: [{ regimeId: 'HIPAA', reason: 'PHI leak' }],
        },
      ],
    };
    const result = computeComplianceClearance('AISDLC-316', ['soul-a'], ctx);
    expect(result.er5).toBe(0);
  });

  it('aggregates regimes from multiple affected souls (union)', () => {
    const ctx: ComplianceClearanceContext = {
      enabled: true,
      perSoulRegimes: [
        { soulId: 'soul-a', regimes: ['HIPAA'] }, // healthcare soul
        { soulId: 'soul-b', regimes: ['PCI-DSS-L1'] }, // payments soul
        { soulId: 'soul-c', regimes: [] }, // unregulated soul
      ],
      violations: [
        {
          id: 'AISDLC-316',
          violations: [{ regimeId: 'PCI-DSS-L1', reason: 'Card data in soul-b analytics' }],
        },
      ],
    };
    // Work item targets soul-a AND soul-b → both regimes in scope.
    const result = computeComplianceClearance('AISDLC-316', ['soul-a', 'soul-b'], ctx);
    expect(result.er5).toBe(0);
    expect(result.checkedRegimes).toContain('HIPAA');
    expect(result.checkedRegimes).toContain('PCI-DSS-L1');
  });
});

// ── AC #4: RFC-0022 consumption surface ─────────────────────────────────

describe('AC #4: RFC-0022 CompliancePosture consumption surface', () => {
  it('composes regimes from RFC-0022 posture with soul-declared regimes', () => {
    const ctx: ComplianceClearanceContext = {
      enabled: true,
      perSoulRegimes: [{ soulId: 'soul-a', regimes: ['HIPAA'] }],
      posture: [makePosture(['SOC2-T2', 'GDPR'])],
      violations: [
        {
          id: 'AISDLC-316',
          violations: [{ regimeId: 'GDPR', reason: 'Cross-border transfer' }],
        },
      ],
    };
    const result = computeComplianceClearance('AISDLC-316', ['soul-a'], ctx);
    // GDPR comes from RFC-0022 posture → in scope → violation gates.
    expect(result.er5).toBe(0);
    expect(result.checkedRegimes).toContain('HIPAA');
    expect(result.checkedRegimes).toContain('SOC2-T2');
    expect(result.checkedRegimes).toContain('GDPR');
  });

  it('works with only the RFC-0022 posture and no soul-declared regimes', () => {
    const ctx: ComplianceClearanceContext = {
      enabled: true,
      perSoulRegimes: [{ soulId: 'soul-a', regimes: [] }],
      posture: [makePosture(['HIPAA', 'SOC2-T2'])],
    };
    const result = computeComplianceClearance('AISDLC-316', ['soul-a'], ctx);
    expect(result.er5).toBe(1);
    expect(result.routingPath).toBe('clearance-holds');
    expect(result.checkedRegimes).toContain('HIPAA');
    expect(result.checkedRegimes).toContain('SOC2-T2');
  });

  it('filters soft regimes from the posture (defense-in-depth on OQ-5 boundary)', () => {
    const ctx: ComplianceClearanceContext = {
      enabled: true,
      perSoulRegimes: [{ soulId: 'soul-a', regimes: [] }],
      // A maliciously / accidentally constructed posture with a soft regime.
      posture: [makePosture(['HIPAA', 'house-style'])],
    };
    const result = computeComplianceClearance('AISDLC-316', ['soul-a'], ctx);
    expect(result.checkedRegimes).toEqual(['HIPAA']);
    expect(result.checkedRegimes).not.toContain('house-style');
  });

  it('handles multi-posture lists (v2 forward-compat per OQ-6)', () => {
    const ctx: ComplianceClearanceContext = {
      enabled: true,
      perSoulRegimes: [{ soulId: 'soul-a', regimes: [] }],
      // v2 multi-tenant: multiple postures may apply at the same time.
      posture: [makePosture(['HIPAA']), makePosture(['SOC2-T2', 'PCI-DSS-L1'])],
    };
    const result = computeComplianceClearance('AISDLC-316', ['soul-a'], ctx);
    expect(result.checkedRegimes).toEqual(
      expect.arrayContaining(['HIPAA', 'SOC2-T2', 'PCI-DSS-L1']),
    );
  });

  it('dedupes regime IDs across soul + posture sources', () => {
    const ctx: ComplianceClearanceContext = {
      enabled: true,
      perSoulRegimes: [{ soulId: 'soul-a', regimes: ['HIPAA'] }],
      posture: [makePosture(['HIPAA', 'SOC2-T2'])],
    };
    const result = computeComplianceClearance('AISDLC-316', ['soul-a'], ctx);
    // HIPAA appears only once in the checked regime set.
    expect(result.checkedRegimes.filter((r) => r === 'HIPAA')).toHaveLength(1);
  });
});

// ── Integration: admission composite gates on Eρ₅ = 0 ───────────────────

describe('admission composite integration — Eρ₅ gates on violation', () => {
  it('gates composite to 0 when adopter opted in AND a violation is asserted', () => {
    const input = makeAdmissionInput();
    const result = computeAdmissionComposite(input, undefined, {
      complianceClearanceContext: {
        enabled: true,
        perSoulRegimes: [{ soulId: '__platform', regimes: ['HIPAA'] }],
        violations: [
          {
            id: 'AISDLC-316',
            violations: [{ regimeId: 'HIPAA', reason: 'PHI leak to platform analytics' }],
          },
        ],
      },
    });
    expect(result.score.composite).toBe(0);
    expect(result.breakdown.complianceClearance).toBeDefined();
    expect(result.breakdown.complianceClearance?.er5).toBe(0);
    expect(result.breakdown.complianceClearance?.routingPath).toBe('clearance-violated');
  });

  it('leaves composite unchanged when adopter opted in BUT no violations', () => {
    const input = makeAdmissionInput();
    const opted = computeAdmissionComposite(input, undefined, {
      complianceClearanceContext: {
        enabled: true,
        perSoulRegimes: [{ soulId: '__platform', regimes: ['HIPAA'] }],
        // no violations entry
      },
    });
    const baseline = computeAdmissionComposite(input);
    // er5 = 1 → multiplicative identity → composite matches baseline within fp tolerance.
    expect(opted.score.composite).toBeCloseTo(baseline.score.composite, 6);
    expect(opted.breakdown.complianceClearance?.er5).toBe(1);
    expect(opted.breakdown.complianceClearance?.routingPath).toBe('clearance-holds');
  });

  it('preserves override bypass (composite=Infinity wins over Eρ₅ gate)', () => {
    const input = makeAdmissionInput();
    const result = computeAdmissionComposite(input, undefined, {
      priorityInputOverrides: {
        override: true,
        overrideReason: 'emergency-hotfix',
      },
      complianceClearanceContext: {
        enabled: true,
        perSoulRegimes: [{ soulId: '__platform', regimes: ['HIPAA'] }],
        violations: [
          {
            id: 'AISDLC-316',
            violations: [{ regimeId: 'HIPAA', reason: 'Hotfix bypasses normal control' }],
          },
        ],
      },
    });
    // Override path returns BEFORE Eρ₅ is computed — composite is Infinity.
    // (Operator accountability shifts to the override reason / expiry trail.)
    expect(result.score.composite).toBe(Infinity);
    // Breakdown does NOT carry compliance clearance in override path.
    expect(result.breakdown.complianceClearance).toBeUndefined();
  });

  it('surfaces routing path "no-regimes" when adopter opted in but no regimes declared', () => {
    const input = makeAdmissionInput();
    const result = computeAdmissionComposite(input, undefined, {
      complianceClearanceContext: {
        enabled: true,
        perSoulRegimes: [{ soulId: '__platform', regimes: [] }],
      },
    });
    expect(result.breakdown.complianceClearance?.routingPath).toBe('no-regimes');
    expect(result.breakdown.complianceClearance?.er5).toBe(1);
  });

  it('regression: enabling Eρ₅ with violations creates a meaningfully different score', () => {
    const input = makeAdmissionInput();
    const baseline = computeAdmissionComposite(input);
    const gated = computeAdmissionComposite(input, undefined, {
      complianceClearanceContext: {
        enabled: true,
        perSoulRegimes: [{ soulId: '__platform', regimes: ['HIPAA'] }],
        violations: [{ id: 'AISDLC-316', violations: [{ regimeId: 'HIPAA', reason: 'leak' }] }],
      },
    });
    expect(baseline.score.composite).toBeGreaterThan(0);
    expect(gated.score.composite).toBe(0);
  });
});

// ── Violations data shape ───────────────────────────────────────────────

describe('ComplianceViolationEntry shape', () => {
  it('accepts the documented severity hints without affecting gating', () => {
    const entry: ComplianceViolationEntry = {
      id: 'AISDLC-316',
      violations: [
        { regimeId: 'HIPAA', reason: 'critical leak', severity: 'critical' },
        { regimeId: 'HIPAA', reason: 'major leak', severity: 'major' },
        { regimeId: 'HIPAA', reason: 'minor leak', severity: 'minor' },
      ],
    };
    const ctx: ComplianceClearanceContext = {
      enabled: true,
      perSoulRegimes: [{ soulId: 'soul-a', regimes: ['HIPAA'] }],
      violations: [entry],
    };
    // ANY violation gates regardless of severity (categorical 0/1 per §7.1).
    const result = computeComplianceClearance('AISDLC-316', ['soul-a'], ctx);
    expect(result.er5).toBe(0);
    expect(result.violations).toHaveLength(3);
  });
});
