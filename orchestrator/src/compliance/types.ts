/**
 * TypeScript interfaces for the CompliancePosture resource (RFC-0022 §5).
 *
 * Lives at .ai-sdlc/compliance.yaml; schema at
 * spec/schemas/compliance-posture.v1.schema.json.
 *
 * Design notes:
 * - Loader returns CompliancePosture[] (single-element list in v1) per OQ-6
 *   so v2 multi-tenant composition is additive — not a breaking API change.
 * - derivedGates overrides require a sibling _notes map (OQ-2 enforcement).
 * - All regime declarations require attestedBy + attestedAt (legal claim
 *   discipline — loader rejects postures missing either field).
 */

// ── Regime ────────────────────────────────────────────────────────────────

/**
 * A single regulatory regime declaration with attestation metadata.
 *
 * Convention for `id`: '<framework>-<tier-or-version>'.
 * Examples: 'SOC2-T2', 'HIPAA', 'PCI-DSS-L1', 'GDPR', 'FedRAMP-Moderate', 'ISO-27001:2022'.
 */
export interface Regime {
  /**
   * Canonical regime identifier.
   * Convention: '<framework>-<tier-or-version>'.
   * Examples: 'SOC2-T2', 'HIPAA', 'PCI-DSS-L1', 'GDPR', 'FedRAMP-Moderate', 'ISO-27001:2022'.
   */
  id: string;

  /**
   * Optional explicit control list from the regime the adopter is claiming coverage for.
   * Examples: ['CC6.6', 'CC8.1'] for SOC2; ['§164.308(a)(4)', '§164.312(a)'] for HIPAA.
   * Used by the audit export to slice evidence per control.
   */
  controls?: string[];

  /**
   * Audit cadence — drives default retention windows and export pre-staging.
   */
  auditFrequency?: 'annual' | 'continuous' | 'on-demand';

  /**
   * Who declared this regime applies.
   * E.g., 'Acme Legal LLP' or a contributor name.
   * REQUIRED in v1: framework refuses to load a posture with regimes lacking attestation
   * metadata (forces explicit operator/legal sign-off on each declaration).
   */
  attestedBy: string;

  /**
   * ISO 8601 date when the regime was attested.
   * REQUIRED in v1 (same rationale as attestedBy).
   */
  attestedAt: string;

  /**
   * Operator's rationale for declaring this regime.
   * Recommended for audit trail; not enforced by loader but strongly encouraged.
   */
  attestedNotes?: string;
}

// ── DerivedGates ──────────────────────────────────────────────────────────

/**
 * Gate values derived from declared regimes.
 * When multiple regimes are declared, tightest constraint wins per axis (RFC-0022 §6).
 */
export interface DerivedGates {
  /**
   * Per RFC-0009 OQ-11.
   * 'shared-with-rls' = single Postgres branch with row-level security tenant isolation.
   * 'per-shard' = one branch per shard / customer.
   */
  databaseBranchPool: 'shared-with-rls' | 'per-shard';

  /**
   * Per AISDLC-128.
   * 'minimal' = framework-default patterns only.
   * 'standard' = + common cloud provider keys.
   * 'strict' = + entropy-based detection + adopter-supplied custom patterns.
   */
  secretScanStrictness: 'minimal' | 'standard' | 'strict';

  /**
   * Per AISDLC-74/146.
   * When true, framework refuses to merge PRs without a valid DSSE attestation envelope at HEAD.
   */
  attestationRequired: boolean;

  /**
   * Floor for log retention in days.
   * Framework keeps logs for at least this many days; GC by mtime.
   */
  auditRetentionDays: number;

  /**
   * Per config/trusted-reviewers.yaml.
   * 'open' = any GitHub user can act as reviewer.
   * 'allowlist' = explicit reviewer list; identity-only check.
   * 'allowlist+role' = allowlist + per-role authority (review vs approve vs admin).
   */
  reviewerAuthorityModel: 'open' | 'allowlist' | 'allowlist+role';
}

/**
 * Operator-supplied partial overrides for DerivedGates.
 *
 * Per OQ-2: each overridden field MUST have a corresponding non-empty entry
 * in the sibling `_notes` map. The loader rejects any override missing notes.
 *
 * The `_notes` field is a sibling map keyed by field name to keep the override
 * values themselves typed and to make the notes audit-traceable.
 */
export type PartialDerivedGatesOverrides = Partial<Omit<DerivedGates, never>> & {
  /**
   * Notes for each overridden gate field.
   * Key = gate field name (e.g. 'databaseBranchPool').
   * Value = non-empty rationale string.
   * Loader rejects any gate field override whose corresponding _notes entry is missing or empty.
   */
  _notes?: Record<string, string>;
};

// ── AuditExportSpec ───────────────────────────────────────────────────────

/**
 * Specification for a single evidence bundle included in `cli-compliance-audit export`.
 */
export interface AuditExportSpec {
  /**
   * Which kind of evidence to include in the export bundle.
   */
  kind:
    | 'dsse-envelope' // .ai-sdlc/attestations/*.dsse.json
    | 'dor-calibration' // _dor/calibration.jsonl
    | 'trusted-reviewers' // git history of config/trusted-reviewers.yaml
    | 'enforcement-events' // .ai-sdlc/enforcement/*.jsonl
    | 'access-control-changes'; // git history of CODEOWNERS + branch protection settings

  /**
   * Output format for this evidence bundle.
   */
  format: 'json' | 'jsonl' | 'csv';

  /**
   * Retention policy for this evidence bundle.
   */
  retentionPolicy: {
    /**
     * Retention floor in days. Framework GC removes after `days + grace`.
     */
    days: number;
    /**
     * hot = on local disk; cold = expected to be archived externally.
     */
    tier?: 'hot' | 'cold';
  };
}

// ── CompliancePosture ─────────────────────────────────────────────────────

/**
 * The CompliancePosture resource.
 *
 * Lives at .ai-sdlc/compliance.yaml.
 * Schema at spec/schemas/compliance-posture.v1.schema.json.
 *
 * Adopters declare which regulatory regimes apply; the framework derives gate
 * defaults from those regimes and uses this posture to drive attestation
 * requirements, secret-scan strictness, DB pool isolation, and audit-export
 * configuration.
 */
export interface CompliancePosture {
  apiVersion: 'ai-sdlc.io/v1alpha1';
  kind: 'CompliancePosture';
  metadata: {
    /** Canonical project identifier. DNS-label format. */
    name: string;
    namespace?: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
  };
  spec: {
    /**
     * Declared regulatory posture. Empty array means "(none declared)" — baseline posture applies.
     * Baseline: shared-with-rls, minimal, attestationRequired=false, 90d retention, open reviewer model.
     */
    regimes: Regime[];

    /**
     * Operator overrides for derived gate values.
     * Each overridden field requires a non-empty _notes entry (OQ-2).
     * The loader rejects any override missing a notes entry.
     */
    derivedGates?: PartialDerivedGatesOverrides;

    /**
     * Evidence bundles to produce on `cli-compliance-audit export`.
     */
    auditExports: AuditExportSpec[];
  };
}

// ── Baseline ──────────────────────────────────────────────────────────────

/**
 * The "(none declared)" baseline DerivedGates — applies when no regimes are declared.
 * Matches pre-RFC-0022 framework behavior (no gate changes for existing projects).
 */
export const BASELINE_DERIVED_GATES: Readonly<DerivedGates> = {
  databaseBranchPool: 'shared-with-rls',
  secretScanStrictness: 'minimal',
  attestationRequired: false,
  auditRetentionDays: 90,
  reviewerAuthorityModel: 'open',
} as const;

/**
 * The "(none declared)" baseline CompliancePosture — returned when no
 * .ai-sdlc/compliance.yaml exists (AC #6 / OQ-6 backward-compat).
 */
export const BASELINE_POSTURE: Readonly<CompliancePosture> = {
  apiVersion: 'ai-sdlc.io/v1alpha1',
  kind: 'CompliancePosture',
  metadata: {
    name: 'baseline',
  },
  spec: {
    regimes: [],
    auditExports: [],
  },
} as const;
