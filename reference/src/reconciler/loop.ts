/**
 * Continuous reconciliation loop.
 * Implements the controller pattern from spec/spec.md Section 9.
 */

import type { AnyResource } from '../core/types.js';
import type { ReconcilerFn, ReconcilerConfig } from './types.js';
import { DEFAULT_RECONCILER_CONFIG } from './types.js';
import { reconcileOnce, calculateBackoff } from './index.js';

interface QueueItem {
  resource: AnyResource;
  attempt: number;
}

export class ReconcilerLoop {
  private readonly reconciler: ReconcilerFn;
  private readonly config: ReconcilerConfig;
  private readonly queue = new Map<string, QueueItem>();
  private readonly active = new Set<string>();
  private readonly knownResources = new Map<string, AnyResource>();
  private periodicTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(reconciler: ReconcilerFn, config?: Partial<ReconcilerConfig>) {
    this.reconciler = reconciler;
    this.config = { ...DEFAULT_RECONCILER_CONFIG, ...config };
  }

  /**
   * Enqueue a resource for reconciliation. Deduplicates by metadata.name.
   * If the resource is already active or queued, this is a no-op.
   */
  enqueue(resource: AnyResource): void {
    const name = resource.metadata.name;
    if (this.active.has(name) || this.queue.has(name)) return;
    this.queue.set(name, { resource, attempt: 0 });
    this.knownResources.set(name, resource);
    if (this.running) {
      this.processQueue();
    }
  }

  /**
   * Start the reconciliation loop and periodic timer.
   */
  start(): void {
    this.running = true;
    this.processQueue();
    this.periodicTimer = setInterval(() => {
      for (const [name, resource] of this.knownResources) {
        if (!this.active.has(name) && !this.queue.has(name)) {
          this.queue.set(name, { resource, attempt: 0 });
        }
      }
      this.processQueue();
    }, this.config.periodicIntervalMs);
  }

  /**
   * Stop the reconciliation loop.
   */
  stop(): void {
    this.running = false;
    if (this.periodicTimer !== null) {
      clearInterval(this.periodicTimer);
      this.periodicTimer = null;
    }
  }

  get queueSize(): number {
    return this.queue.size;
  }

  get activeCount(): number {
    return this.active.size;
  }

  private processQueue(): void {
    if (!this.running) return;

    const available = this.config.maxConcurrency - this.active.size;
    if (available <= 0) return;

    const entries = Array.from(this.queue.entries()).slice(0, available);

    for (const [name, item] of entries) {
      this.queue.delete(name);
      this.active.add(name);
      this.processItem(name, item);
    }
  }

  private processItem(name: string, item: QueueItem): void {
    reconcileOnce(item.resource, this.reconciler).then((result) => {
      if (!this.running) {
        this.active.delete(name);
        return;
      }

      this.active.delete(name);

      switch (result.type) {
        case 'success':
          // Reset attempt counter — periodic timer will re-enqueue later
          break;

        case 'error': {
          const nextAttempt = item.attempt + 1;
          const delay = calculateBackoff(nextAttempt, this.config);
          setTimeout(() => {
            if (!this.running) return;
            this.queue.set(name, { resource: item.resource, attempt: nextAttempt });
            this.processQueue();
          }, delay);
          break;
        }

        case 'requeue':
          this.queue.set(name, { resource: item.resource, attempt: 0 });
          this.processQueue();
          break;

        case 'requeue-after':
          setTimeout(() => {
            if (!this.running) return;
            this.queue.set(name, { resource: item.resource, attempt: 0 });
            this.processQueue();
          }, result.delayMs);
          break;
      }
    });
  }
}
