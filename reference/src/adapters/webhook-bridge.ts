/**
 * Webhook-to-EventStream bridge.
 * Converts incoming webhook payloads into typed async event streams
 * without prescribing an HTTP framework.
 * <!-- Source: PRD Section 9 -->
 */

import { EventEmitter } from 'node:events';
import type { EventStream } from './interfaces.js';

/**
 * A webhook bridge converts raw webhook payloads into typed events
 * that can be consumed as async iterators (EventStream).
 */
export interface WebhookBridge<T> {
  /** Push a raw webhook payload into the bridge for processing. */
  push(payload: unknown): void;
  /** Create an EventStream that yields typed events. */
  stream(): EventStream<T>;
  /** Number of active listeners. */
  listenerCount(): number;
  /** Close the bridge, ending all active streams. */
  close(): void;
}

export type WebhookTransformer<T> = (payload: unknown) => T | null;

/**
 * Create a webhook bridge that transforms raw payloads into typed events.
 *
 * @param transformer - Converts raw webhook payload to a typed event,
 *   or returns null to filter/skip the event.
 *
 * Usage:
 * ```ts
 * const bridge = createWebhookBridge<IssueEvent>((payload) => {
 *   const p = payload as { action: string; issue: { id: number } };
 *   return { type: 'created', issue: mapIssue(p.issue), timestamp: new Date().toISOString() };
 * });
 *
 * // In your HTTP handler:
 * app.post('/webhooks/issues', (req) => bridge.push(req.body));
 *
 * // Consume events:
 * for await (const event of bridge.stream()) {
 *   console.log(event);
 * }
 * ```
 */
export function createWebhookBridge<T>(transformer: WebhookTransformer<T>): WebhookBridge<T> {
  const emitter = new EventEmitter();
  let closed = false;

  return {
    push(payload: unknown): void {
      if (closed) return;
      const event = transformer(payload);
      if (event !== null) {
        emitter.emit('event', event);
      }
    },

    stream(): EventStream<T> {
      const buffer: T[] = [];
      let resolve: ((value: IteratorResult<T>) => void) | null = null;
      let done = false;

      const onEvent = (event: T) => {
        if (resolve) {
          const r = resolve;
          resolve = null;
          r({ value: event, done: false });
        } else {
          buffer.push(event);
        }
      };

      const onClose = () => {
        done = true;
        if (resolve) {
          const r = resolve;
          resolve = null;
          r({ value: undefined as unknown as T, done: true });
        }
      };

      emitter.on('event', onEvent);
      emitter.on('close', onClose);

      return {
        [Symbol.asyncIterator](): AsyncIterator<T> {
          return {
            next(): Promise<IteratorResult<T>> {
              if (buffer.length > 0) {
                return Promise.resolve({ value: buffer.shift()!, done: false });
              }
              if (done) {
                return Promise.resolve({ value: undefined as unknown as T, done: true });
              }
              return new Promise((r) => {
                resolve = r;
              });
            },

            return(): Promise<IteratorResult<T>> {
              emitter.off('event', onEvent);
              emitter.off('close', onClose);
              done = true;
              return Promise.resolve({ value: undefined as unknown as T, done: true });
            },
          };
        },
      };
    },

    listenerCount(): number {
      return emitter.listenerCount('event');
    },

    close(): void {
      closed = true;
      emitter.emit('close');
      emitter.removeAllListeners();
    },
  };
}
