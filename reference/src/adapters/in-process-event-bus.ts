/**
 * In-process EventBus implementation.
 * Wraps Node.js EventEmitter behind the EventBus interface.
 */

import { EventEmitter } from 'node:events';
import type { EventBus } from './interfaces.js';

export interface InProcessEventBus extends EventBus {
  /** Get the number of subscribers for a topic (for testing). */
  subscriberCount(topic: string): number;
}

/**
 * Create an in-process EventBus backed by Node.js EventEmitter.
 */
export function createInProcessEventBus(): InProcessEventBus {
  const emitter = new EventEmitter();

  return {
    async publish(topic: string, payload: unknown): Promise<void> {
      emitter.emit(topic, payload);
    },

    subscribe(topic: string, handler: (payload: unknown) => void): () => void {
      emitter.on(topic, handler);
      return () => {
        emitter.off(topic, handler);
      };
    },

    subscriberCount(topic: string): number {
      return emitter.listenerCount(topic);
    },
  };
}
