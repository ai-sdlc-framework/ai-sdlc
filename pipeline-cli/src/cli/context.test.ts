import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildContextCli, resolveRole } from './context.js';
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
    put: (e, o) => (calls.push('put:' + o.scope), { path: o.path ?? 'x.md', created: true }),
    update: () => null,
    list: () => (calls.push('list'), []),
    listRaw: () => [],
  }));
`,
    );
    writeFileSync(
      join(dir, '.ai-sdlc/context.yaml'),
      'knowledge:\n  backend: recording\n  backendModule: ai-sdlc-fixture-recording\n',
    );
    writeFileSync(join(dir, 'NOTES.md'), '# T\n\n## Why\n\nBecause.\n');
    const run = (args: string[]) =>
      buildContextCli([...args, '--project-dir', dir])
        .exitProcess(false)
        .fail(false)
        .parseAsync();
    await run(['ingest-sections', 'NOTES.md']);
    await run(['capture', 'fact-1', '--value', 'v', '--source-doc', 'doc.pdf']);
    await run(['export']);
    const calls = (globalThis as { __recordingCalls?: string[] }).__recordingCalls;
    expect(calls).toEqual(['put:tracked', 'put:protected', 'list']);
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

describe('resolveRole', () => {
  it('is human only on an interactive tty with no active task', () => {
    expect(resolveRole({}, true)).toBe('human');
    expect(resolveRole({}, false)).toBe('agent');
    expect(resolveRole({ AI_SDLC_ACTIVE_TASK_ID: 'AISDLC-1' }, true)).toBe('agent');
  });
});
