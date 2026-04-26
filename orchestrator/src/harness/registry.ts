/**
 * Harness adapter registry per RFC §13.2. Resolves harness names to adapter implementations.
 * Pipeline-load fails with UnknownHarness when a stage names an unregistered harness.
 */

import type { HarnessAdapter, HarnessName } from './types.js';

export class UnknownHarnessError extends Error {
  constructor(public readonly name: string) {
    super(`Unknown harness: ${name}`);
    this.name = 'UnknownHarnessError';
  }
}

export class HarnessRegistry {
  private readonly adapters = new Map<HarnessName, HarnessAdapter>();

  register(adapter: HarnessAdapter): void {
    this.adapters.set(adapter.name, adapter);
  }

  get(name: string): HarnessAdapter {
    const a = this.adapters.get(name as HarnessName);
    if (!a) throw new UnknownHarnessError(name);
    return a;
  }

  has(name: string): boolean {
    return this.adapters.has(name as HarnessName);
  }

  list(): HarnessName[] {
    return Array.from(this.adapters.keys());
  }
}
