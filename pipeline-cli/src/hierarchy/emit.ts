/**
 * Event emission for the session hierarchy.
 *
 * Every hierarchy action that is an orchestrator event goes through an
 * injected `EventEmitter`, so tests record events in memory and never write to
 * the real artifacts directory. The production emitter appends to the
 * date-rotated events stream through the shared writer, which stamps `ts`.
 */

import { writeEvent, type OrchestratorEvent } from '../orchestrator/events.js';

/** The event fields a caller supplies; the writer stamps `ts`. */
export type HierarchyEvent = Pick<OrchestratorEvent, 'type' | 'taskId'> & {
  [k: string]: unknown;
};

/** Records one event. Must not throw: events are best-effort. */
export type EventEmitter = (event: HierarchyEvent) => void;

/** Emitter that appends to the orchestrator events stream (a no-op when the orchestrator flag is off). */
export function createStreamEmitter(artifactsDir?: string): EventEmitter {
  return (event) => {
    writeEvent({ ...event, ts: '' }, artifactsDir === undefined ? {} : { artifactsDir });
  };
}
