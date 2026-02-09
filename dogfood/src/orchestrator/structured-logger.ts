/**
 * Structured logger adapter — wraps the reference implementation's
 * structured loggers to satisfy the dogfood Logger interface with timing.
 */

import {
  createConsoleLogger,
  createBufferLogger,
  type StructuredLogger,
  type LogEntry,
} from '@ai-sdlc/reference';
import type { Logger } from './logger.js';

/**
 * Create a dogfood Logger backed by the reference createConsoleLogger.
 */
export function createStructuredConsoleLogger(name = 'ai-sdlc'): Logger {
  const structured = createConsoleLogger(name);
  return wrapStructuredLogger(structured);
}

/**
 * Create a dogfood Logger backed by the reference createBufferLogger.
 * Captured entries can be retrieved for assertions.
 */
export function createStructuredBufferLogger(name = 'ai-sdlc'): Logger & {
  getEntries(): LogEntry[];
  clear(): void;
} {
  const buffer = createBufferLogger(name);
  const logger = wrapStructuredLogger(buffer);

  return {
    ...logger,
    getEntries() {
      return [...buffer.getEntries()];
    },
    clear() {
      buffer.clear();
    },
  };
}

function wrapStructuredLogger(structured: StructuredLogger): Logger {
  const starts = new Map<string, number>();
  const durations = new Map<string, number>();
  const pipelineStart = performance.now();

  return {
    stage(name: string) {
      starts.set(name, performance.now());
      structured.info(`stage:start:${name}`, { stage: name });
    },

    stageEnd(name: string) {
      const start = starts.get(name);
      if (start !== undefined) {
        const duration = Math.round(performance.now() - start);
        durations.set(name, duration);
        structured.info(`stage:end:${name}`, { stage: name, durationMs: duration });
      }
    },

    info(msg: string) {
      structured.info(msg);
    },

    error(msg: string) {
      structured.error(msg);
    },

    summary() {
      const total = Math.round(performance.now() - pipelineStart);
      const stageTimings: Record<string, number> = {};
      for (const [name, ms] of durations) {
        stageTimings[name] = ms;
      }
      structured.info('pipeline-summary', { stages: stageTimings, totalMs: total });
    },
  };
}

export { createConsoleLogger, createBufferLogger };
