/**
 * Utility functions for cycle detection and handling.
 */

import type { IssueTracker } from '@ai-sdlc/reference';
import { PipelineCycleDetector, type PipelineStage } from './pipeline-cycle-detector.js';
import { NOTIFICATION_TITLES } from './defaults.js';

export interface CycleHandlerOptions {
  /** Issue or PR identifier. */
  issueOrPrId: string;
  /** Stage being invoked. */
  stage: PipelineStage;
  /** Issue tracker for fetching/posting comments. */
  tracker: IssueTracker;
  /** Cycle detector instance. */
  detector: PipelineCycleDetector;
  /** Optional Slack notification callback. */
  notifySlack?: (message: string) => Promise<void>;
  /** Custom cycle notification template (optional). */
  cycleTemplate?: { title: string; body: string };
}

export interface CycleCheckResult {
  /** Whether a cycle was detected. */
  cycleDetected: boolean;
  /** Marker to append to comments for tracking. */
  marker: string;
  /** Formatted message describing the cycle (if detected). */
  cycleMessage?: string;
}

/**
 * Sanitize template content to prevent markdown/HTML injection.
 * Strips HTML tags and limits length.
 *
 * A single-pass `<[^>]*>` strip is flagged by CodeQL as
 * `js/incomplete-multi-character-sanitization` (alert #65) because a
 * crafted string like `<scr<script>ipt>` leaves `<script>` after one pass.
 * We iterate the replacement until stable so any re-introduced bad
 * substring is eliminated on the next pass — making the sanitization
 * demonstrably idempotent.
 */
export function sanitizeTemplate(text: string): string {
  // Single linear scan removing every `<...>` span (from a `<` through the
  // first following `>`). After one pass no `<` that has a later `>` survives,
  // so the result is already a fixed point (idempotent) — no loop-until-stable
  // needed, and no regex backtracking (CodeQL js/polynomial-redos).
  let out = '';
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf('<', i);
    if (open === -1) break;
    const close = text.indexOf('>', open + 1);
    if (close === -1) break; // unclosed `<`: keep the remainder as-is
    out += text.slice(i, open);
    i = close + 1;
  }
  out += text.slice(i);
  return out.slice(0, 2000);
}

/**
 * Check for pipeline cycles and post notification if detected.
 *
 * The marker is generated upfront so the caller can append it to comments
 * BEFORE executing the stage (records intent, prevents race conditions).
 * Cycle detection accounts for the pending invocation (+1 to current count).
 */
export async function checkAndHandleCycle(options: CycleHandlerOptions): Promise<CycleCheckResult> {
  const { issueOrPrId, stage, tracker, detector, notifySlack, cycleTemplate } = options;

  // Detect cycles from existing comment markers (no +1 — marker is separate)
  const cycleResult = await detector.detectCycle(tracker, issueOrPrId);

  // Generate marker for the caller to append to comments
  const marker = detector.recordInvocation(stage);

  if (cycleResult.cycleDetected) {
    const loopingSummary = cycleResult.loopingStages
      .map((s) => `- **${s.stage}**: ${s.count}/${s.max} invocations`)
      .join('\n');

    const title = sanitizeTemplate(
      cycleTemplate?.title ?? NOTIFICATION_TITLES.pipelineCycleDetected,
    );
    const body = sanitizeTemplate(
      cycleTemplate?.body ??
        `The pipeline has detected an infinite loop across the following stages:\n\n${loopingSummary}\n\n**Manual intervention is required** to resolve the cycle. Please review the issue and PR to determine the root cause.`,
    );

    const cycleMessage = `## ${title}\n\n${body}`;

    // Post cycle detection comment
    await tracker.addComment(issueOrPrId, cycleMessage);

    // Send Slack notification if configured
    if (notifySlack) {
      const slackMessage = `:warning: *Pipeline Cycle Detected* for #${issueOrPrId}\n\nLooping stages:\n${cycleResult.loopingStages.map((s) => `• ${s.stage}: ${s.count}/${s.max}`).join('\n')}`;
      await notifySlack(slackMessage).catch((err: unknown) => {
        console.error(
          '[cycle-detector] Slack notification failed:',
          err instanceof Error ? err.message : String(err),
        );
      });
    }

    return { cycleDetected: true, marker, cycleMessage };
  }

  return { cycleDetected: false, marker };
}

/**
 * Create a cycle detector from pipeline config.
 * Reads maxRetries from stage configurations.
 */
export function createCycleDetectorFromConfig(config: {
  stages?: Array<{ name: string; onFailure?: { maxRetries?: number } }>;
}): PipelineCycleDetector {
  const detector = new PipelineCycleDetector();

  if (config.stages) {
    const overrides: Partial<Record<PipelineStage, number>> = {};

    for (const stage of config.stages) {
      const maxRetries = stage.onFailure?.maxRetries;
      if (maxRetries !== undefined) {
        if (stage.name === 'code') {
          overrides['fix-ci'] = maxRetries;
        } else if (stage.name === 'review') {
          overrides['fix-review'] = maxRetries;
        } else if (
          stage.name === 'admission' ||
          stage.name === 'triage' ||
          stage.name === 'agent'
        ) {
          overrides[stage.name as PipelineStage] = maxRetries;
        }
      }
    }

    if (Object.keys(overrides).length > 0) {
      detector.updateMaxInvocations(overrides);
    }
  }

  return detector;
}
