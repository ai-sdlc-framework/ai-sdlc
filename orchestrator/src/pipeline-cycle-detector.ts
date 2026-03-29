/**
 * PipelineCycleDetector — tracks stage invocations per issue/PR across
 * all workflow runs to detect infinite orchestration loops.
 *
 * Uses GitHub issue/PR comments as shared state (hidden HTML markers)
 * to work across workflow boundaries.
 */

import type { IssueTracker } from '@ai-sdlc/reference';

export type PipelineStage = 'admission' | 'triage' | 'agent' | 'review' | 'fix-ci' | 'fix-review';

export interface CycleConfig {
  /** Max invocations per stage (default: 3 for agent stages, 2 for fix stages). */
  maxInvocations: Record<PipelineStage, number>;
}

export interface CycleDetectionResult {
  cycleDetected: boolean;
  loopingStages: Array<{ stage: PipelineStage; count: number; max: number }>;
  totalInvocations: number;
}

/** Default max invocations per stage. */
export const DEFAULT_CYCLE_LIMITS: Record<PipelineStage, number> = {
  admission: 3,
  triage: 3,
  agent: 3,
  review: 2,
  'fix-ci': 2,
  'fix-review': 2,
};

/**
 * Generate HTML comment marker for a stage invocation.
 * Format: <!-- ai-sdlc-cycle:{stage}:{timestamp} -->
 */
export function createStageMarker(stage: PipelineStage): string {
  const timestamp = Date.now();
  return `<!-- ai-sdlc-cycle:${stage}:${timestamp} -->`;
}

/**
 * Parse stage invocation markers from comment bodies.
 * Returns a map of stage -> invocation count.
 */
export function parseStageInvocations(comments: string[]): Map<PipelineStage, number> {
  const counts = new Map<PipelineStage, number>();
  const markerPattern = /<!-- ai-sdlc-cycle:(\w+(?:-\w+)?):(\d+) -->/g;

  for (const body of comments) {
    let match;
    while ((match = markerPattern.exec(body)) !== null) {
      const stage = match[1] as PipelineStage;
      counts.set(stage, (counts.get(stage) ?? 0) + 1);
    }
  }

  return counts;
}

export class PipelineCycleDetector {
  private config: CycleConfig;

  constructor(config?: Partial<CycleConfig>) {
    this.config = {
      maxInvocations: { ...DEFAULT_CYCLE_LIMITS, ...config?.maxInvocations },
    };
  }

  /**
   * Check if a cycle exists for the given issue/PR by analyzing comment history.
   * Returns cycle detection result with looping stages if any.
   */
  async detectCycle(tracker: IssueTracker, issueOrPrId: string): Promise<CycleDetectionResult> {
    const comments = await tracker.getComments(issueOrPrId);
    const commentBodies = comments.map((c) => c.body);
    return this.detectCycleFromComments(commentBodies);
  }

  /**
   * Detect cycle from comment bodies (for testing without IssueTracker).
   */
  detectCycleFromComments(comments: string[]): CycleDetectionResult {
    const invocations = parseStageInvocations(comments);
    const loopingStages: Array<{ stage: PipelineStage; count: number; max: number }> = [];
    let totalInvocations = 0;

    for (const [stage, count] of invocations.entries()) {
      totalInvocations += count;
      const max = this.config.maxInvocations[stage];
      if (count >= max) {
        loopingStages.push({ stage, count, max });
      }
    }

    return {
      cycleDetected: loopingStages.length > 0,
      loopingStages,
      totalInvocations,
    };
  }

  /**
   * Record a stage invocation by creating a marker.
   * The caller should append this to their comment.
   */
  recordInvocation(stage: PipelineStage): string {
    return createStageMarker(stage);
  }

  /**
   * Get the max invocation limit for a stage.
   */
  getMaxInvocations(stage: PipelineStage): number {
    return this.config.maxInvocations[stage];
  }

  /**
   * Update max invocations for specific stages.
   */
  updateMaxInvocations(overrides: Partial<Record<PipelineStage, number>>): void {
    this.config.maxInvocations = { ...this.config.maxInvocations, ...overrides };
  }
}
