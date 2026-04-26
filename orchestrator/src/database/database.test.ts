import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildInjectionOverrides,
  parsePostgresUrl,
  maskConnectionString,
} from './connection-injection.js';
import { enforceTopologyGuard, buildMigrationDivergedEvent } from './topology.js';
import { DatabaseAdapterRegistry, UnknownDatabaseAdapterError } from './registry.js';
import { SqliteCopyAdapter } from './adapters/sqlite-copy.js';
import { NeonAdapter } from './adapters/neon.js';
import { PgSnapshotRestoreAdapter } from './adapters/pg-snapshot-restore.js';
import { ExternalAdapter } from './adapters/external.js';
import { createDefaultDatabaseAdapterRegistry } from './index.js';
import { BranchTopologyForbiddenError, type ResolvedDatabaseBranchPool } from './types.js';

describe('connection-injection', () => {
  const samplePool: ResolvedDatabaseBranchPool = {
    name: 'primary',
    adapter: 'neon',
    upstream: { connectionStringEnv: 'DATABASE_URL_DEV', branchFrom: 'dev' },
    injection: {
      targetEnv: 'DATABASE_URL',
      additionalEnvs: ['PGHOST', 'PGPORT', 'PGDATABASE', 'PGUSER', 'PGPASSWORD'],
    },
  };

  it('overlays the rewritten connection string under targetEnv', () => {
    const handle = {
      branchKey: 'feat-x',
      connectionString: 'postgres://u:p@host:5432/db',
      createdAt: new Date(),
      upstream: 'dev',
      metadata: {},
    };
    const overrides = buildInjectionOverrides(handle, samplePool);
    expect(overrides.DATABASE_URL).toBe('postgres://u:p@host:5432/db');
  });

  it('derives Postgres component env vars from connection string', () => {
    const handle = {
      branchKey: 'feat-x',
      connectionString: 'postgres://alice:secret@h.example:6543/mydb',
      createdAt: new Date(),
      upstream: 'dev',
      metadata: {},
    };
    const o = buildInjectionOverrides(handle, samplePool);
    expect(o.PGHOST).toBe('h.example');
    expect(o.PGPORT).toBe('6543');
    expect(o.PGDATABASE).toBe('mydb');
    expect(o.PGUSER).toBe('alice');
    expect(o.PGPASSWORD).toBe('secret');
  });

  it('skips additionalEnvs gracefully when URL is non-Postgres', () => {
    const handle = {
      branchKey: 'sqlite-test',
      connectionString: 'file:///tmp/db.sqlite',
      createdAt: new Date(),
      upstream: 'dev',
      metadata: {},
    };
    const o = buildInjectionOverrides(handle, samplePool);
    expect(o.DATABASE_URL).toBe('file:///tmp/db.sqlite');
    expect(o.PGHOST).toBeUndefined();
  });

  it('parsePostgresUrl returns null for malformed URLs', () => {
    expect(parsePostgresUrl('not-a-url')).toBeNull();
  });

  it('parsePostgresUrl supports postgresql:// scheme', () => {
    const c = parsePostgresUrl('postgresql://u:p@h/db');
    expect(c?.host).toBe('h');
  });

  it('maskConnectionString replaces password with ****', () => {
    const masked = maskConnectionString('postgres://alice:supersecret@h:5432/db');
    expect(masked).toContain('****');
    expect(masked).not.toContain('supersecret');
  });

  it('maskConnectionString returns placeholder for unparseable input', () => {
    expect(maskConnectionString('not-a-url')).toBe('<unparseable connection string>');
  });
});

describe('topology guard', () => {
  const pool: ResolvedDatabaseBranchPool = {
    name: 'primary',
    adapter: 'neon',
    upstream: { connectionStringEnv: 'DATABASE_URL_DEV', branchFrom: 'feat-parent' },
    injection: { targetEnv: 'DATABASE_URL' },
  };

  it('refuses to branch from an in-flight branch when allowBranchFromBranch is false (default)', () => {
    expect(() =>
      enforceTopologyGuard(pool, {
        inFlightBranchNames: new Set(['feat-parent']),
        stableUpstreams: new Set(['dev', 'main']),
      }),
    ).toThrow(BranchTopologyForbiddenError);
  });

  it('allows branching from an in-flight branch when allowBranchFromBranch: true', () => {
    expect(() =>
      enforceTopologyGuard(
        { ...pool, allowBranchFromBranch: true },
        {
          inFlightBranchNames: new Set(['feat-parent']),
          stableUpstreams: new Set(['dev', 'main']),
        },
      ),
    ).not.toThrow();
  });

  it('allows branching from a stable upstream regardless of guard', () => {
    expect(() =>
      enforceTopologyGuard(
        { ...pool, upstream: { ...pool.upstream, branchFrom: 'dev' } },
        { inFlightBranchNames: new Set(), stableUpstreams: new Set(['dev', 'main']) },
      ),
    ).not.toThrow();
  });

  it('buildMigrationDivergedEvent constructs the §15.5.1 event payload', () => {
    const event = buildMigrationDivergedEvent(
      { branchKey: 'feat-prefs-PR-A', reason: 'pr-abandoned', issueId: 'AISDLC-247' },
      [
        {
          branchKey: 'feat-prefs-ui-PR-B',
          issueId: 'AISDLC-249',
          lastActivity: new Date('2026-04-26T17:55:00Z'),
        },
      ],
    );
    expect(event.type).toBe('MigrationDiverged');
    expect(event.divergentChildren).toHaveLength(1);
    expect(event.recommendation).toMatch(/operator triage/);
  });
});

describe('DatabaseAdapterRegistry', () => {
  it('register + get round-trips', () => {
    const reg = new DatabaseAdapterRegistry();
    const a = new SqliteCopyAdapter();
    reg.register(a);
    expect(reg.get('sqlite-copy')).toBe(a);
  });

  it('throws UnknownDatabaseAdapterError for unregistered names', () => {
    const reg = new DatabaseAdapterRegistry();
    expect(() => reg.get('mystery-db')).toThrow(UnknownDatabaseAdapterError);
  });

  it('createDefaultDatabaseAdapterRegistry includes all four v1 adapters', () => {
    const reg = createDefaultDatabaseAdapterRegistry();
    expect(reg.has('sqlite-copy')).toBe(true);
    expect(reg.has('neon')).toBe(true);
    expect(reg.has('pg-snapshot-restore')).toBe(true);
    expect(reg.has('external')).toBe(true);
  });
});

describe('SqliteCopyAdapter', () => {
  let tmpRoot: string;
  let upstreamPath: string;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), 'sqlite-adapter-'));
    upstreamPath = join(tmpRoot, 'upstream.sqlite');
    await writeFile(upstreamPath, 'fake sqlite content');
  });
  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it('declares expected capabilities', () => {
    const a = new SqliteCopyAdapter();
    expect(a.capabilities.costModel).toBe('free');
    expect(a.capabilities.supportsMigrations).toBe(true);
    expect(a.capabilities.supportsReadOnlyBranches).toBe(true);
  });

  it('validate succeeds when upstream file exists', async () => {
    const a = new SqliteCopyAdapter({
      env: { DB_FILE: upstreamPath },
      storageRoot: join(tmpRoot, 'branches'),
    });
    const v = await a.validate({
      name: 'p',
      adapter: 'sqlite-copy',
      upstream: { connectionStringEnv: 'DB_FILE' },
      injection: { targetEnv: 'DB_FILE' },
    });
    expect(v.ok).toBe(true);
  });

  it('validate fails when env var is unset', async () => {
    const a = new SqliteCopyAdapter({ env: {} });
    const v = await a.validate({
      name: 'p',
      adapter: 'sqlite-copy',
      upstream: { connectionStringEnv: 'MISSING' },
      injection: { targetEnv: 'DB_FILE' },
    });
    expect(v.ok).toBe(false);
  });

  it('allocate creates a per-branch copy', async () => {
    const a = new SqliteCopyAdapter({
      env: { DB_FILE: upstreamPath },
      storageRoot: join(tmpRoot, 'branches'),
    });
    const handle = await a.allocate(
      {
        name: 'p',
        adapter: 'sqlite-copy',
        upstream: { connectionStringEnv: 'DB_FILE' },
        injection: { targetEnv: 'DB_FILE' },
      },
      'feat-x',
    );
    expect(handle.branchKey).toBe('feat-x');
    expect(handle.connectionString).toMatch(/^file:\/\//);
    expect(handle.metadata.mode).toBe('copy');
  });

  it('reclaim removes the per-branch file', async () => {
    const a = new SqliteCopyAdapter({
      env: { DB_FILE: upstreamPath },
      storageRoot: join(tmpRoot, 'branches'),
    });
    const handle = await a.allocate(
      {
        name: 'p',
        adapter: 'sqlite-copy',
        upstream: { connectionStringEnv: 'DB_FILE' },
        injection: { targetEnv: 'DB_FILE' },
      },
      'feat-x',
    );
    await a.reclaim(handle);
    const entries = await readdir(join(tmpRoot, 'branches'));
    expect(entries).not.toContain('feat-x.sqlite');
  });

  it('list enumerates active per-branch files', async () => {
    const a = new SqliteCopyAdapter({
      env: { DB_FILE: upstreamPath },
      storageRoot: join(tmpRoot, 'branches'),
    });
    const pool: ResolvedDatabaseBranchPool = {
      name: 'p',
      adapter: 'sqlite-copy',
      upstream: { connectionStringEnv: 'DB_FILE' },
      injection: { targetEnv: 'DB_FILE' },
    };
    await a.allocate(pool, 'a');
    await a.allocate(pool, 'b');
    const handles = await a.list(pool);
    expect(handles.map((h) => h.branchKey).sort()).toEqual(['a', 'b']);
  });
});

describe('NeonAdapter', () => {
  it('validate fails without apiTokenEnv', async () => {
    const a = new NeonAdapter({ env: {} });
    const v = await a.validate({
      name: 'p',
      adapter: 'neon',
      upstream: { connectionStringEnv: 'DATABASE_URL_DEV', branchFrom: 'dev' },
      injection: { targetEnv: 'DATABASE_URL' },
      credentials: { projectId: 'prj_x' },
    });
    expect(v.ok).toBe(false);
  });

  it('validate fails when env token is missing', async () => {
    const a = new NeonAdapter({ env: {} });
    const v = await a.validate({
      name: 'p',
      adapter: 'neon',
      upstream: { connectionStringEnv: 'DATABASE_URL_DEV', branchFrom: 'dev' },
      injection: { targetEnv: 'DATABASE_URL' },
      credentials: { apiTokenEnv: 'NEON_API_TOKEN', projectId: 'prj_x' },
    });
    expect(v.ok).toBe(false);
  });

  it('validate succeeds when all credentials are present', async () => {
    const a = new NeonAdapter({ env: { NEON_API_TOKEN: 'tok' } });
    const v = await a.validate({
      name: 'p',
      adapter: 'neon',
      upstream: { connectionStringEnv: 'DATABASE_URL_DEV', branchFrom: 'dev' },
      injection: { targetEnv: 'DATABASE_URL' },
      credentials: { apiTokenEnv: 'NEON_API_TOKEN', projectId: 'prj_x' },
    });
    expect(v.ok).toBe(true);
  });

  it('allocate uses injected api when provided', async () => {
    const a = new NeonAdapter({
      env: { NEON_API_TOKEN: 'tok' },
      api: {
        createBranch: async () => ({
          branchId: 'br_123',
          connectionString: 'postgres://u:p@neon-x.tech:5432/db',
        }),
        deleteBranch: async () => {},
        listBranches: async () => [],
      },
    });
    const handle = await a.allocate(
      {
        name: 'p',
        adapter: 'neon',
        upstream: { connectionStringEnv: 'DATABASE_URL_DEV', branchFrom: 'dev' },
        injection: { targetEnv: 'DATABASE_URL' },
        credentials: { apiTokenEnv: 'NEON_API_TOKEN', projectId: 'prj_x' },
      },
      'feat-y',
    );
    expect(handle.metadata.branchId).toBe('br_123');
  });
});

describe('PgSnapshotRestoreAdapter', () => {
  it('validate requires admin connection string env + storage volume', async () => {
    const a = new PgSnapshotRestoreAdapter({ env: { ADMIN_DATABASE_URL: 'postgres://...' } });
    expect(
      (
        await a.validate({
          name: 'p',
          adapter: 'pg-snapshot-restore',
          upstream: { connectionStringEnv: 'DATABASE_URL_DEV' },
          injection: { targetEnv: 'DATABASE_URL' },
          credentials: {
            adminConnectionStringEnv: 'ADMIN_DATABASE_URL',
            storageVolume: '/var/lib/x',
          },
        })
      ).ok,
    ).toBe(true);
  });
});

describe('ExternalAdapter', () => {
  it('validate refuses without acknowledgeUntrusted: true', async () => {
    const a = new ExternalAdapter();
    expect(
      (
        await a.validate({
          name: 'p',
          adapter: 'external',
          upstream: { connectionStringEnv: 'X' },
          injection: { targetEnv: 'X' },
          credentials: {
            allocateCommand: 'echo postgres://',
            reclaimCommand: 'true',
          },
        })
      ).ok,
    ).toBe(false);
  });

  it('validate succeeds with acknowledgeUntrusted: true and both commands', async () => {
    const a = new ExternalAdapter();
    expect(
      (
        await a.validate({
          name: 'p',
          adapter: 'external',
          upstream: { connectionStringEnv: 'X' },
          injection: { targetEnv: 'X' },
          credentials: {
            allocateCommand: 'echo postgres://...',
            reclaimCommand: 'true',
            acknowledgeUntrusted: true,
          },
        })
      ).ok,
    ).toBe(true);
  });

  it('allocate runs the hook and parses the connection string from stdout', async () => {
    const a = new ExternalAdapter({
      exec: async () => ({ stdout: 'postgres://hook:secret@external/db\n', stderr: '' }),
    });
    const handle = await a.allocate(
      {
        name: 'p',
        adapter: 'external',
        upstream: { connectionStringEnv: 'X' },
        injection: { targetEnv: 'X' },
        credentials: {
          allocateCommand: 'echo connection-string',
          reclaimCommand: 'true',
          acknowledgeUntrusted: true,
        },
      },
      'feat-z',
    );
    expect(handle.connectionString).toBe('postgres://hook:secret@external/db');
  });

  it('allocate fails on empty stdout', async () => {
    const a = new ExternalAdapter({
      exec: async () => ({ stdout: '', stderr: '' }),
    });
    await expect(
      a.allocate(
        {
          name: 'p',
          adapter: 'external',
          upstream: { connectionStringEnv: 'X' },
          injection: { targetEnv: 'X' },
          credentials: {
            allocateCommand: 'echo',
            reclaimCommand: 'true',
            acknowledgeUntrusted: true,
          },
        },
        'feat-z',
      ),
    ).rejects.toThrow();
  });
});
