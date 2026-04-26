/**
 * Connection-string injection per RFC §15.6. The agent sees the per-worktree branch
 * via the same env-var name (`DATABASE_URL` etc.) the application expects. Adapters
 * provide the rewritten string; this module derives optional component env vars
 * (PGHOST, PGDATABASE, etc.) from it.
 */

import type { DatabaseBranchHandle, ResolvedDatabaseBranchPool } from './types.js';

export interface InjectedEnvOverrides {
  [envName: string]: string;
}

/**
 * Build the env-var overlay for a single (handle, pool) pair. The agent's process
 * env is the orchestrator's env merged with this overlay.
 *
 * Component derivation supports postgres:// connection strings — for non-Postgres
 * URLs (e.g., sqlite file paths), additionalEnvs is silently ignored.
 */
export function buildInjectionOverrides(
  handle: DatabaseBranchHandle,
  pool: ResolvedDatabaseBranchPool,
): InjectedEnvOverrides {
  const overrides: InjectedEnvOverrides = {};
  overrides[pool.injection.targetEnv] = handle.connectionString;

  if (pool.injection.additionalEnvs && pool.injection.additionalEnvs.length > 0) {
    const components = parsePostgresUrl(handle.connectionString);
    if (components) {
      for (const envName of pool.injection.additionalEnvs) {
        const mapped = mapEnvNameToComponent(envName, components);
        if (mapped !== null) overrides[envName] = mapped;
      }
    }
  }

  return overrides;
}

interface ConnectionComponents {
  host: string;
  port: string;
  database: string;
  user: string;
  password: string;
}

export function parsePostgresUrl(url: string): ConnectionComponents | null {
  // postgres://[user[:password]@]host[:port][/database][?...]
  // Also handles postgresql:// scheme.
  try {
    const parsed = new URL(url);
    if (!/^postgres(?:ql)?:$/.test(parsed.protocol)) return null;
    return {
      host: parsed.hostname,
      port: parsed.port || '5432',
      database: parsed.pathname.replace(/^\//, ''),
      user: decodeURIComponent(parsed.username),
      password: decodeURIComponent(parsed.password),
    };
  } catch {
    return null;
  }
}

function mapEnvNameToComponent(name: string, c: ConnectionComponents): string | null {
  const upper = name.toUpperCase();
  switch (upper) {
    case 'PGHOST':
    case 'POSTGRES_HOST':
    case 'DB_HOST':
      return c.host;
    case 'PGPORT':
    case 'POSTGRES_PORT':
    case 'DB_PORT':
      return c.port;
    case 'PGDATABASE':
    case 'POSTGRES_DB':
    case 'DB_NAME':
      return c.database;
    case 'PGUSER':
    case 'POSTGRES_USER':
    case 'DB_USER':
      return c.user;
    case 'PGPASSWORD':
    case 'POSTGRES_PASSWORD':
    case 'DB_PASSWORD':
      return c.password;
    default:
      return null;
  }
}

/**
 * Mask a connection string for safe logging. Replaces the password segment with
 * `****`. Per RFC §15.1 the connection string itself MUST NEVER appear in any
 * observability output — this helper exists for adapter error messages where
 * the URL form might leak.
 */
export function maskConnectionString(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.password) {
      parsed.password = '****';
    }
    return parsed.toString();
  } catch {
    return '<unparseable connection string>';
  }
}
