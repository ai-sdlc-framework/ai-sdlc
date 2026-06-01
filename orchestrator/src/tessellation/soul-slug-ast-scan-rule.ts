/**
 * RFC-0009 §13 Rule #1 — SoulSlugAstScanRule.
 *
 * Implements `TessellationRule` for the Tessellation§13RuleRegistry so Rule #1
 * is dispatchable via `registry.register(rule)` (AISDLC-489, AISDLC-467 AC#3
 * follow-up).
 *
 * Wraps the existing soul-slug AST scan logic from `tessellation-drift.ts` as a
 * first-class `TessellationRule` instance. The implementation is a thin adapter
 * that delegates to the same two-pattern regex scan used by `detectTessellationDrift()`
 * internally, preserving the existing detection semantics unchanged.
 *
 * ### Scan strategy
 *
 * Line-by-line regex over `target.substrateFiles`:
 *   1. `'<slug>'` or `"<slug>"` — bare string-literal match.
 *   2. `soul === '<slug>'` / `soulId === '<slug>'` — soul-discriminating branch.
 *
 * Soul slugs are supplied at construction time via `soulSlugs`. The registry
 * dispatcher passes the shared `RuleScanTarget` to all rules; callers building
 * the target should set `target.soulSlugs` to the tessellation's soul ID list.
 * When `target.soulSlugs` is present it takes precedence; otherwise the rule
 * falls back to the `soulSlugs` supplied at construction time.
 *
 * ### Severity
 *
 * Default `'warning'` (matches the pre-registry `TessellationDriftDetectedEvent`
 * `severity: 'warning'` field in the original `tessellation-drift.ts`).
 *
 * @see spec/rfcs/RFC-0009-tessellated-design-intent-documents.md §7.2 Rule #1
 * @see orchestrator/src/tessellation-drift.ts (original Rule #1 logic)
 */

import type {
  TessellationRule,
  DriftEvent,
  DriftSeverity,
  RuleScanTarget,
  SubstrateFileEntry,
} from './rule-registry.js';

// ── AST scan details shape ─────────────────────────────────────────────

/**
 * A single soul-slug AST scan finding.
 */
export interface SoulSlugAstScanFinding {
  /** Path of the substrate file that contained the soul-leaking literal. */
  filePath: string;
  /** Soul slug whose name leaked into shared substrate. */
  soulSlug: string;
  /** 1-based line number in `filePath`. */
  line: number;
  /**
   * Discriminator for which pattern triggered the finding:
   * - `'string-literal'`   — bare `'<slug>'` (or `"<slug>"`) appeared in substrate
   * - `'soul-conditional'` — `soul === '<slug>'` / similar branched on soul
   */
  pattern: 'string-literal' | 'soul-conditional';
  /** The raw matching substring (trimmed, max 200 chars) for operator inspection. */
  excerpt: string;
}

/**
 * Structured details payload for soul-slug-ast-scan drift events.
 */
export interface SoulSlugAstScanDetails {
  rule: 'soul-slug-ast-scan';
  findings: SoulSlugAstScanFinding[];
}

// ── Internal helpers ───────────────────────────────────────────────────

/**
 * Validate a soul slug. Mirrors the validator in `tessellation-drift.ts`:
 * lowercase alphanumeric + dashes, 1-64 chars.
 */
function isValidSlug(slug: string): boolean {
  return /^[a-z0-9-]+$/.test(slug) && slug.length >= 1 && slug.length <= 64;
}

/** Escape a string for safe use inside a RegExp pattern. */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Scan one substrate file for soul-leakage patterns.
 *
 * Same two-pattern strategy as the internal `scanSubstrateFile` in
 * `tessellation-drift.ts` — adapted to `SubstrateFileEntry` (which uses
 * `contents` + `path`, the same field names) and extended return shape.
 */
function scanSubstrateFileForSlugs(
  file: SubstrateFileEntry,
  soulSlugs: readonly string[],
): SoulSlugAstScanFinding[] {
  const findings: SoulSlugAstScanFinding[] = [];
  if (file.contents.length === 0 || soulSlugs.length === 0) return findings;

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
        continue; // Don't double-report same line as bare literal.
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

// ── Rule implementation ────────────────────────────────────────────────

/**
 * SoulSlugAstScanRule — RFC-0009 §13 Rule #1.
 *
 * Scans substrate files for soul-slug string literals and soul-discriminating
 * conditionals. Emits a `DriftEvent` when any soul slug leaks into shared
 * substrate code.
 *
 * ### Registration
 *
 * ```ts
 * const registry = createTessellation13Registry();
 * registry.register(new SoulSlugAstScanRule(['soul-a', 'soul-b']));
 * // With target-side soul slugs (takes precedence):
 * // target.soulSlugs = tessellation.souls.map(s => s.soulId);
 * ```
 */
export class SoulSlugAstScanRule implements TessellationRule {
  readonly name = 'soul-slug-ast-scan';
  readonly description =
    'Scans shared substrate files for soul-slug string literals and soul-discriminating conditionals (RFC-0009 §7.2 Rule #1)';
  readonly severity: DriftSeverity;

  private readonly constructionSlugs: readonly string[];

  /**
   * @param soulSlugs  Default set of soul slugs to scan for. When the scan
   *                   target carries `soulSlugs`, those take precedence.
   *                   Pass an empty array when you always supply slugs via the target.
   * @param severity   Default `'warning'` (matches pre-registry behaviour).
   */
  constructor(soulSlugs: readonly string[] = [], severity: DriftSeverity = 'warning') {
    this.constructionSlugs = soulSlugs;
    this.severity = severity;
  }

  scan(target: RuleScanTarget): DriftEvent[] {
    const { substrateFiles, tessellatedDid } = target;
    // Accept soul slugs from target if provided (forward-compat field), else
    // fall back to slugs supplied at construction time.
    const soulSlugs: readonly string[] =
      (target as RuleScanTarget & { soulSlugs?: string[] }).soulSlugs ?? this.constructionSlugs;

    // No-op when no substrate files or no soul slugs to scan for.
    if (!substrateFiles || substrateFiles.length === 0) return [];
    if (soulSlugs.length === 0) return [];

    const now = new Date().toISOString();
    const allFindings: SoulSlugAstScanFinding[] = [];

    for (const file of substrateFiles) {
      const findings = scanSubstrateFileForSlugs(file, soulSlugs);
      if (findings.length > 0) allFindings.push(...findings);
    }

    if (allFindings.length === 0) return [];

    const involved = new Set(allFindings.map((f) => f.soulSlug));

    return [
      {
        rule: this.name,
        timestamp: now,
        message: `AST scan: ${allFindings.length} soul-name leakage hit(s) across ${involved.size} soul(s) in shared substrate (tessellation: ${tessellatedDid})`,
        severity: this.severity,
        details: {
          rule: 'soul-slug-ast-scan',
          findings: allFindings,
        } satisfies SoulSlugAstScanDetails,
      },
    ];
  }
}
