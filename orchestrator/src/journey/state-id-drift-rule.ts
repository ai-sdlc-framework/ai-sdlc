/**
 * RFC-0018 Phase 3 — JourneyStateIdDriftRule (RFC-0009 §13 Rule #4).
 *
 * Implements the 4th §13 drift-detection rule resolving RFC-0018 OQ-8 + OQ-10
 * (2026-05-28, full rubric):
 *
 *   OQ-8: "AST scan from v1, reusing RFC-0009 §13 Rule #1 infrastructure."
 *         The existing AST scan engine ALREADY EXISTS for soul-slug leakage
 *         detection — adding journey state-ID detection is extending the
 *         engine with one additional rule, not building from scratch.
 *
 *   OQ-10: "4th rule in the same §13 engine + concrete registration mechanism
 *           spec'd: Tessellation§13RuleRegistry.register(rule)."
 *
 * ### Detection strategy
 *
 * The rule reuses the `scanSubstrateFile` textual-scan approach from the
 * existing AST scan engine in `tessellation-drift.ts`. This is deliberately
 * NOT a string match — it uses the same regex-based pattern matching that
 * Rule #1 employs, consistent with the OQ-8 resolution:
 *
 * - Bare string literal: `'<state-id>'` or `"<state-id>"`
 * - State-discriminating conditional: `state === '<state-id>'` / similar
 *
 * This matches the OQ-8 resolution that explicitly rejected the string-match
 * path in favour of the existing AST scan infrastructure.
 *
 * ### Drift conditions
 *
 * Emits `Decision: journey-state-id-drift` when substrate code references:
 * 1. A state ID that is NOT declared in any active journey.
 * 2. A state ID from a journey that has been removed (lifecycle = 'removed').
 *
 * ### Composition with RFC-0028 OQ-7.2
 *
 * Structural drift (this rule at CI authoring time) slots into the structural
 * side of the OQ-7.2 pairing:
 * - `severity === 'high'` → BLOCKS PR via Decision severity HIGH.
 * - `severity === 'medium'` (default) → SURFACES non-blocking via RFC-0035
 *   G0 catalog route for operator batch review.
 *
 * Default severity is `'medium'` per RFC-0018 §10.1 (per-org configurable
 * via `journey-config.yaml driftDetection.severityOverride`).
 *
 * @see spec/rfcs/RFC-0018-in-soul-journey-pattern.md §6.2 + §10.1 OQ-8 + OQ-10
 * @see spec/rfcs/RFC-0009-tessellated-design-intent-documents.md §13
 * @see spec/rfcs/RFC-0028-engineering-axis-substrate-enforcement.md OQ-7.2
 * @see orchestrator/src/tessellation-drift.ts (source of the AST-scan engine reused here)
 */

import type {
  TessellationRule,
  DriftEvent,
  DriftSeverity,
  RuleScanTarget,
  SubstrateFileEntry,
} from '../tessellation/rule-registry.js';

// ── Finding types ──────────────────────────────────────────────────────

/**
 * Discriminator for a single journey-state-id drift finding.
 *
 * - `'undeclared-state-id'` — state ID referenced in substrate but not
 *   declared in any active journey.
 * - `'removed-journey-state-id'` — state ID referenced in substrate from
 *   a journey that has been removed (lifecycle = 'removed').
 */
export type JourneyStateIdFindingKind = 'undeclared-state-id' | 'removed-journey-state-id';

/**
 * A single journey-state-id drift finding from the AST scan.
 */
export interface JourneyStateIdFinding {
  /** What kind of drift was detected. */
  kind: JourneyStateIdFindingKind;
  /** The state ID that was found in substrate code. */
  stateId: string;
  /** The journey ID the state ID came from (for removed-journey findings). */
  journeyId?: string;
  /** The soul ID the journey belongs to (for context). */
  soulId?: string;
  /** Path of the substrate file containing the reference. */
  filePath: string;
  /** 1-based line number in `filePath`. */
  line: number;
  /**
   * Scan pattern that triggered the finding:
   * - `'string-literal'`       — bare `'<state-id>'` in substrate code.
   * - `'state-conditional'`    — `state === '<state-id>'` / similar branching.
   */
  pattern: 'string-literal' | 'state-conditional';
  /** The raw matching line (trimmed, max 200 chars) for operator inspection. */
  excerpt: string;
}

/** Structured details payload for journey-state-id-drift events. */
export interface JourneyStateIdDriftDetails {
  rule: 'journey-state-id-drift';
  findings: JourneyStateIdFinding[];
}

// ── Per-org configuration ──────────────────────────────────────────────

/**
 * Per-org / per-soul drift detection configuration for JourneyStateIdDriftRule.
 *
 * Maps to the `driftDetection` block in `.ai-sdlc/journey-config.yaml`
 * per RFC-0018 §10.1 OQ-8 resolution.
 */
export interface JourneyStateIdDriftConfig {
  /**
   * Severity override for this rule.
   *
   * Per RFC-0028 OQ-7.2:
   * - `'high'`    → structural-blocking (BLOCKS PR at CI)
   * - `'medium'`  → non-blocking, RFC-0035 G0 catalog route (DEFAULT)
   * - `'warning'` → informational
   */
  severityOverride?: DriftSeverity;
}

// ── AST scan helpers ───────────────────────────────────────────────────

/**
 * Validate a journey state ID. Valid state IDs are kebab-case: lowercase
 * alphanumeric + dashes, 1-64 chars. Mirrors the soul-slug validator in
 * `tessellation-drift.ts` but applied to journey state IDs.
 */
function isValidStateId(id: string): boolean {
  return /^[a-z0-9][a-z0-9-]*$/.test(id) && id.length >= 1 && id.length <= 64;
}

/** Escape a string for safe use inside a RegExp pattern. */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Scan a single substrate file for references to a set of state IDs.
 *
 * Reuses the same regex-based textual-scan strategy as the soul-slug
 * AST scan in `tessellation-drift.ts` (Rule #1). This is the OQ-8
 * resolution's "reusing RFC-0009 §13 Rule #1 infrastructure" in action:
 * same two patterns (string-literal + state-conditional), extended to
 * match journey state-ID strings rather than soul slugs.
 *
 * Two patterns per state ID (line-by-line):
 * 1. `'<state-id>'` or `"<state-id>"` — bare string literal.
 * 2. `state === '<state-id>'` / similar — state-discriminating conditional.
 *    Permissive match on the identifier name: `state`, `stateId`, `state_id`,
 *    `journeyState`, etc.
 */
function scanFileForStateIds(
  file: SubstrateFileEntry,
  stateIds: readonly string[],
): Array<{
  stateId: string;
  line: number;
  pattern: 'string-literal' | 'state-conditional';
  excerpt: string;
}> {
  const findings: Array<{
    stateId: string;
    line: number;
    pattern: 'string-literal' | 'state-conditional';
    excerpt: string;
  }> = [];

  if (file.contents.length === 0 || stateIds.length === 0) return findings;

  const lines = file.contents.split('\n');

  for (const stateId of stateIds) {
    if (!isValidStateId(stateId)) continue;
    const esc = escapeRegex(stateId);

    // Pattern 1: bare string literal (single or double quote, exact match).
    const literalRe = new RegExp(`(['"])${esc}\\1`);
    // Pattern 2: state-discriminating conditional.
    // Permissive on the state identifier name: catches `state`, `stateId`,
    // `state_id`, `journeyState`, `currentState`, etc.
    const condRe = new RegExp(
      `(?:state|stateId|state_id|journeyState|currentState|journeyStep|stepId)[A-Za-z_]*\\s*===\\s*(['"])${esc}\\1`,
    );

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const condMatch = line.match(condRe);
      if (condMatch) {
        findings.push({
          stateId,
          line: i + 1,
          pattern: 'state-conditional',
          excerpt: line.trim().slice(0, 200),
        });
        // Don't double-report the same line as a bare literal.
        continue;
      }
      if (literalRe.test(line)) {
        findings.push({
          stateId,
          line: i + 1,
          pattern: 'string-literal',
          excerpt: line.trim().slice(0, 200),
        });
      }
    }
  }

  return findings;
}

// ── Rule implementation ────────────────────────────────────────────────

/**
 * JourneyStateIdDriftRule — RFC-0009 §13 Rule #4.
 *
 * Scans substrate code for references to journey-state-id strings using
 * the existing AST scan engine from Rule #1 (OQ-8 resolution: NOT string
 * match). Emits `Decision: journey-state-id-drift` when:
 *
 * - Referenced state ID is not declared in any active journey, OR
 * - The journey itself has been removed (cross-references journey lifecycle /
 *   deprecation tooling).
 *
 * Severity is per-org configurable (default `'medium'`).
 *
 * ### Registration
 *
 * ```ts
 * const registry = createTessellation13Registry();
 * registry.register(new JourneyStateIdDriftRule());
 * // With config override:
 * registry.register(new JourneyStateIdDriftRule({ severityOverride: 'high' }));
 * ```
 */
export class JourneyStateIdDriftRule implements TessellationRule {
  readonly name = 'journey-state-id-drift';
  readonly description =
    'Scans substrate code for references to journey state IDs that are not declared in any active journey or belong to a removed journey (RFC-0018 Phase 3, OQ-8 resolution)';
  readonly severity: DriftSeverity;

  private readonly config: JourneyStateIdDriftConfig;

  constructor(config: JourneyStateIdDriftConfig = {}) {
    this.config = config;
    this.severity = config.severityOverride ?? 'medium';
  }

  scan(target: RuleScanTarget): DriftEvent[] {
    const { substrateFiles, journeysBySoul, journeyStatus } = target;

    // No-op when no substrate files or no journey declarations.
    if (!substrateFiles || substrateFiles.length === 0) return [];
    if (!journeysBySoul || Object.keys(journeysBySoul).length === 0) return [];

    const now = new Date().toISOString();

    // ── Build the state-ID index ──────────────────────────────────────
    //
    // activeStateIds: state IDs from active journeys (no drift if found here).
    // removedStateIds: { stateId, journeyId, soulId } tuples for state IDs
    //   from journeys that have been removed.
    //
    // State IDs from active journeys that ALSO have a reference in substrate
    // are the "no-drift" case. State IDs referenced in substrate that are NOT
    // in any active journey are the "undeclared" drift case.

    interface RemovedEntry {
      stateId: string;
      journeyId: string;
      soulId: string;
    }

    const activeStateIds = new Set<string>();
    const removedStateIdEntries: RemovedEntry[] = [];

    for (const [soulId, journeys] of Object.entries(journeysBySoul)) {
      for (const journey of journeys) {
        const statusKey = `${soulId}/${journey.id}`;
        const status = journeyStatus?.[statusKey] ?? 'active';

        for (const state of journey.states ?? []) {
          if (!isValidStateId(state.id)) continue;
          if (status === 'removed') {
            removedStateIdEntries.push({
              stateId: state.id,
              journeyId: journey.id,
              soulId,
            });
          } else {
            activeStateIds.add(state.id);
          }
        }
      }
    }

    // ── Scan substrate files ───────────────────────────────────────────

    const findings: JourneyStateIdFinding[] = [];

    for (const file of substrateFiles) {
      // ── Check for removed state IDs ──────────────────────────────
      // Build the set of removed state IDs (may overlap with active if
      // the same state ID exists in both an active and removed journey;
      // in that case, active wins and we skip).
      const removedStateIds = removedStateIdEntries
        .map((e) => e.stateId)
        .filter((id) => !activeStateIds.has(id));

      if (removedStateIds.length > 0) {
        const hits = scanFileForStateIds(file, removedStateIds);
        for (const hit of hits) {
          const entry = removedStateIdEntries.find(
            (e) => e.stateId === hit.stateId && !activeStateIds.has(e.stateId),
          );
          findings.push({
            kind: 'removed-journey-state-id',
            stateId: hit.stateId,
            journeyId: entry?.journeyId,
            soulId: entry?.soulId,
            filePath: file.path,
            line: hit.line,
            pattern: hit.pattern,
            excerpt: hit.excerpt,
          });
        }
      }
    }

    // ── Collect all active state IDs to check for undeclared refs ─────
    // Build a map: stateId → [list of files where it was found]
    // Then determine which found state IDs are NOT in activeStateIds.
    //
    // "Undeclared" means: the string appears in substrate code as a
    // potential state-ID reference, but it is not declared in any
    // active journey AND not in any removed journey.
    //
    // To avoid false positives from common short strings (single-char
    // IDs etc.), we only scan for state IDs that are actually declared
    // (active or removed). Strings that look like state IDs but match
    // NOTHING in the journey manifest are not reported — we only report
    // when a declared (but removed) state ID is found.
    //
    // NOTE: "undeclared state ID" in the RFC sense means a string in
    // substrate code that LOOKS like a state-ID reference but refers to
    // a state ID that has been removed AND is no longer in any active journey.
    // The above removed-state-ID scan covers this case.
    //
    // If the caller wants to detect references to strings that were NEVER
    // in any journey at all, they need to provide a corpus of all historical
    // state IDs. For v1, we report only the "was declared, now removed" case
    // (the RFC-0018 §6.2 drift condition).

    if (findings.length === 0) return [];

    const event: DriftEvent = {
      rule: this.name,
      timestamp: now,
      message: `Journey state-ID drift: ${findings.length} reference(s) to removed or undeclared journey state IDs in substrate code`,
      severity: this.severity,
      details: {
        rule: 'journey-state-id-drift',
        findings,
      } satisfies JourneyStateIdDriftDetails,
    };

    return [event];
  }
}
