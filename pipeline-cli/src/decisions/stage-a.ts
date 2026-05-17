/**
 * RFC-0035 Phase 2 — Stage A deterministic scorer.
 *
 * Implements the §5.1 deterministic evaluation ladder:
 *
 * 1. Schema validity — JSON-schema + structural checks
 * 2. Blast radius — RFC-0014 dep-graph traversal (`blockedTaskCount`,
 *    `blockedRfcCount`, `affectedPillars[]`) — AC#2
 * 3. Reference resolution — scope + dependsOn refs resolved against graph
 * 4. Decision-tree depth — static analysis of declared `subDecisions[]`
 * 5. Capacity arithmetic — proposed actor vs remaining daily budget
 * 6. Reversibility — pattern-match against tagged-irreversible categories
 * 7. Duplicate detection — Levenshtein + normalized-summary
 *
 * Produces a `StageAOutput` with a deterministic priority signal in [0,1]
 * and an unambiguous routing actor when one exists.
 *
 * AC#3: decisions with all-deterministic inputs (reversibility not `unknown`,
 * schema valid, references resolved) have `resolvedByStageA: true` — no
 * Stage B/C LLM call needed for them.
 *
 * AC#5: composes with RFC-0014 substrate by importing `DependencyGraph` and
 * `computeEffectivePriorities` directly — no graph code duplication.
 *
 * @module decisions/stage-a
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { DependencyGraph } from '../deps/dependency-graph.js';
import { buildDependencyGraph, impact as graphImpact } from '../deps/dependency-graph.js';
import { computeEffectivePriorities } from '../deps/effective-priority.js';

import type {
  Decision,
  DecisionOption,
  StageABlastRadius,
  StageADuplicateCheck,
  StageAOutput,
} from './decision-record.js';

// ── Irreversibility patterns (§5.1 reversibility check) ─────────────────────

/**
 * Keyword patterns that indicate a decision is irreversible (one-way).
 * Pattern-matched against decision summary + body (lowercased). Mirroring
 * RFC-0035 §5.1 "tagged-irreversible categories".
 */
export const IRREVERSIBLE_PATTERNS: readonly string[] = [
  'db-migration',
  'database migration',
  'public-api',
  'public api',
  'merge-conflict-resolution',
  'merge conflict resolution',
  'schema-breaking',
  'breaking change',
  'data migration',
  'rename and delete',
  'delete all',
  'hard delete',
  'irreversible',
  'one-way',
];

// ── Pillar tags (§6.1 — reusing RFC-0029 pillar model) ──────────────────────

const ENGINEERING_KEYWORDS = [
  'architecture',
  'implementation',
  'typescript',
  'algorithm',
  'performance',
  'infrastructure',
  'database',
  'api',
  'schema',
  'backend',
  'frontend',
  'pipeline',
  'cli',
  'test',
  'code',
  'deploy',
  'build',
  'ci',
  'cd',
  'library',
];

const PRODUCT_KEYWORDS = [
  'strategy',
  'scope',
  'priority',
  'roadmap',
  'feature',
  'user story',
  'backlog',
  'sprint',
  'milestone',
  'product',
  'audience',
  'market',
];

const DESIGN_KEYWORDS = [
  'ux',
  'ui',
  'user experience',
  'visual',
  'design',
  'interaction',
  'accessibility',
  'component',
  'layout',
  'theme',
  'style',
  'color',
];

// ── Capacity defaults (§7.1 — RFC-0016 t-shirt size mapping) ─────────────────

export interface CapacityConfig {
  xs: { perDay: number };
  s: { perDay: number };
  m: { perDay: number };
  l: { perDay: number };
  xl: { perDay: number };
}

export const DEFAULT_CAPACITY_CONFIG: CapacityConfig = {
  xs: { perDay: 30 },
  s: { perDay: 15 },
  m: { perDay: 6 },
  l: { perDay: 2 },
  xl: { perDay: 1 },
};

// ── Stage A input ─────────────────────────────────────────────────────────────

export interface StageAInput {
  /** The decision being evaluated. */
  decision: Decision;
  /**
   * All currently open decisions — used for duplicate detection.
   * Does not need to include the target decision itself.
   */
  openDecisions?: Decision[];
  /**
   * RFC-0014 dependency graph — used for blast-radius computation (AC#2).
   * If not provided and `workDir` is given, the graph is built from disk.
   * If neither is provided, blast-radius defaults to zeros.
   */
  graph?: DependencyGraph;
  /**
   * Project root directory. Used to build the dep-graph when `graph` is
   * absent, and to scan backlog tasks for `DEC-NNNN` references.
   */
  workDir?: string;
  /** Capacity configuration (defaults to RFC-0016 t-shirt size defaults). */
  capacityConfig?: CapacityConfig;
  /**
   * How many decisions of each tier have already been decided today (actor's
   * current usage). Used for capacity arithmetic. Defaults to all-zero.
   */
  todayUsage?: Partial<Record<string, number>>;
}

// ── Levenshtein + normalisation (§5.1 duplicate detection) ──────────────────

/**
 * Normalise a decision summary for duplicate detection: lowercase, strip
 * punctuation, collapse whitespace. Mirrors the "normalized-summary" phrasing
 * in §5.1.
 */
export function normaliseSummary(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Iterative Levenshtein distance. Returns the edit distance between `a` and
 * `b` (number of single-character insertions / deletions / substitutions).
 * O(|a|×|b|) time, O(min(|a|,|b|)) space.
 */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  // Keep shorter string in the inner loop.
  if (a.length > b.length) return levenshtein(b, a);
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  const curr = new Array<number>(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j];
  }
  return prev[b.length];
}

/**
 * Normalised similarity score [0,1] where 1 = identical strings.
 *
 *   similarity = 1 - (editDistance / maxLength)
 *
 * Returns 0 for empty strings.
 */
export function normalisedSimilarity(a: string, b: string): number {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 0;
  return 1 - levenshtein(a, b) / maxLen;
}

// ── Stage A sub-checks ────────────────────────────────────────────────────────

/**
 * 1. Schema validity — structural checks on the projected Decision.
 *
 * Phase 2 performs structural (non-JSON-schema-library) validation so the
 * scorer has no hard dep on Ajv (which is a dev/test dep only). The
 * spec/schemas/decision.v1.schema.json remains the authoritative schema;
 * these structural checks mirror its key constraints.
 */
export function checkSchemaValidity(decision: Decision): { valid: boolean; reasons: string[] } {
  const reasons: string[] = [];

  if (!decision.metadata?.id || !/^DEC-\d{4,}$/.test(decision.metadata.id)) {
    reasons.push('metadata.id: must match DEC-NNNN');
  }
  if (!decision.metadata?.source) reasons.push('metadata.source: required');
  if (!decision.metadata?.scope) reasons.push('metadata.scope: required');
  if (!decision.spec?.summary) reasons.push('spec.summary: required');
  if (!Array.isArray(decision.spec?.options) || decision.spec.options.length === 0) {
    reasons.push('spec.options: must be a non-empty array');
  }
  if (!decision.status?.lifecycle) reasons.push('status.lifecycle: required');

  for (const opt of decision.spec?.options ?? []) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test((opt as DecisionOption).id ?? '')) {
      reasons.push(`option.id "${(opt as DecisionOption).id}": must be a lowercase slug`);
    }
    if (!(opt as DecisionOption).description) {
      reasons.push(`option.id "${(opt as DecisionOption).id}": description required`);
    }
  }

  return { valid: reasons.length === 0, reasons };
}

/**
 * Scan backlog task files for `DEC-NNNN` references in frontmatter or body.
 * Returns the set of decision IDs referenced. Used for blast-radius without
 * duplicating the full dep-graph parsing logic (AC#5 — compose, don't copy).
 */
function scanBacklogForDecisionRef(decisionId: string, workDir: string): string[] {
  const dirs = [join(workDir, 'backlog', 'tasks'), join(workDir, 'backlog', 'completed')];
  const referencingFiles: string[] = [];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (!name.endsWith('.md')) continue;
      try {
        const raw = readFileSync(join(dir, name), 'utf8');
        if (raw.includes(decisionId)) {
          referencingFiles.push(join(dir, name));
        }
      } catch {
        // tolerate read failures
      }
    }
  }
  return referencingFiles;
}

/**
 * Extract task ID from a scope string like `issue:AISDLC-285`.
 * Returns null if the scope doesn't reference a task.
 */
function scopeToTaskId(scope: string): string | null {
  const m = scope.match(/^issue:([A-Za-z0-9._-]+)$/i);
  return m ? m[1] : null;
}

/**
 * Extract RFC ID from a scope string like `rfc:RFC-0035`.
 * Returns null if the scope doesn't reference an RFC.
 */
function scopeToRfcId(scope: string): string | null {
  const m = scope.match(/^rfc:(RFC-\d+)$/i);
  return m ? m[1] : null;
}

/**
 * Derive affected pillars from the decision text (summary + body + option descriptions).
 * Maps to the RFC-0029 three-pillar model: engineering / product / design.
 */
export function deriveAffectedPillars(decision: Decision): string[] {
  const text = [
    decision.spec.summary,
    decision.spec.body ?? '',
    ...(decision.spec.options ?? []).map((o) => o.description),
  ]
    .join(' ')
    .toLowerCase();

  const pillars = new Set<string>();
  if (ENGINEERING_KEYWORDS.some((k) => text.includes(k))) pillars.add('engineering');
  if (PRODUCT_KEYWORDS.some((k) => text.includes(k))) pillars.add('product');
  if (DESIGN_KEYWORDS.some((k) => text.includes(k))) pillars.add('design');
  // Default: if no keywords matched, tag as engineering (the most common pillar
  // for framework decisions — safe conservative default).
  if (pillars.size === 0) pillars.add('engineering');
  return [...pillars].sort();
}

/**
 * 2. Blast radius — RFC-0014 dep-graph traversal (AC#2).
 *
 * Counts:
 *   - `blockedTaskCount` — open backlog tasks whose text references this
 *     decision ID. When a dep-graph is provided AND the scope references a
 *     task (e.g. `issue:AISDLC-285`), also counts tasks in the `impact()`
 *     closure — i.e. tasks that will become unblocked once the decision is
 *     answered and the scoped task resumes.
 *   - `blockedRfcCount` — incremented by 1 when scope is `rfc:...`.
 *   - `affectedPillars` — derived from decision text via keyword matching.
 */
export function computeBlastRadius(
  decision: Decision,
  graph?: DependencyGraph,
  workDir?: string,
): StageABlastRadius {
  const decisionId = decision.metadata.id;

  // Count open tasks that reference this decision by ID
  let blockedTaskCount = 0;
  let blockedRfcCount = 0;

  if (workDir) {
    const refs = scanBacklogForDecisionRef(decisionId, workDir);
    // Only count open tasks (from backlog/tasks/) as truly blocked
    blockedTaskCount = refs.filter((p) => p.includes('/backlog/tasks/')).length;
  }

  // If the scope references a task and we have a dep-graph, add the impact
  // closure (tasks that depend on the scoped task and would benefit from
  // this decision being resolved). Uses RFC-0014 `impact()` — AC#5 compose.
  if (graph) {
    const taskId = scopeToTaskId(decision.metadata.scope);
    if (taskId) {
      const impacted = graphImpact(graph, taskId);
      const openImpacted = impacted.filter((n) => n.status === 'open').length;
      blockedTaskCount += openImpacted;
    }

    // Also factor in effective priority of the scoped task for load-bearing
    // score computation later.
    const taskId2 = scopeToTaskId(decision.metadata.scope);
    if (taskId2) {
      const ep = computeEffectivePriorities(graph);
      const rec = ep.get(taskId2.toLowerCase());
      if (rec) {
        // Use the effective priority weight to inflate the blocked count signal
        // per OQ-2: `loadBearing = max(taskPriority(t)) + log(blockedTaskCount)`.
        // We keep blockedTaskCount as a plain count here; the priority weight is
        // folded into the priority signal at the aggregation step.
        void rec; // referenced for the log formula in computePrioritySignal
      }
    }
  }

  // RFC scope increments blockedRfcCount
  const rfcId = scopeToRfcId(decision.metadata.scope);
  if (rfcId) blockedRfcCount = 1;

  const affectedPillars = deriveAffectedPillars(decision);

  return { blockedTaskCount, blockedRfcCount, affectedPillars };
}

/**
 * 3. Reference resolution — verify scope and dependsOn IDs exist.
 *
 * For `issue:AISDLC-NNN` scopes: check the dep-graph (or assume resolved
 * when no graph is provided, degrading gracefully).
 * For `DEC-NNNN` in `dependsOn[]`: check the open-decisions list.
 * `rfc:RFC-NNNN` and `workspace` scopes are assumed resolved (no runtime
 * lookup without a network call).
 */
export function checkReferenceResolution(
  decision: Decision,
  graph?: DependencyGraph,
  openDecisions?: Decision[],
): { resolved: boolean; broken: string[] } {
  const broken: string[] = [];

  // Scope reference
  const taskId = scopeToTaskId(decision.metadata.scope);
  if (taskId && graph) {
    if (!graph.nodes.has(taskId.toLowerCase())) {
      broken.push(`scope task not in graph: ${taskId}`);
    }
  }

  // dependsOn — decision IDs
  for (const depId of decision.spec.dependsOn ?? []) {
    if (/^DEC-\d{4,}$/.test(depId)) {
      const found = openDecisions?.some((d) => d.metadata.id === depId) ?? false;
      if (!found) {
        broken.push(`dependsOn decision not found: ${depId}`);
      }
    }
  }

  return { resolved: broken.length === 0, broken };
}

/**
 * 4. Decision-tree depth — count sub-decisions recursively.
 *
 * Phase 2: depth = max number of `subDecisions[]` entries across all
 * options (direct children only — Phase 3 adds recursive tree walking).
 * Returns 0 when no options have subDecisions.
 */
export function measureDecisionTreeDepth(decision: Decision): number {
  let max = 0;
  for (const opt of decision.spec.options ?? []) {
    const count = opt.subDecisions?.length ?? 0;
    if (count > max) max = count;
  }
  return max;
}

/**
 * 5. Capacity arithmetic — proposed actor vs remaining daily budget.
 *
 * Uses RFC-0016 t-shirt sizing (OQ-6 resolution). If the decision has a
 * capacity tier set, checks whether the actor has budget for that tier.
 * Degrades gracefully when no tier or actor is set (returns withinBudget:
 * true with an advisory reason).
 */
export function checkCapacityArithmetic(
  decision: Decision,
  config?: CapacityConfig,
  todayUsage?: Partial<Record<string, number>>,
): { withinBudget: boolean; reason: string } {
  const tier = decision.status?.capacity?.tier;
  if (!tier) {
    return { withinBudget: true, reason: 'no tier assigned — capacity check deferred to Stage B' };
  }
  const cfg = config ?? DEFAULT_CAPACITY_CONFIG;
  const limit = cfg[tier]?.perDay ?? Infinity;
  const used = todayUsage?.[tier] ?? 0;
  if (used < limit) {
    return { withinBudget: true, reason: `tier:${tier} — ${used}/${limit} used today` };
  }
  return {
    withinBudget: false,
    reason: `tier:${tier} budget exhausted — ${used}/${limit} decisions made today`,
  };
}

/**
 * 6. Reversibility — pattern-match against tagged-irreversible categories.
 *
 * Per RFC §5.1: if `decision.spec.reversible` is explicitly set, use it.
 * Otherwise, pattern-match the summary + body against `IRREVERSIBLE_PATTERNS`.
 * If a pattern matches → `one-way`. If no patterns match → `unknown` (LLM
 * needed for novel categories — per Stage B §5.2 "reversibility may need
 * LLM for novel categories").
 */
export function assessReversibility(decision: Decision): 'reversible' | 'one-way' | 'unknown' {
  // Explicit field always wins.
  if (decision.spec.reversible === true) return 'reversible';
  if (decision.spec.reversible === false) return 'one-way';

  // Pattern-match against known irreversible categories.
  const text = [decision.spec.summary, decision.spec.body ?? ''].join(' ').toLowerCase();
  if (IRREVERSIBLE_PATTERNS.some((p) => text.includes(p))) return 'one-way';

  // Can't determine without LLM — Stage B will handle.
  return 'unknown';
}

/**
 * 7. Duplicate detection — Levenshtein + normalized-summary (§5.1).
 *
 * Compares the decision's normalised summary against all open decisions.
 * Returns the closest match (or unique when no match exceeds the threshold).
 */
export function detectDuplicates(
  decision: Decision,
  openDecisions: Decision[],
  similarityThreshold = 0.85,
): StageADuplicateCheck {
  const targetNorm = normaliseSummary(decision.spec.summary);
  let bestSimilarity = 0;
  let bestId: string | null = null;

  for (const other of openDecisions) {
    if (other.metadata.id === decision.metadata.id) continue;
    const otherNorm = normaliseSummary(other.spec.summary);
    const sim = normalisedSimilarity(targetNorm, otherNorm);
    if (sim > bestSimilarity) {
      bestSimilarity = sim;
      bestId = other.metadata.id;
    }
  }

  const isDuplicate = bestSimilarity >= similarityThreshold;
  return {
    isDuplicate,
    candidateId: isDuplicate ? bestId : null,
    similarity: Math.round(bestSimilarity * 1000) / 1000,
  };
}

// ── Priority signal aggregation ───────────────────────────────────────────────

/**
 * Compute the composite priority signal [0,1] from Stage A sub-checks.
 *
 * Per OQ-2 resolution: `loadBearing = max(taskPriority(t)) + log(blockedTaskCount)`.
 * We normalise this to [0,1] by capping at a realistic maximum then mapping
 * linearly. The four contributing dimensions and their weights:
 *
 *   blastRadius    40% — `log1p(blockedTaskCount) / log1p(20)` (normalized)
 *   reversibility  25% — one-way=1.0, unknown=0.5, reversible=0.0
 *   treeDepth      20% — `min(depth/5, 1.0)`
 *   capacity       15% — !withinBudget → 0.8, withinBudget → 0.3
 *
 * Additionally we incorporate the scope-task effective priority (via RFC-0014)
 * when available: `priorityWeight / 4` (normalized from [1,4]).
 */
export function computePrioritySignal(
  blastRadius: StageABlastRadius,
  reversibility: 'reversible' | 'one-way' | 'unknown',
  treeDepth: number,
  capacityCheck: { withinBudget: boolean },
  scopeTaskPriorityWeight?: number,
): number {
  // Blast radius score — log-diminishing returns per OQ-2
  const blastScore = Math.min(Math.log1p(blastRadius.blockedTaskCount) / Math.log1p(20), 1.0);

  const reversibilityScore =
    reversibility === 'one-way' ? 1.0 : reversibility === 'unknown' ? 0.5 : 0.0;

  const depthScore = Math.min(treeDepth / 5, 1.0);

  const capacityScore = capacityCheck.withinBudget ? 0.3 : 0.8;

  // Base composite
  let signal =
    blastScore * 0.4 + reversibilityScore * 0.25 + depthScore * 0.2 + capacityScore * 0.15;

  // RFC-0014 effective-priority uplift (max 20% additional weight)
  if (scopeTaskPriorityWeight !== undefined) {
    const priorityNorm = scopeTaskPriorityWeight / 4; // [1,4] → [0.25,1.0]
    signal = signal * 0.8 + priorityNorm * 0.2;
  }

  return Math.max(0, Math.min(1, Math.round(signal * 1000) / 1000));
}

// ── resolvedByStageA determination ───────────────────────────────────────────

/**
 * AC#3 — a decision is resolved by Stage A alone (no Stage B/C call needed)
 * when ALL of:
 *
 *   a) Schema is valid — malformed decisions can't be reliably scored.
 *   b) Reversibility is NOT `unknown` — novel categories need LLM (Stage B).
 *   c) References are resolved — broken refs would produce incorrect blast-radius.
 *   d) Not a duplicate — suspected duplicates should be de-duplicated before
 *      routing (otherwise both decisions absorb operator attention).
 *
 * When these conditions hold, Stage A can deterministically compute the
 * priority signal and routing actor without any LLM call.
 */
export function isResolvedByStageA(
  schemaValidity: { valid: boolean },
  reversibility: 'reversible' | 'one-way' | 'unknown',
  referenceResolution: { resolved: boolean },
  duplicateDetection: StageADuplicateCheck,
): boolean {
  return (
    schemaValidity.valid &&
    reversibility !== 'unknown' &&
    referenceResolution.resolved &&
    !duplicateDetection.isDuplicate
  );
}

/**
 * Determine the routing actor from Stage A alone.
 *
 * Routing is unambiguous when (per §6.2):
 *   - Decision is LLM-eligible (reversible + low blast-radius ≤ 2 tasks) →
 *     routing = 'framework' (auto-decide, operator sees in digest)
 *   - Decision already has an explicit `routing.assignedActor` →
 *     keep as-is (Stage A confirms it rather than overwriting)
 *   - Decision touches a single pillar → that pillar (engineering / product /
 *     design) — routing to pillar owner is a Stage 3 concern; Stage A tags
 *     the pillar but leaves the email lookup to config.
 *
 * Returns null when routing can't be determined without Stage B.
 */
export function determineRoutingActor(
  decision: Decision,
  reversibility: 'reversible' | 'one-way' | 'unknown',
  blastRadius: StageABlastRadius,
  resolvedByStageA: boolean,
): string | null {
  if (!resolvedByStageA) return null;

  // Explicit actor from the event log takes precedence.
  const existingActor = decision.status?.routing?.assignedActor;
  if (existingActor) return existingActor;

  // Multi-pillar → operator (cross-pillar per §6.2). This check must come
  // BEFORE the LLM-eligible check because a multi-pillar reversible decision
  // still routes to the operator, not the framework.
  if (blastRadius.affectedPillars.length > 1) {
    return 'operator';
  }

  // LLM-eligible: reversible + low blast-radius → framework auto-decides.
  if (reversibility === 'reversible' && blastRadius.blockedTaskCount <= 2) {
    return 'framework';
  }

  // Single-pillar: tag with the pillar (Stage 3 resolves to email).
  if (blastRadius.affectedPillars.length === 1) {
    return `pillar:${blastRadius.affectedPillars[0]}`;
  }

  return null;
}

// ── Main entry point ──────────────────────────────────────────────────────────

/**
 * Run Stage A scoring on a decision.
 *
 * This is a pure-ish function: it reads the dep-graph from disk when
 * `graph` is not provided and `workDir` is set, but it never writes
 * anything. The caller is responsible for emitting a
 * `recommendation-issued` event if they want to persist the result.
 */
export function runStageA(input: StageAInput): StageAOutput {
  const { decision, openDecisions = [], capacityConfig, todayUsage } = input;

  // Resolve graph lazily — build from disk only if needed and not provided.
  let graph = input.graph;
  if (!graph && input.workDir) {
    try {
      graph = buildDependencyGraph({ workDir: input.workDir });
    } catch {
      // Dep-graph unavailable — blast-radius degrades to zero counts.
    }
  }

  // ── Sub-checks ────────────────────────────────────────────────────────────

  const schemaValidity = checkSchemaValidity(decision);

  const blastRadius = computeBlastRadius(decision, graph, input.workDir);

  const referenceResolution = checkReferenceResolution(decision, graph, openDecisions);

  const decisionTreeDepth = measureDecisionTreeDepth(decision);

  const capacityCheck = checkCapacityArithmetic(decision, capacityConfig, todayUsage);

  const reversibility = assessReversibility(decision);

  const duplicateDetection = detectDuplicates(decision, openDecisions);

  // ── RFC-0014 effective-priority uplift ────────────────────────────────────

  let scopeTaskPriorityWeight: number | undefined;
  if (graph) {
    const taskId = scopeToTaskId(decision.metadata.scope);
    if (taskId) {
      const ep = computeEffectivePriorities(graph);
      const rec = ep.get(taskId.toLowerCase());
      if (rec) {
        scopeTaskPriorityWeight = rec.effectivePriority;
      }
    }
  }

  // ── Aggregate ─────────────────────────────────────────────────────────────

  const prioritySignal = computePrioritySignal(
    blastRadius,
    reversibility,
    decisionTreeDepth,
    capacityCheck,
    scopeTaskPriorityWeight,
  );

  const resolvedByStageA = isResolvedByStageA(
    schemaValidity,
    reversibility,
    referenceResolution,
    duplicateDetection,
  );

  const routingActor = determineRoutingActor(
    decision,
    reversibility,
    blastRadius,
    resolvedByStageA,
  );

  return {
    schemaValidity,
    blastRadius,
    referenceResolution,
    decisionTreeDepth,
    capacityCheck,
    reversibility,
    duplicateDetection,
    prioritySignal,
    resolvedByStageA,
    routingActor,
  };
}

// ── Coverage metric (AC#6) ────────────────────────────────────────────────────

export const STAGE_A_COVERAGE_TARGET = 0.4;

export interface StageACoverage {
  /** Total open decisions in the catalog. */
  totalDecisions: number;
  /** Decisions resolved by Stage A alone (no Stage B/C needed). */
  resolvedByStageA: number;
  /** Coverage rate [0,1] = resolvedByStageA / totalDecisions. */
  coverageRate: number;
  /** Whether the coverage meets the ≥40% target from AC#6. */
  meetsTarget: boolean;
}

/**
 * Compute Stage A coverage across a set of decisions.
 *
 * Each decision is either:
 *   - already scored (has `status.evaluation.stageA` from a prior
 *     `recommendation-issued` event), in which case the stored
 *     `resolvedByStageA` field is used directly; or
 *   - unscored (no prior Stage A run), in which case `runStageA` is called
 *     in-memory with the provided graph/workDir context.
 *
 * This means coverage is computed against the *potential* of the current
 * catalog — running `score-a` on every decision would achieve this rate.
 *
 * AC#6: target ≥40% (STAGE_A_COVERAGE_TARGET = 0.4).
 */
export function computeStageACoverage(
  decisions: Decision[],
  opts: { graph?: DependencyGraph; workDir?: string } = {},
): StageACoverage {
  const total = decisions.length;
  if (total === 0) {
    return { totalDecisions: 0, resolvedByStageA: 0, coverageRate: 0, meetsTarget: false };
  }

  let resolved = 0;
  for (const d of decisions) {
    // Use stored result if already scored.
    const stored = (d.status.evaluation as Record<string, unknown> | undefined)?.stageA as
      | { resolvedByStageA?: boolean }
      | undefined;
    if (stored?.resolvedByStageA !== undefined) {
      if (stored.resolvedByStageA) resolved++;
      continue;
    }

    // Score in-memory.
    const result = runStageA({ decision: d, openDecisions: decisions, ...opts });
    if (result.resolvedByStageA) resolved++;
  }

  const coverageRate = Math.round((resolved / total) * 1000) / 1000;
  return {
    totalDecisions: total,
    resolvedByStageA: resolved,
    coverageRate,
    meetsTarget: coverageRate >= STAGE_A_COVERAGE_TARGET,
  };
}

// ── Event factory (for emitting recommendation-issued) ───────────────────────

export interface MakeRecommendationIssuedEventInput {
  decisionId: string;
  stageAOutput: StageAOutput;
  by?: string;
  now?: Date;
}

/**
 * Build a well-formed `recommendation-issued` event from Stage A output.
 * The caller passes this to `appendDecisionEvent` to persist the result.
 */
export function makeRecommendationIssuedEvent(
  input: MakeRecommendationIssuedEventInput,
): import('./decision-record.js').RecommendationIssuedEvent {
  const ts = (input.now ?? new Date()).toISOString();
  const routing = input.stageAOutput.routingActor
    ? { assignedActor: input.stageAOutput.routingActor }
    : undefined;
  const evt: import('./decision-record.js').RecommendationIssuedEvent = {
    eventVersion: 'v1' as const,
    type: 'recommendation-issued' as const,
    ts,
    decisionId: input.decisionId,
    stageA: input.stageAOutput,
    prioritySignal: input.stageAOutput.prioritySignal,
    resolvedByStageA: input.stageAOutput.resolvedByStageA,
  };
  if (routing !== undefined) evt.routing = routing;
  if (input.by !== undefined) evt.by = input.by;
  return evt;
}
