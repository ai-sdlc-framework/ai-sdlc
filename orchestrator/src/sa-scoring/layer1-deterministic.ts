/**
 * Layer 1 — Deterministic SA scorer (RFC-0008 Addendum B §B.4).
 *
 * Consumes a `CompiledDid` + issue text + state store metrics and
 * produces a fully-deterministic scoring result. Layer 1 never makes
 * network or LLM calls *except* for the dep-parse sidecar (for
 * requirement-construction detection).
 *
 * A `core` out-of-scope match is a **hard gate** — downstream SA-1
 * scoring must treat `hardGated=true` as SA-1 = 0.0 regardless of
 * Layer 2/3 output. Evolving matches surface as warnings but do not
 * gate admission.
 */

import type { CompiledDid, CompiledAntiPattern } from './did-compiler.js';
import type { DepparseClient, DepparseMatch } from './depparse-client.js';
import { DepparseError } from './depparse-client.js';

// ── Result shapes ────────────────────────────────────────────────────

export interface ScopeGateMatch {
  label: string;
  synonym?: string;
  identityClass: 'core' | 'evolving';
  matchedText: string;
}

export interface ScopeGateResult {
  inScopeHits: ScopeGateMatch[];
  outOfScopeHits: ScopeGateMatch[];
  /** True when a core out-of-scope term matched (hard gate). */
  hardGated: boolean;
  /** Warnings for evolving out-of-scope hits (soft gate). */
  warnings: string[];
}

export interface ConstraintViolation {
  constraintId: string;
  concept: string;
  relationship: string;
  pattern: string;
  matchedText: string;
  construction?: string;
  depPath?: string[];
  identityClass: 'core' | 'evolving';
}

export interface ConstraintViolationResult {
  violations: ConstraintViolation[];
  /** True when the depparse sidecar was unavailable (fail-soft skip). */
  depparseSkipped: boolean;
}

export interface AntiPatternHit {
  id: string;
  label: string;
  pattern: string;
  matchedText: string;
  identityClass: 'core' | 'evolving';
  scope: 'product' | 'design-principle' | 'voice' | 'visual';
  /** Present only for scope='design-principle'. */
  principleId?: string;
}

export interface AntiPatternResult {
  hits: AntiPatternHit[];
}

export type MeasurableSignalStatus = 'pass' | 'fail' | 'missing';

export interface MeasurableSignalCheck {
  id: string;
  metric: string;
  threshold: number;
  operator: string;
  observedValue?: number;
  status: MeasurableSignalStatus;
  identityClass: 'core' | 'evolving';
}

export interface MeasurableSignalResult {
  checks: MeasurableSignalCheck[];
  /** Count of signals with status='fail' on a core-classified signal. */
  coreFailureCount: number;
}

export interface DeterministicScoringResult {
  scopeGate: ScopeGateResult;
  constraintViolations: ConstraintViolationResult;
  antiPatternHits: AntiPatternResult;
  designAntiPatternHits: AntiPatternResult;
  measurableSignalChecks: MeasurableSignalResult;
  /** Shortcut — true when the scope gate (core) fails. */
  hardGated: boolean;
  /** Total count of `core` violations across all sources. */
  coreViolationCount: number;
  /** Total count of `evolving` violations across all sources. */
  evolvingViolationCount: number;
  /** Human-readable pre-verified summary for Layer 3 prompt injection. */
  preVerifiedSummary: string;
}

// ── Tokenization / matching ──────────────────────────────────────────

function lower(s: string): string {
  return s.toLowerCase();
}

function includesWhole(haystack: string, needle: string): boolean {
  if (!needle) return false;
  // Whole-word-ish match: bounds on non-alphanumeric.
  const re = new RegExp(`(^|[^a-z0-9])${escapeRegex(lower(needle))}($|[^a-z0-9])`, 'i');
  return re.test(haystack);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ── Scope gate ───────────────────────────────────────────────────────

export function checkScopeGate(issueText: string, compiled: CompiledDid): ScopeGateResult {
  const text = lower(issueText);
  const inHits: ScopeGateMatch[] = [];
  const outHits: ScopeGateMatch[] = [];
  const warnings: string[] = [];
  let hardGated = false;

  for (const entry of compiled.scopeLists.inScope) {
    const all = [entry.label, ...entry.synonyms];
    for (const term of all) {
      if (includesWhole(text, term)) {
        inHits.push({
          label: entry.label,
          synonym: term === entry.label ? undefined : term,
          identityClass: entry.identityClass,
          matchedText: term,
        });
        break;
      }
    }
  }

  for (const entry of compiled.scopeLists.outOfScope) {
    const all = [entry.label, ...entry.synonyms];
    for (const term of all) {
      if (includesWhole(text, term)) {
        outHits.push({
          label: entry.label,
          synonym: term === entry.label ? undefined : term,
          identityClass: entry.identityClass,
          matchedText: term,
        });
        if (entry.identityClass === 'core') {
          hardGated = true;
        } else {
          warnings.push(`Evolving out-of-scope match: "${entry.label}" via "${term}"`);
        }
        break;
      }
    }
  }

  return { inScopeHits: inHits, outOfScopeHits: outHits, hardGated, warnings };
}

// ── Constraint violations (via depparse sidecar) ─────────────────────

export async function detectConstraintViolations(
  issueText: string,
  compiled: CompiledDid,
  client: DepparseClient,
): Promise<ConstraintViolationResult> {
  const violations: ConstraintViolation[] = [];
  let depparseSkipped = false;

  for (const rule of compiled.constraintRules) {
    // Only enforce `must-not-require` / `must-not-include` via depparse;
    // `must-require` / `must-include` are positive constraints (enforced
    // downstream as signal requirements, not as violation checks).
    if (rule.relationship !== 'must-not-require' && rule.relationship !== 'must-not-include') {
      continue;
    }

    let response;
    try {
      response = await client.match({
        text: issueText,
        patterns: rule.detectionPatterns,
      });
    } catch (err) {
      if (
        err instanceof DepparseError &&
        (err.kind === 'model-unavailable' || err.kind === 'network' || err.kind === 'timeout')
      ) {
        depparseSkipped = true;
        continue;
      }
      throw err;
    }

    for (const match of response.matches) {
      violations.push(buildViolation(rule, match));
    }
  }

  return { violations, depparseSkipped };
}

function buildViolation(
  rule: CompiledDid['constraintRules'][number],
  match: DepparseMatch,
): ConstraintViolation {
  return {
    constraintId: rule.id,
    concept: rule.concept,
    relationship: rule.relationship,
    pattern: match.pattern,
    matchedText: match.matchedText,
    construction: match.construction,
    depPath: match.depPath,
    identityClass: rule.identityClass,
  };
}

// ── Anti-pattern matching ────────────────────────────────────────────

function matchAntiPatterns(
  text: string,
  list: CompiledAntiPattern[],
  scope: AntiPatternHit['scope'],
  principleId?: string,
): AntiPatternHit[] {
  const hits: AntiPatternHit[] = [];
  for (const ap of list) {
    for (const pattern of ap.detectionPatterns) {
      if (includesWhole(text, pattern)) {
        hits.push({
          id: ap.id,
          label: ap.label,
          pattern,
          matchedText: pattern,
          identityClass: ap.identityClass,
          scope,
          ...(principleId ? { principleId } : {}),
        });
      }
    }
  }
  return hits;
}

export function detectAntiPatterns(
  issueText: string,
  compiled: CompiledDid,
): { product: AntiPatternResult; design: AntiPatternResult } {
  const text = lower(issueText);

  const productHits = matchAntiPatterns(text, compiled.antiPatternLists.product, 'product');

  const designHits: AntiPatternHit[] = [];
  for (const [principleId, list] of Object.entries(compiled.antiPatternLists.perPrinciple)) {
    designHits.push(...matchAntiPatterns(text, list, 'design-principle', principleId));
  }
  designHits.push(...matchAntiPatterns(text, compiled.antiPatternLists.voice, 'voice'));
  designHits.push(...matchAntiPatterns(text, compiled.antiPatternLists.visual, 'visual'));

  return {
    product: { hits: productHits },
    design: { hits: designHits },
  };
}

// ── Measurable signal checks ─────────────────────────────────────────

export function checkMeasurableSignals(
  observed: Record<string, number>,
  compiled: CompiledDid,
): MeasurableSignalResult {
  const checks: MeasurableSignalCheck[] = [];
  let coreFailureCount = 0;

  for (const signal of compiled.measurableSignals) {
    const value = observed[signal.metric];
    let status: MeasurableSignalStatus;
    if (value === undefined || Number.isNaN(value)) {
      status = 'missing';
    } else {
      status = evaluateOperator(value, signal.threshold, signal.operator) ? 'pass' : 'fail';
    }

    checks.push({
      id: signal.id,
      metric: signal.metric,
      threshold: signal.threshold,
      operator: signal.operator,
      observedValue: value,
      status,
      identityClass: signal.identityClass,
    });

    if (status === 'fail' && signal.identityClass === 'core') coreFailureCount++;
  }

  return { checks, coreFailureCount };
}

function evaluateOperator(value: number, threshold: number, operator: string): boolean {
  switch (operator) {
    case 'gte':
      return value >= threshold;
    case 'lte':
      return value <= threshold;
    case 'gt':
      return value > threshold;
    case 'lt':
      return value < threshold;
    case 'eq':
      return value === threshold;
    case 'neq':
      return value !== threshold;
    default:
      return false;
  }
}

// ── Orchestrator entry point ─────────────────────────────────────────

export interface Layer1Input {
  issueText: string;
  compiled: CompiledDid;
  depparse: DepparseClient;
  /** Observed metric values keyed by signal metric name. */
  observedMetrics?: Record<string, number>;
}

export async function runLayer1(input: Layer1Input): Promise<DeterministicScoringResult> {
  const { issueText, compiled, depparse, observedMetrics = {} } = input;

  const scopeGate = checkScopeGate(issueText, compiled);
  const constraintViolations = await detectConstraintViolations(issueText, compiled, depparse);
  const { product, design } = detectAntiPatterns(issueText, compiled);
  const measurable = checkMeasurableSignals(observedMetrics, compiled);

  // Count core vs evolving violations across all dimensions.
  let coreViolationCount = 0;
  let evolvingViolationCount = 0;

  const bump = (ic: 'core' | 'evolving') => {
    if (ic === 'core') coreViolationCount++;
    else evolvingViolationCount++;
  };
  for (const hit of scopeGate.outOfScopeHits) bump(hit.identityClass);
  for (const v of constraintViolations.violations) bump(v.identityClass);
  for (const h of product.hits) bump(h.identityClass);
  for (const h of design.hits) bump(h.identityClass);
  coreViolationCount += measurable.coreFailureCount;

  const hardGated = scopeGate.hardGated;

  const preVerifiedSummary = renderPreVerifiedSummary({
    scopeGate,
    constraintViolations,
    product,
    design,
    measurable,
    hardGated,
    coreViolationCount,
    evolvingViolationCount,
  });

  return {
    scopeGate,
    constraintViolations,
    antiPatternHits: product,
    designAntiPatternHits: design,
    measurableSignalChecks: measurable,
    hardGated,
    coreViolationCount,
    evolvingViolationCount,
    preVerifiedSummary,
  };
}

// ── preVerifiedSummary template (§B.6.1) ─────────────────────────────

interface SummaryInput {
  scopeGate: ScopeGateResult;
  constraintViolations: ConstraintViolationResult;
  product: AntiPatternResult;
  design: AntiPatternResult;
  measurable: MeasurableSignalResult;
  hardGated: boolean;
  coreViolationCount: number;
  evolvingViolationCount: number;
}

export function renderPreVerifiedSummary(input: SummaryInput): string {
  const lines: string[] = [];
  lines.push('## Deterministic verification');
  lines.push('');
  lines.push(`- Hard gated: ${input.hardGated ? 'yes' : 'no'}`);
  lines.push(`- Core violations: ${input.coreViolationCount}`);
  lines.push(`- Evolving violations: ${input.evolvingViolationCount}`);
  lines.push('');
  lines.push('### Scope gate');
  if (input.scopeGate.outOfScopeHits.length === 0) {
    lines.push('- No out-of-scope hits');
  } else {
    for (const hit of input.scopeGate.outOfScopeHits) {
      lines.push(
        `- ${hit.identityClass} OUT — "${hit.label}"` +
          (hit.synonym ? ` via "${hit.synonym}"` : ''),
      );
    }
  }
  lines.push('');
  lines.push('### Constraint violations');
  if (input.constraintViolations.violations.length === 0) {
    lines.push('- None detected');
    if (input.constraintViolations.depparseSkipped) {
      lines.push('- (depparse sidecar unavailable — skipped)');
    }
  } else {
    for (const v of input.constraintViolations.violations) {
      lines.push(
        `- ${v.identityClass} ${v.constraintId} (${v.relationship} ${v.concept}) — "${v.matchedText}"` +
          (v.construction ? ` via ${v.construction}` : ''),
      );
    }
  }
  lines.push('');
  lines.push('### Anti-pattern hits');
  const allAntiHits = [...input.product.hits, ...input.design.hits];
  if (allAntiHits.length === 0) {
    lines.push('- None detected');
  } else {
    for (const h of allAntiHits) {
      lines.push(
        `- ${h.identityClass} [${h.scope}${h.principleId ? `:${h.principleId}` : ''}] ${h.label} — "${h.matchedText}"`,
      );
    }
  }
  lines.push('');
  lines.push('### Measurable signals');
  const failures = input.measurable.checks.filter((c) => c.status === 'fail');
  if (failures.length === 0) {
    lines.push('- No failing signals');
  } else {
    for (const c of failures) {
      lines.push(
        `- ${c.identityClass} ${c.id} (${c.metric} ${c.operator} ${c.threshold}) — observed ${c.observedValue ?? 'n/a'}`,
      );
    }
  }
  return lines.join('\n');
}
