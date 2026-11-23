import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { HierarchyDeps } from './types.js';
import {
  forwarderAgentAlive,
  forwarderLabel,
  forwarderPersistence,
  forwarderPlistPath,
  installForwarder,
} from './webhook-forwarder.js';
import {
  formatWebhookForeign,
  formatWebhookStatus,
  parseFeed,
  trackPrActivity,
  webhookDown,
  webhookHealth,
  webhookPersistence,
  carriedFeed,
  webhookServe,
  webhookStatus,
  webhookUp,
} from './webhook.js';
import { agentPath, resolveRealGh } from './webhook-forwarder.js';
import { runWebhookHealthTick } from './webhook-health.js';
import { removeFixtureDir } from '../__test-helpers/remove-fixture-dir.js';

let dir: string;
let lines: string[];

const mk = (env: NodeJS.ProcessEnv, alive = true): HierarchyDeps =>
  ({
    boardDir: dir,
    cwd: dir,
    env,
    log: (l: string) => lines.push(l),
    isAlive: () => alive,
    isPortFree: () => true,
    probeWebhookIdentity: () => ({ repo: null, boardDir: dir }),
    binPath: '/bin/cli-hierarchy.mjs',
  }) as unknown as HierarchyDeps;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'wh-'));
  lines = [];
});
afterEach(() => removeFixtureDir(dir));

describe('cli-hierarchy webhook (AISDLC-880)', () => {
  it('reports off (no secret) without the secret and starts nothing', () => {
    const spawner = vi.fn();
    const deps = mk({});
    expect(formatWebhookStatus(webhookStatus(deps))).toBe('webhook: off (no secret)');
    webhookUp(deps, undefined, spawner);
    expect(spawner).not.toHaveBeenCalled();
  });

  it('spawns the serve process when the secret is set and nothing runs', () => {
    const spawner = vi.fn();
    const deps = mk({ AI_SDLC_WEBHOOK_SECRET: 'x', AI_SDLC_WEBHOOK_PORT: '9001' });
    expect(formatWebhookStatus(webhookStatus(deps))).toBe('webhook: off (not running)');
    webhookUp(deps, undefined, spawner);
    expect(spawner).toHaveBeenCalledWith(process.execPath, [
      '/bin/cli-hierarchy.mjs',
      'webhook',
      'serve',
      '--port',
      '9001',
      '--board-dir',
      dir,
    ]);
    // An unpinned start asks the receiver to scan upward.
    const unpinned = mk({ AI_SDLC_WEBHOOK_SECRET: 'x' });
    const sp2 = vi.fn();
    webhookUp(unpinned, undefined, sp2);
    expect(sp2.mock.calls[0]![1]).toEqual(expect.arrayContaining(['--scan', 'true']));
    webhookUp(deps, undefined, spawner, { kind: 'gh-forward', pid: 42 });
    expect(spawner).toHaveBeenLastCalledWith(
      process.execPath,
      expect.arrayContaining(['--feed', 'gh-forward', '--feed-pid', '42']),
    );
    expect(() => webhookUp(deps, '70000', spawner)).toThrow(/invalid webhook port/);
  });

  it('serves on 127.0.0.1, shows up with the port, and stops cleanly', async () => {
    const deps = mk({ AI_SDLC_WEBHOOK_SECRET: 'x' });
    const done = webhookServe(deps, '0');
    await vi.waitFor(() => expect(webhookStatus(deps).state).toBe('up'));
    const st = webhookStatus(deps);
    expect(formatWebhookStatus(st)).toMatch(
      /^webhook: running \(port \d+, target http:\/\/127\.0\.0\.1:\d+\/webhooks\/github, health not read\)$/,
    );
    const spawner = vi.fn();
    webhookUp(deps, undefined, spawner);
    expect(spawner).not.toHaveBeenCalled();
    process.emit('SIGTERM');
    await done;
    expect(existsSync(path.join(dir, 'webhook.json'))).toBe(false);
  });

  it('serve refuses without the secret; down handles absent and recorded receivers', () => {
    return expect(webhookServe(mk({})))
      .rejects.toThrow(/not set/)
      .then(() => {
        expect(webhookDown(mk({}))).toBe(false);
        writeFileSync(path.join(dir, 'webhook.json'), JSON.stringify({ pid: 99, port: 1 }));
        const kill = vi.fn();
        expect(webhookDown(mk({ AI_SDLC_WEBHOOK_SECRET: 'x' }), kill)).toBe(true);
        expect(kill).toHaveBeenCalledWith(99);
      });
  });
});

describe('webhook health (AISDLC-1157)', () => {
  const NOW = Date.parse('2026-11-02T12:00:00Z');
  const minsAgo = (m: number): Date => new Date(NOW - m * 60_000);
  const write = (name: string, o: unknown): void =>
    writeFileSync(path.join(dir, name), JSON.stringify(o));
  const event = (pr: number, ageMin: number): void => {
    mkdirSync(path.join(dir, 'events'), { recursive: true });
    const f = path.join(
      dir,
      'events',
      encodeURIComponent(`o/r#${pr}@abc:pull_request:d${pr}${ageMin}`) + '.json',
    );
    writeFileSync(f, '{}');
    utimesSync(f, minsAgo(ageMin), minsAgo(ageMin));
  };
  const activity = (pr: number, changedMinAgo: number): void =>
    write('webhook-pr-activity.json', {
      heads: { [String(pr)]: { head: 'h', changedAt: minsAgo(changedMinAgo).toISOString() } },
    });
  const hd = (opts: { alive?: boolean; run?: (f: string, a: readonly string[]) => unknown } = {}) =>
    ({
      ...mk({ AI_SDLC_WEBHOOK_SECRET: 'x' }, opts.alive ?? true),
      now: () => new Date(NOW),
      run: opts.run ?? (() => ({ status: 1, stdout: '', stderr: '' })),
    }) as unknown as HierarchyDeps;
  const receiver = (feed?: unknown): void =>
    write('webhook.json', { pid: 1, port: 9, ...(feed ? { feed } : {}) });
  const up = { probePort: () => true };

  it('is down when the receiver is dead, or its port does not answer', () => {
    expect(webhookHealth(hd(), up).class).toBe('down');
    receiver();
    expect(webhookHealth(hd({ alive: false }), up).signals.receiver).toBe(false);
    const h = webhookHealth(hd(), { probePort: () => false });
    expect(h.class).toBe('down');
    expect(h.reasons[0]).toMatch(/port 9/);
    expect(
      formatWebhookStatus(
        { state: 'off', reason: 'not running' },
        webhookHealth(hd({ alive: false }), up),
      ),
    ).toMatch(/^webhook: down/);
  });

  it('a loaded, not running agent keeps an open episode open (AC-7)', () => {
    receiver({ kind: 'gh-forward', agent: 'x.y' });
    const run = () => ({
      status: 0,
      stdout: 'state = spawn scheduled\n last exit code = 126\n',
      stderr: '',
    });
    const closeEpisode = vi.fn();
    writeFileSync(
      path.join(dir, 'webhook-health.json'),
      JSON.stringify({ class: 'degraded', since: 's' }),
    );
    const r = runWebhookHealthTick({
      boardDir: dir,
      now: () => new Date(NOW),
      health: () => webhookHealth(hd({ run }), up),
      closeEpisode,
    });
    expect(r.health?.class).toBe('degraded');
    expect(closeEpisode).not.toHaveBeenCalled();
  });

  it('a refused delivery degrades health naming the secret; an accepted event clears it (AC-8)', () => {
    receiver({ kind: 'none' });
    write('webhook-refused.json', { at: minsAgo(2).toISOString(), count: 3 });
    const h = webhookHealth(hd(), up);
    expect(h.class).toBe('degraded');
    expect(h.reasons.join(' ')).toMatch(/secret mismatch/);
    expect(h.signals.refusedDeliveries).toBe(3);
    event(1, 1);
    const after = webhookHealth(hd(), up);
    expect(after.class).toBe('healthy');
    expect(after.signals.refusedDeliveries).toBeUndefined();
  });

  it('is unverified, not healthy, with no events and no PR activity (AISDLC-1345)', () => {
    receiver({ kind: 'none' });
    const h = webhookHealth(hd(), up);
    expect(h.class).toBe('unverified');
    expect(h.signals).toMatchObject({ quiet: true, lastEventAgeMin: null, forwarder: 'none' });
  });

  it('is not healthy with no events and recent PR activity either (AISDLC-1345)', () => {
    receiver({ kind: 'none' });
    activity(7, 10);
    expect(webhookHealth(hd(), up).class).not.toBe('healthy');
  });

  it('reports the newest event time and the recorded port (AISDLC-1345)', () => {
    receiver({ kind: 'none' });
    event(1, 5);
    const h = webhookHealth(hd(), up);
    expect(h.class).toBe('healthy');
    expect(typeof h.signals.lastEventAt).toBe('string');
    expect(h.signals.receiverPort).toBeDefined();
  });

  it('is degraded when a PR changed, no event for the stale window', () => {
    receiver({ kind: 'none' });
    activity(7, 10);
    event(8, 45);
    const h = webhookHealth(hd(), up);
    expect(h.class).toBe('degraded');
    expect(h.signals).toMatchObject({
      prActivityWithoutEvent: true,
      lastEventAgeMin: 45,
      quiet: false,
    });
    expect(formatWebhookStatus({ state: 'up', port: 9, pid: 1 }, h)).toBe(
      'webhook: degraded (port 9, repo unknown, last event 45m, feed none, target http://127.0.0.1:9/webhooks/github)',
    );
  });

  it('stays healthy when the event for the changed PR arrived', () => {
    receiver({ kind: 'none' });
    activity(7, 10);
    event(7, 5);
    expect(webhookHealth(hd(), up).class).toBe('healthy');
  });

  it('is down after the down window with PR activity inside it', () => {
    receiver({ kind: 'none' });
    activity(7, 100);
    event(7, 200);
    const h = webhookHealth(hd(), up);
    expect(h.class).toBe('down');
    expect(formatWebhookStatus({ state: 'up', port: 9, pid: 1 }, h)).toContain('last event 3h');
  });

  it('is degraded when the recorded forwarder pid is gone while the receiver is up', () => {
    receiver({ kind: 'gh-forward', pid: 5 });
    const deps = hd();
    (deps as { isAlive: (p: number) => boolean }).isAlive = (p) => p === 1;
    const h = webhookHealth(deps, up);
    expect(h.class).toBe('degraded');
    expect(h.signals.forwarder).toBe('dead');
  });

  it('reads liveness from this board record only, never a process match', () => {
    const other = vi.fn(() => ({ status: 0, stdout: '123\n', stderr: '' }));
    write('webhook.json', { pid: 1, port: 9 });
    const h = webhookHealth(hd({ run: other }), up);
    expect(h.signals.forwarder).toBe('unknown');
    expect(h.signals.feed).toBe('none');
    expect(other.mock.calls.some((c) => (c as unknown[])[0] === 'pgrep')).toBe(false);
    receiver({ kind: 'gh-forward' });
    expect(webhookHealth(hd({ run: other }), up).signals.forwarder).toBe('dead');
    receiver({ kind: 'gh-forward', pid: 1 });
    expect(webhookHealth(hd(), up).signals.forwarder).toBe('alive');
  });

  it('probes the port through run and tracks PR activity from the snapshot', () => {
    receiver();
    const ok = hd({ run: () => ({ status: 0, stdout: '', stderr: '' }) });
    expect(webhookHealth(ok).signals.port).toBe(true);
    write('pr-snapshot.json', {
      prs: [
        { number: 1, headRefOid: 'a' },
        { number: 2, headRefOid: 'b' },
      ],
    });
    trackPrActivity(dir, new Date(NOW));
    write('pr-snapshot.json', { prs: [{ number: 1, headRefOid: 'a2' }] });
    trackPrActivity(dir, new Date(NOW + 60_000));
    const st = JSON.parse(readFileSync(path.join(dir, 'webhook-pr-activity.json'), 'utf-8'));
    expect(st.heads['1'].head).toBe('a2');
    expect(st.lastClosedAt).toBeUndefined();
    trackPrActivity(path.join(dir, 'nope'), new Date(NOW));
  });

  it('parses the feed flag', () => {
    expect(parseFeed(undefined)).toBeUndefined();
    expect(parseFeed('tunnel', '9')).toEqual({ kind: 'tunnel', pid: 9 });
    expect(parseFeed('none')).toEqual({ kind: 'none' });
    expect(() => parseFeed('carrier-pigeon')).toThrow(/invalid webhook feed/);
  });
});

describe('supervised gh forwarder (AISDLC-1207)', () => {
  let home: string;
  const calls: string[][] = [];
  const hooks = [
    { id: 1, name: 'cli' },
    { id: 2, name: 'web' },
  ];
  const mkRun =
    (launchAlive = true) =>
    (file: string, args: readonly string[]) => {
      calls.push([file, ...args]);
      if (file === 'gh' && args[0] === 'repo') return { status: 0, stdout: 'o/r\n', stderr: '' };
      if (file === 'gh' && args[0] === 'api' && args[1] === 'repos/o/r/hooks')
        return { status: 0, stdout: JSON.stringify(hooks), stderr: '' };
      if (file === 'launchctl' && args[0] === 'print')
        return { status: launchAlive ? 0 : 1, stdout: 'state = running\n', stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    };
  const mkd = (env: NodeJS.ProcessEnv, launchAlive = true): HierarchyDeps =>
    ({
      ...mk({ PATH: '/opt/bin:/usr/bin', ...env }),
      now: () => new Date(),
      run: mkRun(launchAlive),
      isExecutable: (f: string) => f === '/opt/bin/gh',
      sleepMs: () => undefined,
    }) as unknown as HierarchyDeps;

  beforeEach(() => {
    calls.length = 0;
    home = mkdtempSync(path.join(os.tmpdir(), 'wh-home-'));
  });
  afterEach(() => removeFixtureDir(home));

  /** Run the receiver in-process with a gh-forward feed; resolves once it is bound and recorded, then stops it. */
  const serveFwd = async (
    d: HierarchyDeps,
    platform: NodeJS.Platform = 'darwin',
    port = '0',
  ): Promise<void> => {
    const done = webhookServe(d, port, { kind: 'gh-forward' }, { platform });
    const early = await Promise.race([
      done.then(
        () => undefined,
        (e: Error) => e,
      ),
      vi
        .waitFor(() => {
          if (!existsSync(path.join(dir, 'webhook.json'))) throw new Error('not yet');
        })
        .then(() => undefined),
    ]);
    if (early) throw early;
    process.emit('SIGTERM');
    await done;
  };

  it('refuses without the secret', () => {
    expect(() =>
      webhookUp(mkd({ HOME: home }), undefined, vi.fn(), { kind: 'gh-forward' }, 'darwin'),
    ).toThrow(/AI_SDLC_WEBHOOK_SECRET/);
  });

  it('deletes only cli hooks, writes the plist with --secret and loads it', async () => {
    const deps = mkd({ HOME: home, AI_SDLC_WEBHOOK_SECRET: 's3' });
    await serveFwd(deps, 'darwin', '19001');
    const deletes = calls.filter((c) => c.includes('DELETE'));
    expect(deletes).toEqual([['gh', 'api', '-X', 'DELETE', 'repos/o/r/hooks/1']]);
    const label = forwarderLabel(deps);
    expect(label).toMatch(/^com\.ai-sdlc\.webhook\./);
    const plist = readFileSync(path.join(home, `Library/LaunchAgents/${label}.plist`), 'utf-8');
    expect(plist).toContain('<string>--secret</string>');
    expect(plist).toContain('<string>s3</string>');
    expect(plist).toContain('http://127.0.0.1:19001/webhooks/github');
    expect(calls.some((c) => c[0] === 'launchctl' && c[1] === 'bootstrap')).toBe(true);
  });

  it('plist runs the absolute real gh, no env, and no board bin on PATH (AC-1, AC-2)', async () => {
    const base = mkd({ HOME: home, AI_SDLC_WEBHOOK_SECRET: 's3' });
    const deps = {
      ...base,
      env: { ...base.env, PATH: `${dir}/bin:/opt/bin:/usr/bin` },
    } as HierarchyDeps;
    await serveFwd(deps);
    const plist = readFileSync(
      path.join(home, `Library/LaunchAgents/${forwarderLabel(deps)}.plist`),
      'utf-8',
    );
    expect(plist).toContain('<array>\n    <string>/opt/bin/gh</string>');
    expect(plist).not.toContain('/usr/bin/env');
    expect(plist).toContain('<key>PATH</key><string>/opt/bin:/usr/bin</string>');
    expect(plist).not.toContain(`${dir}/bin`);
  });

  it('fails naming gh when only the board wrapper exists (AC-3)', async () => {
    const base = mkd({ HOME: home, AI_SDLC_WEBHOOK_SECRET: 's3' });
    const deps = {
      ...base,
      env: { ...base.env, PATH: `${dir}/bin:/usr/bin` },
      isExecutable: (f: string) => f === `${dir}/bin/gh`,
    } as HierarchyDeps;
    await expect(serveFwd(deps)).rejects.toThrow(/real gh/);
    expect(calls.some((c) => c[0] === 'launchctl')).toBe(false);
  });

  const crashLoop = {
    status: 0,
    stdout: 'state = spawn scheduled\n\tlast exit code = 126\n',
    stderr: '',
  };
  const crashing = (extra: Record<string, string> = {}): HierarchyDeps => {
    const base = mkd({ HOME: home, AI_SDLC_WEBHOOK_SECRET: 's3', ...extra });
    const run = base.run;
    return {
      ...base,
      run: (f: string, a: readonly string[]) =>
        f === 'launchctl' && a[0] === 'print' ? crashLoop : run(f, a),
    } as HierarchyDeps;
  };

  it('a loaded crash-looping agent is not alive, dead, not healthy, not persisted (AC-4, AC-5)', () => {
    const deps = crashing();
    expect(forwarderAgentAlive(deps)).toBe(false);
    writeFileSync(
      path.join(dir, 'webhook.json'),
      JSON.stringify({ pid: 99, port: 1, feed: { kind: 'gh-forward', agent: 'x.y' } }),
    );
    const h = webhookHealth(deps, { probePort: () => true });
    expect(h.signals.forwarder).toBe('dead');
    expect(h.class).not.toBe('healthy');
    const line = webhookPersistence(deps, 'darwin');
    expect(line).toMatch(/^persisted: no \(.*last exit 126/);
    expect(line).not.toContain('persisted: launchd');
  });

  it('a forwarder that is not running is logged with the log tail and recorded without an agent (AC-6)', async () => {
    const deps = crashing();
    writeFileSync(path.join(dir, 'webhook-forward.log'), 'sh: gh: Operation not permitted\n');
    await serveFwd(deps);
    expect(lines.join('\n')).toMatch(/not running/);
    let msg = '';
    try {
      installForwarder(deps, 's3', 9001, 'darwin');
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain('last exit code = 126');
    expect(msg).toContain('Operation not permitted');
    expect(lines.join('\n')).not.toContain('loaded for');
  });

  it('prints the command off macOS and loads nothing', async () => {
    const deps = mkd({ HOME: home, AI_SDLC_WEBHOOK_SECRET: 's3' });
    await serveFwd(deps, 'linux');
    expect(lines.join('\n')).toContain('no launchd here');
    expect(lines.join('\n')).not.toContain('s3');
    expect(calls.some((c) => c[0] === 'launchctl')).toBe(false);
  });

  it('logs when launchctl bootstrap fails; fails when the repo is unresolved', async () => {
    const base = mkd({ HOME: home, AI_SDLC_WEBHOOK_SECRET: 's3' });
    const bad = {
      ...base,
      run: (f: string, a: readonly string[]) =>
        f === 'launchctl' && a[0] === 'bootstrap'
          ? { status: 1, stdout: '', stderr: 'boom' }
          : mkRun()(f, a),
    } as unknown as HierarchyDeps;
    await serveFwd(bad);
    expect(lines.join('\n')).toContain('boom');
    rmSync(path.join(dir, 'webhook.json'), { force: true });
    const norepo = { ...base, run: () => ({ status: 1, stdout: '' }) } as unknown as HierarchyDeps;
    await expect(serveFwd(norepo)).rejects.toThrow(/cannot resolve/);
  });

  it('recovers from bootstrap error 5 by bootout then one retry (AC-1)', async () => {
    const base = mkd({ HOME: home, AI_SDLC_WEBHOOK_SECRET: 's3' });
    let boots = 0;
    const deps = {
      ...base,
      run: (f: string, a: readonly string[]) => {
        if (f === 'launchctl' && a[0] === 'bootstrap') {
          boots += 1;
          calls.push([f, ...a]);
          return boots === 1
            ? { status: 5, stdout: '', stderr: 'Bootstrap failed: 5: Input/output error' }
            : { status: 0, stdout: '', stderr: '' };
        }
        return mkRun()(f, a);
      },
    } as unknown as HierarchyDeps;
    await serveFwd(deps);
    expect(boots).toBe(2);
    const boots2 = calls.filter((c) => c[0] === 'launchctl' && c[1] === 'bootout');
    expect(boots2.length).toBeGreaterThanOrEqual(2);
  });

  it('a second error 5 reports stderr, plist and manual commands, receiver still starts (AC-2)', async () => {
    const base = mkd({ HOME: home, AI_SDLC_WEBHOOK_SECRET: 's3' });
    const deps = {
      ...base,
      run: (f: string, a: readonly string[]) =>
        f === 'launchctl' && a[0] === 'bootstrap'
          ? { status: 5, stdout: '', stderr: 'Bootstrap failed: 5: Input/output error' }
          : mkRun()(f, a),
    } as unknown as HierarchyDeps;
    await serveFwd(deps);
    const msg = lines.join('\n');
    expect(msg).toContain('Bootstrap failed: 5');
    expect(msg).toContain(forwarderPlistPath(deps));
    expect(msg).toContain('launchctl bootout gui/');
    expect(msg).toContain('launchctl bootstrap gui/');
  });

  it('labels are per board dir (AC-3)', () => {
    const a = forwarderLabel({ boardDir: '/x/one/dispatch' } as HierarchyDeps);
    const b = forwarderLabel({ boardDir: '/x/two/dispatch' } as HierarchyDeps);
    expect(a).not.toBe(b);
    expect(a).toMatch(/^com\.ai-sdlc\.webhook\.dispatch-[0-9a-f]{8}$/);
  });

  it('persistence line reads launchctl print (AC-4)', () => {
    const env = { HOME: home };
    expect(webhookPersistence(mkd(env, true), 'darwin')).toMatch(
      /^persisted: launchd com\.ai-sdlc\.webhook\./,
    );
    expect(webhookPersistence(mkd(env, false), 'darwin')).toMatch(
      /^persisted: no \(\S+ not installed\)$/,
    );
    expect(forwarderPersistence(mkd(env), undefined, 'linux')).toMatch(/^persisted: no/);
    const boom = {
      ...mkd(env),
      run: () => {
        throw new Error('x');
      },
    } as unknown as HierarchyDeps;
    expect(webhookPersistence(boom)).toContain('persisted: no');
  });

  it('status reads the agent label; down unloads and removes leftover hooks', () => {
    writeFileSync(
      path.join(dir, 'webhook.json'),
      JSON.stringify({
        pid: 99,
        port: 1,
        feed: { kind: 'gh-forward', agent: 'io.ai-sdlc.webhook-forward' },
      }),
    );
    const env = { HOME: home, AI_SDLC_WEBHOOK_SECRET: 's3' };
    const up = webhookHealth(mkd(env, true), { probePort: () => true });
    expect(up.signals.forwarder).toBe('alive');
    const dead = webhookHealth(mkd(env, false), { probePort: () => true });
    expect(dead.signals.forwarder).toBe('dead');
    webhookDown(mkd(env), vi.fn());
    expect(calls.some((c) => c[0] === 'launchctl' && c[1] === 'bootout')).toBe(true);
    expect(calls.some((c) => c.includes('DELETE'))).toBe(true);
  });

  it('parses --feed-agent', () => {
    expect(parseFeed('gh-forward', undefined, 'x')).toEqual({ kind: 'gh-forward', agent: 'x' });
  });
});

describe('webhook per-project port selection (AISDLC-1254)', () => {
  const up = (env: NodeJS.ProcessEnv, held: number[], feed?: Parameters<typeof webhookUp>[3]) => {
    const spawner = vi.fn();
    const deps = {
      ...mk({ AI_SDLC_WEBHOOK_SECRET: 'x', ...env }, false),
      isPortFree: (p: number) => !held.includes(p),
      run: () => ({ status: 0, stdout: 'p4242\ncnode\n', stderr: '' }),
    } as unknown as HierarchyDeps;
    return { spawner, deps, run: () => webhookUp(deps, undefined, spawner, feed, 'linux') };
  };
  const portArg = (s: ReturnType<typeof vi.fn>): string => {
    const a = s.mock.calls[0]![1] as string[];
    return a[a.indexOf('--port') + 1]!;
  };

  it('uses the default port when it is free', () => {
    const t = up({}, []);
    t.run();
    expect(portArg(t.spawner)).toBe('8765');
  });

  it('picks the next free port when the default is held, and reuses it on restart', () => {
    const t = up({}, [8765]);
    t.run();
    expect(portArg(t.spawner)).toBe('8766');
    // the receiver records the port once bound; 8765 is free again and the recorded port wins
    writeFileSync(path.join(dir, 'webhook-port'), '8766\n');
    const t2 = up({}, []);
    t2.run();
    expect(portArg(t2.spawner)).toBe('8766');
  });

  it('lets AI_SDLC_WEBHOOK_PORT pin the port over automatic selection', () => {
    const t = up({ AI_SDLC_WEBHOOK_PORT: '9100' }, [8765]);
    t.run();
    expect(portArg(t.spawner)).toBe('9100');
  });

  it('fails clearly when a pinned port is held', () => {
    const t = up({ AI_SDLC_WEBHOOK_PORT: '9100' }, [9100]);
    expect(t.run).toThrow(/port 9100 is held by node \(pid 4242\)/);
  });

  it('fails with the port and owner when every candidate is held, and status reports a collision', () => {
    const held = Array.from({ length: 20 }, (_, i) => 8765 + i);
    const t = up({}, held);
    expect(t.run).toThrow(
      /no free webhook port in 8765-8784: port 8765 is held by node \(pid 4242\)/,
    );
    expect(t.spawner).not.toHaveBeenCalled();
    const w = webhookStatus(t.deps);
    expect(w).toMatchObject({ state: 'off', reason: 'port collision' });
    expect(formatWebhookStatus(w)).toMatch(/^webhook: collision \(.*port 8765 is held by node/);
  });

  it('builds the forwarder URL from the recorded port and status prints it', async () => {
    const { webhookTargetUrl } = await import('./webhook.js');
    expect(webhookTargetUrl(8766)).toBe('http://127.0.0.1:8766/webhooks/github');
    const line = formatWebhookStatus({ state: 'up', port: 8766, pid: 1 }, {
      class: 'healthy',
      reasons: [],
      signals: { lastEventAgeMin: 1, feed: 'gh-forward' },
    } as unknown as Parameters<typeof formatWebhookStatus>[1]);
    expect(line).toContain('target http://127.0.0.1:8766/webhooks/github');
  });

  it('a failed free-port probe counts the port as busy (AC-5)', () => {
    const deps = {
      ...mk({ AI_SDLC_WEBHOOK_SECRET: 'x' }, false),
      isPortFree: undefined,
      run: () => {
        throw new Error('no node');
      },
    } as unknown as HierarchyDeps;
    expect(() => webhookUp(deps, undefined, vi.fn(), undefined, 'linux')).toThrow(
      /no free webhook port/,
    );
  });

  it('a pinned port that binds is written to webhook-port; a held one fails (AC-7)', async () => {
    const deps = mk({ AI_SDLC_WEBHOOK_SECRET: 'x' });
    const done = webhookServe(deps, '0');
    await vi.waitFor(() => expect(webhookStatus(deps).state).toBe('up'));
    const port = readFileSync(path.join(dir, 'webhook-port'), 'utf-8').trim();
    expect(Number(port)).toBeGreaterThan(0);
    process.emit('SIGTERM');
    await done;
    const held = await holdPort();
    try {
      await expect(webhookServe(deps, String(held.port))).rejects.toThrow(
        /cannot bind webhook port: port \d+ is held/,
      );
    } finally {
      held.close();
    }
  });
});

/** Hold a real 127.0.0.1 port. */
async function holdPort(): Promise<{ port: number; close: () => void }> {
  const net = await import('node:net');
  const srv = net.createServer();
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  return { port: (srv.address() as { port: number }).port, close: () => srv.close() };
}

describe('receiver binds first, then records and installs (AISDLC-1350)', () => {
  let home: string;
  const calls: string[][] = [];
  const mkd = (): HierarchyDeps =>
    ({
      ...mk({ PATH: '/opt/bin:/usr/bin', HOME: home, AI_SDLC_WEBHOOK_SECRET: 's3' }),
      now: () => new Date(),
      run: (f: string, a: readonly string[]) => {
        calls.push([f, ...a]);
        if (f === 'gh' && a[0] === 'repo') return { status: 0, stdout: 'o/r\n', stderr: '' };
        if (f === 'gh') return { status: 0, stdout: '[]', stderr: '' };
        if (f === 'launchctl' && a[0] === 'print')
          return { status: 0, stdout: 'state = running\n', stderr: '' };
        return { status: 0, stdout: '', stderr: '' };
      },
      isExecutable: (f: string) => f === '/opt/bin/gh',
      sleepMs: () => undefined,
    }) as unknown as HierarchyDeps;
  beforeEach(() => {
    calls.length = 0;
    home = mkdtempSync(path.join(os.tmpdir(), 'wh-home-'));
  });
  afterEach(() => removeFixtureDir(home));

  const stopWhenUp = async (done: Promise<void>): Promise<void> => {
    await vi.waitFor(() => expect(existsSync(path.join(dir, 'webhook.json'))).toBe(true));
    process.emit('SIGTERM');
    await done;
  };
  const bootstraps = (): string[][] =>
    calls.filter((c) => c[0] === 'launchctl' && c[1] === 'bootstrap');

  it('binds the next free port when the recorded one is held and names it everywhere (AC-3, AC-4)', async () => {
    const held = await holdPort();
    try {
      const deps = mkd();
      const done = webhookServe(
        deps,
        String(held.port),
        { kind: 'gh-forward' },
        {
          scan: true,
          platform: 'darwin',
        },
      );
      await vi.waitFor(() => expect(existsSync(path.join(dir, 'webhook.json'))).toBe(true));
      const state = JSON.parse(readFileSync(path.join(dir, 'webhook.json'), 'utf-8'));
      expect(state.port).not.toBe(held.port);
      expect(state.feed.agent).toBe(forwarderLabel(deps));
      expect(readFileSync(path.join(dir, 'webhook-port'), 'utf-8').trim()).toBe(String(state.port));
      const plist = readFileSync(
        path.join(home, `Library/LaunchAgents/${forwarderLabel(deps)}.plist`),
        'utf-8',
      );
      expect(plist).toContain(`http://127.0.0.1:${state.port}/webhooks/github`);
      expect(plist).not.toContain(`:${held.port}/`);
      // one forwarder install, after the bind; nothing was recorded for the failed port
      expect(bootstraps()).toHaveLength(1);
      process.emit('SIGTERM');
      await done;
    } finally {
      held.close();
    }
  });

  it('a pinned held port installs no forwarder and records no port (AC-4, AC-7)', async () => {
    const held = await holdPort();
    try {
      await expect(
        webhookServe(mkd(), String(held.port), { kind: 'gh-forward' }, { platform: 'darwin' }),
      ).rejects.toThrow(/cannot bind webhook port/);
      expect(bootstraps()).toHaveLength(0);
      expect(existsSync(path.join(dir, 'webhook-port'))).toBe(false);
    } finally {
      held.close();
    }
  });

  it('plain up after a receiver exit carries the recorded gh-forward feed (AC-1)', () => {
    writeFileSync(
      path.join(dir, 'webhook.json'),
      JSON.stringify({ pid: 99, port: 8765, feed: { kind: 'gh-forward', agent: 'fwd' } }),
    );
    const spawner = vi.fn();
    const deps = { ...mk({ AI_SDLC_WEBHOOK_SECRET: 'x' }, false) } as HierarchyDeps;
    webhookUp(deps, undefined, spawner, undefined, 'darwin');
    expect(spawner.mock.calls[0]![1]).toEqual(expect.arrayContaining(['--feed', 'gh-forward']));
  });

  it('a recorded machine-wide label is replaced by the per-board one with one old bootout (AC-8)', async () => {
    const deps = mkd();
    writeFileSync(
      path.join(dir, 'webhook.json'),
      JSON.stringify({
        pid: 99,
        port: 1,
        feed: { kind: 'gh-forward', agent: 'io.ai-sdlc.webhook-forward' },
      }),
    );
    const done = webhookServe(
      deps,
      '0',
      carriedFeed({ kind: 'gh-forward', agent: 'io.ai-sdlc.webhook-forward' }),
      {
        platform: 'darwin',
      },
    );
    await vi.waitFor(() =>
      expect(JSON.parse(readFileSync(path.join(dir, 'webhook.json'), 'utf-8')).pid).toBe(
        process.pid,
      ),
    );
    const state = JSON.parse(readFileSync(path.join(dir, 'webhook.json'), 'utf-8'));
    expect(state.feed.agent).toBe(forwarderLabel(deps));
    expect(
      calls.filter((c) => c[1] === 'bootout' && c[2].endsWith('/io.ai-sdlc.webhook-forward')),
    ).toHaveLength(1);
    await stopWhenUp(done);
  });

  it('a running receiver with the machine-wide label is re-pointed in place (AC-8)', () => {
    const deps = mkd();
    writeFileSync(
      path.join(dir, 'webhook.json'),
      JSON.stringify({
        pid: 99,
        port: 8765,
        feed: { kind: 'gh-forward', agent: 'io.ai-sdlc.webhook-forward' },
      }),
    );
    webhookUp(deps, undefined, vi.fn(), undefined, 'darwin');
    const state = JSON.parse(readFileSync(path.join(dir, 'webhook.json'), 'utf-8'));
    expect(state.feed.agent).toBe(forwarderLabel(deps));
    expect(
      calls.filter((c) => c[1] === 'bootout' && c[2].endsWith('/io.ai-sdlc.webhook-forward')),
    ).toHaveLength(1);
  });
});

describe('board identity (AISDLC-1349)', () => {
  const NOW = Date.parse('2026-11-02T12:00:00Z');
  const hd = (identity: unknown, spawnless = true) =>
    ({
      ...mk({ AI_SDLC_WEBHOOK_SECRET: 'x' }),
      now: () => new Date(NOW),
      run: () => ({ status: 1, stdout: '', stderr: '' }),
      isPortFree: () => spawnless,
      probeWebhookIdentity: () => identity,
    }) as unknown as HierarchyDeps;
  const record = (extra: object = {}): void =>
    writeFileSync(path.join(dir, 'webhook.json'), JSON.stringify({ pid: 1, port: 9, ...extra }));
  const up = { probePort: () => true };

  it('reads the repository as unknown when none is recorded, and names it when recorded', () => {
    record();
    const own = { repo: null, boardDir: dir };
    const h = webhookHealth(hd(own), up);
    expect(h.repo).toBeUndefined();
    expect(formatWebhookStatus({ state: 'up', port: 9, pid: 1 }, h)).toContain('repo unknown');
    record({ repo: 'o/a' });
    const named = webhookHealth(hd(own), up);
    expect(named.repo).toBe('o/a');
    expect(formatWebhookStatus({ state: 'up', port: 9, pid: 1 }, named)).toContain('repo o/a');
  });

  it('a live pid whose port answers as another board, or not at all, is not up and webhookUp starts one', () => {
    record({ repo: 'o/a' });
    const other = { repo: 'o/b', boardDir: '/some/other/board' };
    const h = webhookHealth(hd(other), up);
    expect(h.class).toBe('down');
    expect(h.signals.receiver).toBe(false);
    expect(h.reasons[0]).toMatch(/another board.*o\/b/);
    const silent = webhookHealth(hd(undefined), up);
    expect(silent.class).toBe('down');
    expect(silent.reasons[0]).toMatch(/does not answer \/health/);
    const st = webhookStatus(hd(other));
    expect(st).toMatchObject({ state: 'off', reason: 'foreign listener' });
    expect(formatWebhookStatus(st)).toMatch(/^webhook: down \(.*another board/);
    expect(webhookStatus(hd(undefined))).toMatchObject({ reason: 'foreign listener' });
    const spawner = vi.fn();
    webhookUp(hd(other), undefined, spawner);
    expect(spawner).toHaveBeenCalledTimes(1);
  });

  it('the default identity probe asks /health through run and parses the answer', () => {
    record({ repo: 'o/a' });
    const via = (r: unknown): HierarchyDeps =>
      ({
        ...hd(undefined),
        probeWebhookIdentity: undefined,
        run: () => r,
      }) as unknown as HierarchyDeps;
    const ok = JSON.stringify({ status: 'ok', repo: 'o/a', boardDir: dir });
    expect(webhookStatus(via({ status: 0, stdout: ok }))).toMatchObject({ state: 'up' });
    const foreign = JSON.stringify({ repo: null, boardDir: '/x' });
    expect(webhookStatus(via({ status: 0, stdout: foreign }))).toMatchObject({
      reason: 'foreign listener',
    });
    expect(webhookStatus(via({ status: 1, stdout: '' }))).toMatchObject({ state: 'off' });
    expect(webhookStatus(via({ status: 0, stdout: 'not json' }))).toMatchObject({ state: 'off' });
    expect(webhookStatus(via({ status: 0, stdout: '{"status":"ok"}' }))).toMatchObject({
      state: 'off',
    });
  });

  it('events of another repository do not count as this board last event', () => {
    record({ repo: 'o/a' });
    mkdirSync(path.join(dir, 'events'), { recursive: true });
    const f = path.join(dir, 'events', encodeURIComponent('o/b#3@abc:pull_request:d1') + '.json');
    writeFileSync(f, '{}');
    const h = webhookHealth(hd({ repo: 'o/a', boardDir: dir }), up);
    expect(h.signals.lastEventAt).toBeUndefined();
  });

  it('status prints the refused foreign deliveries, and nothing when there are none', () => {
    record({ repo: 'o/a' });
    const own = { repo: 'o/a', boardDir: dir };
    expect(formatWebhookForeign(webhookHealth(hd(own), up))).toEqual([]);
    expect(formatWebhookForeign(undefined)).toEqual([]);
    writeFileSync(
      path.join(dir, 'webhook-foreign.json'),
      JSON.stringify({ at: 'x', count: 3, repo: 'o/b' }),
    );
    const lines = formatWebhookForeign(webhookHealth(hd(own), up));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/3 delivery\(ies\) refused for repository o\/b.*o\/a/);
  });
});

describe('per-board isolation (AISDLC-1376)', () => {
  it('uses the real gh when another board wrapper is first on PATH (AC-1)', () => {
    const other = '/repos/other/.ai-sdlc/dispatch/bin';
    const deps = {
      ...mk({ PATH: `${other}:/opt/bin:/usr/bin` }),
      isExecutable: (f: string) => f === `${other}/gh` || f === '/opt/bin/gh',
    } as unknown as HierarchyDeps;
    expect(agentPath(deps)).toBe('/opt/bin:/usr/bin');
    expect(resolveRealGh(deps)).toBe('/opt/bin/gh');
  });

  it('two back-to-back up calls spawn one receiver (AC-2)', () => {
    const spawner = vi.fn(() => 4242);
    const deps = {
      ...mk({ AI_SDLC_WEBHOOK_SECRET: 'x', AI_SDLC_WEBHOOK_PORT: '9001' }),
      now: () => new Date(),
    } as unknown as HierarchyDeps;
    webhookUp(deps, undefined, spawner);
    webhookUp(deps, undefined, spawner);
    expect(spawner).toHaveBeenCalledTimes(1);
    expect(lines).toContain('webhook already starting for this board');
  });

  it('spawns again once the starting marker is stale', () => {
    const spawner = vi.fn();
    writeFileSync(path.join(dir, 'webhook-starting'), `4242 ${Date.now() - 60_000}\n`);
    const deps = {
      ...mk({ AI_SDLC_WEBHOOK_SECRET: 'x', AI_SDLC_WEBHOOK_PORT: '9001' }),
      now: () => new Date(),
    } as unknown as HierarchyDeps;
    webhookUp(deps, undefined, spawner);
    expect(spawner).toHaveBeenCalledTimes(1);
  });

  it('a receiver whose pid is not recorded leaves webhook.json on stop (AC-3)', async () => {
    const deps = {
      ...mk({ AI_SDLC_WEBHOOK_SECRET: 's3', HOME: dir, PATH: '/usr/bin' }),
      now: () => new Date(),
      run: () => ({ status: 0, stdout: '[]', stderr: '' }),
    } as unknown as HierarchyDeps;
    const done = webhookServe(deps, '0', undefined, { scan: true });
    await vi.waitFor(() => expect(existsSync(path.join(dir, 'webhook.json'))).toBe(true));
    const live = { pid: process.pid + 1, port: 1 };
    writeFileSync(path.join(dir, 'webhook.json'), JSON.stringify(live) + '\n');
    process.emit('SIGTERM');
    await done;
    expect(JSON.parse(readFileSync(path.join(dir, 'webhook.json'), 'utf-8'))).toEqual(live);
  });
});
