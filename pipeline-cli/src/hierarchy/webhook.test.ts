import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { HierarchyDeps } from './types.js';
import { forwarderLabel, forwarderPersistence, forwarderPlistPath } from './webhook-forwarder.js';
import {
  formatWebhookStatus,
  parseFeed,
  trackPrActivity,
  webhookDown,
  webhookHealth,
  webhookPersistence,
  webhookServe,
  webhookStatus,
  webhookUp,
} from './webhook.js';
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

  it('is healthy and quiet with no PR activity, even with no events', () => {
    receiver({ kind: 'none' });
    const h = webhookHealth(hd(), up);
    expect(h.class).toBe('healthy');
    expect(h.signals).toMatchObject({ quiet: true, lastEventAgeMin: null, forwarder: 'none' });
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
      'webhook: degraded (port 9, last event 45m, feed none, target http://127.0.0.1:9/webhooks/github)',
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

  it('falls back to a process match for the forwarder', () => {
    receiver({ kind: 'gh-forward' });
    const alive = hd({ run: () => ({ status: 0, stdout: '123\n', stderr: '' }) });
    expect(webhookHealth(alive, up).signals.forwarder).toBe('alive');
    expect(webhookHealth(hd(), up).signals.forwarder).toBe('dead');
    write('webhook.json', { pid: 1, port: 9 });
    expect(webhookHealth(hd(), up).signals.forwarder).toBe('unknown');
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
        return { status: launchAlive ? 0 : 1, stdout: '', stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    };
  const mkd = (env: NodeJS.ProcessEnv, launchAlive = true): HierarchyDeps =>
    ({ ...mk(env), now: () => new Date(), run: mkRun(launchAlive) }) as unknown as HierarchyDeps;

  beforeEach(() => {
    calls.length = 0;
    home = mkdtempSync(path.join(os.tmpdir(), 'wh-home-'));
  });
  afterEach(() => removeFixtureDir(home));

  it('refuses without the secret', () => {
    expect(() =>
      webhookUp(mkd({ HOME: home }), undefined, vi.fn(), { kind: 'gh-forward' }, 'darwin'),
    ).toThrow(/AI_SDLC_WEBHOOK_SECRET/);
  });

  it('deletes only cli hooks, writes the plist with --secret and loads it', () => {
    const spawner = vi.fn();
    const deps = mkd({ HOME: home, AI_SDLC_WEBHOOK_SECRET: 's3', AI_SDLC_WEBHOOK_PORT: '9001' });
    webhookUp(deps, undefined, spawner, { kind: 'gh-forward' }, 'darwin');
    const deletes = calls.filter((c) => c.includes('DELETE'));
    expect(deletes).toEqual([['gh', 'api', '-X', 'DELETE', 'repos/o/r/hooks/1']]);
    const label = forwarderLabel(deps);
    expect(label).toMatch(/^com\.ai-sdlc\.webhook\./);
    const plist = readFileSync(path.join(home, `Library/LaunchAgents/${label}.plist`), 'utf-8');
    expect(plist).toContain('<string>--secret</string>');
    expect(plist).toContain('<string>s3</string>');
    expect(plist).toContain('http://127.0.0.1:9001/webhooks/github');
    expect(calls.some((c) => c[0] === 'launchctl' && c[1] === 'bootstrap')).toBe(true);
    expect(spawner).toHaveBeenCalledWith(
      process.execPath,
      expect.arrayContaining(['--feed-agent', label]),
    );
  });

  it('prints the command off macOS and loads nothing', () => {
    const deps = mkd({ HOME: home, AI_SDLC_WEBHOOK_SECRET: 's3' });
    webhookUp(deps, undefined, vi.fn(), { kind: 'gh-forward' }, 'linux');
    expect(lines.join('\n')).toContain('no launchd here');
    expect(lines.join('\n')).not.toContain('s3');
    expect(calls.some((c) => c[0] === 'launchctl')).toBe(false);
  });

  it('fails when launchctl bootstrap fails or the repo is unresolved', () => {
    const base = mkd({ HOME: home, AI_SDLC_WEBHOOK_SECRET: 's3' });
    const bad = {
      ...base,
      run: (f: string, a: readonly string[]) =>
        f === 'launchctl' && a[0] === 'bootstrap'
          ? { status: 1, stdout: '', stderr: 'boom' }
          : mkRun()(f, a),
    } as unknown as HierarchyDeps;
    expect(() => webhookUp(bad, undefined, vi.fn(), { kind: 'gh-forward' }, 'darwin')).toThrow(
      /boom/,
    );
    const norepo = { ...base, run: () => ({ status: 1, stdout: '' }) } as unknown as HierarchyDeps;
    expect(() => webhookUp(norepo, undefined, vi.fn(), { kind: 'gh-forward' }, 'darwin')).toThrow(
      /cannot resolve/,
    );
  });

  it('recovers from bootstrap error 5 by bootout then one retry (AC-1)', () => {
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
    webhookUp(deps, undefined, vi.fn(), { kind: 'gh-forward' }, 'darwin');
    expect(boots).toBe(2);
    const boots2 = calls.filter((c) => c[0] === 'launchctl' && c[1] === 'bootout');
    expect(boots2.length).toBeGreaterThanOrEqual(2);
  });

  it('a second error 5 reports stderr, plist and manual commands, receiver still starts (AC-2)', () => {
    const base = mkd({ HOME: home, AI_SDLC_WEBHOOK_SECRET: 's3' });
    const deps = {
      ...base,
      run: (f: string, a: readonly string[]) =>
        f === 'launchctl' && a[0] === 'bootstrap'
          ? { status: 5, stdout: '', stderr: 'Bootstrap failed: 5: Input/output error' }
          : mkRun()(f, a),
    } as unknown as HierarchyDeps;
    const spawner = vi.fn();
    let msg = '';
    try {
      webhookUp(deps, undefined, spawner, { kind: 'gh-forward' }, 'darwin');
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain('Bootstrap failed: 5');
    expect(msg).toContain(forwarderPlistPath(deps));
    expect(msg).toContain('launchctl bootout gui/');
    expect(msg).toContain('launchctl bootstrap gui/');
    expect(spawner).toHaveBeenCalled();
  });

  it('labels are per board dir (AC-3)', () => {
    const a = forwarderLabel({ boardDir: '/x/one/dispatch' } as HierarchyDeps);
    const b = forwarderLabel({ boardDir: '/x/two/dispatch' } as HierarchyDeps);
    expect(a).not.toBe(b);
    expect(a).toMatch(/^com\.ai-sdlc\.webhook\.dispatch-[0-9a-f]{8}$/);
  });

  it('persistence line reads launchctl print (AC-4)', () => {
    const env = { HOME: home };
    expect(webhookPersistence(mkd(env, true))).toMatch(
      /^persisted: launchd com\.ai-sdlc\.webhook\./,
    );
    expect(webhookPersistence(mkd(env, false))).toMatch(/^persisted: no \(.* not loaded/);
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
    expect(readFileSync(path.join(dir, 'webhook-port'), 'utf-8').trim()).toBe('8766');
    // restart: 8765 now free again, the recorded port still wins
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

  it('installs the forwarder against the selected port', () => {
    const calls: string[][] = [];
    const t = up({}, [8765], { kind: 'gh-forward' });
    const deps = {
      ...t.deps,
      run: (f: string, a: string[]) => {
        calls.push([f, ...a]);
        return { status: 0, stdout: 'o/r', stderr: '' };
      },
    } as unknown as HierarchyDeps;
    webhookUp(deps, undefined, t.spawner, { kind: 'gh-forward' }, 'linux');
    expect(lines.join('\n')).toContain('--url http://127.0.0.1:8766/webhooks/github');
  });
});
