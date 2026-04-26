export * from './types.js';
export { DatabaseAdapterRegistry, UnknownDatabaseAdapterError } from './registry.js';
export {
  buildInjectionOverrides,
  parsePostgresUrl,
  maskConnectionString,
  type InjectedEnvOverrides,
} from './connection-injection.js';
export {
  enforceTopologyGuard,
  buildMigrationDivergedEvent,
  type KnownInFlightBranches,
  type MigrationDivergedEvent,
} from './topology.js';

export { SqliteCopyAdapter, type SqliteCopyAdapterDeps } from './adapters/sqlite-copy.js';
export { NeonAdapter, type NeonAdapterDeps } from './adapters/neon.js';
export {
  PgSnapshotRestoreAdapter,
  type PgSnapshotRestoreAdapterDeps,
} from './adapters/pg-snapshot-restore.js';
export { ExternalAdapter, type ExternalAdapterDeps } from './adapters/external.js';

import { DatabaseAdapterRegistry } from './registry.js';
import { SqliteCopyAdapter } from './adapters/sqlite-copy.js';
import { NeonAdapter } from './adapters/neon.js';
import { PgSnapshotRestoreAdapter } from './adapters/pg-snapshot-restore.js';
import { ExternalAdapter } from './adapters/external.js';

/** Pre-populated registry with the four shipped v1 adapters. */
export function createDefaultDatabaseAdapterRegistry(): DatabaseAdapterRegistry {
  const reg = new DatabaseAdapterRegistry();
  reg.register(new SqliteCopyAdapter());
  reg.register(new NeonAdapter());
  reg.register(new PgSnapshotRestoreAdapter());
  reg.register(new ExternalAdapter());
  return reg;
}
