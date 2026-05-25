/**
 * RFC-0024 Refit Phase 5 — DoR-clarification → emergent-capture integration
 * (AISDLC-277 / OQ-11).
 *
 * When an operator answers a DoR Stage B clarification question, their
 * answer may reveal a NEW concern (not just a clarification of the
 * existing question). Per the 2026-05-15 OQ-11 resolution, this module
 * reuses the Phase 2 shared classifier substrate on each segment of the
 * operator's answer with task type `dor-answer-is-new-concern`. Segments
 * classified as `new-concern` above the substrate threshold are
 * proposed as emergent capture records that reference the DoR thread.
 *
 * **Design contract** (per OQ-11):
 *   1. RFC-0011's rubric + admission semantics stay unchanged. This module
 *      runs as a SIDE-EFFECT of processing the operator's clarification
 *      response. No new gate, no admission impact.
 *   2. Each segment is classified independently. A multi-segment answer
 *      can produce N captures + the remaining clarification text.
 *   3. The operator confirms in the TUI before captures commit. This
 *      module returns a `CaptureProposal[]` plus the classifier decisions
 *      (so the TUI can show "AI suggested with confidence X"); the
 *      caller (TUI / interactive CLI) collects confirmation and then
 *      calls `commitDorAnswerCaptures()` to actually write the records.
 *   4. Capture records carry `blocksIssueId` pointing at the DoR thread's
 *      issue id (so RFC-0024 §9.3's pre-dispatch filter can keep the
 *      thread in `Needs Clarification` until the captures are triaged).
 *   5. The fall-open default is the same as the substrate: low-confidence
 *      / ambiguous / classifier-failure segments stay as part of the
 *      clarification answer — they are NOT auto-extracted. The operator
 *      always sees them in the answer surface.
 *
 * **Threshold semantics**: only segments where the classifier returns
 * `classification: 'new-concern'` AND `metBehindThreshold === true` are
 * proposed as captures. `ambiguous` and `clarification` segments are
 * always left in the answer. Low-confidence `new-concern` segments
 * surface in the proposal as `requiresConfirmation: true` so the TUI
 * can show "AI thinks this is a new concern but is not sure; confirm?"
 * — they do not auto-extract until operator confirms.
 *
 * @module dor/dor-answer-capture
 */

import {
  classify,
  type ClassifierDecision,
  type ClassifyOpts,
  type LlmInvoker,
} from '../classifier/substrate/index.js';
import { writeCapture, type CaptureRecord } from '../capture/index.js';

// ── Segmentation ──────────────────────────────────────────────────────────────

/**
 * Segment a free-text operator answer into individually-classifiable
 * units. The classifier prompt's contract is "evaluate ONE segment of an
 * operator's answer" — feeding it a multi-paragraph blob would coalesce
 * separate concerns into a single classification, defeating OQ-11's
 * "multi-segment answers can split capture from clarification".
 *
 * The segmenter is intentionally rule-based (not LLM-driven) to keep
 * cost bounded: an operator answer is typically 1-6 paragraphs / bullets;
 * one LLM call per segment is cheap, but adding an LLM call to discover
 * the segments would double cost for no calibration benefit. The rules:
 *
 *   1. Blank-line-separated paragraphs become segments (most common
 *      structure: operator types `paragraph\n\nparagraph`).
 *   2. Inside a paragraph, lines that start with a bullet marker (`-`,
 *      `*`, `1.`, `2.`, ...) each become their own segment.
 *   3. A paragraph with no bullets is one segment.
 *   4. Whitespace-only segments are dropped.
 *
 * Trailing/leading whitespace on each segment is trimmed so the prompt
 * sees clean text. Segment order is preserved so the caller can stitch
 * the un-extracted segments back together as the residual clarification.
 *
 * @param answer The raw operator answer string.
 * @returns Array of trimmed segment strings (may be empty).
 */
export function segmentDorAnswer(answer: string): string[] {
  if (typeof answer !== 'string') return [];
  const trimmed = answer.trim();
  if (trimmed.length === 0) return [];

  const segments: string[] = [];
  // Split on blank lines (>=1 empty line).
  const paragraphs = trimmed.split(/\n\s*\n/);
  for (const paragraph of paragraphs) {
    const para = paragraph.trim();
    if (para.length === 0) continue;

    // Detect bullet structure: every non-blank line starts with a bullet
    // marker. If so, each line is its own segment.
    const lines = para
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    const bulletLines = lines.filter(isBulletLine);
    if (bulletLines.length === lines.length && lines.length > 1) {
      for (const line of bulletLines) {
        segments.push(stripBulletMarker(line));
      }
    } else {
      segments.push(para);
    }
  }
  return segments;
}

function isBulletLine(line: string): boolean {
  return /^(?:[-*+•]|\d+[.)])\s+/.test(line);
}

function stripBulletMarker(line: string): string {
  return line.replace(/^(?:[-*+•]|\d+[.)])\s+/, '').trim();
}

// ── Per-segment classifier wrapper ────────────────────────────────────────────

/**
 * One segment + its classifier decision. The caller can use the decision
 * fields directly (`classification`, `confidence`, `reasoning`,
 * `metBehindThreshold`) to render TUI rationale tooltips.
 */
export interface ClassifiedDorAnswerSegment {
  /** The trimmed segment text the classifier saw. */
  segment: string;
  /** Substrate decision — see `ClassifierDecision`. */
  decision: ClassifierDecision;
}

export interface ClassifyDorAnswerSegmentsOpts {
  /** Substrate LLM invoker — required (use FakeLlmInvoker in tests). */
  invoker: LlmInvoker;
  /** Optional per-call threshold override. Default: substrate config (0.7). */
  threshold?: number;
  /** Optional model override. Default: substrate config. */
  model?: string;
  /** Project root (for substrate config + corpus). Default: process.cwd(). */
  repoRoot?: string;
  /** Corpus dir override (tests). */
  corpusDir?: string;
  /**
   * Optional context the substrate prompt may include (DoR question text,
   * gate id, issue title). Mirrors `ClassifierInput.context`.
   */
  context?: Record<string, unknown>;
  /**
   * When true, do NOT append calibration corpus entries (e.g. TUI dry-run
   * preview). Default: false (corpus capture is on).
   */
  skipCorpus?: boolean;
}

/**
 * Classify each segment of a DoR operator answer via the shared
 * substrate. Returns the per-segment decisions in input order.
 *
 * The substrate's `classify()` never throws — invoker errors / parse
 * failures return a `pending` sentinel decision with confidence 0. This
 * function inherits that contract: a classifier outage means every
 * segment stays in the clarification answer (the fall-open default).
 */
export async function classifyDorAnswerSegments(
  segments: readonly string[],
  opts: ClassifyDorAnswerSegmentsOpts,
): Promise<ClassifiedDorAnswerSegment[]> {
  const out: ClassifiedDorAnswerSegment[] = [];
  for (const segment of segments) {
    const classifyOpts: ClassifyOpts = {
      invoker: opts.invoker,
      ...(opts.threshold !== undefined ? { threshold: opts.threshold } : {}),
      ...(opts.model !== undefined ? { model: opts.model } : {}),
      ...(opts.repoRoot !== undefined ? { repoRoot: opts.repoRoot } : {}),
      ...(opts.corpusDir !== undefined ? { corpusDir: opts.corpusDir } : {}),
      ...(opts.skipCorpus !== undefined ? { skipCorpus: opts.skipCorpus } : {}),
    };
    const decision = await classify(
      { text: segment, ...(opts.context !== undefined ? { context: opts.context } : {}) },
      'dor-answer-is-new-concern',
      classifyOpts,
    );
    out.push({ segment, decision });
  }
  return out;
}

// ── Proposal builder ──────────────────────────────────────────────────────────

/**
 * A single proposed capture (pre-confirmation). The TUI surfaces this to
 * the operator with the classifier rationale; confirmed proposals flow
 * through `commitDorAnswerCaptures()`.
 */
export interface CaptureProposal {
  /** The original segment text — becomes the capture's `finding`. */
  finding: string;
  /** The classifier decision for transparency / TUI rationale. */
  decision: ClassifierDecision;
  /**
   * True when `decision.classification === 'new-concern'` AND
   * `decision.metBehindThreshold === true`. Such proposals MAY be
   * auto-confirmed by the TUI's "AI auto-classified this" path; the
   * operator can still override.
   */
  aboveThreshold: boolean;
  /** Substrate corpus-entry id (for operator-override recording). */
  corpusEntryId: string | null;
}

/**
 * The shape returned to the caller (TUI / interactive CLI). Splits the
 * operator's answer into:
 *   - `captureProposals` — segments the classifier flagged as `new-concern`
 *     above threshold. The operator confirms; confirmed proposals are
 *     written via `commitDorAnswerCaptures()`.
 *   - `clarificationSegments` — segments that stay as part of the answer
 *     (classification = `clarification` OR `ambiguous` OR low-confidence
 *     `new-concern` OR classifier-failure sentinels).
 *   - `classifierResults` — per-segment decisions in input order, so the
 *     TUI can render full classifier rationale for every segment (not
 *     just the proposed captures).
 */
export interface DorAnswerProposalResult {
  /** Segments to propose as captures (operator confirms in TUI). */
  captureProposals: CaptureProposal[];
  /**
   * Segments to keep as part of the operator's clarification answer.
   * The caller stitches these back into a residual answer string.
   */
  clarificationSegments: string[];
  /**
   * All per-segment classifier results in input order (super-set of
   * `captureProposals.decision`). Surfaced so the TUI can show classifier
   * reasoning for every segment, including the `clarification` /
   * `ambiguous` ones the operator didn't have to triage.
   */
  classifierResults: ClassifiedDorAnswerSegment[];
}

export interface ProposeCapturesOpts extends ClassifyDorAnswerSegmentsOpts {
  /** The DoR thread's issue id — populates `blocksIssueId` on proposals. */
  dorThreadIssueId: string;
}

/**
 * High-level entry point: take a DoR thread context + operator answer,
 * return capture proposals + remaining clarification + per-segment
 * classifier results.
 *
 * **Does NOT write captures.** The TUI confirms with the operator first;
 * confirmed proposals flow through `commitDorAnswerCaptures()`. This
 * separation is the OQ-11 design contract — "operator confirms in TUI
 * before commit" (AC #5).
 *
 * **dorThreadIssueId** populates the `blocksIssueId` field on proposals
 * (AC #4 — capture records reference the DoR thread by ID). It is NOT
 * used by the classifier itself (the issue id is metadata, not signal).
 *
 * **Empty-answer fast path**: if `answer` is empty or whitespace-only,
 * returns `{ captureProposals: [], clarificationSegments: [], classifierResults: [] }`
 * without invoking the classifier. Saves an LLM call per empty answer.
 *
 * **Idempotency**: calling this twice on the same input produces two
 * sets of corpus entries (the substrate's corpus capture is per-call).
 * Callers should call once, render the result, and commit confirmed
 * proposals via `commitDorAnswerCaptures()` — re-calling would double-
 * count the calibration corpus.
 */
export async function proposeCapturesFromDorAnswer(
  answer: string,
  opts: ProposeCapturesOpts,
): Promise<DorAnswerProposalResult> {
  const segments = segmentDorAnswer(answer);
  if (segments.length === 0) {
    return { captureProposals: [], clarificationSegments: [], classifierResults: [] };
  }

  const classified = await classifyDorAnswerSegments(segments, opts);

  const captureProposals: CaptureProposal[] = [];
  const clarificationSegments: string[] = [];
  for (const c of classified) {
    if (c.decision.classification === 'new-concern' && c.decision.metBehindThreshold) {
      captureProposals.push({
        finding: c.segment,
        decision: c.decision,
        aboveThreshold: true,
        corpusEntryId: c.decision.corpusEntryId,
      });
    } else {
      // clarification | ambiguous | low-confidence new-concern |
      // classifier-failure 'pending' sentinels all stay in the answer.
      clarificationSegments.push(c.segment);
    }
  }

  return {
    captureProposals,
    clarificationSegments,
    classifierResults: classified,
  };
}

// ── Commit helper ─────────────────────────────────────────────────────────────

export interface CommitDorAnswerCapturesOpts {
  /** The DoR thread's issue id — written to capture.blocksIssueId. */
  dorThreadIssueId: string;
  /** Operator email/login — recorded on the capture's source. */
  operator: string;
  /**
   * The DoR Stage B question text the operator was answering. Stored
   * as `evidence.additionalContext` so the capture's audit trail shows
   * "what was the operator answering when this finding surfaced?".
   */
  dorQuestionContext?: string;
  /** Override the artifacts dir (tests). */
  artifactsDir?: string;
  /** Override clock (tests). */
  now?: Date;
}

/**
 * Write the operator-confirmed capture proposals as capture records.
 * Each proposal becomes one capture record with:
 *
 *   - `finding`             = proposal.finding (the segment text)
 *   - `severity`            = 'unknown' (substrate doesn't classify severity
 *                              for `dor-answer-is-new-concern`; the
 *                              OQ-5 severity classifier is a SEPARATE
 *                              substrate call that the capture writer
 *                              handles, kept out of this module to
 *                              respect Phase 5's scope)
 *   - `triage`              = 'tbd' (operator triages later via the
 *                              TUI Blockers pane per RFC-0024 §10)
 *   - `source.type`         = 'operator' (the OPERATOR's answer surfaced
 *                              the concern; the classifier only segmented)
 *   - `source.operator`     = opts.operator
 *   - `source.context`      = "DoR clarification on <issueId>" + optional
 *                              question context
 *   - `evidence.additionalContext` = opts.dorQuestionContext (if provided)
 *   - `blocksIssueId`       = opts.dorThreadIssueId (AC #4)
 *
 * Returns the array of written records in the order corresponding to
 * `proposals[]`.
 *
 * **Failure mode**: if `writeCapture()` throws on any proposal (disk
 * full, permission error, validation), the error propagates and earlier
 * captures remain written. Callers SHOULD detect partial-write failure
 * and surface it to the operator; we deliberately do NOT swallow because
 * silent partial commits would contaminate the audit trail.
 */
export function commitDorAnswerCaptures(
  proposals: readonly CaptureProposal[],
  opts: CommitDorAnswerCapturesOpts,
): CaptureRecord[] {
  const written: CaptureRecord[] = [];
  const baseContext = `DoR clarification on ${opts.dorThreadIssueId}`;
  const sourceContext = opts.dorQuestionContext
    ? `${baseContext}: ${opts.dorQuestionContext}`
    : baseContext;

  for (const proposal of proposals) {
    const record = writeCapture({
      finding: proposal.finding,
      sourceType: 'operator',
      operator: opts.operator,
      context: sourceContext,
      evidence: opts.dorQuestionContext ? { additionalContext: opts.dorQuestionContext } : {},
      blocksIssueId: opts.dorThreadIssueId,
      ...(opts.artifactsDir !== undefined ? { artifactsDir: opts.artifactsDir } : {}),
      ...(opts.now !== undefined ? { now: opts.now } : {}),
    });
    written.push(record);
  }
  return written;
}

// ── Convenience composite ─────────────────────────────────────────────────────

export interface ProcessDorAnswerOpts
  extends ProposeCapturesOpts, Omit<CommitDorAnswerCapturesOpts, 'dorThreadIssueId'> {
  /**
   * Operator-confirmation callback. Called with the proposed captures;
   * returns the subset the operator confirmed. Default: confirms ALL
   * proposals (used when the caller has already gathered confirmation
   * out-of-band, e.g. a bulk-confirm flag).
   *
   * Per AC #5 the operator confirms in TUI before commit — this hook is
   * how the TUI passes its confirmation back.
   */
  confirm?: (
    proposals: readonly CaptureProposal[],
  ) => Promise<CaptureProposal[]> | CaptureProposal[];
}

export interface ProcessDorAnswerResult {
  /** The records that were actually written (post-confirmation). */
  writtenCaptures: CaptureRecord[];
  /** The full proposal result from `proposeCapturesFromDorAnswer`. */
  proposal: DorAnswerProposalResult;
  /** The proposals the operator confirmed (subset of `proposal.captureProposals`). */
  confirmedProposals: CaptureProposal[];
  /**
   * The residual clarification answer string — `proposal.clarificationSegments`
   * stitched with double newlines, ready to be posted back as the
   * operator's "clean" DoR answer.
   */
  residualClarification: string;
}

/**
 * End-to-end composite. Convenience wrapper for callers that have both
 * the operator's answer and a confirmation hook in one place. Pure
 * surfaces (the TUI) can call the lower-level functions directly when
 * they need to render mid-process.
 */
export async function processDorAnswer(
  answer: string,
  opts: ProcessDorAnswerOpts,
): Promise<ProcessDorAnswerResult> {
  const proposal = await proposeCapturesFromDorAnswer(answer, opts);
  const confirmFn = opts.confirm ?? ((ps: readonly CaptureProposal[]) => Array.from(ps));
  const confirmedProposals = await Promise.resolve(confirmFn(proposal.captureProposals));

  const writtenCaptures = commitDorAnswerCaptures(confirmedProposals, {
    dorThreadIssueId: opts.dorThreadIssueId,
    operator: opts.operator,
    ...(opts.dorQuestionContext !== undefined
      ? { dorQuestionContext: opts.dorQuestionContext }
      : {}),
    ...(opts.artifactsDir !== undefined ? { artifactsDir: opts.artifactsDir } : {}),
    ...(opts.now !== undefined ? { now: opts.now } : {}),
  });

  const residualClarification = proposal.clarificationSegments.join('\n\n');

  return {
    writtenCaptures,
    proposal,
    confirmedProposals,
    residualClarification,
  };
}
