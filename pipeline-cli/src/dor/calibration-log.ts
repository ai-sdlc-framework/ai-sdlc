/**
 * DoR calibration log writer (RFC §5.5).
 *
 * Every refinement verdict (Stage A only OR Stage A + Stage B) is
 * appended as one JSONL line to `$ARTIFACTS_DIR/_dor/calibration.jsonl`.
 * This log is the basis for:
 *
 *   - The weekly calibration spot-check (medium-confidence verdicts).
 *   - Rubric tuning — when authors override a verdict, the override
 *     joins the entry's `outcome` field for later analysis.
 *   - Shadow-mode evaluation (RFC §5.6) — comparing baseline vs
 *     candidate runs against the same issues.
 *
 * The log is INTENTIONALLY append-only and INTENTIONALLY denormalised
 * (each entry includes the verdict, the input snapshot, and any
 * available outcome). Reading it back is a `wc -l` + `jq` exercise; we
 * don't need a database for this.
 *
 * Default `$ARTIFACTS_DIR` is `./artifacts` — a project-local directory
 * the existing pipeline-cli already uses for ephemeral state.
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { redactSecrets } from './secret-redact.js';
import type { GateEvaluation, IssueInput, RefinementVerdict } from './types.js';

export interface CalibrationEntryInput {
  /** Issue snapshot at evaluation time (id / title / body). Optional but recommended. */
  issue?: Pick<IssueInput, 'id' | 'source' | 'title' | 'body'>;
  /** The verdict the evaluator produced. */
  verdict: RefinementVerdict;
  /**
   * Ground-truth outcome — populated when known (e.g. shadow-mode
   * comparison, post-hoc human override). Empty string for live runs.
   */
  outcome?: 'admit' | 'needs-clarification' | 'override' | '';
  /** Optional free-text annotation. */
  notes?: string;
}

export interface CalibrationLogOpts {
  /**
   * Base artifacts directory. Falls back to `process.env.ARTIFACTS_DIR`
   * and finally `./artifacts`.
   */
  artifactsDir?: string;
  /**
   * Override the timestamp written into the entry. Used by tests for
   * snapshot reproducibility.
   */
  now?: () => Date;
  /**
   * Override the on-disk file path entirely. Useful for tests that
   * want a single tmpfile rather than the conventional layout.
   */
  filePath?: string;
}

export interface CalibrationEntry {
  /** ISO-8601 timestamp of the log write. */
  ts: string;
  issueId: string;
  rubricVersion: 'v1';
  evaluatorVersion: string;
  overallVerdict: 'admit' | 'needs-clarification';
  overallConfidence?: 'high' | 'medium' | 'low';
  failedGates: number[];
  /** Ground-truth outcome (when known). */
  outcome: 'admit' | 'needs-clarification' | 'override' | '';
  /** Compact issue snapshot — body is truncated. */
  issue?: {
    id: string;
    source: string;
    title: string;
    bodySha?: string;
    bodyPreview?: string;
  };
  /** Full verdict object — schema-shaped, no internal fields. */
  verdict: RefinementVerdict;
  notes?: string;
}

/**
 * Maximum body characters to inline in the log. Larger bodies are SHA'd.
 *
 * AISDLC-122 lowered this from 500 → 80 to shrink the surface area for
 * pasted secrets that don't match a known shape. 80 chars is enough to
 * eyeball whether the issue is "the typo PR" vs "the auth bug", but
 * short enough that anything resembling structured data (a token, a URL
 * with auth params, a long config blob) trips the SHA branch instead.
 */
const BODY_INLINE_LIMIT = 80;

/**
 * Resolve the calibration log path: explicit override > opts.artifactsDir
 * > `$ARTIFACTS_DIR` env var > `./artifacts`. The conventional file is
 * `<artifactsDir>/_dor/calibration.jsonl`.
 */
export function resolveCalibrationLogPath(opts: CalibrationLogOpts = {}): string {
  if (opts.filePath) return opts.filePath;
  const base = opts.artifactsDir ?? process.env.ARTIFACTS_DIR ?? join(process.cwd(), 'artifacts');
  return join(base, '_dor', 'calibration.jsonl');
}

/**
 * Append a calibration entry to the log. Creates the parent directory
 * if missing. Synchronous on purpose — calibration writes are 1 line
 * per evaluation and we want them durable before the evaluator returns.
 */
export function appendCalibrationEntry(
  input: CalibrationEntryInput,
  opts: CalibrationLogOpts = {},
): { path: string; entry: CalibrationEntry } {
  const path = resolveCalibrationLogPath(opts);
  mkdirSync(dirname(path), { recursive: true });

  const entry = buildEntry(input, opts);
  appendFileSync(path, `${JSON.stringify(entry)}\n`, { encoding: 'utf8' });

  return { path, entry };
}

/**
 * Build the entry without writing — exposed so tests can assert on the
 * shape without touching the filesystem, and so streaming consumers
 * (Slack digest, dashboard) can re-use the format.
 */
export function buildEntry(
  input: CalibrationEntryInput,
  opts: CalibrationLogOpts = {},
): CalibrationEntry {
  const { verdict, issue, outcome, notes } = input;
  const now = opts.now ?? (() => new Date());

  const failedGates = verdict.gates
    .filter((g) => g.verdict === 'fail')
    .map((g) => g.gateId)
    .sort((a, b) => a - b);

  const issueSnapshot: CalibrationEntry['issue'] = issue
    ? {
        id: issue.id,
        source: issue.source,
        title: redactSecrets(issue.title),
        ...(issue.body && issue.body.length > BODY_INLINE_LIMIT
          ? { bodySha: shortSha(issue.body) }
          : { bodyPreview: redactSecrets(issue.body ?? '') }),
      }
    : undefined;

  return {
    ts: now().toISOString(),
    issueId: verdict.issueId,
    rubricVersion: verdict.rubricVersion,
    evaluatorVersion: verdict.evaluatorVersion,
    overallVerdict: verdict.overallVerdict,
    overallConfidence: verdict.overallConfidence,
    failedGates,
    outcome: outcome ?? '',
    issue: issueSnapshot,
    verdict: redactVerdict(verdict),
    notes: notes !== undefined ? redactSecrets(notes) : notes,
  };
}

/**
 * Apply `redactSecrets()` to the LLM-derived free-text fields inside a
 * verdict (`finding`, `clarificationQuestion` per gate, plus the
 * top-level `summary` and `questions[]`). Returns a new verdict object;
 * the input is not mutated.
 *
 * **Important contract (AISDLC-127 / AISDLC-115.4)**: every egress path
 * that writes verdict text outside of in-memory consumption MUST apply
 * its own `redactSecrets()` pass — do NOT rely on this function having
 * already redacted upstream. The comment-loop renderers
 * (`renderClarificationComment`, `renderAdmitComment`,
 * `renderPrTasksComment` in `comment-loop.ts`) call `redactSecrets()`
 * directly on each free-text field they emit; both `dor-render-comment`
 * and `dor-render-pr-summary` CLI subcommands (used by the GH Action
 * ingress in `dor-ingress.yml`) inherit that guarantee. Future egress
 * surfaces (Slack digest per RFC-0011 Phase 5; observability events per
 * RFC-0015 §7) MUST follow the same pattern.
 */
function redactVerdict(verdict: RefinementVerdict): RefinementVerdict {
  return {
    ...verdict,
    summary: verdict.summary !== undefined ? redactSecrets(verdict.summary) : verdict.summary,
    questions: verdict.questions
      ? verdict.questions.map((q) => redactSecrets(q))
      : verdict.questions,
    gates: verdict.gates.map(redactGate),
  };
}

function redactGate(gate: GateEvaluation): GateEvaluation {
  return {
    ...gate,
    finding: gate.finding !== undefined ? redactSecrets(gate.finding) : gate.finding,
    clarificationQuestion:
      gate.clarificationQuestion !== undefined
        ? redactSecrets(gate.clarificationQuestion)
        : gate.clarificationQuestion,
  };
}

/**
 * Tiny non-cryptographic checksum used as a body identifier in the log.
 * Crypto-grade hashes are unnecessary here; we only want stable
 * grouping of "same body, different rubric versions" across runs.
 */
function shortSha(body: string): string {
  let h = 0xdeadbeef;
  for (let i = 0; i < body.length; i++) {
    h = (h ^ body.charCodeAt(i)) * 0x01000193;
    // Force back into 32-bit signed range
    h |= 0;
  }
  // 8-char hex prefix is plenty for grouping.
  return `cs_${(h >>> 0).toString(16).padStart(8, '0')}`;
}
