/**
 * RFC-0025 §5.2 + §13 OQ-6 — `framework-coverage-gap` response.
 * Phase 5 (AISDLC-306).
 *
 * When the orchestrator's playbook hits a failure mode the playbook
 * didn't anticipate (i.e. `UnknownFailureMode` fall-through after no
 * catalogued `Handler.detect()` matched), the framework MUST:
 *
 *   1. **File a capture record** (`source: framework-coverage-gap`,
 *      `triage: tbd`) per RFC-0024 §6 — composes with the existing
 *      capture substrate so operators triage via the standard RFC-0024
 *      rubric (§7) → `quick-fix-task` / `new-issue` / `new-feature-issue` /
 *      `scope-creep`. The capture provides the audit trail and flood
 *      control (RFC-0024 §15.1 stale-ladder + rate-ceiling).
 *
 *   2. **Auto-quarantine the affected dispatch** so the worktree is
 *      removed and any in-flight commits are preserved under a
 *      `quarantine/<task>-<ts>` ref by the existing rollback module
 *      (`pipeline-cli/src/orchestrator/rollback.ts`). The actual
 *      quarantine action is performed by `maybeRollback()`; this module
 *      only emits the SIGNAL that quarantine is desired (returned by
 *      `recordFrameworkCoverageGap()` so the loop integrator can decide
 *      whether to act, e.g. respecting `coverage-gap.autoQuarantine`
 *      config).
 *
 * Per-org configurability (OQ-6 + §13.1):
 *   - `quality.coverage-gap.autoQuarantine` (default `true`)
 *   - `quality.coverage-gap.fileCapture`    (default `true`)
 *
 * @module tui/analytics/coverage-gap
 */

import { writeCapture } from '../../capture/capture-writer.js';
import type { CaptureRecord } from '../../capture/capture-record.js';
import {
  DEFAULT_COVERAGE_GAP_AUTO_QUARANTINE,
  DEFAULT_COVERAGE_GAP_FILE_CAPTURE,
  type CoverageGapConfig,
} from './quality-monitoring-config.js';

/**
 * Stable string used in the capture's `source.context` and the rendered
 * finding so operators can grep `_captures/*.jsonl` for coverage-gap
 * captures specifically.
 */
export const FRAMEWORK_COVERAGE_GAP_SOURCE = 'framework-coverage-gap';

/**
 * Input to `recordFrameworkCoverageGap()`. Sourced from `loop.ts`'s
 * UnknownFailureMode fall-through path.
 */
export interface RecordCoverageGapOpts {
  /** Task ID the dispatch was for (relatedIssueId on the capture). */
  taskId: string;
  /** Free-form error description / stderr capture from the failed dispatch. */
  reason: string;
  /** PR URL if the dispatch had opened one (rare for unmatched failures). */
  prUrl?: string | null;
  /** Optional categorical source hint stamped on the capture (e.g. `gh-push`, `verify`). */
  sourceHint?: string;
  /** Per-org config; defaults applied when omitted. */
  config?: Partial<CoverageGapConfig>;
  /** Artifacts directory override (tests / sandboxed runs). */
  artifactsDir?: string;
  /** Wall-clock override (tests). */
  now?: Date;
  /** Logger — best-effort; failures are swallowed to protect the orchestrator loop. */
  logger?: { warn: (msg: string) => void; info?: (msg: string) => void };
}

/**
 * Result returned from `recordFrameworkCoverageGap()`. The caller (typically
 * `loop.ts`'s UnknownFailureMode escalation) inspects `shouldQuarantine` to
 * decide whether to invoke the rollback module's auto-quarantine path.
 *
 * `capture` is `null` when `fileCapture` was disabled or the write failed
 * (the loop continues regardless — the capture is observability, not
 * critical-path).
 */
export interface RecordCoverageGapResult {
  /** Whether the caller should invoke auto-quarantine for this dispatch. */
  shouldQuarantine: boolean;
  /** The RFC-0024 capture record written (null when fileCapture disabled or write failed). */
  capture: CaptureRecord | null;
  /** The effective config (defaults merged) that was applied. */
  effectiveConfig: CoverageGapConfig;
}

/**
 * Record a `framework-coverage-gap` event per OQ-6.
 *
 * Best-effort: capture-write failures are swallowed (logged via
 * `opts.logger?.warn`) so a transient disk issue never blocks the
 * orchestrator's escalation path.
 */
export function recordFrameworkCoverageGap(opts: RecordCoverageGapOpts): RecordCoverageGapResult {
  const effectiveConfig: CoverageGapConfig = {
    autoQuarantine: opts.config?.autoQuarantine ?? DEFAULT_COVERAGE_GAP_AUTO_QUARANTINE,
    fileCapture: opts.config?.fileCapture ?? DEFAULT_COVERAGE_GAP_FILE_CAPTURE,
  };

  let capture: CaptureRecord | null = null;

  if (effectiveConfig.fileCapture) {
    try {
      // Truncate the finding for the one-line `finding` field; the full
      // reason is preserved in `evidence.additionalContext`.
      const findingLine = (() => {
        const firstLine = (opts.reason ?? '').split('\n')[0] ?? '';
        const compact = firstLine.trim().slice(0, 240);
        if (compact.length > 0) return `framework-coverage-gap: ${compact}`;
        return 'framework-coverage-gap: uncatalogued orchestrator failure mode';
      })();

      capture = writeCapture({
        finding: findingLine,
        severity: 'unknown',
        triage: 'tbd',
        sourceType: 'ai-agent',
        agentRole: 'orchestrator',
        context: FRAMEWORK_COVERAGE_GAP_SOURCE,
        evidence: {
          additionalContext: [
            `source: ${FRAMEWORK_COVERAGE_GAP_SOURCE}`,
            opts.sourceHint ? `sourceHint: ${opts.sourceHint}` : null,
            `taskId: ${opts.taskId}`,
            opts.prUrl ? `prUrl: ${opts.prUrl}` : null,
            '',
            'Original failure reason (truncated to 2000 chars):',
            (opts.reason ?? '').slice(0, 2000),
          ]
            .filter((v): v is string => typeof v === 'string')
            .join('\n'),
        },
        relatedIssueId: opts.taskId,
        artifactsDir: opts.artifactsDir,
        now: opts.now,
      });
      opts.logger?.info?.(
        `[coverage-gap] wrote capture ${capture.id} for ${opts.taskId} (triage: tbd)`,
      );
    } catch (err) {
      opts.logger?.warn(
        `[coverage-gap] capture write failed (non-fatal): ${(err as Error).message}`,
      );
      capture = null;
    }
  }

  return {
    shouldQuarantine: effectiveConfig.autoQuarantine,
    capture,
    effectiveConfig,
  };
}
