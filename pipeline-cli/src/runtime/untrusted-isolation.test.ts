/** AISDLC-1277 — untrusted spawns start without host credentials and not in bypass mode. */
import { afterEach, describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { ShellClaudePSpawner } from './shell-claude-p-spawner.js';
import {
  UNTRUSTED_ENV_ALLOWLIST,
  UNTRUSTED_SPAWN_ENV,
  isUntrustedSpawnEnv,
} from './untrusted-env.js';
import { removeFixtureDir } from '../__test-helpers/remove-fixture-dir.js';

type Seen = { argv: readonly string[]; env?: NodeJS.ProcessEnv; homeExistedAtStart: boolean };

function fakeSpawn(seen: Seen[], exitCode = 0) {
  return (_c: string, argv: readonly string[], o: { env?: NodeJS.ProcessEnv }) => {
    const home = o.env?.HOME;
    seen.push({
      argv,
      env: o.env,
      homeExistedAtStart: !!home && existsSync(home) && readdirSync(home).length === 0,
    });
    const child = new EventEmitter() as ChildProcess;
    (child as unknown as { stdout: EventEmitter }).stdout = new EventEmitter();
    (child as unknown as { stderr: EventEmitter }).stderr = new EventEmitter();
    setImmediate(() => child.emit('close', exitCode, null));
    return child;
  };
}

const SECRETS = [
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'ANTHROPIC_API_KEY',
  'NPM_TOKEN',
  'SSH_AUTH_SOCK',
  'FOO_SECRET',
];
const saved: Record<string, string | undefined> = {};
function setSecrets(): void {
  for (const k of [...SECRETS, ...UNTRUSTED_ENV_ALLOWLIST]) saved[k] = process.env[k];
  for (const k of SECRETS) process.env[k] = 'sekret';
  for (const k of UNTRUSTED_ENV_ALLOWLIST) {
    if (k === 'TMPDIR' || k === 'TMP' || k === 'TEMP') process.env[k] = tmpdir();
    else process.env[k] = process.env[k] ?? 'v';
  }
}
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const untrustedOpts = {
  type: 'developer' as const,
  prompt: 'p',
  cwd: '/x',
  env: { ...UNTRUSTED_SPAWN_ENV },
};

describe('untrusted spawn isolation (AISDLC-1277)', () => {
  it('child env keys equal the allowlist and carry no secrets', async () => {
    setSecrets();
    const seen: Seen[] = [];
    await new ShellClaudePSpawner({ spawn: fakeSpawn(seen) }).spawn(untrustedOpts);
    const keys = Object.keys(seen[0].env ?? {}).sort();
    const expected = [
      ...UNTRUSTED_ENV_ALLOWLIST,
      'HOME',
      'GIT_CONFIG_NOSYSTEM',
      'GIT_TERMINAL_PROMPT',
      ...Object.keys(UNTRUSTED_SPAWN_ENV),
    ].sort();
    expect(keys).toEqual(expected);
    for (const k of SECRETS) expect(seen[0].env).not.toHaveProperty(k);
  });

  it('HOME is a fresh empty dir, removed after success and failure', async () => {
    setSecrets();
    for (const code of [0, 1]) {
      const seen: Seen[] = [];
      await new ShellClaudePSpawner({ spawn: fakeSpawn(seen, code) }).spawn(untrustedOpts);
      expect(seen[0].homeExistedAtStart).toBe(true);
      expect(existsSync(seen[0].env?.HOME as string)).toBe(false);
    }
  });

  it('HOME is removed when the process cannot be spawned', async () => {
    let home: string | undefined;
    const sp = new ShellClaudePSpawner({
      spawn: (_c, _a, o) => {
        home = o.env?.HOME;
        throw new Error('boom');
      },
    });
    const r = await sp.spawn(untrustedOpts);
    expect(r.status).toBe('error');
    expect(existsSync(home as string)).toBe(false);
  });

  it('git push fails for lack of credentials and gh reports no login', async () => {
    setSecrets();
    const seen: Seen[] = [];
    await new ShellClaudePSpawner({ spawn: fakeSpawn(seen) }).spawn(untrustedOpts);
    const env = { ...seen[0].env, HOME: mkdtempSync(join(tmpdir(), 'iso-home-')) };
    const realHome = mkdtempSync(join(tmpdir(), 'iso-real-'));
    const repo = mkdtempSync(join(tmpdir(), 'iso-repo-'));
    const remote = mkdtempSync(join(tmpdir(), 'iso-remote-'));
    try {
      writeFileSync(join(realHome, '.gitconfig'), '[credential]\n\thelper = store\n');
      writeFileSync(join(realHome, '.git-credentials'), 'https://u:p@example.invalid\n');
      const g = (e: NodeJS.ProcessEnv, ...a: string[]) =>
        spawnSync('git', a, { cwd: repo, env: e, encoding: 'utf8' });
      execFileSync('git', ['init', '-q'], { cwd: repo });
      g(env, 'config', 'user.email', 'a@b.c');
      g(env, 'config', 'user.name', 'n');
      g(env, 'commit', '--allow-empty', '-qm', 'x');
      // A remote that demands credentials: the child has none, so the push fails.
      const push = g(
        { ...env, GIT_ASKPASS: 'false' },
        'push',
        'https://127.0.0.1:1/none.git',
        'HEAD:refs/heads/x',
      );
      expect(push.status).not.toBe(0);
      expect(g(env, 'config', '--global', '--get', 'credential.helper').stdout).toBe('');
      const gh = spawnSync('gh', ['auth', 'status'], { env, encoding: 'utf8' });
      if (!gh.error) expect(gh.status).not.toBe(0);
    } finally {
      for (const d of [repo, remote, realHome, env.HOME as string]) removeFixtureDir(d);
    }
  });

  it('argv does not select bypassPermissions and names allowed tools', () => {
    const argv = new ShellClaudePSpawner().buildArgv(untrustedOpts);
    expect(argv).not.toContain('bypassPermissions');
    expect(argv[argv.indexOf('--permission-mode') + 1]).toBe('acceptEdits');
    expect(argv).toContain('--allowedTools');
    expect(argv[argv.indexOf('--allowedTools') + 1]).toContain('Edit');
  });

  it('a trusted spawn is unchanged', () => {
    const argv = new ShellClaudePSpawner().buildArgv({ ...untrustedOpts, env: undefined });
    expect(argv[argv.indexOf('--permission-mode') + 1]).toBe('bypassPermissions');
    expect(argv).not.toContain('--allowedTools');
    expect(isUntrustedSpawnEnv({ AI_SDLC_UNTRUSTED_RUN: '0' })).toBe(false);
  });
});
