import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildCli } from './index.js';
import { resetMachineDeprecationWarning } from '../workflow/execute-host.js';
import {
  buildContext,
  defaultCliBinDir,
  nextStepCommand,
  PluginScriptsNotFoundError,
  resolvePluginScriptsDir,
} from './next-step.js';
import { removeFixtureDir } from '../__test-helpers/remove-fixture-dir.js';

const REPO_PLUGIN = fileURLToPath(new URL('../../../ai-sdlc-plugin', import.meta.url));

function pluginAt(root: string): string {
  mkdirSync(join(root, 'scripts'), { recursive: true });
  writeFileSync(join(root, 'scripts', 'resolve-pipeline-cli.sh'), '#!/bin/bash\n');
  return join(root, 'scripts');
}

describe('path resolution', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'plugin-scripts-'));
  });
  afterEach(() => removeFixtureDir(tmp));

  it('finds the installed plugin from the module location whatever the cwd is', () => {
    const plugin = join(tmp, 'plugin');
    const scripts = pluginAt(plugin);
    const moduleDir = join(plugin, 'node_modules', '@ai-sdlc', 'pipeline-cli', 'dist', 'cli');
    mkdirSync(moduleDir, { recursive: true });
    expect(resolvePluginScriptsDir({}, join(tmp, 'elsewhere'), moduleDir)).toBe(scripts);
  });

  it('CLAUDE_PLUGIN_DIR with the marker wins over every other candidate', () => {
    const a = pluginAt(join(tmp, 'a'));
    pluginAt(join(tmp, 'b'));
    pluginAt(join(tmp, 'cwd', 'ai-sdlc-plugin'));
    const moduleDir = join(tmp, 'm', 'node_modules', '@ai-sdlc', 'pipeline-cli', 'dist', 'cli');
    pluginAt(join(tmp, 'm'));
    expect(
      resolvePluginScriptsDir(
        { CLAUDE_PLUGIN_DIR: join(tmp, 'a'), CLAUDE_PLUGIN_ROOT: join(tmp, 'b') },
        join(tmp, 'cwd'),
        moduleDir,
      ),
    ).toBe(a);
  });

  it('skips a variable whose folder lacks the marker', () => {
    mkdirSync(join(tmp, 'empty', 'scripts'), { recursive: true });
    const b = pluginAt(join(tmp, 'b'));
    expect(
      resolvePluginScriptsDir(
        { CLAUDE_PLUGIN_DIR: join(tmp, 'empty'), CLAUDE_PLUGIN_ROOT: join(tmp, 'b') },
        join(tmp, 'cwd'),
        join(tmp, 'nowhere', 'a', 'b', 'c', 'd'),
      ),
    ).toBe(b);
  });

  it('falls back to <cwd>/ai-sdlc-plugin (the monorepo case)', () => {
    const scripts = pluginAt(join(tmp, 'cwd', 'ai-sdlc-plugin'));
    expect(
      resolvePluginScriptsDir({}, join(tmp, 'cwd'), join(tmp, 'nowhere', 'a', 'b', 'c', 'd')),
    ).toBe(scripts);
  });

  it('throws naming both variables and every path tried when nothing qualifies', () => {
    const moduleDir = join(tmp, 'nowhere', 'a', 'b', 'c', 'd');
    let err: unknown;
    try {
      resolvePluginScriptsDir({ CLAUDE_PLUGIN_DIR: '/x' }, '/c', moduleDir);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(PluginScriptsNotFoundError);
    const msg = (err as Error).message;
    expect(msg).toContain('CLAUDE_PLUGIN_DIR');
    expect(msg).toContain('CLAUDE_PLUGIN_ROOT');
    for (const t of (err as PluginScriptsNotFoundError).tried) expect(msg).toContain(t);
    expect((err as PluginScriptsNotFoundError).tried).toContain(
      join('/c', 'ai-sdlc-plugin', 'scripts'),
    );
  });

  it('no source file other than the resolver builds an ai-sdlc-plugin/scripts path (AISDLC-1328)', () => {
    const root = fileURLToPath(new URL('..', import.meta.url));
    const hits: string[] = [];
    const walk = (d: string): void => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const f = join(d, e.name);
        if (e.isDirectory()) walk(f);
        else if (/\.ts$/.test(e.name) && !/\.test\.ts$/.test(e.name)) {
          const text = readFileSync(f, 'utf8');
          if (
            /ai-sdlc-plugin['"`]?\s*,\s*['"`]scripts['"`]?\s*\)|ai-sdlc-plugin\/scripts['"`]/.test(
              text,
            )
          )
            hits.push(f);
        }
      }
    };
    walk(root);
    expect(hits).toEqual([]);
  });

  it('resolves pipeline-cli/bin next to this package, where ai-sdlc-pipeline.mjs lives', () => {
    const bin = defaultCliBinDir();
    expect(bin.endsWith('pipeline-cli/bin')).toBe(true);
    expect(existsSync(join(bin, 'ai-sdlc-pipeline.mjs'))).toBe(true);
    expect(existsSync(join(bin, 'cli-attestation.mjs'))).toBe(true);
  });

  it('builds a context whose scratch dir sits beside the state file', () => {
    process.env.CLAUDE_PLUGIN_DIR = REPO_PLUGIN;
    const ctx = buildContext('/proj', '/tmp/x/state.json');
    expect(ctx).toMatchObject({
      workDir: '/proj',
      statePath: '/tmp/x/state.json',
      filesDir: '/tmp/x/state.json.files',
    });
  });
});

describe('registration', () => {
  it('is a `next-step` subcommand with --task, --state, --result and --fresh', () => {
    const cmd = nextStepCommand();
    expect(cmd.command).toBe('next-step');
    const help = JSON.stringify(cmd.describe);
    expect(help).toContain('AISDLC-762');
  });

  it('shows up in the router help', async () => {
    const out: string[] = [];
    await new Promise<void>((resolve) => {
      buildCli()
        .exitProcess(false)
        .parse(['--help'], {}, (_err: unknown, _argv: unknown, output: string) => {
          out.push(output);
          resolve();
        });
    });
    expect(out.join('\n')).toMatch(/next-step/);
  });
});

describe('lone dash --result (AISDLC-1337)', () => {
  // Capture the parsed argv via middleware; a stub handler replaces the real one.
  const parseArgs = async (...args: string[]): Promise<Record<string, unknown>> => {
    const saved = process.argv;
    process.argv = ['node', 'ai-sdlc-pipeline', ...args];
    let captured: Record<string, unknown> = {};
    try {
      await Promise.resolve()
        .then(() =>
          buildCli()
            .exitProcess(false)
            .fail(false)
            .middleware((argv) => {
              captured = argv as Record<string, unknown>;
              throw new Error('captured');
            }, true)
            .parseAsync(),
        )
        .catch((e: Error) => {
          if (e.message !== 'captured') throw e;
        });
    } finally {
      process.argv = saved;
    }
    return captured;
  };
  const base = ['next-step', '--task', 'AISDLC-1', '--state', 's.json'];

  it('accepts `--result -` with no Unknown argument error', async () => {
    expect((await parseArgs(...base, '--result', '-')).result).toBe('-');
  });

  it('keeps `--result=-` and `--result <file>` unchanged', async () => {
    expect((await parseArgs(...base, '--result=-')).result).toBe('-');
    expect((await parseArgs(...base, '--result', 'r.json')).result).toBe('r.json');
  });
});

describe('handler', () => {
  let dir: string;
  let stdout: string;
  let exitCode: number | undefined;
  const savedEnv = { ...process.env };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'next-step-cli-'));
    stdout = '';
    exitCode = undefined;
    process.env.CLAUDE_PLUGIN_DIR = REPO_PLUGIN;
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stdout += String(chunk);
      return true;
    });
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      exitCode = code ?? 0;
      return undefined as never;
    }) as never);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    process.env = { ...savedEnv };
    removeFixtureDir(dir);
  });

  const run = async (args: Record<string, unknown>): Promise<void> => {
    const cmd = nextStepCommand();
    await (cmd.handler as (a: Record<string, unknown>) => Promise<void>)({
      'work-dir': dir,
      ...args,
    });
  };

  it('re-emits the pending instruction for the dash form with empty stdin', async () => {
    const state = join(dir, 's.json');
    await run({ task: 'not-an-arg!', state });
    stdout = '';
    const stdin = Object.getOwnPropertyDescriptor(process, 'stdin')!;
    Object.defineProperty(process, 'stdin', { value: Readable.from([]), configurable: true });
    try {
      await run({ task: 'not-an-arg!', state, result: '-' });
    } finally {
      Object.defineProperty(process, 'stdin', stdin);
    }
    const parsed = JSON.parse(stdout);
    expect(parsed.action).toBe('stop');
    expect(parsed.reason).toContain('Accepted forms');
    expect(stdout).not.toContain('Unknown argument');
  });

  it('prints exactly one JSON document and exits 1 on a stop', async () => {
    await run({ task: 'not-an-arg!', state: join(dir, 's.json') });
    const parsed = JSON.parse(stdout);
    expect(parsed).toMatchObject({ action: 'stop', outcome: 'aborted', prUrl: null });
    expect(parsed.reason).toContain('Accepted forms');
    expect(exitCode).toBe(1);
  });

  it('runs the workflow engine by default (it does not leak the run state path into process.env, AISDLC-1155)', async () => {
    delete process.env.AI_SDLC_WORKFLOW_ENGINE;
    delete process.env.AI_SDLC_WORKFLOW_STATE;
    const state = join(dir, 's.json');
    await run({ task: 'not-an-arg!', state });
    expect(process.env.AI_SDLC_WORKFLOW_STATE).toBeUndefined();
    expect(JSON.parse(stdout).action).toBe('stop');
  });

  it('AI_SDLC_WORKFLOW_ENGINE=0 runs the legacy Machine and warns that it is deprecated', async () => {
    resetMachineDeprecationWarning();
    process.env.AI_SDLC_WORKFLOW_ENGINE = '0';
    delete process.env.AI_SDLC_WORKFLOW_STATE;
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await run({ task: 'not-an-arg!', state: join(dir, 's.json') });
    expect(process.env.AI_SDLC_WORKFLOW_STATE).toBeUndefined();
    expect(err.mock.calls.flat().join('\n')).toContain('deprecated');
    expect(JSON.parse(stdout).action).toBe('stop');
  });

  it('stops before any step with no qualifying plugin scripts folder (AISDLC-1328)', async () => {
    process.env.CLAUDE_PLUGIN_DIR = join(dir, 'missing');
    delete process.env.CLAUDE_PLUGIN_ROOT;
    await run({ task: 'AISDLC-1', state: join(dir, 's.json') });
    const parsed = JSON.parse(stdout);
    expect(parsed.action).toBe('stop');
    expect(parsed.reason).toContain('CLAUDE_PLUGIN_DIR');
    expect(parsed.reason).toContain('CLAUDE_PLUGIN_ROOT');
    expect(parsed.reason).toContain(join(dir, 'missing', 'scripts'));
    expect(parsed.reason).toContain(join(dir, 'ai-sdlc-plugin', 'scripts'));
    expect(exitCode).toBe(1);
    expect(existsSync(join(dir, 's.json'))).toBe(false);
  });

  it('refuses in a CCR sandbox', async () => {
    process.env.CLAUDE_CODE_ENV = 'ccr';
    await run({ task: 'AISDLC-1', state: join(dir, 's.json') });
    expect(JSON.parse(stdout).reason).toContain('CCR remote sandbox');
    expect(exitCode).toBe(1);
  });

  it('--fresh discards a stale state file and its files directory first', async () => {
    const state = join(dir, 's.json');
    writeFileSync(state, JSON.stringify({ schemaVersion: 99 }));
    mkdirSync(`${state}.files`);
    writeFileSync(join(`${state}.files`, 'old.md'), 'old');
    await run({ task: 'bogus arg', state, fresh: true });
    expect(existsSync(state)).toBe(false);
    expect(existsSync(`${state}.files`)).toBe(false);
    expect(JSON.parse(stdout).action).toBe('stop');
  });

  it('turns an unreadable state (schema mismatch) into a stop instead of a crash', async () => {
    const state = join(dir, 's.json');
    writeFileSync(state, JSON.stringify({ schemaVersion: 99 }));
    await run({ task: 'AISDLC-1', state });
    expect(JSON.parse(stdout).reason).toContain('unsupported next-step state schema');
    expect(exitCode).toBe(1);
  });

  it('reads the result from a file', async () => {
    const state = join(dir, 's.json');
    const result = join(dir, 'result.json');
    writeFileSync(result, '{}');
    writeFileSync(state, JSON.stringify({ schemaVersion: 99 }));
    await run({ task: 'AISDLC-1', state, result });
    expect(readFileSync(result, 'utf8')).toBe('{}');
    expect(JSON.parse(stdout).action).toBe('stop');
  });

  it('keeps console.log off stdout while it runs and restores it afterwards', async () => {
    const before = console.log;
    await run({ task: 'bad!', state: join(dir, 's.json') });
    expect(console.log).toBe(before);
  });
});
