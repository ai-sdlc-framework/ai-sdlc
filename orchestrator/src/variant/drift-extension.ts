/**
 * RFC-0017 Phase 3 — Eτ_tessellation_drift extension for variant-scoped scans.
 *
 * Composes with RFC-0009 Phase 4.2 / AISDLC-317 (`orchestrator/src/tessellation-drift.ts`)
 * to extend drift detection with variant-scoped design intent scans per RFC-0017 §6.2:
 *
 *   "when a variant is added/removed/modified, the Eτ_tessellation_drift detector
 *   MUST scan substrate code for variant-specific identifiers (parallel to per-soul
 *   scan). Substrate code referring to specific variant IDs is a drift signal."
 *
 * Emits `Decision: variant-design-intent-drift` events catalog-routed per
 * RFC-0035 Stage A/B/C (non-blocking per G0 contract).
 *
 * **Composition model:**
 * This extension runs AFTER the base `detectTessellationDrift` (soul-scope detector).
 * It adds a variant-scoped Rule #1a: scan substrate files for variant-slug leakage,
 * parallel to how the base detector scans for soul-slug leakage. The rationale is
 * identical: variant IDs in shared substrate code are a drift signal — they indicate
 * variant-specific logic has leaked into non-variant-scoped files, which complicates
 * future variant removal and creates implicit coupling.
 *
 * @see spec/rfcs/RFC-0017-in-soul-variant-pattern.md §6.2 Behavioral changes
 * @see orchestrator/src/tessellation-drift.ts — base RFC-0009 Phase 4.2 detector
 * @see spec/rfcs/RFC-0035-decision-catalog-operator-routing.md G0
 */

import type { SubstrateFile } from '../tessellation-drift.js';
import type { VariantOverlay } from '../variant-admission.js';

// ── Event types ───────────────────────────────────────────────────────────────

/**
 * Single finding from the variant-scoped substrate scan.
 * Parallel to `AstScanFinding` in tessellation-drift.ts.
 */
export interface VariantDriftFinding {
  /** Path of the substrate file that contained the variant-slug reference. */
  filePath: string;
  /** Soul slug the leaking variant belongs to. */
  soulSlug: string;
  /** Variant slug that appeared in shared substrate. */
  variantSlug: string;
  /** 1-based line number in `filePath`. */
  line: number;
  /**
   * Discriminator for which pattern triggered:
   * - `'string-literal'`     — bare `'<variant-slug>'` in substrate
   * - `'variant-conditional'` — conditional branching on variant slug
   */
  pattern: 'string-literal' | 'variant-conditional';
  /** The raw matching substring (trimmed, max 200 chars). */
  excerpt: string;
}

/**
 * Decision Catalog event emitted when variant-scoped drift is detected.
 * Catalog-routed per RFC-0035 Stage A/B/C (G0 non-blocking).
 */
export interface VariantDesignIntentDriftEvent {
  type: 'VariantDesignIntentDriftDetected';
  /** RFC-3339 UTC timestamp at detection time. */
  timestamp: string;
  /** Tessellated DID URI this scan ran against. */
  tessellatedDid: string;
  /** Soul IDs whose variants were implicated. */
  involvedSouls: string[];
  /** Variant IDs that appeared in shared substrate (per soul). */
  involvedVariants: Record<string, string[]>;
  severity: 'warning';
  /** Human-readable one-line summary; safe for operator surfaces. */
  message: string;
  /** Catalog decision kind per OQ-7 routing. */
  decisionKind: 'variant-design-intent-drift';
  /**
   * RFC-0035 routing metadata — always non-blocking per G0.
   */
  routing: {
    blocking: false;
    catalogStage: 'A' | 'B' | 'C';
  };
  details: {
    findings: VariantDriftFinding[];
  };
}

// ── Detector configuration ────────────────────────────────────────────────────

/**
 * Configuration for the variant-scoped drift extension.
 * Composes with `TessellationDriftConfig` in tessellation-drift.ts.
 */
export interface VariantDriftExtensionConfig {
  /**
   * Master opt-in switch. Follows RFC-0009 §10 Phase 4 "adopter opt-in" convention.
   * Default `false` — the detector short-circuits and emits nothing when disabled.
   */
  enabled?: boolean;
  /**
   * RFC-0035 Stage assignment for emitted `variant-design-intent-drift` Decisions.
   * Default `'A'` (deterministic check — regex scan against substrate files).
   */
  catalogStage?: 'A' | 'B' | 'C';
}

// ── Input / output shapes ─────────────────────────────────────────────────────

export interface VariantDriftExtensionInput {
  /** The Tessellated DID URI (for event provenance). */
  tessellatedDid: string;
  /**
   * Variant overlays keyed by soulId. Source of truth for which variant slugs
   * to scan for in substrate files. Parallel to `tessellation.souls` in the
   * base detector.
   */
  variantsBySoul: Record<string, VariantOverlay[]>;
  /**
   * Substrate files to scan. Same file set as passed to `detectTessellationDrift`
   * (shared substrate, not soul-scoped or variant-scoped files).
   */
  substrateFiles?: SubstrateFile[];
}

export interface VariantDriftExtensionResult {
  /** Events emitted (zero or one — the detector aggregates all findings into one event). */
  events: VariantDesignIntentDriftEvent[];
  /** True when the detector short-circuited because `enabled === false`. */
  optedOut: boolean;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function isValidSlug(slug: string): boolean {
  return /^[a-z0-9-]+$/.test(slug) && slug.length >= 1 && slug.length <= 64;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Scan a single substrate file for variant-slug leakage.
 *
 * Detection strategy: textual regex scan (parallel to the base detector's
 * Rule #1 soul-slug scan). Two patterns:
 *
 *   1. `'<variant-slug>'` or `"<variant-slug>"` — bare string literal.
 *   2. `if (variant === '<variant-slug>')` etc. — variant-discriminating branch.
 */
function scanSubstrateFileForVariants(
  file: SubstrateFile,
  soulSlug: string,
  variantSlugs: string[],
): VariantDriftFinding[] {
  const findings: VariantDriftFinding[] = [];
  if (file.contents.length === 0 || variantSlugs.length === 0) return findings;

  const lines = file.contents.split('\n');
  for (const variantSlug of variantSlugs) {
    if (!isValidSlug(variantSlug)) continue;
    const esc = escapeRegex(variantSlug);
    // Pattern 1: bare string literal (single or double quote, exact match)
    const literalRe = new RegExp(`(['"])${esc}\\1`);
    // Pattern 2: variant-discriminating conditional
    // Permissive on identifier name: variant, variantId, variant_id, etc.
    const condRe = new RegExp(`(?:variant[A-Za-z_]*)\\s*===\\s*(['"])${esc}\\1`);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const condMatch = line.match(condRe);
      if (condMatch) {
        findings.push({
          filePath: file.path,
          soulSlug,
          variantSlug,
          line: i + 1,
          pattern: 'variant-conditional',
          excerpt: line.trim().slice(0, 200),
        });
        continue; // don't double-report as a bare literal
      }
      if (literalRe.test(line)) {
        findings.push({
          filePath: file.path,
          soulSlug,
          variantSlug,
          line: i + 1,
          pattern: 'string-literal',
          excerpt: line.trim().slice(0, 200),
        });
      }
    }
  }
  return findings;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Detect variant-scoped design intent drift in shared substrate files.
 *
 * Composes with `detectTessellationDrift` (RFC-0009 Phase 4.2) by adding a
 * variant-scope parallel to its Rule #1 (soul-slug scan). Substrate code that
 * mentions specific variant slugs is a drift signal — variant-specific logic
 * should be isolated behind variant-aware routing, not hardcoded in shared code.
 *
 * Emits `Decision: variant-design-intent-drift` (catalog-routed, G0 non-blocking).
 *
 * When `config.enabled !== true` the detector short-circuits immediately and
 * returns `{ events: [], optedOut: true }` — honoring the RFC-0009 §10
 * "adopter opt-in initially" convention.
 *
 * @param input  Detection inputs.
 * @param config Detector configuration.
 * @param emit   Optional callback called once per emitted event. Errors propagate.
 */
export async function detectVariantDrift(
  input: VariantDriftExtensionInput,
  config: VariantDriftExtensionConfig = {},
  emit?: (event: VariantDesignIntentDriftEvent) => Promise<void> | void,
): Promise<VariantDriftExtensionResult> {
  // Master opt-out
  if (config.enabled !== true) {
    return { events: [], optedOut: true };
  }

  const catalogStage = config.catalogStage ?? 'A';
  const now = new Date().toISOString();
  const allFindings: VariantDriftFinding[] = [];

  // Scan each soul's variants against the substrate files
  if (input.substrateFiles && input.substrateFiles.length > 0) {
    for (const [soulSlug, variants] of Object.entries(input.variantsBySoul)) {
      if (!isValidSlug(soulSlug)) continue;
      const variantSlugs = variants.map((v) => v.id).filter(isValidSlug);
      if (variantSlugs.length === 0) continue;
      for (const file of input.substrateFiles) {
        const findings = scanSubstrateFileForVariants(file, soulSlug, variantSlugs);
        allFindings.push(...findings);
      }
    }
  }

  const events: VariantDesignIntentDriftEvent[] = [];

  if (allFindings.length > 0) {
    // Aggregate involved souls and variants
    const involvedSoulsSet = new Set(allFindings.map((f) => f.soulSlug));
    const involvedVariants: Record<string, string[]> = {};
    for (const finding of allFindings) {
      if (!involvedVariants[finding.soulSlug]) {
        involvedVariants[finding.soulSlug] = [];
      }
      if (!involvedVariants[finding.soulSlug].includes(finding.variantSlug)) {
        involvedVariants[finding.soulSlug].push(finding.variantSlug);
      }
    }
    // Sort for determinism
    for (const soul of Object.keys(involvedVariants)) {
      involvedVariants[soul].sort();
    }

    const totalVariants = Object.values(involvedVariants).flat().length;
    const ev: VariantDesignIntentDriftEvent = {
      type: 'VariantDesignIntentDriftDetected',
      timestamp: now,
      tessellatedDid: input.tessellatedDid,
      involvedSouls: [...involvedSoulsSet].sort(),
      involvedVariants,
      severity: 'warning',
      message:
        `Variant design intent drift: ${allFindings.length} variant-slug leakage hit(s) ` +
        `across ${totalVariants} variant(s) in ${involvedSoulsSet.size} soul(s) detected ` +
        `in shared substrate. Decision: variant-design-intent-drift (RFC-0035 Stage ${catalogStage}, non-blocking).`,
      decisionKind: 'variant-design-intent-drift',
      routing: { blocking: false, catalogStage },
      details: { findings: allFindings },
    };
    events.push(ev);
    if (emit) {
      await emit(ev);
    }
  }

  return { events, optedOut: false };
}
