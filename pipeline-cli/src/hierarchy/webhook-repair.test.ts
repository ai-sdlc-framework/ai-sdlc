import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { removeFixtureDir } from '../__test-helpers/remove-fixture-dir.js';
import type { HierarchyDeps } from './types.js';
import { forwarderLabel, forwarderPersistence, forwarderPlistPath } from './webhook-forwarder.js';
import { runWebhookHealthTick, type WebhookEscalationInput } from './webhook-health.js';
import { makeWebhookRepair, redactSecrets } from './webhook-repair.js';
import type { WebhookHealth } from './webhook.js';

let dir: string;
let home: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'whr-'));
  home = mkdtempSync(path.join(os.tmpdir(), 'whr-home-'));
});
afterEach(() => {
  removeFixtureDir(dir);
  removeFixtureDir(home);
});

const T0 = Date.parse('2026-11-02T12:00:00Z');
let nowMs = T0;
const at = (min: number): void => {
  nowMs = T0 + min * 60_000;
};

type Call = [string, readonly string[]];
const setup = (
  opts: {
    secret?: string;
    feed?: unknown;
    plist?: 'current' | 'old' | 'none';
    printOut?: string;
  } = {},
) => {
  nowMs = T0;
  const calls: Call[] = [];
  const secret = 'secret' in opts ? opts.secret : 'abc123';
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    ...(secret ? { AI_SDLC_WEBHOOK_SECRET: secret } : {}),
  };
  const deps = {
    boardDir: dir,
    cwd: dir,
    env,
    log: () => undefined,
    now: () => new Date(nowMs),
    isExecutable: (f: string) => f === '/usr/bin/gh',
    sleepMs: () => undefined,
    run: (f: string, a: readonly string[]): unknown => {
      calls.push([f, a]);
      if (f === 'gh' && a[0] === 'repo') return { status: 0, stdout: 'o/r\n', stderr: '' };
      if (f === 'gh') return { status: 0, stdout: '[]', stderr: '' };
      if (f === 'launchctl' && a[0] === 'print')
        return { status: 0, stdout: opts.printOut ?? 'state = running\n', stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    },
  } as unknown as HierarchyDeps;
  const label = forwarderLabel(deps);
  const feed = 'feed' in opts ? opts.feed : { kind: 'gh-forward', agent: label };
  writeFileSync(
    path.join(dir, 'webhook.json'),
    JSON.stringify({ pid: 1, port: 9, ...(feed ? { feed } : {}) }),
  );
  const plistPath = forwarderPlistPath(deps, label);
  if (opts.plist && opts.plist !== 'none') {
    mkdirSync(path.dirname(plistPath), { recursive: true });
    // Render the current shape through an install into a scratch run, or write an old shape.
    writeFileSync(
      plistPath,
      opts.plist === 'old'
        ? '<plist><string>/usr/bin/env</string><string>--secret</string><string>abc123</string></plist>'
        : currentPlist(deps, label),
    );
  }
  return { deps, calls, label, plistPath };
};

import { agentPath, forwarderArgs, renderPlist } from './webhook-forwarder.js';
function currentPlist(deps: HierarchyDeps, label: string): string {
  const args = forwarderArgs('o/r', 9, 'abc123');
  args[0] = '/usr/bin/gh';
  return renderPlist(args, path.join(dir, 'webhook-forward.log'), agentPath(deps), label);
}

const reading = (
  over: Partial<WebhookHealth['signals']> = {},
  reason = 'no event for 45 min',
): WebhookHealth => ({
  class: 'down',
  since: new Date(nowMs).toISOString(),
  reasons: [reason],
  signals: {
    receiver: true,
    port: true,
    lastEventAgeMin: 45,
    prActivityWithoutEvent: true,
    prActivity: true,
    quiet: false,
    forwarder: 'alive',
    feed: 'gh-forward',
    ...over,
  },
});

const kicks = (calls: Call[]): Call[] =>
  calls.filter(([f, a]) => f === 'launchctl' && a[0] === 'kickstart');
const stateFile = (): string => readFileSync(path.join(dir, 'webhook-health.json'), 'utf-8');

const tick = (
  s: ReturnType<typeof setup>,
  h: WebhookHealth,
  filed: WebhookEscalationInput[],
  platform: NodeJS.Platform = 'darwin',
) =>
  runWebhookHealthTick({
    boardDir: dir,
    now: s.deps.now,
    health: () => h,
    escalate: (i) => {
      filed.push(i);
      return 'DEC-0900';
    },
    repair: makeWebhookRepair(s.deps, platform),
  });

describe('webhook self-repair (AISDLC-1299)', () => {
  it('with no recorded port installs nothing and reports the reason (AISDLC-1350 AC9)', () => {
    const t = setup({ feed: { kind: 'gh-forward', agent: 'x' }, plist: 'none' });
    const repair = makeWebhookRepair(t.deps, 'darwin');
    rmSync(path.join(dir, 'webhook.json'), { force: true });
    const r = repair.run();
    expect(r).toMatchObject({ action: 'blocked', ok: false });
    expect(r.detail).toMatch(/no receiver port is recorded/);
    expect(t.calls.some(([f]) => f === 'launchctl')).toBe(false);
  });

  it('a silent feed gets one kickstart -k and a recorded attempt, no decision (AC1)', () => {
    const s = setup({ plist: 'current' });
    const filed: WebhookEscalationInput[] = [];
    tick(s, reading(), filed);
    const k = kicks(s.calls);
    expect(k).toHaveLength(1);
    expect(k[0]![1]).toEqual(['kickstart', '-k', `gui/${process.getuid?.() ?? 0}/${s.label}`]);
    expect(filed).toHaveLength(0);
    expect(JSON.parse(stateFile()).attempts).toHaveLength(1);
  });

  it('limits to 3 kickstarts an hour, 5 minutes apart, then opens a decision with the attempts and log (AC2)', () => {
    const s = setup({ plist: 'current' });
    writeFileSync(
      path.join(dir, 'webhook-forward.log'),
      'websocket: close 1006 (abnormal closure)\n',
    );
    const filed: WebhookEscalationInput[] = [];
    tick(s, reading(), filed);
    at(2);
    tick(s, reading(), filed); // too soon
    expect(kicks(s.calls)).toHaveLength(1);
    at(6);
    tick(s, reading(), filed);
    at(12);
    tick(s, reading(), filed);
    expect(kicks(s.calls)).toHaveLength(3);
    expect(filed).toHaveLength(0);
    at(14); // third attempt is under 5 minutes old: still waiting
    tick(s, reading(), filed);
    expect(filed).toHaveLength(0);
    at(20);
    tick(s, reading(), filed);
    expect(kicks(s.calls)).toHaveLength(3);
    expect(filed).toHaveLength(1);
    expect(filed[0]!.body).toContain('kickstart ok');
    expect(filed[0]!.body).toContain('close 1006');
    at(25);
    tick(s, reading(), filed);
    expect(filed).toHaveLength(1);
  });

  it('a loaded, not running job triggers the repair with no PR activity (AC3)', () => {
    const s = setup({
      plist: 'current',
      printOut: 'state = spawn scheduled\n last exit code = 126\n',
    });
    const h = reading(
      { forwarder: 'dead', prActivity: false, quiet: true },
      'the forwarder is not running while the receiver is up',
    );
    h.class = 'degraded';
    const filed: WebhookEscalationInput[] = [];
    tick(s, h, filed);
    expect(kicks(s.calls)).toHaveLength(1);
    expect(filed).toHaveLength(0);
  });

  it('an out-of-date agent file is reinstalled with the secret set (AC4)', () => {
    const s = setup({ plist: 'old' });
    const filed: WebhookEscalationInput[] = [];
    tick(s, reading(), filed);
    expect(s.calls.some(([f, a]) => f === 'launchctl' && a[0] === 'bootstrap')).toBe(true);
    expect(JSON.parse(stateFile()).attempts[0].action).toBe('reinstall');
    expect(filed).toHaveLength(0);
  });

  it('an out-of-date agent file with no secret makes no launchctl call and opens the decision (AC4)', () => {
    const s = setup({ secret: undefined, plist: 'none' });
    const filed: WebhookEscalationInput[] = [];
    tick(s, reading(), filed);
    expect(s.calls.filter(([f]) => f === 'launchctl')).toHaveLength(0);
    expect(filed).toHaveLength(1);
    expect(filed[0]!.body).toContain('out of date');
    expect(filed[0]!.body).toContain('is not set');
  });

  it('never writes the secret to the decision or the state file (AC5)', () => {
    const s = setup({ plist: 'current' });
    writeFileSync(
      path.join(dir, 'webhook-forward.log'),
      'gh webhook forward --secret abc123\nAI_SDLC_WEBHOOK_SECRET=abc123\nplain abc123 text\n',
    );
    const filed: WebhookEscalationInput[] = [];
    for (const m of [0, 6, 12, 20]) {
      at(m);
      tick(s, reading(), filed);
    }
    expect(filed).toHaveLength(1);
    expect(filed[0]!.body).not.toContain('abc123');
    expect(filed[0]!.body).toContain('[redacted]');
    expect(stateFile()).not.toContain('abc123');
  });

  it('an arriving event resets the attempts and closes the decision (AC6)', () => {
    const s = setup({ plist: 'current' });
    const filed: WebhookEscalationInput[] = [];
    for (const m of [0, 6, 12, 20]) {
      at(m);
      tick(s, reading(), filed);
    }
    const closeEpisode = vi.fn();
    const healthy = { ...reading(), class: 'healthy' as const, reasons: [] };
    healthy.signals = { ...healthy.signals, lastEventAt: s.deps.now().toISOString() };
    runWebhookHealthTick({
      boardDir: dir,
      now: s.deps.now,
      health: () => healthy,
      closeEpisode,
      repair: makeWebhookRepair(s.deps),
    });
    expect(closeEpisode).toHaveBeenCalledTimes(1);
    expect(JSON.parse(stateFile()).attempts).toBeUndefined();
    at(30);
    tick(s, reading(), filed);
    expect(kicks(s.calls)).toHaveLength(4);
  });

  it('status prints loaded, not running with the last exit (AC7)', () => {
    const s = setup({ printOut: 'state = spawn scheduled\n last exit code = 126\n' });
    expect(forwarderPersistence(s.deps, s.label, 'darwin')).toContain(
      'loaded, not running (last exit 126)',
    );
  });

  it('touches nothing for a tunnel, no feed or without launchd (AC8)', () => {
    for (const [feed, platform, signals] of [
      [{ kind: 'tunnel' }, 'darwin', { feed: 'tunnel' as const }],
      [{ kind: 'none' }, 'darwin', { feed: 'none' as const }],
      [undefined, 'darwin', {}],
      ['agent', 'linux', {}],
    ] as const) {
      const s = setup({
        feed: feed === 'agent' ? { kind: 'gh-forward', agent: 'x.y' } : feed,
        plist: 'current',
      });
      const filed: WebhookEscalationInput[] = [];
      tick(s, reading(signals), filed, platform);
      expect(s.calls.filter(([f]) => f === 'launchctl')).toHaveLength(0);
      expect(filed).toHaveLength(1);
      removeFixtureDir(path.join(dir, 'webhook-health.json'));
    }
  });

  it('records a failed kickstart and redacts text', () => {
    const s = setup({ plist: 'current' });
    (s.deps as { run: unknown }).run = (f: string, a: readonly string[]) =>
      f === 'launchctl' && a[0] === 'kickstart'
        ? { status: 113, stdout: '', stderr: 'no such abc123\n' }
        : { status: 0, stdout: '', stderr: '' };
    const r = makeWebhookRepair(s.deps).run();
    expect(r.ok).toBe(false);
    expect(r.detail).not.toContain('abc123');
    expect(redactSecrets('--secret=zzz x', [])).toBe('--secret=[redacted] x');
  });
});
