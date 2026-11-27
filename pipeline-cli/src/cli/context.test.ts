import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildContextCli, resolveRole } from './context.js';
import { SYNC_STAMP_PATH } from '../knowledge/sync.js';
import { removeFixtureDir } from '../__test-helpers/remove-fixture-dir.js';

let dir: string;
afterEach(() => {
  removeFixtureDir(dir);
  process.exitCode = 0;
});

describe('cli-context validate', () => {
  it('passes on an empty project', async () => {
    dir = mkdtempSync(join(tmpdir(), 'cli-context-'));
    await buildContextCli(['validate', '--project-dir', dir]).parseAsync();
    expect(process.exitCode ?? 0).toBe(0);
  });
});

describe('cli-context ingest-sections', () => {
  it('writes one entry per section under the tracked root and they validate', async () => {
    dir = mkdtempSync(join(tmpdir(), 'cli-context-'));
    writeFileSync(join(dir, 'NOTES.md'), '# T\n\n## Why it exists\n\nBecause history.\n');
    await buildContextCli([
      'ingest-sections',
      'NOTES.md',
      '--project-dir',
      dir,
      '--observed',
      '2026-10-23',
    ]).parseAsync();
    expect(existsSync(join(dir, '.ai-sdlc/knowledge/process/why-it-exists.md'))).toBe(true);
    await buildContextCli(['validate', '--project-dir', dir]).parseAsync();
    expect(process.exitCode ?? 0).toBe(0);
    // a second run re-ingests the existing entry instead of creating it again
    const out: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((c) => !!out.push(String(c)));
    try {
      await buildContextCli(['ingest-sections', 'NOTES.md', '--project-dir', dir]).parseAsync();
    } finally {
      vi.restoreAllMocks();
    }
    expect(out).toEqual(['0 created, 1 updated\n']);
  });
});

describe('cli-context knowledge.backend (DEC-0427)', () => {
  it('fails closed on an unregistered backend instead of using files', async () => {
    dir = mkdtempSync(join(tmpdir(), 'cli-context-'));
    mkdirSync(join(dir, '.ai-sdlc'));
    writeFileSync(join(dir, '.ai-sdlc/context.yaml'), 'knowledge:\n  backend: remote\n');
    writeFileSync(join(dir, 'NOTES.md'), '# T\n\n## Why\n\nBecause.\n');
    await expect(async () =>
      buildContextCli(['ingest-sections', 'NOTES.md', '--project-dir', dir])
        .exitProcess(false)
        .fail(false)
        .parseAsync(),
    ).rejects.toThrow(/knowledge backend 'remote' is not registered/);
    expect(existsSync(join(dir, '.ai-sdlc/knowledge'))).toBe(false);
  });

  it('routes every write and read through the registered backend, never the files store', async () => {
    dir = mkdtempSync(join(tmpdir(), 'cli-context-'));
    mkdirSync(join(dir, '.ai-sdlc'));
    writeFileSync(join(dir, 'package.json'), '{"name":"adopter","private":true}');
    const pkgDir = join(dir, 'node_modules', 'ai-sdlc-fixture-recording');
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(
      join(pkgDir, 'package.json'),
      '{"name":"ai-sdlc-fixture-recording","main":"index.js"}',
    );
    writeFileSync(
      join(pkgDir, 'index.js'),
      `const calls = (globalThis.__recordingCalls = []);
exports.registerKnowledgeBackends = (r) =>
  r.registerKnowledgeBackend('recording', () => ({
    kind: 'recording',
    get: () => null,
    list: () => (calls.push('list'), []),
    listRaw: () => [],
    // tracked writes are queued as proposals; protected ones and REJECT.md sections are
    // rejected (AISDLC-1456)
    create: async (e, o) => (
      calls.push('create:' + o.scope + ':' + o.principal.split(':')[0]),
      o.scope === 'tracked' && !String(e.fields.id).includes('reject')
        ? { id: e.fields.id, path: '', created: false, status: 'proposed' }
        : { id: e.fields.id, path: '', created: false, status: 'rejected', reason: 'read-only replica' }
    ),
    write: async (id) => ({ id, path: '', created: false, status: 'rejected', reason: 'unused' }),
  }));
`,
    );
    writeFileSync(
      join(dir, '.ai-sdlc/context.yaml'),
      'knowledge:\n  backend: recording\n  backendModule: ai-sdlc-fixture-recording\n',
    );
    writeFileSync(join(dir, 'NOTES.md'), '# T\n\n## Why\n\nBecause.\n');
    writeFileSync(join(dir, 'REJECT.md'), '# T\n\n## Why\n\nBecause.\n');
    const run = (args: string[]) =>
      buildContextCli([...args, '--project-dir', dir])
        .exitProcess(false)
        .fail(false)
        .parseAsync();
    const out: string[] = [];
    const err: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((c) => !!out.push(String(c)));
    vi.spyOn(process.stderr, 'write').mockImplementation((c) => !!err.push(String(c)));
    try {
      await run(['ingest-sections', 'NOTES.md']);
      expect(out).toEqual(['0 created, 0 updated, 1 queued as a proposal\n']);
      expect(process.exitCode ?? 0).toBe(0);
      await run(['ingest-sections', 'REJECT.md']);
      expect(out[1]).toBe('0 created, 0 updated, 1 rejected\n');
      expect(process.exitCode).toBe(1);
      process.exitCode = 0;
      await run(['capture', 'fact-1', '--value', 'v', '--source-doc', 'doc.pdf']);
      expect(err).toEqual([
        'rejected section-reject-md-why: read-only replica\n',
        'rejected: read-only replica\n',
      ]);
      expect(process.exitCode).toBe(1);
      process.exitCode = 0;
      await run(['export']);
    } finally {
      vi.restoreAllMocks();
    }
    const calls = (globalThis as { __recordingCalls?: string[] }).__recordingCalls;
    expect(calls?.map((c) => c.replace(/:(human|agent)$/, ':<role>'))).toEqual([
      'create:tracked:<role>',
      'create:tracked:<role>',
      'create:protected:<role>',
      'list',
    ]);
    expect(existsSync(join(dir, '.ai-sdlc/knowledge'))).toBe(false);
    expect(existsSync(join(dir, '.ai-sdlc/knowledge-protected'))).toBe(false);
  });
});

describe('cli-context check-backend (AISDLC-1433)', () => {
  const run = async (format: string) => {
    const out: string[] = [];
    const err: string[] = [];
    const o = vi.spyOn(process.stdout, 'write').mockImplementation((c) => !!out.push(String(c)));
    const e = vi.spyOn(process.stderr, 'write').mockImplementation((c) => !!err.push(String(c)));
    try {
      await buildContextCli([
        'check-backend',
        '--format',
        format,
        '--project-dir',
        dir,
      ]).parseAsync();
    } finally {
      o.mockRestore();
      e.mockRestore();
    }
    return { out: out.join(''), err: err.join('') };
  };

  it('reports an unregistered backend instead of failing before the command runs', async () => {
    dir = mkdtempSync(join(tmpdir(), 'cli-context-'));
    mkdirSync(join(dir, '.ai-sdlc'));
    writeFileSync(join(dir, '.ai-sdlc/context.yaml'), 'knowledge:\n  backend: remote\n');
    const json = JSON.parse((await run('json')).out) as { resolved: boolean; error: string };
    expect(json.resolved).toBe(false);
    expect(json.error).toMatch(/'remote' is not registered/);
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
    const text = await run('text');
    expect(text.out).toContain('backend remote: does not open');
    expect(text.err).toContain('not registered');
  });

  it('passes the files backend with no local paths', async () => {
    dir = mkdtempSync(join(tmpdir(), 'cli-context-'));
    const json = JSON.parse((await run('json')).out) as { backend: string; opened: boolean };
    expect(json).toMatchObject({ backend: 'files', opened: true, localPaths: [] });
    expect(process.exitCode ?? 0).toBe(0);
  });
});

describe('cli-context sync and status (AISDLC-1459)', () => {
  const run = async (cmd: string) => {
    const out: string[] = [];
    const o = vi.spyOn(process.stdout, 'write').mockImplementation((c) => !!out.push(String(c)));
    try {
      await buildContextCli([cmd, '--project-dir', dir]).parseAsync();
    } finally {
      o.mockRestore();
    }
    return JSON.parse(out.join('')) as Record<string, unknown>;
  };

  it('reports supported:false and exits 0 on the files backend', async () => {
    dir = mkdtempSync(join(tmpdir(), 'cli-context-'));
    expect(await run('sync')).toEqual({ ok: true, supported: false });
    expect(await run('status')).toEqual({ ok: true, supported: false });
    expect(process.exitCode ?? 0).toBe(0);
    expect(existsSync(join(dir, SYNC_STAMP_PATH))).toBe(false);
  });

  it('syncs a backend, records the outcome, and exits non-zero on a sync error', async () => {
    dir = mkdtempSync(join(tmpdir(), 'cli-context-'));
    mkdirSync(join(dir, '.ai-sdlc'));
    writeFileSync(join(dir, 'package.json'), '{"name":"adopter","private":true}');
    const pkgDir = join(dir, 'node_modules', 'ai-sdlc-fixture-syncing');
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(
      join(pkgDir, 'package.json'),
      '{"name":"ai-sdlc-fixture-syncing","main":"index.js"}',
    );
    writeFileSync(
      join(pkgDir, 'index.js'),
      `exports.registerKnowledgeBackends = (r) =>
  r.registerKnowledgeBackend('syncing', () => ({
    kind: 'syncing',
    get: () => null,
    put: () => ({ path: 'x.md', created: true }),
    update: () => null,
    list: () => [],
    listRaw: () => [],
    sync: async () => {
      if (globalThis.__syncFail) throw new Error('remote unreachable');
      return { pulled: 2, pushed: 1 };
    },
    status: async () => ({ queued: 4, rejected: 1 }),
  }));
`,
    );
    writeFileSync(
      join(dir, '.ai-sdlc/context.yaml'),
      'knowledge:\n  backend: syncing\n  backendModule: ai-sdlc-fixture-syncing\n',
    );
    const g = globalThis as { __syncFail?: boolean };

    expect(await run('sync')).toMatchObject({
      supported: true,
      ok: true,
      pulled: 2,
      pushed: 1,
      indexed: 0,
    });
    expect(process.exitCode ?? 0).toBe(0);
    const ok = JSON.parse(readFileSync(join(dir, SYNC_STAMP_PATH), 'utf-8')) as { at: string };

    g.__syncFail = true;
    try {
      expect(await run('sync')).toMatchObject({ ok: false, error: 'remote unreachable' });
    } finally {
      delete g.__syncFail;
    }
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;

    const status = await run('status');
    expect(status).toMatchObject({
      ok: true,
      supported: true,
      queued: 4,
      rejected: 1,
      lastError: 'remote unreachable',
    });
    expect(typeof status.lastSyncAt).toBe('string');
    expect(ok.at).toBeTruthy();
  });

  it('prints an error line and exits non-zero when status() throws', async () => {
    dir = mkdtempSync(join(tmpdir(), 'cli-context-'));
    mkdirSync(join(dir, '.ai-sdlc'));
    writeFileSync(join(dir, 'package.json'), '{"name":"adopter","private":true}');
    const pkgDir = join(dir, 'node_modules', 'ai-sdlc-fixture-status-fails');
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(
      join(pkgDir, 'package.json'),
      '{"name":"ai-sdlc-fixture-status-fails","main":"index.js"}',
    );
    writeFileSync(
      join(pkgDir, 'index.js'),
      `exports.registerKnowledgeBackends = (r) =>
  r.registerKnowledgeBackend('status-fails', () => ({
    kind: 'status-fails',
    get: () => null,
    put: () => ({ path: 'x.md', created: true }),
    update: () => null,
    list: () => [],
    listRaw: () => [],
    status: async () => { throw new Error('no route'); },
  }));
`,
    );
    writeFileSync(
      join(dir, '.ai-sdlc/context.yaml'),
      'knowledge:\n  backend: status-fails\n  backendModule: ai-sdlc-fixture-status-fails\n',
    );
    expect(await run('status')).toEqual({ ok: false, supported: true, error: 'no route' });
    expect(process.exitCode).toBe(1);
  });
});

describe('resolveRole', () => {
  it('is human only on an interactive tty with no active task', () => {
    expect(resolveRole({}, true)).toBe('human');
    expect(resolveRole({}, false)).toBe('agent');
    expect(resolveRole({ AI_SDLC_ACTIVE_TASK_ID: 'AISDLC-1' }, true)).toBe('agent');
  });
});
