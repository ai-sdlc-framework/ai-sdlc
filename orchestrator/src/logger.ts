/**
 * Structured logger with stage timing for the AI-SDLC pipeline.
 */

export interface Logger {
  /** Mark the start of a named stage. */
  stage(name: string): void;
  /** Mark the end of a named stage and record its duration. */
  stageEnd(name: string): void;
  /** Log an informational message. */
  info(msg: string): void;
  /** Log an error message. */
  error(msg: string): void;
  /** Print a summary of all stage durations and total time. */
  summary(): void;
}

export function createLogger(): Logger {
  const starts = new Map<string, number>();
  const durations = new Map<string, number>();
  const pipelineStart = performance.now();

  return {
    stage(name: string) {
      starts.set(name, performance.now());
      console.log(`[ai-sdlc] \u25B8 ${name}`);
    },

    stageEnd(name: string) {
      const start = starts.get(name);
      if (start !== undefined) {
        const duration = Math.round(performance.now() - start);
        durations.set(name, duration);
        console.log(`[ai-sdlc] \u2713 ${name} (${duration}ms)`);
      }
    },

    info(msg: string) {
      console.log(`[ai-sdlc] ${msg}`);
    },

    error(msg: string) {
      console.error(`[ai-sdlc] ERROR: ${msg}`);
    },

    summary() {
      const total = Math.round(performance.now() - pipelineStart);
      console.log(`[ai-sdlc] --- Pipeline Summary ---`);
      for (const [name, ms] of durations) {
        console.log(`[ai-sdlc]   ${name}: ${ms}ms`);
      }
      console.log(`[ai-sdlc]   total: ${total}ms`);
    },
  };
}
