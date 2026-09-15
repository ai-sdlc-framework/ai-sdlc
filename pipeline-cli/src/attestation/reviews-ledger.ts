/**
 * Append-only reviews ledger (AISDLC-616).
 *
 * ## Motivation
 *
 * The framework cannot currently answer "does running 3 reviewers catch
 * materially more blocking defects than 1?" because the signal is destroyed
 * on every run:
 *
 *   - `.ai-sdlc/verdicts/*.json` are gitignored (0 commits in history) and
 *     overwritten on every review iteration.
 *   - `.ai-sdlc/transcripts/<task>/<role>.jsonl` retain only the FINAL
 *     verdict; by merge time every reviewer has flipped to APPROVED (you
 *     don't merge until findings are fixed), so the retained end-state is
 *     all-approved by construction.
 *   - `subagent-sessions` carry only dispatch metadata, no findings.
 *
 * This module writes one durable, APPEND-ONLY JSONL record per reviewer per
 * iteration (including the first pass) to `.ai-sdlc/reviews/<task-id>.jsonl`
 * — the file is NEVER overwritten, only appended to, so first-pass findings
 * survive even after the reviewer later flips to APPROVED.
 *
 * ## Durability
 *
 * The ledger is a COMMITTED artifact (not gitignored, unlike
 * `.ai-sdlc/verdicts/`), so it survives across sessions/machines and is
 * visible in git history/blame — the same "commit it" strategy RFC-0042 used
 * for `.ai-sdlc/transcript-leaves/`. Because the ledger records lifecycle
 * observability data (not reviewed source content), its path is excluded
 * from the attestation patch-id / Merkle-root computation in LOCKSTEP with
 * `PATCH_ID_EXCLUSIONS` (`pipeline-cli/src/attestation/patch-id.ts`) and
 * `ATTESTATION_PATH_EXCLUSIONS` (`pipeline-cli/attestation-core/verify-core.mjs`)
 * — see `patch-id-exclusion-lockstep.test.ts`. Without this exclusion,
 * appending a ledger record between `emit-leaf` and `sign-v6` would shift the
 * patch-id and reproduce the AISDLC-421/610 bug class.
 *
 * @module attestation/reviews-ledger
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Reviewer role recorded in a ledger entry.
 *
 * AISDLC-617 — `'correctness'` is the opt-in merged code+test reviewer role
 * (`correctness-reviewer` agent, `reviewerSet: code-test-merged`). It is
 * additive: existing `'code'` / `'test'` / `'security'` records are
 * unaffected, and ledger consumers that only know about the original three
 * roles simply never see `'correctness'` records unless the flag is enabled.
 */
export type ReviewLedgerRole = 'code' | 'test' | 'security' | 'correctness';

/** Severity of an individual finding. */
export type ReviewLedgerSeverity = 'critical' | 'major' | 'minor' | 'suggestion';

/**
 * A single itemized finding, normalized enough for cross-reviewer dedupe.
 *
 * `title`/`area` are a coarse normalized key (lower-cased, whitespace
 * collapsed) so two reviewers flagging "the same" defect in different words
 * can still be matched by the analysis tooling — see
 * `pipeline-cli/src/cli/reviews.ts`.
 */
export interface ReviewLedgerFinding {
  severity: ReviewLedgerSeverity;
  /** Human-readable one-line summary of the finding (as the reviewer wrote it). */
  summary: string;
  /**
   * Normalized dedupe key derived from `summary`/`file`/`message` — lower-cased,
   * whitespace-collapsed. Two findings with the same `title` are treated as
   * "the same defect" by the analysis tool's overlap computation.
   */
  title: string;
  /** Optional coarse area/file the finding applies to (path or subsystem name). */
  area?: string;
}

/** One append-only ledger record: one reviewer's verdict for one iteration of one task. */
export interface ReviewLedgerRecord {
  taskId: string;
  /** PR number, when known at emit time. `null` when not yet opened. */
  prNumber: number | null;
  /** 40-char hex git commit SHA the review was performed against. */
  commitSha: string;
  /** 1-based iteration number (first pass = 1). */
  iteration: number;
  role: ReviewLedgerRole;
  /** Harness the reviewer ran under, e.g. 'claude-code' | 'codex'. */
  harness: string;
  /** ISO-8601 timestamp when the record was appended. */
  timestamp: string;
  verdict: 'approved' | 'rejected';
  findings: ReviewLedgerFinding[];
}

const REVIEWS_DIR_RELATIVE = join('.ai-sdlc', 'reviews');

/**
 * Normalize a reviewer/agent name (e.g. `code-reviewer`, `code-reviewer-codex`,
 * `security-reviewer`) into the canonical `ReviewLedgerRole`. Returns `null`
 * for unrecognized names so callers can fail loudly rather than silently
 * mis-tagging a record.
 */
export function normalizeReviewerRole(reviewerName: string): ReviewLedgerRole | null {
  const n = reviewerName.toLowerCase();
  if (n.startsWith('code-reviewer') || n === 'code') return 'code';
  if (n.startsWith('test-reviewer') || n === 'test' || n === 'testing') return 'test';
  if (n.startsWith('security-reviewer') || n === 'security' || n === 'critic') return 'security';
  // AISDLC-617 — opt-in merged code+test reviewer.
  if (n.startsWith('correctness-reviewer') || n === 'correctness') return 'correctness';
  return null;
}

/** Collapse whitespace and lower-case a string for use as a dedupe key. */
function normalizeTitle(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 200);
}

/**
 * Build a normalized `ReviewLedgerFinding[]` from a reviewer's raw verdict
 * findings. Accepts BOTH shapes seen in the codebase:
 *
 *   - itemized array: `[{ severity, file?, line?, message }]` (the raw shape
 *     reviewer subagents return, per `ai-sdlc-plugin/agents/*-reviewer.md`)
 *   - aggregated counts object: `{ critical, major, minor, suggestion }` (the
 *     shape `emit-leaf` has historically consumed, post-Step-8-aggregation)
 *
 * When given counts only, synthesizes one finding per non-zero severity
 * bucket (no itemized title is available, so `summary`/`title` are a
 * generic "<n> <severity> finding(s)" placeholder) — still enough for the
 * block-rate / sole-blocker-rate analysis, though cross-reviewer dedupe by
 * title is naturally a no-op in that degraded mode.
 */
export function normalizeFindings(
  raw:
    | Array<{ severity?: string; file?: string; line?: number; message?: string }>
    | { critical?: number; major?: number; minor?: number; suggestion?: number }
    | undefined,
): ReviewLedgerFinding[] {
  if (!raw) return [];

  if (Array.isArray(raw)) {
    const out: ReviewLedgerFinding[] = [];
    for (const item of raw) {
      const severity = (item.severity ?? 'minor').toLowerCase() as ReviewLedgerSeverity;
      if (!['critical', 'major', 'minor', 'suggestion'].includes(severity)) continue;
      const summary = item.message ?? '(no summary provided)';
      const area = item.file;
      const titleSource = area ? `${area}: ${summary}` : summary;
      out.push({
        severity,
        summary,
        title: normalizeTitle(titleSource),
        area,
      });
    }
    return out;
  }

  const counts = raw as { critical?: number; major?: number; minor?: number; suggestion?: number };
  const out: ReviewLedgerFinding[] = [];
  (['critical', 'major', 'minor', 'suggestion'] as const).forEach((severity) => {
    const n = counts[severity] ?? 0;
    for (let i = 0; i < n; i++) {
      const summary = `${severity} finding #${i + 1} (itemized detail unavailable — counts-only verdict)`;
      out.push({ severity, summary, title: normalizeTitle(summary) });
    }
  });
  return out;
}

/**
 * Resolve the absolute path of the per-task reviews ledger:
 * `<repoRoot>/.ai-sdlc/reviews/<task-id-lower>.jsonl`.
 */
export function reviewsLedgerPath(taskId: string, repoRoot?: string): string {
  const taskIdLower = taskId.toLowerCase();
  return join(repoRoot ?? process.cwd(), REVIEWS_DIR_RELATIVE, `${taskIdLower}.jsonl`);
}

/**
 * Load all records from a specific ledger JSONL file path. Returns an empty
 * array when the file does not exist. Malformed lines are skipped (logged to
 * stderr) rather than aborting the whole read — a single corrupted line must
 * not lose the rest of the append-only history.
 */
export function loadReviewLedgerFromFile(filePath: string): ReviewLedgerRecord[] {
  if (!existsSync(filePath)) return [];
  const content = readFileSync(filePath, 'utf8');
  const records: ReviewLedgerRecord[] = [];
  let lineNo = 0;
  for (const line of content.split('\n')) {
    lineNo++;
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      records.push(JSON.parse(trimmed) as ReviewLedgerRecord);
    } catch (err) {
      process.stderr.write(
        `[reviews-ledger] WARNING: skipping malformed JSONL line ${lineNo} in ${filePath}: ${String(err)}\n`,
      );
    }
  }
  return records;
}

/** Load all records for a task's ledger. Returns `[]` when no ledger exists yet. */
export function loadReviewLedger(taskId: string, repoRoot?: string): ReviewLedgerRecord[] {
  return loadReviewLedgerFromFile(reviewsLedgerPath(taskId, repoRoot));
}

/**
 * Atomically APPEND a single record to the task's ledger. Never overwrites
 * existing content — every call, including the first pass and every
 * subsequent review iteration, is a pure append. Atomicity via write-to-tmp
 * + `renameSync` (POSIX rename is atomic within the same filesystem),
 * mirroring `appendLeafToFile` in `merkle.ts`.
 */
export function appendReviewLedgerRecord(record: ReviewLedgerRecord, repoRoot?: string): void {
  const filePath = reviewsLedgerPath(record.taskId, repoRoot);
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });

  const existing = existsSync(filePath) ? readFileSync(filePath, 'utf8') : '';
  const newLine = JSON.stringify(record) + '\n';
  const newContent =
    existing === '' || existing.endsWith('\n') ? existing + newLine : existing + '\n' + newLine;

  const tmpPath = filePath + '.tmp';
  writeFileSync(tmpPath, newContent, { encoding: 'utf8' });
  renameSync(tmpPath, filePath);
}

/**
 * List every ledger file under `<repoRoot>/.ai-sdlc/reviews/*.jsonl` and load
 * all of their records, flattened into one array. Used by the analysis CLI
 * to compute reviewer marginal-value metrics across an entire repo's history
 * (and, by invoking this once per `--repo-root`, across multiple repos).
 */
export function loadAllReviewLedgers(repoRoot?: string): ReviewLedgerRecord[] {
  const dir = join(repoRoot ?? process.cwd(), REVIEWS_DIR_RELATIVE);
  if (!existsSync(dir)) return [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const records: ReviewLedgerRecord[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.jsonl')) continue;
    records.push(...loadReviewLedgerFromFile(join(dir, entry)));
  }
  return records;
}
