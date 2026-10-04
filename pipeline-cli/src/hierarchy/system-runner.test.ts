import { EventEmitter } from 'node:events';

import { describe, expect, it } from 'vitest';

import {
  buildGitEnv,
  createGitRunner,
  DEFAULT_GIT_PUSH_TIMEOUT_MS,
  DEFAULT_GIT_TIMEOUT_MS,
  type GitRunnerOptions,
} from './system-runner.js';

describe('buildGitEnv', () => {
  it('removes every variable that redirects git and keeps the rest', () => {
    const env = buildGitEnv({
      PATH: '/usr/bin',
      HOME: '/home/x',
      GIT_DIR: '/elsewhere/.git',
      GIT_WORK_TREE: '/elsewhere',
      GIT_INDEX_FILE: '/elsewhere/index',
      GIT_COMMON_DIR: '/elsewhere/.git',
      GIT_OBJECT_DIRECTORY: '/elsewhere/objects',
      GIT_ALTERNATE_OBJECT_DIRECTORIES: '/elsewhere/alt',
      GIT_CONFIG: '/evil/config',
      GIT_CONFIG_GLOBAL: '/evil/global',
      GIT_CONFIG_SYSTEM: '/evil/system',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'core.hooksPath',
      GIT_CONFIG_VALUE_0: '/evil/hooks',
      GIT_CONFIG_PARAMETERS: "'core.fsmonitor=/evil'",
      GIT_SSH_COMMAND: 'ssh -i /keys/deploy',
    });
    expect(
      Object.keys(env).filter((k) => /^GIT_(DIR|WORK_TREE|INDEX_FILE|CONFIG)/.test(k)),
    ).toEqual([]);
    expect(env.GIT_COMMON_DIR).toBeUndefined();
    expect(env.GIT_OBJECT_DIRECTORY).toBeUndefined();
    expect(env.GIT_ALTERNATE_OBJECT_DIRECTORIES).toBeUndefined();
    expect(env.PATH).toBe('/usr/bin');
    expect(env.HOME).toBe('/home/x');
    expect(env.GIT_SSH_COMMAND).toBe('ssh -i /keys/deploy');
  });

  it('turns credential prompts off, overriding any inherited value', () => {
    expect(buildGitEnv({}).GIT_TERMINAL_PROMPT).toBe('0');
    expect(buildGitEnv({ GIT_TERMINAL_PROMPT: '1' }).GIT_TERMINAL_PROMPT).toBe('0');
  });

  it('matches names case-insensitively and does not change its input', () => {
    const input = { git_dir: '/x', Git_Config_Count: '2', KEEP: 'y' };
    const env = buildGitEnv(input);
    expect(env.git_dir).toBeUndefined();
    expect(env.Git_Config_Count).toBeUndefined();
    expect(env.KEEP).toBe('y');
    expect(input.git_dir).toBe('/x');
  });
});

describe('createGitRunner', () => {
  it('has a two minute default and a thirty minute push default', () => {
    expect(DEFAULT_GIT_TIMEOUT_MS).toBe(120_000);
    expect(DEFAULT_GIT_PUSH_TIMEOUT_MS).toBe(1_800_000);
  });

  it('refuses any program other than git without running it', async () => {
    const r = await createGitRunner()(process.execPath, ['-e', 'process.exit(0)']);
    expect(r.status).toBeNull();
    expect(r.stderr).toContain('does not run');
  });

  it('gives push the long timeout and a process-group kill, and other commands the default', async () => {
    const spawned: { args: string[]; options: Record<string, unknown> }[] = [];
    const timers: { fn: () => void; ms: number }[] = [];
    const kills: [number, string][] = [];
    const spawn = ((_file: string, args: string[], options: Record<string, unknown>) => {
      spawned.push({ args, options });
      const child = new EventEmitter() as EventEmitter & {
        pid: number;
        stdout: EventEmitter;
        stderr: EventEmitter;
      };
      child.pid = 4242;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      return child;
    }) as unknown as NonNullable<GitRunnerOptions['spawn']>;
    const run = createGitRunner({
      spawn,
      env: { PATH: '/usr/bin', GIT_DIR: '/x/.git', GIT_CONFIG_COUNT: '1' },
      kill: (pid, signal) => kills.push([pid, signal]),
      setTimer: (fn, ms) => {
        timers.push({ fn, ms });
        return timers.length;
      },
      clearTimer: () => {},
    });

    const rebase = run('git', ['rebase', 'origin/main'], { cwd: '/wt' });
    const push = run('git', ['push', '--force-with-lease', 'origin', 'HEAD:refs/heads/b'], {
      cwd: '/wt',
    });

    // Each command runs git alone, detached into its own group, with the scrubbed env.
    expect(spawned).toHaveLength(2);
    for (const call of spawned) {
      expect(call.options.detached).toBe(true);
      expect(call.options.shell).toBeUndefined();
      expect(call.options.env).toEqual({ PATH: '/usr/bin', GIT_TERMINAL_PROMPT: '0' });
    }
    // The push gets thirty minutes; the rebase keeps two.
    expect(timers.map((t) => t.ms)).toEqual([120_000, 1_800_000]);

    // The push times out: the whole group (negative pid) is killed, not just git.
    timers[1]!.fn();
    const pushResult = await push;
    expect(kills).toEqual([[-4242, 'SIGKILL']]);
    expect(pushResult.status).toBeNull();
    expect(pushResult.stderr).toContain('timed out after 1800000 ms');

    // The rebase times out the same way, at its own limit.
    timers[0]!.fn();
    expect((await rebase).stderr).toContain('timed out after 120000 ms');
    expect(kills).toEqual([
      [-4242, 'SIGKILL'],
      [-4242, 'SIGKILL'],
    ]);
  });
});
