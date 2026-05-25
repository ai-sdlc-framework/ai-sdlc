/**
 * RFC-0009 Phase 4.2 — Eτ_tessellation_drift detector (orchestrator-side).
 *
 * Detects design-coherence drift across tessellated souls per RFC-0009 §7.2
 * (OQ-6 resolution: detection is orchestrator-side, not adapter-side).
 *
 * Three detection rules are specified in §7.2:
 *
 *   Rule #1 — AST scan for soul-name string literals in shared substrate
 *             SHIPS HERE. Static scan over the substrate file set looking for
 *             soul-slug string literals and `if (soul === '<slug>')` patterns
 *             in modules that are NOT scoped to a single soul.
 *
 *   Rule #2 — Embedding distance between Soul DIDs over time
 *             EXPLICITLY DEFERRED to RFC-0019 (Embedding Provider Adapter).
 *             Not implemented here; would land in a separate detector once
 *             `embedDocument(text)` is callable from the orchestrator.
 *
 *   Rule #3 — Cross-soul provenance audits
 *             SHIPS HERE. Walks the supplied provenance records (RFC-0009 §8.3
 *             ProvenanceRecord with `targetedSouls`, `substrateScoped`,
 *             `tessellatedSoulRef`, all landed by AISDLC-315) and flags work
 *             whose `targetedSouls` set crosses tessellation boundaries
 *             without an amendment record; flags substrate work whose
 *             downstream provenance shows soul-distinct outcomes diverge.
 *
 * Both shipped rules are gated on adopter opt-in via `enabled` (default
 * `false`) per RFC-0009 §10 Phase 4 promotion convention ("All sub-dimension
 * activations are gated on adopter opt-in initially").
 *
 * Detected drift events emit to `events.jsonl` (the RFC-0015 substrate) via
 * the supplied `emit` callback. Callers wire this to
 * `orchestrator/src/artifacts.appendEvent(artifactsDir, event)`.
 *
 * @see spec/rfcs/RFC-0009-tessellated-design-intent-documents.md §7.2 + §10
 */

import type { ProvenanceRecord } from '@ai-sdlc/reference';
import type { Tessellation } from '@ai-sdlc/reference';

// ── Event types ────────────────────────────────────────────────────────

/**
 * Discriminated rule identifier for an emitted drift event.
 *
 * - `'ast-scan'`           — Rule #1 (soul-name leakage in substrate).
 * - `'cross-soul-provenance'` — Rule #3 (provenance crosses soul boundaries
 *                                       without amendment, OR substrate
 *                                       provenance shows divergent soul-
 *                                       distinct outcomes).
 *
 * Rule #2 (`'embedding-distance'`) is reserved for the RFC-0019 follow-on
 * detector and is intentionally NOT a member of this union — exporting it
 * here would invite premature consumers. AISDLC-340 will add it.
 */
export type TessellationDriftRule = 'ast-scan' | 'cross-soul-provenance';

/**
 * The minimal common shape of every drift event written to events.jsonl.
 *
 * Discriminated by `rule` so consumers (operators grepping events.jsonl,
 * cli-status, TUI analytics) can attribute to the originating detector
 * without re-parsing free-form messages.
 */
export interface TessellationDriftDetectedEvent {
  type: 'TessellationDriftDetected';
  rule: TessellationDriftRule;
  /** RFC-3339 UTC timestamp at detection time. */
  timestamp: string;
  /**
   * Parent Tessellated DID URI (e.g., `did:platform-x:platform`) the drift
   * was detected against. Sourced from the `tessellation` field's owning
   * DID; callers pass it through so events.jsonl traces back to the DID.
   */
  tessellatedDid: string;
  /**
   * Soul IDs implicated in the drift (for `ast-scan`: souls whose slugs
   * appeared in shared substrate; for `cross-soul-provenance`: souls
   * crossed). Empty if no specific souls are implicated.
   */
  involvedSouls: string[];
  /** Human-readable severity label. Currently a single tier; reserved for future expansion. */
  severity: 'warning';
  /** Free-form one-line summary; safe for operator surfaces (TUI, Slack). */
  message: string;
  /**
   * Rule-specific structured payload. Per-rule discriminator is `rule`
   * above; consumers narrow on that before reading `details`.
   */
  details: AstScanDetails | CrossSoulProvenanceDetails;
}

/** Details emitted by Rule #1 (AST scan). */
export interface AstScanDetails {
  rule: 'ast-scan';
  /** Each finding represents one literal/conditional hit in substrate code. */
  findings: AstScanFinding[];
}

/** A single AST-scan finding. */
export interface AstScanFinding {
  /** Path of the substrate file that contained the soul-leaking literal. */
  filePath: string;
  /** Soul slug whose name leaked into shared substrate. */
  soulSlug: string;
  /** 1-based line number in `filePath`. */
  line: number;
  /**
   * Discriminator for which pattern triggered the finding:
   * - `'string-literal'`     — bare `'<slug>'` (or `"<slug>"`) appeared in substrate
   * - `'soul-conditional'`   — `if (soul === '<slug>')` / `=== "<slug>"` branched on soul
   */
  pattern: 'string-literal' | 'soul-conditional';
  /** The raw matching substring (trimmed) for operator inspection. */
  excerpt: string;
}

/** Details emitted by Rule #3 (cross-soul provenance audit). */
export interface CrossSoulProvenanceDetails {
  rule: 'cross-soul-provenance';
  /** Each finding represents one provenance record (or substrate-vs-soul divergence) flagged. */
  findings: CrossSoulProvenanceFinding[];
}

/** A single cross-soul provenance finding. */
export interface CrossSoulProvenanceFinding {
  /**
   * Discriminator:
   * - `'cross-boundary-no-amendment'` — provenance's `targetedSouls` spans
   *   >=2 souls and no recorded amendment was supplied for the work.
   * - `'substrate-divergent-outcomes'` — `substrateScoped: true` provenance
   *   where downstream soul-distinct outcomes diverge sharply (the caller-
   *   supplied `outcomeBySoul` map shows ≥`divergenceThreshold` spread).
   */
  kind: 'cross-boundary-no-amendment' | 'substrate-divergent-outcomes';
  /**
   * Stable per-work-item identifier extracted from `promptHash` so operators
   * can grep events.jsonl by work item without exposing soul data.
   */
  workItemRef: string;
  /** Soul IDs crossed (for cross-boundary) or implicated (for substrate-divergent). */
  crossedSouls: string[];
  /**
   * Soul-distinct outcome readings for substrate-divergent findings, keyed
   * by soulId. Absent for cross-boundary findings.
   */
  outcomeBySoul?: Record<string, number>;
  /** Free-form description; safe for operator surfaces. */
  note: string;
}

// ── Substrate file source ──────────────────────────────────────────────

/**
 * A single substrate file's contents for Rule #1 to scan.
 *
 * Callers materialize this from the dependency graph + filesystem before
 * invoking the detector. Only files NOT scoped to a single soul should be
 * passed in (files under `.ai-sdlc/souls/<slug>/` or other soul-scoped
 * trees are by-definition allowed to mention their own soul slug).
 */
export interface SubstrateFile {
  /** Workspace-relative path (use forward slashes; informational only). */
  path: string;
  /** Full file contents as UTF-8. */
  contents: string;
}

// ── Provenance audit input ─────────────────────────────────────────────

/**
 * One provenance record paired with the optional cross-soul amendment ref +
 * the optional downstream soul-outcome readings.
 *
 * `amendmentRecorded` is true when the work item carried an explicit
 * cross-tessellation amendment (operator-acknowledged the cross-soul span).
 * `outcomeBySoul` is the optional downstream calibration cell readout per
 * soul, supplied for substrate-scoped provenance so Rule #3 can detect
 * sharp divergence in soul-distinct outcomes.
 */
export interface ProvenanceAuditEntry {
  /** The provenance record itself (RFC-0009 §8.3 extended shape). */
  record: ProvenanceRecord;
  /** True iff the operator recorded a cross-tessellation amendment for this work item. */
  amendmentRecorded?: boolean;
  /**
   * Soul-distinct outcome readout, keyed by soulId. Only meaningful when
   * `record.substrateScoped === true`. Values are caller-supplied outcome
   * scores in [0, 1]; the detector flags when the spread exceeds
   * `divergenceThreshold`.
   */
  outcomeBySoul?: Record<string, number>;
}

// ── Detector configuration ─────────────────────────────────────────────

/**
 * Detector configuration. All fields optional with safe defaults; the only
 * required toggle is `enabled` (default `false`, honoring RFC-0009 §10
 * Phase 4 opt-in default).
 */
export interface TessellationDriftConfig {
  /**
   * Master opt-in switch. Per RFC-0009 §10 Phase 4 "All sub-dimension
   * activations are gated on adopter opt-in initially". Default `false`;
   * the detector short-circuits and emits nothing when disabled.
   */
  enabled?: boolean;
  /**
   * Per-rule kill switches. Useful for staged rollout (e.g., enable rule
   * #1 first, observe noise levels, then enable rule #3). Defaults: both
   * `true` (subject to `enabled` master gate).
   */
  rules?: {
    astScan?: boolean;
    crossSoulProvenance?: boolean;
  };
  /**
   * Spread threshold for substrate-divergent-outcomes detection. When the
   * max-min of `outcomeBySoul` values exceeds this number, the detector
   * emits a `substrate-divergent-outcomes` finding. Defaults to 0.3 (a
   * 30-point spread on a 0..1 outcome scale).
   */
  divergenceThreshold?: number;
}

export const DEFAULT_DIVERGENCE_THRESHOLD = 0.3;

// ── Detector inputs + outputs ──────────────────────────────────────────

export interface TessellationDriftInput {
  /** The Tessellated DID URI the scan runs against (for event provenance). */
  tessellatedDid: string;
  /** The tessellation manifest (souls + substrate invariants). */
  tessellation: Tessellation;
  /** Substrate file contents to scan with Rule #1. Empty/absent = rule #1 no-op. */
  substrateFiles?: SubstrateFile[];
  /** Provenance entries to scan with Rule #3. Empty/absent = rule #3 no-op. */
  provenance?: ProvenanceAuditEntry[];
}

export interface TessellationDriftResult {
  /** Every drift event emitted during this run (also forwarded to `emit`). */
  events: TessellationDriftDetectedEvent[];
  /** True when the detector short-circuited because `enabled === false`. */
  optedOut: boolean;
}

// ── Internal helpers ───────────────────────────────────────────────────

/**
 * Validate a soul slug. Mirrors `TessellationSoul.soulId` JSON-schema
 * constraint: lowercase alphanumeric + dashes, 1-64 chars.
 */
function isValidSlug(slug: string): boolean {
  return /^[a-z0-9-]+$/.test(slug) && slug.length >= 1 && slug.length <= 64;
}

/**
 * Escape a string for safe use inside a RegExp character class / pattern.
 * The soul slug grammar already excludes regex metacharacters, but this
 * stays defensive in case future schema changes admit more chars.
 */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Scan one substrate file for soul-leakage patterns.
 *
 * Detection strategy is deliberately textual rather than full-parser-AST.
 * RFC-0009 §7.2 calls this "AST scan" but a regex pass over source files
 * is the framework primitive that ships today and matches the rule's
 * goal — surface soul-slug leakage in substrate code for operator review.
 * False positives (e.g., the slug appearing inside a code comment) are
 * accepted as part of the surface; operators triage and silence per-file
 * via a tessellation amendment if needed.
 *
 * Two patterns are scanned, both line-by-line so we report 1-based line
 * numbers in findings:
 *
 *   1. `'<slug>'` or `"<slug>"` — bare string-literal match.
 *   2. `if (soul === '<slug>')` / `=== "<slug>"` — soul-discriminating branch.
 *      Soul identifier is matched permissively (`soul`, `soulId`, `soul_id`).
 */
function scanSubstrateFile(file: SubstrateFile, soulSlugs: readonly string[]): AstScanFinding[] {
  const findings: AstScanFinding[] = [];
  if (file.contents.length === 0) return findings;

  // Pre-compile patterns per soul slug so we walk the file once per slug.
  // Files are typically small (<5KB per substrate file in practice) so
  // the O(N×S) walk is fine without further optimization.
  const lines = file.contents.split('\n');
  for (const slug of soulSlugs) {
    if (!isValidSlug(slug)) continue;
    const esc = escapeRegex(slug);
    // Pattern 1: bare string literal (single or double quote, exact match).
    const literalRe = new RegExp(`(['"])${esc}\\1`);
    // Pattern 2: soul-discriminating conditional. Permissive on the soul
    // identifier name so it catches `soul`, `soulId`, `soul_id`, etc.
    const condRe = new RegExp(`(?:soul[A-Za-z_]*)\\s*===\\s*(['"])${esc}\\1`);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const condMatch = line.match(condRe);
      if (condMatch) {
        findings.push({
          filePath: file.path,
          soulSlug: slug,
          line: i + 1,
          pattern: 'soul-conditional',
          excerpt: line.trim().slice(0, 200),
        });
        // Don't double-report the same line as a bare literal.
        continue;
      }
      if (literalRe.test(line)) {
        findings.push({
          filePath: file.path,
          soulSlug: slug,
          line: i + 1,
          pattern: 'string-literal',
          excerpt: line.trim().slice(0, 200),
        });
      }
    }
  }
  return findings;
}

/**
 * Derive a short stable work-item reference from a provenance record's
 * `promptHash` (16 hex chars is plenty for human-grep utility while still
 * being unique enough across the audit window). Falls back to the
 * timestamp when promptHash is empty.
 */
function deriveWorkItemRef(record: ProvenanceRecord): string {
  if (record.promptHash && record.promptHash.length > 0) {
    return record.promptHash.slice(0, 16);
  }
  return record.timestamp;
}

/** Compute the max-min spread of an outcome map. Returns 0 for empty / 1-soul maps. */
function outcomeSpread(outcomeBySoul: Record<string, number>): number {
  const values = Object.values(outcomeBySoul).filter((v): v is number => typeof v === 'number');
  if (values.length < 2) return 0;
  return Math.max(...values) - Math.min(...values);
}

// ── Public API ─────────────────────────────────────────────────────────

/**
 * Run Eτ_tessellation_drift detection against the supplied inputs.
 *
 * The detector is **read-only** — it does not mutate the tessellation,
 * the provenance records, or the substrate files. It computes events and
 * forwards each via the optional `emit` callback (callers wire this to
 * `appendEvent(artifactsDir, ev)`).
 *
 * When `config.enabled !== true` the detector short-circuits immediately
 * and returns `{ events: [], optedOut: true }`. This honors the RFC-0009
 * §10 Phase 4 "adopter opt-in initially" convention; the detector exists
 * in the surface but produces zero side effects until explicitly enabled.
 *
 * @param input  Detection inputs (tessellation + optional substrate + provenance).
 * @param config Detector configuration (master `enabled` flag + per-rule toggles).
 * @param emit   Optional event sink; called once per detected event. Errors
 *               from `emit` are propagated to the caller (intentional — the
 *               detector is sync-pure with respect to its inputs; the caller
 *               decides how to handle event-stream failures).
 */
export async function detectTessellationDrift(
  input: TessellationDriftInput,
  config: TessellationDriftConfig = {},
  emit?: (event: TessellationDriftDetectedEvent) => Promise<void> | void,
): Promise<TessellationDriftResult> {
  // ── Master opt-out short-circuit ────────────────────────────────
  if (config.enabled !== true) {
    return { events: [], optedOut: true };
  }

  const events: TessellationDriftDetectedEvent[] = [];
  const now = new Date().toISOString();
  const soulSlugs = input.tessellation.souls.map((s) => s.soulId).filter(isValidSlug);
  const soulSlugSet = new Set(soulSlugs);

  const rules = config.rules ?? {};
  const runAstScan = rules.astScan !== false;
  const runCrossSoulProvenance = rules.crossSoulProvenance !== false;
  const divergenceThreshold = config.divergenceThreshold ?? DEFAULT_DIVERGENCE_THRESHOLD;

  // ── Rule #1: AST scan for soul-name string literals in substrate ─
  if (runAstScan && input.substrateFiles && input.substrateFiles.length > 0) {
    const allFindings: AstScanFinding[] = [];
    for (const file of input.substrateFiles) {
      const findings = scanSubstrateFile(file, soulSlugs);
      if (findings.length > 0) allFindings.push(...findings);
    }
    if (allFindings.length > 0) {
      const involved = new Set(allFindings.map((f) => f.soulSlug));
      const ev: TessellationDriftDetectedEvent = {
        type: 'TessellationDriftDetected',
        rule: 'ast-scan',
        timestamp: now,
        tessellatedDid: input.tessellatedDid,
        involvedSouls: [...involved].sort(),
        severity: 'warning',
        message: `AST scan: ${allFindings.length} soul-name leakage hit(s) across ${involved.size} soul(s) in shared substrate`,
        details: { rule: 'ast-scan', findings: allFindings },
      };
      events.push(ev);
    }
  }

  // ── Rule #3: Cross-soul provenance audits ────────────────────────
  if (runCrossSoulProvenance && input.provenance && input.provenance.length > 0) {
    const findings: CrossSoulProvenanceFinding[] = [];
    for (const entry of input.provenance) {
      const { record, amendmentRecorded, outcomeBySoul } = entry;

      // Filter targetedSouls down to souls actually present in the
      // tessellation — out-of-tessellation slugs are stale and not
      // actionable as drift.
      const valid = (record.targetedSouls ?? []).filter((s) => soulSlugSet.has(s));

      // Detection A: provenance crosses tessellation boundary without amendment.
      if (valid.length >= 2 && amendmentRecorded !== true) {
        findings.push({
          kind: 'cross-boundary-no-amendment',
          workItemRef: deriveWorkItemRef(record),
          crossedSouls: [...valid].sort(),
          note: `work item targeted ${valid.length} souls without a recorded cross-tessellation amendment`,
        });
      }

      // Detection B: substrate-scoped provenance with divergent
      // soul-distinct outcomes.
      if (
        record.substrateScoped === true &&
        outcomeBySoul &&
        Object.keys(outcomeBySoul).length >= 2
      ) {
        const spread = outcomeSpread(outcomeBySoul);
        if (spread >= divergenceThreshold) {
          findings.push({
            kind: 'substrate-divergent-outcomes',
            workItemRef: deriveWorkItemRef(record),
            crossedSouls: Object.keys(outcomeBySoul).sort(),
            outcomeBySoul: { ...outcomeBySoul },
            note: `substrate provenance shows soul-distinct outcome spread ${spread.toFixed(3)} ≥ threshold ${divergenceThreshold}`,
          });
        }
      }
    }

    if (findings.length > 0) {
      const involved = new Set(findings.flatMap((f) => f.crossedSouls));
      const ev: TessellationDriftDetectedEvent = {
        type: 'TessellationDriftDetected',
        rule: 'cross-soul-provenance',
        timestamp: now,
        tessellatedDid: input.tessellatedDid,
        involvedSouls: [...involved].sort(),
        severity: 'warning',
        message: `Cross-soul provenance: ${findings.length} finding(s) across ${involved.size} soul(s)`,
        details: { rule: 'cross-soul-provenance', findings },
      };
      events.push(ev);
    }
  }

  // ── Emit ────────────────────────────────────────────────────────
  if (emit) {
    for (const ev of events) {
      await emit(ev);
    }
  }

  return { events, optedOut: false };
}
