/** AISDLC-1278 — untrusted developer agent runs in a container. */
import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { ShellClaudePSpawner } from './shell-claude-p-spawner.js';
import {
  assertDigestImage,
  assertNoCredentialEnv,
  assertNoDependencyChange,
  assertWorktreeGitdir,
  assertProxyBindAddress,
  buildUntrustedContainerArgs,
  buildUntrustedContainerEnv,
  buildUntrustedResourceNames,
  defaultStartProxy,
  hardenGitRunner,
  hostGitOverrides,
  isDependencyManifest,
  withUntrustedContainer,
  type ProxyHandle,
} from './untrusted-container.js';
import { UNTRUSTED_SPAWN_ENV } from './untrusted-env.js';
import type { DockerExec } from '../pipeline/reviewer-container.js';
import type { Runner } from './exec.js';

const IMAGE = `node@sha256:${'a'.repeat(64)}`;
const RUN_ID = 'abcdef0123456789';

function proxy(stopped: string[] = [], bindAddress = '127.0.0.1'): () => Promise<ProxyHandle> {
  return async () => ({
    port: 4000,
    sessionToken: 'sess',
    bindAddress,
    stop: async () => {
      stopped.push('stop');
    },
  });
}

function dockerLog(failVersion = false) {
  const calls: string[][] = [];
  const exec: DockerExec = async (args) => {
    calls.push(args);
    if (args[0] === 'version' && failVersion) return { code: 1, stdout: '', stderr: 'no docker' };
    return { code: 0, stdout: '', stderr: '' };
  };
  return { calls, exec };
}

function fakeChild(code = 0): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  (child as unknown as { stdout: EventEmitter }).stdout = new EventEmitter();
  (child as unknown as { stderr: EventEmitter }).stderr = new EventEmitter();
  setImmediate(() => child.emit('close', code, null));
  return child;
}

const opts = {
  type: 'developer' as const,
  prompt: 'p',
  cwd: '/work/tree',
  env: { ...UNTRUSTED_SPAWN_ENV },
};

describe('container args (AC1, AC3)', () => {
  const env = buildUntrustedContainerEnv(opts.env, { port: 4000, sessionToken: 's' });
  const args = buildUntrustedContainerArgs({
    name: 'n',
    network: 'ucvg-ua-net-x',
    worktree: '/work/tree',
    env,
    image: IMAGE,
    command: ['claude', '--print'],
  });

  it('has exactly one host mount: the worktree', () => {
    const mounts = args.flatMap((a, i) => (a === '-v' ? [args[i + 1]] : []));
    expect(mounts).toEqual(['/work/tree:/workspace:rw']);
    expect(args.join(' ')).not.toMatch(/docker\.sock|\.ssh|SSH_AUTH_SOCK|\/Users/);
    expect(args).not.toContain('--privileged');
  });

  it('uses a digest image and the internal network only', () => {
    expect(args).toContain(IMAGE);
    expect(args).toContain('--network=ucvg-ua-net-x');
    expect(args.some((a) => a === '--network=host' || a === '--network=bridge')).toBe(false);
  });

  it('env holds no credential', () => {
    for (const k of Object.keys(env)) expect(k).not.toMatch(/_TOKEN$|_KEY$|_SECRET$/);
    expect(() => assertNoCredentialEnv({ GH_TOKEN: 'x' })).toThrow(/credential/);
    expect(() => assertNoCredentialEnv({ ANTHROPIC_API_KEY: 'x' })).toThrow(/credential/);
    expect(() => assertNoCredentialEnv({ FOO_SECRET: 'x' })).toThrow(/credential/);
    expect(() =>
      buildUntrustedContainerArgs({
        name: 'n',
        network: 'x',
        worktree: '/w',
        env: { A_KEY: 'x' },
        image: IMAGE,
        command: [],
      }),
    ).toThrow(/credential/);
  });

  it('rejects a tag-only image and a bad mount path', () => {
    expect(() => assertDigestImage('node:22')).toThrow(/digest/);
    expect(() =>
      buildUntrustedContainerArgs({
        name: 'n',
        network: 'x',
        worktree: 'rel',
        env: {},
        image: IMAGE,
        command: [],
      }),
    ).toThrow(/mount path/);
    expect(() => buildUntrustedResourceNames('ZZ')).toThrow(/hex/);
  });
});

describe('proxy bind (AC4)', () => {
  it('accepts loopback only', () => {
    for (const a of ['127.0.0.1', '::1', 'localhost'])
      expect(() => assertProxyBindAddress(a)).not.toThrow();
    for (const a of ['0.0.0.0', '172.17.0.1', '192.168.1.5']) {
      expect(() => assertProxyBindAddress(a)).toThrow(/loopback/);
    }
  });

  it('the default proxy factory binds 127.0.0.1 and needs a credential', async () => {
    const saved = process.env.ANTHROPIC_API_KEY;
    try {
      delete process.env.ANTHROPIC_API_KEY;
      await expect(defaultStartProxy()).rejects.toThrow(/credential/);
      process.env.ANTHROPIC_API_KEY = 'k';
      const p = await defaultStartProxy();
      try {
        expect(p.bindAddress).toBe('127.0.0.1');
        expect(p.port).toBeGreaterThan(0);
      } finally {
        await p.stop();
      }
    } finally {
      if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = saved;
    }
  });

  it('refuses a non-loopback proxy', async () => {
    const { exec } = dockerLog();
    const r = await withUntrustedContainer(
      { exec, startProxy: proxy([], '0.0.0.0'), image: IMAGE, runId: RUN_ID },
      { worktree: '/w', optsEnv: opts.env, command: ['claude'] },
      async () => 1,
    );
    expect(r).toHaveProperty('error');
  });
});

describe('spawner in container mode (AC5, AC8, AC9)', () => {
  it('no runtime: error names the runtime and nothing spawns on the host', async () => {
    const { exec } = dockerLog(true);
    let hostSpawns = 0;
    const sp = new ShellClaudePSpawner({
      spawn: () => {
        hostSpawns++;
        return fakeChild();
      },
      untrustedContainer: { exec, startProxy: proxy(), image: IMAGE },
    });
    const r = await sp.spawn(opts);
    expect(r.status).toBe('error');
    expect(r.error).toMatch(/docker/);
    expect(hostSpawns).toBe(0);
  });

  for (const code of [0, 1]) {
    it(`removes container, relay, network and proxy on exit code ${code}`, async () => {
      const { exec, calls } = dockerLog();
      const stopped: string[] = [];
      const launched: Array<{ bin: string; argv: readonly string[] }> = [];
      const sp = new ShellClaudePSpawner({
        spawn: (bin, argv) => {
          launched.push({ bin, argv });
          return fakeChild(code);
        },
        untrustedContainer: { exec, startProxy: proxy(stopped), image: IMAGE, runId: RUN_ID },
      });
      await sp.spawn(opts);
      expect(launched[0].bin).toBe('docker');
      expect(launched[0].argv).toContain('--network=ucvg-ua-net-' + RUN_ID);
      const removed = calls.filter((c) => c[0] === 'rm' || (c[0] === 'network' && c[1] === 'rm'));
      expect(removed).toHaveLength(3);
      expect(stopped).toEqual(['stop']);
    });
  }

  it('cleans up when the agent run throws', async () => {
    const { exec, calls } = dockerLog();
    const r = await withUntrustedContainer(
      { exec, startProxy: proxy(), image: IMAGE, runId: RUN_ID },
      { worktree: '/w', optsEnv: opts.env, command: ['claude'] },
      async () => {
        throw new Error('boom');
      },
    );
    expect(r).toHaveProperty('error');
    expect(calls.some((c) => c[0] === 'rm')).toBe(true);
  });

  it('setup failures are reported and cleaned up', async () => {
    for (const failing of ['network', 'run', 'connect']) {
      const calls: string[][] = [];
      const exec: DockerExec = async (args) => {
        calls.push(args);
        const hit =
          (failing === 'network' && args[0] === 'network' && args[1] === 'create') ||
          (failing === 'run' && args[0] === 'run') ||
          (failing === 'connect' && args[0] === 'network' && args[1] === 'connect');
        return { code: hit ? 1 : 0, stdout: '', stderr: '' };
      };
      const r = await withUntrustedContainer(
        { exec, startProxy: proxy(), image: IMAGE, runId: RUN_ID },
        { worktree: '/w', optsEnv: opts.env, command: ['claude'] },
        async () => 1,
      );
      expect(r).toHaveProperty('error');
    }
  });

  it('a trusted spawn stays on the host path', async () => {
    const launched: string[] = [];
    const sp = new ShellClaudePSpawner({
      spawn: (bin) => {
        launched.push(bin);
        return fakeChild();
      },
      untrustedContainer: true,
    });
    await sp.spawn({ type: 'developer', prompt: 'p', cwd: '/x' });
    expect(launched).toEqual(['claude']);
  });
});

describe('host git hardening (AC6)', () => {
  it('overrides pin hooks, fsmonitor and ssh command', () => {
    const o = hostGitOverrides('/main');
    expect(o).toContain('core.hooksPath=/dev/null');
    expect(o).toContain('commit.gpgsign=false');
    expect(o).toContain('gpg.program=false');
    expect(o).toContain('core.fsmonitor=false');
    expect(o).toContain('core.sshCommand=ssh');
  });

  it('wraps git calls only', async () => {
    const seen: string[][] = [];
    const inner: Runner = async (c, a) => {
      seen.push([c, ...a]);
      return { code: 0, stdout: '', stderr: '' };
    };
    const r = hardenGitRunner(inner, '/main');
    await r('git', ['status']);
    await r('gh', ['pr', 'view']);
    expect(seen[0].slice(-1)).toEqual(['status']);
    expect(seen[0]).toContain('core.hooksPath=/dev/null');
    expect(seen[1]).toEqual(['gh', 'pr', 'view']);
  });

  it('a planted core.hooksPath does not run under the hardened git', () => {
    const repo = mkdtempSync(join(tmpdir(), 'hk-repo-'));
    const main = mkdtempSync(join(tmpdir(), 'hk-main-'));
    mkdirSync(join(main, '.husky', '_'), { recursive: true });
    const evil = join(repo, 'evil');
    mkdirSync(evil);
    const marker = join(repo, 'ran');
    writeFileSync(join(evil, 'pre-commit'), `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o755 });
    const g = (...a: string[]) => spawnSync('git', a, { cwd: repo, encoding: 'utf8' });
    execFileSync('git', ['init', '-q'], { cwd: repo });
    g('config', 'user.email', 'a@b.c');
    g('config', 'user.name', 'x');
    g('config', 'core.hooksPath', evil);
    writeFileSync(join(repo, 'f'), 'x');
    g('add', 'f');
    g(...hostGitOverrides(main), 'commit', '-q', '-m', 'm');
    expect(spawnSync('test', ['-e', marker]).status).not.toBe(0);
  });
});

describe('worktree gitdir pin (AC6)', () => {
  const mk = (content: string | null) => {
    const wt = mkdtempSync(join(tmpdir(), 'gd-wt-'));
    const main = mkdtempSync(join(tmpdir(), 'gd-main-'));
    mkdirSync(join(main, '.git', 'worktrees', 'w'), { recursive: true });
    if (content !== null) writeFileSync(join(wt, '.git'), content.replace('MAIN', main));
    return { wt, main };
  };
  it('accepts a gitdir under the main checkout', () => {
    const { wt, main } = mk('gitdir: MAIN/.git/worktrees/w\n');
    expect(() => assertWorktreeGitdir(wt, main)).not.toThrow();
  });
  it('refuses a repointed or missing .git file', () => {
    const a = mk('gitdir: /tmp/evil-gitdir\n');
    expect(() => assertWorktreeGitdir(a.wt, a.main)).toThrow(/no longer points/);
    const b = mk('garbage');
    expect(() => assertWorktreeGitdir(b.wt, b.main)).toThrow(/no longer points/);
    const c = mk(null);
    expect(() => assertWorktreeGitdir(c.wt, c.main)).toThrow(/missing/);
  });
});

describe('dependency manifest limit (AC7)', () => {
  it('recognises manifests and lockfiles', () => {
    for (const f of ['package.json', 'a/b/pnpm-lock.yaml', 'requirements-dev.txt', 'go.sum']) {
      expect(isDependencyManifest(f)).toBe(true);
    }
    expect(isDependencyManifest('src/index.ts')).toBe(false);
  });

  const runnerFor =
    (committed: string, status: string): Runner =>
    async (_c, a) => ({
      code: 0,
      stdout: a[0] === 'diff' ? committed : status.replace(/\n/g, '\0'),
      stderr: '',
    });

  it('stops naming the file, committed or uncommitted', async () => {
    await expect(
      assertNoDependencyChange(runnerFor('src/a.ts\npackage.json\n', ''), '/w'),
    ).rejects.toThrow(/package\.json/);
    await expect(
      assertNoDependencyChange(runnerFor('', ' M pnpm-lock.yaml\n'), '/w'),
    ).rejects.toThrow(/pnpm-lock\.yaml/);
  });

  it('lists untracked files individually (-uall -z) so a new folder cannot hide a manifest', async () => {
    const calls: string[][] = [];
    const r: Runner = async (_c, a) => {
      calls.push(a);
      return {
        code: 0,
        stdout: a[0] === 'diff' ? '' : '?? packages/evil/package.json\0',
        stderr: '',
      };
    };
    await expect(assertNoDependencyChange(r, '/w')).rejects.toThrow(
      /packages\/evil\/package\.json/,
    );
    expect(calls.find((a) => a[0] === 'status')).toEqual(['status', '--porcelain', '-uall', '-z']);
  });

  it('catches the origin of a rename', async () => {
    const r: Runner = async (_c, a) => ({
      code: 0,
      stdout: a[0] === 'diff' ? '' : 'R  src/x.ts\0package.json\0',
      stderr: '',
    });
    await expect(assertNoDependencyChange(r, '/w')).rejects.toThrow(/package\.json/);
  });

  it('passes a clean diff', async () => {
    await expect(
      assertNoDependencyChange(runnerFor('src/a.ts\n', '?? new.ts\n'), '/w'),
    ).resolves.toBeUndefined();
  });
});

const hasDocker = spawnSync('docker', ['version'], { stdio: 'ignore' }).status === 0;
describe.skipIf(!hasDocker || process.env.AI_SDLC_SANDBOX_INTEGRATION_TESTS !== '1')(
  'container integration (skipped: needs a docker runtime and AI_SDLC_SANDBOX_INTEGRATION_TESTS=1)',
  () => {
    // Needs AI_SDLC_UNTRUSTED_AGENT_IMAGE (digest ref with sh and node) so the pull is real.
    const image = process.env.AI_SDLC_UNTRUSTED_AGENT_IMAGE;
    const runIn = async (script: string, wt: string, up: () => Promise<ProxyHandle>) => {
      let status: number | null = -1;
      const res = await withUntrustedContainer(
        { image, startProxy: up },
        { worktree: wt, optsEnv: undefined, command: ['sh', '-c', script] },
        async (l) => {
          status = spawnSync(l.binary, l.args, { encoding: 'utf8' }).status;
        },
      );
      expect('value' in res).toBe(true);
      return status;
    };
    const stubProxy = async (): Promise<ProxyHandle> => {
      const srv = createServer((_q, r) => {
        r.end('ok');
      }).listen(0, '127.0.0.1');
      await new Promise((ok) => srv.once('listening', ok));
      const port = (srv.address() as { port: number }).port;
      return {
        port,
        sessionToken: 'tok',
        bindAddress: '127.0.0.1',
        stop: () => new Promise<void>((ok) => srv.close(() => ok())),
      };
    };

    it.skipIf(!process.env.AI_SDLC_UNTRUSTED_AGENT_IMAGE)(
      'denies outside files and other hosts, allows the proxy',
      async () => {
        const wt = mkdtempSync(join(tmpdir(), 'ua-wt-'));
        const outside = mkdtempSync(join(tmpdir(), 'ua-out-'));
        writeFileSync(join(outside, 'secret'), 's');
        expect(await runIn(`cat ${join(outside, 'secret')}`, wt, stubProxy)).not.toBe(0);
        expect(
          await runIn('wget -q -T 5 -O- http://example.com >/dev/null', wt, stubProxy),
        ).not.toBe(0);
        expect(
          await runIn('wget -q -T 5 -O- "$ANTHROPIC_BASE_URL" | grep -q ok', wt, stubProxy),
        ).toBe(0);
      },
    );
  },
);
