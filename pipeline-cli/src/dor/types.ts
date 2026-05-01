/**
 * Definition-of-Ready (DoR) Stage A types.
 *
 * RFC-0011 Phase 2a — deterministic Stage A only. Stage B (LLM) lands
 * in Phase 2b (AISDLC-115.3); for now an issue that passes Stage A is
 * admitted as `ready` (RFC §12 Phase 2a acceptance: "ships standalone").
 *
 * The shapes here mirror the published `refinement-verdict.v1.schema.json`
 * (RFC §9.2) — additive fields only, so the same verdict object can be
 * round-tripped through the schema validator without modification once
 * Stage B starts contributing per-gate verdicts too.
 */

export type GateId = 1 | 2 | 3 | 4 | 5 | 6 | 7;

export type GateVerdict = 'pass' | 'fail' | 'skip';

export type GateConfidence = 'high' | 'medium' | 'low';

export type GateSeverity = 'block' | 'warn';

export type GateStage = 'A' | 'B';

export type OverallVerdict = 'admit' | 'needs-clarification';

/**
 * Input to `evaluateIssue()`. Mirrors RFC §5.1 — the rubric is
 * harness-agnostic; callers normalise from their source format
 * (GitHub issue, backlog task, Forge ticket, Slack thread, ...) into
 * this shared shape before invoking the evaluator.
 */
export interface IssueInput {
  /** Source of the issue (used by ingress shims for fan-out, NOT a rubric input). */
  source: 'github' | 'backlog' | 'forge' | 'slack';
  /** Stable issue identifier (e.g. 'AISDLC-92', 'gh#42', 'forge-1234'). */
  id: string;
  /** Issue title. */
  title: string;
  /** Issue body (markdown). */
  body: string;
  /** Author identity — metric attribution only, NOT a rubric input. */
  authorIdentity?: string;
  /**
   * Optional explicit list of references the caller wants resolved on top
   * of any references the rubric extracts from the body. Useful when the
   * caller has source-specific link metadata (e.g. GitHub `closes #N`
   * cross-link relations) that aren't in the markdown body.
   */
  references?: string[];
  /** Defaults to the current rubric version ('v1'). */
  rubricVersion?: string;
  /**
   * Project root. Used by file-existence resolver to validate
   * `RFC-NNNN` / `AISDLC-NN` style references against the on-disk repo.
   * Defaults to `process.cwd()`.
   */
  workDir?: string;
}

/**
 * Result of evaluating a single gate. The Stage A check returns a
 * partial verdict that the orchestrator combines with Stage B (when
 * Phase 2b lands) to produce the final `RefinementVerdict.gates[]`
 * element.
 */
export interface GateEvaluation {
  gateId: GateId;
  /**
   * Per-gate outcome. 'skip' is currently only used by Stage A for
   * fully-semantic gates (4, 6) where Stage A has nothing to assert
   * — the orchestrator records the skip so Stage B knows it owns the
   * verdict.
   */
  verdict: GateVerdict;
  confidence: GateConfidence;
  severity: GateSeverity;
  /** Which evaluation stage produced this verdict. Always 'A' for Stage A. */
  stage: GateStage;
  /** Human-readable description of why the gate failed. */
  finding?: string;
  /** Single clarifying question for the comment-loop ingress. */
  clarificationQuestion?: string;
}

/**
 * Composite Stage A verdict. Maps onto the
 * `refinement-verdict.v1.schema.json` shape so it can be persisted
 * to the calibration log without further transformation.
 */
export interface StageAVerdict {
  issueId: string;
  rubricVersion: string;
  overallVerdict: OverallVerdict;
  gates: GateEvaluation[];
  signedAt: string;
  evaluatorVersion: string;
  /** Optional aggregate summary line. */
  summary?: string;
  /** Aggregated clarifying questions (deduped, ordered). */
  questions?: string[];
  /** Aggregate confidence. */
  overallConfidence?: GateConfidence;
  /**
   * Wall-clock evaluation latency in ms. Stage A perf budget is <100ms
   * per RFC §12 Phase 2a.
   */
  durationMs: number;
}

/**
 * Resolver registry — RFC §13 Q2 resolution.
 *
 * Each resolver knows ONE reference shape (GitHub issue link, repo file,
 * arbitrary URL) and returns whether the reference resolves to something
 * real. Adding a new ingress (Linear, Forge, ...) is one new resolver —
 * the rubric stays untouched.
 */
export interface Reference {
  /**
   * Raw reference text (e.g. '#42', 'RFC-0011', 'https://example.com',
   * 'orchestrator/src/admission.ts'). Resolvers receive the matched
   * substring; how it was extracted is not their concern.
   */
  raw: string;
  /** Tag indicating which resolver should handle this reference. */
  kind: 'github-issue' | 'file-existence' | 'url' | 'unknown';
}

export interface ResolveResult {
  ref: Reference;
  resolved: boolean;
  /** Optional reason on failure (e.g. 'HTTP 404', 'file not found'). */
  reason?: string;
}

export interface Resolver {
  /** Stable name used in registry lookups + log lines. */
  name: 'github-issue' | 'file-existence' | 'url';
  /** Returns true when this resolver handles the reference shape. */
  supports(ref: Reference): boolean;
  resolve(ref: Reference, opts: ResolverOpts): Promise<ResolveResult>;
}

export interface ResolverOpts {
  /** Project root — file-existence resolver root. */
  workDir: string;
  /**
   * Optional shell runner override — same shape as the pipeline's main
   * `Runner`. Tests inject a fake; production resolvers default to the
   * shared `defaultRunner`.
   */
  runner?: import('../runtime/exec.js').Runner;
  /**
   * Optional fetch override for the URL HEAD resolver. Tests inject a
   * fake; production defaults to the global `fetch`.
   */
  fetchImpl?: typeof fetch;
  /**
   * Per-resolve timeout in ms. Defaults to 5 seconds — the rubric needs
   * to stay under the Stage A 100ms-per-issue budget when local, but
   * remote calls (gh issue view, URL HEAD) get more headroom.
   */
  timeoutMs?: number;
}
