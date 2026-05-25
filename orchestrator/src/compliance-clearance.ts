/**
 * RFC-0009 Phase 4.1 — Eρ₅ Compliance Clearance scoring.
 *
 * Implements the categorical 0/1 gating dimension from RFC-0009 §7.1:
 *
 *   Eρ₅ = soul.triad.engineering.complianceRegimes[].clearance(work_item)
 *       = 0 if any named regime is violated
 *       = 1 otherwise
 *
 * **OQ-5 scope** (v3.3 resolution, 2026-05-03): HARD regulatory frameworks
 * ONLY — anything with formal external-audit consequences. Internal best
 * practices, code style, architectural preferences, and team conventions are
 * OUT OF SCOPE and rejected at declaration time per the boundary test:
 * "would an external regulator or auditor have grounds to act on a violation?"
 *
 *   In scope:
 *     - GDPR (EU data protection)
 *     - HIPAA (US healthcare)
 *     - SOC2 (audit trust framework — variants like SOC2-T2 accepted)
 *     - PCI-DSS (payment card data — variants like PCI-DSS-L1 accepted)
 *     - FedRAMP (US federal cloud — variants like FedRAMP-Moderate accepted)
 *     - Regional data-residency (Schrems II, EU data-localization, China PIPL,
 *       Canadian PIPEDA cross-border)
 *     - Regulated-industry rules (financial KYC/AML, healthcare device
 *       certification, telecom regulations, ISO-27001 audit framework, etc.)
 *
 *   Out of scope (rejected at declaration time):
 *     - Internal best-practices ("clean-code", "team-style", "house-style")
 *     - Code-quality rules ("eslint-recommended", "prettier-standard")
 *     - Architectural preferences ("hexagonal", "ddd-strict")
 *     - Team conventions ("our-conventions", "internal-coding-standard")
 *
 * **Adopter opt-in gate** (RFC-0009 §10 Phase 4): Eρ₅ is gated behind
 * `ComplianceClearanceContext.enabled === true` initially. Promotion to
 * default behavior is subject to ecosystem feedback. When disabled (default),
 * the admission composite does not apply the Eρ₅ multiplier and behaves
 * exactly as in Phase 2/3 — full backward compatibility.
 *
 * **RFC-0022 consumption surface**: when an adopter wires the loaded
 * `CompliancePosture[]` into `ComplianceClearanceContext.posture`, the
 * declared regimes from that resource compose with the soul's own
 * `complianceRegimes` field. Both sources contribute to the regime set
 * the work item is checked against; clearance is gating across the union.
 *
 * @see spec/rfcs/RFC-0009-tessellated-design-intent-documents.md §7.1 + §10
 * @see spec/rfcs/RFC-0022-compliance-posture-audit-surface.md (consumption surface)
 */

import type { CompliancePosture } from './compliance/types.js';

// ── Hard-regulatory whitelist (OQ-5 scope) ─────────────────────────────

/**
 * Canonical hard-regulatory framework prefixes per RFC-0009 §7.1 OQ-5 resolution.
 *
 * Matching is **prefix-based** to accept variants like `SOC2-T2`, `PCI-DSS-L1`,
 * `FedRAMP-Moderate`, `FedRAMP-High`, `ISO-27001:2022`. The exact framework name
 * (without tier/version suffix) is the prefix; anything starting with one of
 * these prefixes is considered a hard-regulatory regime.
 *
 * Regional data-residency frameworks (Schrems II / PIPL / PIPEDA) are listed
 * explicitly. Generic `DATA-RESIDENCY-*` prefix is also accepted for adopters
 * who declare per-region constraints under a unified naming scheme.
 */
export const HARD_REGULATORY_REGIME_PREFIXES: readonly string[] = Object.freeze([
  // ── Core US/EU/global frameworks ────────────────────────────────────
  'GDPR', // EU General Data Protection Regulation
  'HIPAA', // US Health Insurance Portability and Accountability Act
  'SOC2', // Service Organization Control 2 (T1 / T2 variants)
  'PCI-DSS', // Payment Card Industry Data Security Standard (L1-L4 variants)
  'FedRAMP', // US Federal Risk and Authorization Management Program
  'ISO-27001', // ISO/IEC 27001 Information Security Management Systems
  // ── Regional data-residency frameworks ──────────────────────────────
  'PIPL', // China Personal Information Protection Law
  'PIPEDA', // Canadian Personal Information Protection and Electronic Documents Act
  'SCHREMS-II', // EU Schrems II ruling (cross-border data transfers)
  'DATA-RESIDENCY', // Generic regional residency declaration
  // ── Regulated-industry rules ────────────────────────────────────────
  'KYC', // Know-Your-Customer (financial services)
  'AML', // Anti-Money Laundering (financial services)
  'GLBA', // Gramm-Leach-Bliley Act (US financial privacy)
  'SOX', // Sarbanes-Oxley Act (US public-company audit)
  'NERC-CIP', // North American Electric Reliability Corp. Critical Infrastructure Protection
  'FDA-21CFR11', // FDA 21 CFR Part 11 (regulated healthcare/pharma device)
  'CCPA', // California Consumer Privacy Act (state-level, regulator-enforced)
  'CPRA', // California Privacy Rights Act (CCPA successor)
]);

/**
 * Predicate: returns true iff the regime ID matches a hard-regulatory prefix
 * per the OQ-5 scope whitelist.
 *
 * Comparison is case-insensitive on the regime ID (`HIPAA` and `hipaa` both
 * match) but the canonical prefixes are uppercase by convention.
 *
 * @example
 *   isHardRegulatoryRegime('HIPAA')           // true
 *   isHardRegulatoryRegime('SOC2-T2')         // true (SOC2 prefix)
 *   isHardRegulatoryRegime('PCI-DSS-L1')      // true (PCI-DSS prefix)
 *   isHardRegulatoryRegime('FedRAMP-Moderate')// true (FedRAMP prefix)
 *   isHardRegulatoryRegime('ISO-27001:2022')  // true (ISO-27001 prefix)
 *   isHardRegulatoryRegime('clean-code')      // false (soft / out of scope)
 *   isHardRegulatoryRegime('team-style')      // false (soft / out of scope)
 */
export function isHardRegulatoryRegime(regimeId: string): boolean {
  if (typeof regimeId !== 'string' || regimeId.length === 0) return false;
  const upper = regimeId.toUpperCase();
  return HARD_REGULATORY_REGIME_PREFIXES.some((prefix) => upper.startsWith(prefix.toUpperCase()));
}

// ── Declaration-time validation (OQ-5 scope guard) ─────────────────────

/**
 * Result of validating a set of declared regimes against the OQ-5 scope.
 */
export interface ValidateComplianceRegimesResult {
  /** True iff every input regime passes `isHardRegulatoryRegime`. */
  valid: boolean;
  /** The subset of inputs that are hard-regulatory (in-scope). */
  accepted: string[];
  /** The subset rejected as soft / out of scope per OQ-5. */
  rejected: string[];
}

/**
 * Validate a list of declared compliance regimes against the OQ-5 hard-regulatory
 * scope. Used at declaration time (DID load, RFC-0022 posture parse) to reject
 * soft regimes before they reach the Eρ₅ scoring path.
 *
 * Per RFC-0009 OQ-5 sub-decision: soft/advisory regimes are NOT in scope and
 * MUST be filtered at declaration time. Internal best-practices, code style,
 * and team conventions belong to other mechanisms (code review, lint).
 *
 * @param regimes - Declared regime IDs from a soul's `complianceRegimes`
 *                  field or an RFC-0022 `CompliancePosture.spec.regimes[].id`.
 * @returns Validation result with split accepted/rejected lists.
 */
export function validateComplianceRegimes(
  regimes: readonly string[] | undefined,
): ValidateComplianceRegimesResult {
  if (!regimes || regimes.length === 0) {
    return { valid: true, accepted: [], rejected: [] };
  }
  const accepted: string[] = [];
  const rejected: string[] = [];
  for (const r of regimes) {
    if (isHardRegulatoryRegime(r)) accepted.push(r);
    else rejected.push(r);
  }
  return { valid: rejected.length === 0, accepted, rejected };
}

// ── Compliance violation surface ───────────────────────────────────────

/**
 * A single asserted compliance violation against a work item.
 *
 * Adopters populate these from regime-specific clearance checks they run as
 * part of admission enrichment — e.g., a HIPAA preprocessor that detects PHI
 * fields in a work item's payload, a GDPR preprocessor that detects
 * cross-border data transfers without lawful-basis annotation, etc.
 *
 * Phase 4.1 ships the **surface** for these violations; the per-regime
 * clearance checkers themselves are out of scope (per RFC-0009 §10 Phase 4 —
 * the scoring path activates first; specific checkers ship incrementally).
 */
export interface ComplianceViolation {
  /** Regime ID the violation is asserted against (e.g. 'HIPAA'). */
  regimeId: string;
  /**
   * Optional control / clause the violation cites
   * (e.g. '§164.312(a)' for HIPAA technical safeguards).
   */
  control?: string;
  /** Human-readable reason — surfaced in audit logs + operator UI. */
  reason: string;
  /** Optional severity hint; Eρ₅ is gating regardless of severity. */
  severity?: 'critical' | 'major' | 'minor';
}

// ── Context for the scoring pass ───────────────────────────────────────

/**
 * Per-work-item compliance violations, keyed by canonical work-item ID
 * (e.g. `AISDLC-316`). Empty / missing entries imply no violations — clearance
 * holds and Eρ₅ = 1.
 */
export interface ComplianceViolationEntry {
  /** Canonical work item ID (case-insensitive match used internally). */
  id: string;
  /** Asserted violations against this work item. Empty = clearance holds. */
  violations: ComplianceViolation[];
}

/**
 * Per-soul declared compliance regimes, keyed by `soulId` matching
 * `Tessellation.souls[].soulId`. Sourced from each Soul DID's
 * `spec.triad.engineering.complianceRegimes` field at load time.
 *
 * In the non-tessellated (single-DID) path, callers populate a single entry
 * under a sentinel `__platform` key with the DID's own engineering regimes.
 */
export interface SoulComplianceRegimes {
  /** Soul ID this entry applies to (or `__platform` for non-tessellated). */
  soulId: string;
  /** Hard-regulatory regimes declared on the soul's engineering vertex. */
  regimes: string[];
}

/**
 * All Eρ₅ Compliance Clearance inputs needed by the admission composite.
 *
 * Callers build this once per pipeline tick and pass it to
 * `computeAdmissionComposite` via `AdmissionCompositeOptions.complianceClearanceContext`.
 *
 * **Adopter opt-in gate** (Phase 4.1): when `enabled === false` (the default
 * for `undefined`), the admission composite does NOT apply Eρ₅ — full
 * backward compatibility with Phase 2/3 behavior.
 */
export interface ComplianceClearanceContext {
  /**
   * Adopter opt-in gate. When `false` (default), Eρ₅ is not applied and the
   * admission composite behaves as Phase 2/3 (no compliance multiplier).
   *
   * Initially gated on adopter opt-in per RFC-0009 §10 Phase 4; promotion
   * to default-on subject to ecosystem feedback (tracked as a follow-up).
   */
  enabled: boolean;
  /**
   * Per-soul declared regimes from each soul's `triad.engineering.complianceRegimes`.
   *
   * In tessellated mode, one entry per active soul; in non-tessellated mode,
   * one entry under sentinel soulId `__platform`.
   *
   * Regimes here MUST already be filtered by `validateComplianceRegimes` —
   * the loader / adapter that builds this struct is the OQ-5 enforcement
   * boundary. Anything that slips through is treated as a soft regime that
   * does NOT contribute to the gating decision.
   */
  perSoulRegimes: SoulComplianceRegimes[];
  /**
   * Optional RFC-0022 `CompliancePosture[]` from
   * `loadCompliancePosture()`. When present, declared regime IDs from the
   * posture compose with the soul-declared regimes — both contribute to the
   * regime set the work item is checked against. This is the RFC-0022
   * consumption surface (AC #4).
   *
   * Regime IDs from the posture pass the same OQ-5 scope filter; the loader's
   * own validation (`MissingComplianceAttestation`) is independent.
   */
  posture?: readonly CompliancePosture[];
  /**
   * Asserted violations per work item, indexed by work-item ID. Absent ID
   * (or empty `violations` array) implies clearance holds for that item.
   */
  violations?: ComplianceViolationEntry[];
}

// ── Scoring result ─────────────────────────────────────────────────────

/**
 * Result of the Eρ₅ Compliance Clearance pass.
 *
 * `er5` is categorical 0/1 per RFC-0009 §7.1 — `0` means at least one declared
 * regime was violated; `1` means clearance holds (or no regimes apply, or the
 * adopter has not opted in yet).
 */
export interface ComplianceClearanceResult {
  /** Categorical clearance score in {0, 1}. */
  er5: 0 | 1;
  /**
   * Routing path taken (matches the scoring algorithm's decision branches).
   *
   * - `'disabled'`           — adopter opt-in gate is off; Eρ₅ not applied.
   * - `'no-regimes'`         — no hard-regulatory regimes declared for any
   *                            affected soul (or platform); Eρ₅ = 1.
   * - `'clearance-holds'`    — regimes declared, no violations asserted; Eρ₅ = 1.
   * - `'clearance-violated'` — at least one declared regime asserts a violation; Eρ₅ = 0.
   */
  routingPath: 'disabled' | 'no-regimes' | 'clearance-holds' | 'clearance-violated';
  /**
   * The regime IDs the work item was checked against (union of soul-declared
   * regimes from `affectedSoulIds` and any RFC-0022 posture regimes).
   */
  checkedRegimes: string[];
  /**
   * Violations that drove Eρ₅ to 0. Empty when clearance holds.
   */
  violations: ComplianceViolation[];
}

// ── Core scoring function ──────────────────────────────────────────────

/**
 * Compute Eρ₅ Compliance Clearance for a work item.
 *
 * Algorithm (RFC-0009 §7.1 + §10 Phase 4):
 * 1. If `ctx.enabled !== true` → return `er5 = 1` with `routingPath = 'disabled'`.
 * 2. Build the regime set from:
 *    - Each soul in `affectedSoulIds`'s `perSoulRegimes` entry, OR
 *      the `__platform` sentinel entry when `affectedSoulIds` is empty.
 *    - All RFC-0022 posture regimes (if `ctx.posture` present).
 *    Filter through `isHardRegulatoryRegime` (defense-in-depth on the OQ-5 boundary).
 * 3. If regime set is empty → `er5 = 1`, `routingPath = 'no-regimes'`.
 * 4. Look up violations for `workItemId` in `ctx.violations` (case-insensitive).
 *    Filter to violations whose `regimeId` is in the regime set.
 *    - If any remain → `er5 = 0`, `routingPath = 'clearance-violated'`.
 *    - Else → `er5 = 1`, `routingPath = 'clearance-holds'`.
 *
 * @param workItemId        - Canonical work item ID (e.g. `AISDLC-316`).
 * @param affectedSoulIds   - Soul IDs the work item targets (from
 *                            `resolveAffectedSouls()`). Empty array =
 *                            non-tessellated or substrate-only; uses
 *                            `__platform` sentinel.
 * @param ctx               - Compliance clearance context (or undefined =
 *                            treated as disabled).
 * @returns Eρ₅ clearance result with routing audit trail.
 */
export function computeComplianceClearance(
  workItemId: string,
  affectedSoulIds: readonly string[],
  ctx: ComplianceClearanceContext | undefined,
): ComplianceClearanceResult {
  // ── Opt-in gate ────────────────────────────────────────────────
  if (!ctx || ctx.enabled !== true) {
    return {
      er5: 1,
      routingPath: 'disabled',
      checkedRegimes: [],
      violations: [],
    };
  }

  // ── Build the regime set ───────────────────────────────────────
  const regimeSet = new Set<string>();

  // Soul-declared regimes — use affectedSoulIds when present, else __platform.
  const soulIdsToCheck: readonly string[] =
    affectedSoulIds.length === 0 ? ['__platform'] : affectedSoulIds;
  for (const soulId of soulIdsToCheck) {
    const entry = ctx.perSoulRegimes.find((e) => e.soulId === soulId);
    if (!entry) continue;
    for (const r of entry.regimes) {
      if (isHardRegulatoryRegime(r)) regimeSet.add(r);
    }
  }

  // RFC-0022 posture regimes — added across the union.
  if (ctx.posture && ctx.posture.length > 0) {
    for (const posture of ctx.posture) {
      for (const regime of posture.spec.regimes ?? []) {
        if (isHardRegulatoryRegime(regime.id)) regimeSet.add(regime.id);
      }
    }
  }

  const checkedRegimes = Array.from(regimeSet);

  // ── No regimes apply ───────────────────────────────────────────
  if (checkedRegimes.length === 0) {
    return {
      er5: 1,
      routingPath: 'no-regimes',
      checkedRegimes: [],
      violations: [],
    };
  }

  // ── Look up violations for this work item ──────────────────────
  const normalizedId = workItemId.toLowerCase();
  const entry = ctx.violations?.find((e) => e.id.toLowerCase() === normalizedId);
  const applicableViolations = entry?.violations.filter((v) => regimeSet.has(v.regimeId)) ?? [];

  if (applicableViolations.length > 0) {
    return {
      er5: 0,
      routingPath: 'clearance-violated',
      checkedRegimes,
      violations: applicableViolations,
    };
  }

  return {
    er5: 1,
    routingPath: 'clearance-holds',
    checkedRegimes,
    violations: [],
  };
}
