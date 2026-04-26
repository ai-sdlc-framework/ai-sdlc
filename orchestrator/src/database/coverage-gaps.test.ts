/**
 * Targeted coverage tests for paths flagged by codecov on PR #67. Focuses on adapter
 * error paths, list operations, and edge cases that the main database.test.ts didn't
 * cover. Kept in a separate file so the main test stays readable.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteCopyAdapter } from './adapters/sqlite-copy.js';
import { NeonAdapter } from './adapters/neon.js';
import { ExternalAdapter } from './adapters/external.js';
import { PgSnapshotRestoreAdapter } from './adapters/pg-snapshot-restore.js';
import {
  DatabaseBranchAdapterError,
  type DatabaseBranchHandle,
  type ResolvedDatabaseBranchPool,
} from './types.js';

describe('SqliteCopyAdapter — gap coverage', () => {
  let tmpRoot: string;
  let upstream: string;
  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), 'sqlite-gaps-'));
    upstream = join(tmpRoot, 'up.sqlite');
    await writeFile(upstream, 'fake-sqlite');
  });
  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it('validate fails when upstream path is a directory not a file', async () => {
    const a = new SqliteCopyAdapter({
      env: { DB_FILE: tmpRoot },
      storageRoot: join(tmpRoot, 'b'),
    });
    const v = await a.validate({
      name: 'p',
      adapter: 'sqlite-copy',
      upstream: { connectionStringEnv: 'DB_FILE' },
      injection: { targetEnv: 'DB_FILE' },
    });
    expect(v.ok).toBe(false);
  });

  it('strips file:// scheme on upstream path', async () => {
    const a = new SqliteCopyAdapter({
      env: { DB_FILE: `file://${upstream}` },
      storageRoot: join(tmpRoot, 'b'),
    });
    const v = await a.validate({
      name: 'p',
      adapter: 'sqlite-copy',
      upstream: { connectionStringEnv: 'DB_FILE' },
      injection: { targetEnv: 'DB_FILE' },
    });
    expect(v.ok).toBe(true);
  });

  it('allocateReadOnly creates a hardlink (or copy fallback)', async () => {
    const a = new SqliteCopyAdapter({
      env: { DB_FILE: upstream },
      storageRoot: join(tmpRoot, 'b'),
    });
    const handle = await a.allocateReadOnly(
      {
        name: 'p',
        adapter: 'sqlite-copy',
        upstream: { connectionStringEnv: 'DB_FILE' },
        injection: { targetEnv: 'DB_FILE' },
      },
      'feat-ro',
    );
    expect(handle.metadata.mode).toBe('hardlink-ro');
    expect(handle.connectionString).toMatch(/mode=ro$/);
    const s = await stat(handle.metadata.branchPath);
    expect(s.isFile()).toBe(true);
  });

  it('allocateReadOnly throws when env var is missing', async () => {
    const a = new SqliteCopyAdapter({ env: {}, storageRoot: join(tmpRoot, 'b') });
    await expect(
      a.allocateReadOnly(
        {
          name: 'p',
          adapter: 'sqlite-copy',
          upstream: { connectionStringEnv: 'MISSING' },
          injection: { targetEnv: 'X' },
        },
        'feat-x',
      ),
    ).rejects.toThrow(DatabaseBranchAdapterError);
  });

  it('allocate throws when env var is missing', async () => {
    const a = new SqliteCopyAdapter({ env: {}, storageRoot: join(tmpRoot, 'b') });
    await expect(
      a.allocate(
        {
          name: 'p',
          adapter: 'sqlite-copy',
          upstream: { connectionStringEnv: 'MISSING' },
          injection: { targetEnv: 'X' },
        },
        'feat-x',
      ),
    ).rejects.toThrow(DatabaseBranchAdapterError);
  });

  it('reclaim is a no-op for handles without branchPath metadata', async () => {
    const a = new SqliteCopyAdapter();
    const handle: DatabaseBranchHandle = {
      branchKey: 'x',
      connectionString: 'file:///nope',
      createdAt: new Date(),
      upstream: 'dev',
      metadata: {},
    };
    await expect(a.reclaim(handle)).resolves.toBeUndefined();
  });

  it('list returns [] when the storage root does not yet exist', async () => {
    const a = new SqliteCopyAdapter({
      env: { DB_FILE: upstream },
      storageRoot: join(tmpRoot, 'never'),
    });
    const handles = await a.list({
      name: 'p',
      adapter: 'sqlite-copy',
      upstream: { connectionStringEnv: 'DB_FILE' },
      injection: { targetEnv: 'DB_FILE' },
    });
    expect(handles).toEqual([]);
  });

  it('isAvailable proxies to validate', async () => {
    const a = new SqliteCopyAdapter({
      env: { DB_FILE: upstream },
      storageRoot: join(tmpRoot, 'b'),
    });
    expect(
      await a.isAvailable({
        name: 'p',
        adapter: 'sqlite-copy',
        upstream: { connectionStringEnv: 'DB_FILE' },
        injection: { targetEnv: 'DB_FILE' },
      }),
    ).toBe(true);
  });
});

describe('NeonAdapter — gap coverage', () => {
  const fullPool: ResolvedDatabaseBranchPool = {
    name: 'p',
    adapter: 'neon',
    upstream: { connectionStringEnv: 'DB', branchFrom: 'dev' },
    injection: { targetEnv: 'DATABASE_URL' },
    credentials: { apiTokenEnv: 'NEON_API_TOKEN', projectId: 'prj_x' },
  };

  it('validate fails without branchFrom', async () => {
    const a = new NeonAdapter({ env: { NEON_API_TOKEN: 'tok' } });
    const v = await a.validate({
      ...fullPool,
      upstream: { connectionStringEnv: 'DB' },
    });
    expect(v.ok).toBe(false);
  });

  it('validate fails without projectId', async () => {
    const a = new NeonAdapter({ env: { NEON_API_TOKEN: 'tok' } });
    const v = await a.validate({
      ...fullPool,
      credentials: { apiTokenEnv: 'NEON_API_TOKEN' },
    });
    expect(v.ok).toBe(false);
  });

  it('allocate without deps.api throws DatabaseBranchAdapterError', async () => {
    const a = new NeonAdapter({ env: { NEON_API_TOKEN: 'tok' } });
    await expect(a.allocate(fullPool, 'feat-x')).rejects.toThrow(DatabaseBranchAdapterError);
  });

  it('reclaim without deps.api throws', async () => {
    const a = new NeonAdapter();
    await expect(
      a.reclaim({
        branchKey: 'x',
        connectionString: 'postgres://',
        createdAt: new Date(),
        upstream: 'dev',
        metadata: { branchId: 'br_1', projectId: 'prj_x' },
      }),
    ).rejects.toThrow(DatabaseBranchAdapterError);
  });

  it('reclaim throws when handle lacks projectId/branchId metadata', async () => {
    const a = new NeonAdapter({
      api: {
        createBranch: async () => ({ branchId: 'br_1', connectionString: 'postgres://' }),
        deleteBranch: async () => {},
        listBranches: async () => [],
      },
    });
    await expect(
      a.reclaim({
        branchKey: 'x',
        connectionString: 'postgres://',
        createdAt: new Date(),
        upstream: 'dev',
        metadata: {},
      }),
    ).rejects.toThrow(/projectId\/branchId/);
  });

  it('list returns [] when deps.api is absent', async () => {
    const a = new NeonAdapter({ env: { NEON_API_TOKEN: 'tok' } });
    expect(await a.list(fullPool)).toEqual([]);
  });

  it('list maps branch entries when deps.api is provided', async () => {
    const a = new NeonAdapter({
      env: { NEON_API_TOKEN: 'tok' },
      api: {
        createBranch: async () => ({ branchId: 'br_1', connectionString: 'postgres://' }),
        deleteBranch: async () => {},
        listBranches: async () => [
          {
            branchId: 'br_1',
            branchName: 'feat-a',
            parent: 'dev',
            createdAt: '2026-04-26T00:00:00Z',
          },
          {
            branchId: 'br_2',
            branchName: 'feat-b',
            parent: 'dev',
            createdAt: '2026-04-26T01:00:00Z',
          },
        ],
      },
    });
    const handles = await a.list(fullPool);
    expect(handles).toHaveLength(2);
    expect(handles[0].branchKey).toBe('feat-a');
  });

  it('reclaim with deps.api calls deleteBranch', async () => {
    const calls: string[] = [];
    const a = new NeonAdapter({
      env: { NEON_API_TOKEN: 'tok' },
      api: {
        createBranch: async () => ({ branchId: 'br_1', connectionString: 'postgres://' }),
        deleteBranch: async (proj, br) => {
          calls.push(`${proj}:${br}`);
        },
        listBranches: async () => [],
      },
    });
    await a.reclaim({
      branchKey: 'x',
      connectionString: 'postgres://',
      createdAt: new Date(),
      upstream: 'dev',
      metadata: { branchId: 'br_1', projectId: 'prj_x' },
    });
    expect(calls).toEqual(['prj_x:br_1']);
  });

  it('isAvailable proxies validate', async () => {
    const a = new NeonAdapter({ env: { NEON_API_TOKEN: 'tok' } });
    expect(await a.isAvailable(fullPool)).toBe(true);
  });
});

describe('ExternalAdapter — gap coverage', () => {
  const validPool: ResolvedDatabaseBranchPool = {
    name: 'p',
    adapter: 'external',
    upstream: { connectionStringEnv: 'X' },
    injection: { targetEnv: 'X' },
    credentials: {
      allocateCommand: 'echo postgres://h/d',
      reclaimCommand: 'true',
      acknowledgeUntrusted: true,
    },
  };

  it('validate fails when allocateCommand is absent', async () => {
    const a = new ExternalAdapter();
    const v = await a.validate({
      ...validPool,
      credentials: { reclaimCommand: 'true', acknowledgeUntrusted: true },
    });
    expect(v.ok).toBe(false);
  });

  it('validate fails when reclaimCommand is absent', async () => {
    const a = new ExternalAdapter();
    const v = await a.validate({
      ...validPool,
      credentials: { allocateCommand: 'echo', acknowledgeUntrusted: true },
    });
    expect(v.ok).toBe(false);
  });

  it('allocate wraps exec failures in DatabaseBranchAdapterError', async () => {
    const a = new ExternalAdapter({
      exec: async () => {
        throw new Error('hook crashed');
      },
    });
    await expect(a.allocate(validPool, 'feat-x')).rejects.toThrow(DatabaseBranchAdapterError);
  });

  it('reclaim is a no-op (orchestrator dispatches the reclaim command)', async () => {
    const a = new ExternalAdapter();
    await expect(
      a.reclaim({
        branchKey: 'x',
        connectionString: 'postgres://',
        createdAt: new Date(),
        upstream: 'external',
        metadata: {},
      }),
    ).resolves.toBeUndefined();
  });

  it('list returns [] (external hooks do not expose enumeration)', async () => {
    const a = new ExternalAdapter();
    expect(await a.list(validPool)).toEqual([]);
  });

  it('isAvailable proxies validate', async () => {
    const a = new ExternalAdapter();
    expect(await a.isAvailable(validPool)).toBe(true);
  });
});

describe('PgSnapshotRestoreAdapter — gap coverage', () => {
  const validPool: ResolvedDatabaseBranchPool = {
    name: 'p',
    adapter: 'pg-snapshot-restore',
    upstream: { connectionStringEnv: 'DB' },
    injection: { targetEnv: 'DB' },
    credentials: { adminConnectionStringEnv: 'ADMIN_DB', storageVolume: '/var/x' },
  };

  it('validate fails without adminConnectionStringEnv', async () => {
    const a = new PgSnapshotRestoreAdapter({ env: {} });
    const v = await a.validate({
      ...validPool,
      credentials: { storageVolume: '/var/x' },
    });
    expect(v.ok).toBe(false);
  });

  it('validate fails when adminConnectionString env var is unset', async () => {
    const a = new PgSnapshotRestoreAdapter({ env: {} });
    const v = await a.validate(validPool);
    expect(v.ok).toBe(false);
  });

  it('validate fails without storageVolume', async () => {
    const a = new PgSnapshotRestoreAdapter({ env: { ADMIN_DB: 'postgres://' } });
    const v = await a.validate({
      ...validPool,
      credentials: { adminConnectionStringEnv: 'ADMIN_DB' },
    });
    expect(v.ok).toBe(false);
  });

  it('allocate throws when deps.exec is not injected', async () => {
    const a = new PgSnapshotRestoreAdapter({ env: { ADMIN_DB: 'postgres://' } });
    await expect(a.allocate(validPool, 'feat-x')).rejects.toThrow(DatabaseBranchAdapterError);
  });

  it('reclaim is a no-op when deps.exec is absent', async () => {
    const a = new PgSnapshotRestoreAdapter();
    await expect(
      a.reclaim({
        branchKey: 'x',
        connectionString: 'postgres://',
        createdAt: new Date(),
        upstream: 'dev',
        metadata: {},
      }),
    ).resolves.toBeUndefined();
  });

  it('list returns [] (placeholder until live integration)', async () => {
    const a = new PgSnapshotRestoreAdapter();
    expect(await a.list(validPool)).toEqual([]);
  });

  it('isAvailable proxies validate', async () => {
    const a = new PgSnapshotRestoreAdapter({ env: { ADMIN_DB: 'postgres://' } });
    expect(await a.isAvailable(validPool)).toBe(true);
  });
});
