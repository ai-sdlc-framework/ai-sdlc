import type { DatabaseAdapterName, DatabaseBranchAdapter } from './types.js';

export class UnknownDatabaseAdapterError extends Error {
  constructor(public readonly name: string) {
    super(`Unknown DatabaseBranchAdapter: ${name}`);
    this.name = 'UnknownDatabaseAdapterError';
  }
}

export class DatabaseAdapterRegistry {
  private readonly adapters = new Map<DatabaseAdapterName, DatabaseBranchAdapter>();

  register(adapter: DatabaseBranchAdapter): void {
    this.adapters.set(adapter.name, adapter);
  }

  get(name: string): DatabaseBranchAdapter {
    const a = this.adapters.get(name as DatabaseAdapterName);
    if (!a) throw new UnknownDatabaseAdapterError(name);
    return a;
  }

  has(name: string): boolean {
    return this.adapters.has(name as DatabaseAdapterName);
  }

  list(): DatabaseAdapterName[] {
    return Array.from(this.adapters.keys());
  }
}
