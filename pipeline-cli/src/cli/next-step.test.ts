import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildCli } from './index.js';
import {
  buildContext,
  defaultCliBinDir,
  nextStepCommand,
  resolvePluginScriptsDir,
} from './next-step.js';

describe('path resolution', () => {
  it('prefers CLAUDE_PLUGIN_DIR, then CLAUDE_PLUGIN_ROOT, then the dogfood plugin dir', () => {
    expect(
      resolvePluginScriptsDir({ CLAUDE_PLUGIN_DIR: '/a', CLAUDE_PLUGIN_ROOT: '/b' }, '/c'),
    ).toBe('/a/scripts');
    expect(resolvePluginScriptsDir({ CLAUDE_PLUGIN_ROOT: '/b' }, '/c')).toBe('/b/scripts');
    expect(resolvePluginScriptsDir({}, '/c')).toBe('/c/ai-sdlc-plugin/scripts');
  });

  it('resolves pipeline-cli/bin next to this package, where ai-sdlc-pipeline.mjs lives', () => {
    const bin = defaultCliBinDir();
    expect(bin.endsWith('pipeline-cli/bin')).toBe(true);
    expect(existsSync(join(bin, 'ai-sdlc-pipeline.mjs'))).toBe(true);
    expect(existsSync(join(bin, 'cli-attestation.mjs'))).toBe(true);
  });

  it('builds a context whose scratch dir sits beside the state file', () => {
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

describe('handler', () => {
  let dir: string;
  let stdout: string;
  let exitCode: number | undefined;
  const savedEnv = { ...process.env };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'next-step-cli-'));
    stdout = '';
    exitCode = undefined;
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
    rmSync(dir, { recursive: true, force: true });
  });

  const run = async (args: Record<string, unknown>): Promise<void> => {
    const cmd = nextStepCommand();
    await (cmd.handler as (a: Record<string, unknown>) => Promise<void>)({
      'work-dir': dir,
      ...args,
    });
  };

  it('prints exactly one JSON document and exits 1 on a stop', async () => {
    await run({ task: 'not-an-arg!', state: join(dir, 's.json') });
    const parsed = JSON.parse(stdout);
    expect(parsed).toMatchObject({ action: 'stop', outcome: 'aborted', prUrl: null });
    expect(parsed.reason).toContain('Accepted forms');
    expect(exitCode).toBe(1);
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
