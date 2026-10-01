import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { validateHierarchyRoster } from '@ai-sdlc/reference';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ensureBoardDirs, writeHeartbeat, writeManifest } from '../dispatch/board.js';
import type { DispatchManifest } from '../dispatch/types.js';
import {
  attachTmuxSession,
  buildClaudeCommand,
  createSystemRunner,
  evaluateResourceGate,
  executorNames,
  findStartedSession,
  formatStatus,
  hierarchyDown,
  hierarchyStatus,
  hierarchyUp,
  isValidSessionName,
  isValidTaskId,
  listInflight,
  parseExecutorCount,
  parseMemInfo,
  parseVmStat,
  readRoster,
  readRosterChecked,
  readSessionRegistry,
  readSettingsView,
  roleOfDefaultName,
  rosterPath,
  shellQuote,
  writeRoster,
  type CommandRunner,
  type HierarchyDeps,
  type UpOptions,
} from './index.js';

const NOW = new Date('2026-09-30T12:00:00.000Z');

interface FakeTmux {
  run: CommandRunner;
  calls: { file: string; args: string[] }[];
  windows: string[];
  /** Names the fake harness gives to started sessions (default: requested). */
  nameFor: (requested: string) => string;
  /** When false, sessions never appear in the registry. */
  register: boolean;
  /** When false, `send-keys /exit` does not close the window. */
  exitsOnRequest: boolean;
  failStartFor?: string;
}

function makeFakeTmux(registryDir: string): FakeTmux {
  let nextPid = 4000;
  const fake: FakeTmux = {
    calls: [],
    windows: [],
    nameFor: (n) => n,
    register: true,
    exitsOnRequest: true,
    run: () => ({ status: 1, stdout: '', stderr: '' }),
  };
  const paneOf = new Map<string, string>();
  fake.run = (file, args) => {
    fake.calls.push({ file, args: [...args] });
    if (file !== 'tmux') return { status: 1, stdout: '', stderr: 'unexpected binary' };
    const [cmd] = args;
    const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' });
    switch (cmd) {
      case 'has-session':
        return fake.windows.length > 0 ? ok() : { status: 1, stdout: '', stderr: '' };
      case 'list-windows':
        return fake.windows.length > 0
          ? ok(fake.windows.join('\n') + '\n')
          : { status: 1, stdout: '', stderr: '' };
      case 'new-session':
      case 'new-window': {
        const nameIdx = args.indexOf('-n') + 1;
        const window = args[nameIdx] as string;
        if (fake.failStartFor === window) return { status: 1, stdout: '', stderr: 'boom' };
        fake.windows.push(window);
        const pid = nextPid++;
        paneOf.set(window, `%${pid - 3990} ${pid}`);
        if (fake.register) {
          mkdirSync(registryDir, { recursive: true });
          writeFileSync(
            path.join(registryDir, `${pid}.json`),
            JSON.stringify({
              pid,
              name: fake.nameFor(window),
              startedAt: NOW.getTime(),
              status: 'idle',
              cwd: '/repo',
            }),
          );
        }
        return ok();
      }
      case 'display-message': {
        const target = args[args.indexOf('-t') + 1] as string;
        const pane = paneOf.get(target.split(':')[1] as string) ?? '';
        return ok((args[args.length - 1] === '#{pane_id}' ? pane.split(' ')[0] : pane) + '\n');
      }
      case 'send-keys': {
        if (fake.exitsOnRequest) {
          const target = args[args.indexOf('-t') + 1] as string;
          for (const [w, pane] of paneOf) {
            if (pane.startsWith(`${target} `) || target.endsWith(`:${w}`))
              fake.windows = fake.windows.filter((x) => x !== w);
          }
        }
        return ok();
      }
      case 'kill-window': {
        const target = args[args.indexOf('-t') + 1] as string;
        fake.windows = fake.windows.filter((w) => w !== target.split(':')[1]);
        return ok();
      }
      default:
        return { status: 1, stdout: '', stderr: 'unknown' };
    }
  };
  return fake;
}

let tmp: string;
let boardDir: string;
let registryDir: string;
let settingsFile: string;
let fake: FakeTmux;
let logs: string[];
let attached: string[];
let deps: HierarchyDeps;

function writeSettings(doc: unknown): void {
  writeFileSync(settingsFile, JSON.stringify(doc));
}

const baseOpts: UpOptions = {
  executors: 2,
  plannerModel: 'fable',
  dispatchModel: 'opus',
  executorModel: 'sonnet',
  noPlanner: false,
  attach: false,
};

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'hierarchy-'));
  boardDir = path.join(tmp, 'dispatch');
  registryDir = path.join(tmp, 'sessions');
  settingsFile = path.join(tmp, 'settings.json');
  writeSettings({ crossSessionInbound: 'accept', permissions: { defaultMode: 'acceptEdits' } });
  fake = makeFakeTmux(registryDir);
  logs = [];
  attached = [];
  deps = {
    run: (f, a, o) => fake.run(f, a, o),
    boardDir,
    cwd: '/repo',
    registryDir,
    settingsFiles: [settingsFile],
    userSettingsFile: settingsFile,
    resources: () => ({ availableBytes: 16 * 1024 ** 3, loadAvg1: 0.1, cpus: 8 }),
    env: {},
    now: () => NOW,
    sleep: async () => {},
    log: (l) => logs.push(l),
    attach: (s) => {
      attached.push(s);
      return 0;
    },
    claudeBin: 'claude',
    pollAttempts: 3,
    pollIntervalMs: 1,
  };
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function manifest(taskId: string): DispatchManifest {
  return {
    schemaVersion: 'v1',
    taskId,
    branch: `ai-sdlc/${taskId.toLowerCase()}`,
    worktree: `.worktrees/${taskId.toLowerCase()}`,
    baseSha: 'abc',
    workerKind: 'any',
    dispatchedAt: NOW.toISOString(),
    dispatchedBy: 'test',
    spec: { taskFile: 'x.md', verifyCommands: [] },
  };
}

function putInflight(taskId: string, workerId: string): void {
  ensureBoardDirs(boardDir);
  writeManifest(boardDir, manifest(taskId));
  renameToInflight(taskId);
  writeHeartbeat(boardDir, {
    taskId,
    workerId,
    workerKind: 'in-session-agent',
    startedAt: NOW.toISOString(),
    lastHeartbeat: NOW.toISOString(),
  });
}

function renameToInflight(taskId: string): void {
  const src = path.join(boardDir, 'queue', `${taskId}.dispatch.json`);
  const dst = path.join(boardDir, 'inflight', `${taskId}.dispatch.json`);
  writeFileSync(dst, readFileSync(src));
  rmSync(src);
}

function newWindowCommands(): string[] {
  return fake.calls
    .filter((c) => c.args[0] === 'new-session' || c.args[0] === 'new-window')
    .map((c) => c.args[c.args.length - 1] as string);
}

describe('hierarchy up', () => {
  it('starts one window and one claude command per role and writes a valid roster', async () => {
    const result = await hierarchyUp(baseOpts, deps);

    expect(result.started.map((e) => e.name)).toEqual([
      'planner',
      'operator-dispatch',
      'executor-alpha',
      'executor-beta',
    ]);
    expect(newWindowCommands()).toEqual([
      `'claude' --name 'planner' --model 'fable' --permission-mode 'acceptEdits' '/ai-sdlc planner'`,
      `'claude' --name 'operator-dispatch' --model 'opus' --permission-mode 'bypassPermissions' '/ai-sdlc operator-dispatch'`,
      `'claude' --name 'executor-alpha' --model 'sonnet' --permission-mode 'bypassPermissions' '/ai-sdlc executor'`,
      `'claude' --name 'executor-beta' --model 'sonnet' --permission-mode 'bypassPermissions' '/ai-sdlc executor'`,
    ]);
    // First window creates the session; the rest join it.
    const kinds = fake.calls
      .filter((c) => ['new-session', 'new-window'].includes(c.args[0] as string))
      .map((c) => c.args[0]);
    expect(kinds).toEqual(['new-session', 'new-window', 'new-window', 'new-window']);

    const roster = JSON.parse(readFileSync(rosterPath(boardDir), 'utf-8'));
    expect(validateHierarchyRoster(roster).valid).toBe(true);
    expect(roster.sessions).toHaveLength(4);
    const alpha = roster.sessions.find((s: { name: string }) => s.name === 'executor-alpha');
    expect(alpha).toMatchObject({
      role: 'executor',
      tmuxSession: 'ai-sdlc-hierarchy',
      tmuxWindow: 'executor-alpha',
      model: 'sonnet',
      permissionMode: 'bypassPermissions',
      status: 'running',
      startedAt: NOW.toISOString(),
    });
    expect(alpha.pid).toBeGreaterThan(0);
    expect(alpha.paneId).toMatch(/^%/);
  });

  it('falls back to the default permission mode for the planner when none is configured', async () => {
    writeSettings({ crossSessionInbound: 'accept' });
    await hierarchyUp({ ...baseOpts, executors: 0 }, deps);
    expect(newWindowCommands()[0]).toContain("--permission-mode 'default'");
  });

  it('honours an explicit planner permission mode and --no-planner', async () => {
    await hierarchyUp({ ...baseOpts, executors: 0, plannerPermissionMode: 'plan' }, deps);
    expect(newWindowCommands()[0]).toContain("--permission-mode 'plan'");

    fake = makeFakeTmux(registryDir);
    rmSync(rosterPath(boardDir));
    const r = await hierarchyUp({ ...baseOpts, executors: 1, noPlanner: true }, deps);
    expect(r.started.map((e) => e.name)).toEqual(['operator-dispatch', 'executor-alpha']);
  });

  it('is idempotent: a second up starts nothing and reports the existing windows', async () => {
    await hierarchyUp(baseOpts, deps);
    const before = newWindowCommands().length;
    logs.length = 0;

    const second = await hierarchyUp(baseOpts, deps);

    expect(second.started).toEqual([]);
    expect(second.existing.map((e) => e.name)).toHaveLength(4);
    expect(newWindowCommands()).toHaveLength(before);
    expect(logs.filter((l) => l.startsWith('already running'))).toHaveLength(4);
  });

  it('starts only the missing roles on a later up with more executors', async () => {
    await hierarchyUp(baseOpts, deps);
    const r = await hierarchyUp({ ...baseOpts, executors: 3 }, deps);
    expect(r.started.map((e) => e.name)).toEqual(['executor-gamma']);
    expect(readRoster(boardDir).sessions).toHaveLength(5);
  });

  it('writes a harness-suffixed name back to the roster', async () => {
    fake.nameFor = (n) => (n === 'executor-alpha' ? 'executor-alpha-2' : n);
    // An older session already owns the plain name.
    mkdirSync(registryDir, { recursive: true });
    writeFileSync(
      path.join(registryDir, '1.json'),
      JSON.stringify({
        pid: 1,
        name: 'executor-alpha',
        startedAt: NOW.getTime() - 60_000,
        status: 'busy',
      }),
    );

    await hierarchyUp({ ...baseOpts, executors: 1 }, deps);

    const alpha = readRoster(boardDir).sessions.find((s) => s.tmuxWindow === 'executor-alpha');
    expect(alpha?.name).toBe('executor-alpha-2');
    expect(alpha?.pid).not.toBe(1);
    expect(logs.some((l) => l.includes("registered as 'executor-alpha-2'"))).toBe(true);
  });

  it('keeps the requested name and warns when the registry never lists the session', async () => {
    fake.register = false;
    const r = await hierarchyUp({ ...baseOpts, executors: 0, noPlanner: true }, deps);
    expect(r.started[0]).toMatchObject({ name: 'operator-dispatch', status: 'starting' });
    expect(r.started[0]?.pid).toBeGreaterThan(0);
    expect(r.warnings.some((w) => w.includes('registry did not list'))).toBe(true);
  });

  it.each([
    ['unset', {}],
    ['refuse', { crossSessionInbound: 'refuse' }],
  ])('refuses and prints the settings change when crossSessionInbound is %s', async (_n, doc) => {
    writeSettings(doc);
    await expect(hierarchyUp(baseOpts, deps)).rejects.toThrow(/crossSessionInbound/);
    await hierarchyUp(baseOpts, deps).catch((e: Error) => {
      expect(e.message).toContain('"crossSessionInbound": "accept"');
      expect(e.message).toContain(settingsFile);
    });
    expect(newWindowCommands()).toEqual([]);
    expect(existsSync(rosterPath(boardDir))).toBe(false);
  });

  it('does not require the setting when only the planner would be started', async () => {
    writeSettings({});
    await hierarchyUp({ ...baseOpts, executors: 0 }, deps).catch(() => {});
    // dispatch tier is still planned, so it must refuse
    expect(newWindowCommands()).toEqual([]);
  });

  it('refuses a sixth executor', async () => {
    await expect(hierarchyUp({ ...baseOpts, executors: 6 }, deps)).rejects.toThrow(/a sixth/);
    expect(newWindowCommands()).toEqual([]);
  });

  it('refuses a second planner when one is already running under another name', async () => {
    writeRoster(boardDir, {
      schemaVersion: 'v1',
      sessions: [
        {
          role: 'planner',
          name: 'my-planner',
          tmuxSession: 'ai-sdlc-hierarchy',
          tmuxWindow: 'my-planner',
          paneId: '%1',
          pid: 10,
          model: 'fable',
          permissionMode: 'default',
          startedAt: NOW.toISOString(),
          status: 'running',
        },
      ],
    });
    fake.windows = ['my-planner'];

    await expect(hierarchyUp(baseOpts, deps)).rejects.toThrow(/second one/);
    expect(newWindowCommands()).toEqual([]);

    // --no-planner leaves it alone and starts the rest.
    const r = await hierarchyUp({ ...baseOpts, noPlanner: true, executors: 0 }, deps);
    expect(r.started.map((e) => e.name)).toEqual(['operator-dispatch']);
  });

  it('refuses when the resource gate refuses', async () => {
    deps.resources = () => ({ availableBytes: 1024 ** 3, loadAvg1: 0, cpus: 4 });
    await expect(hierarchyUp(baseOpts, deps)).rejects.toThrow(/resource gate refused/);
  });

  it('drops roster entries whose window is gone and restarts them', async () => {
    await hierarchyUp({ ...baseOpts, executors: 1 }, deps);
    fake.windows = fake.windows.filter((w) => w !== 'executor-alpha');
    const r = await hierarchyUp({ ...baseOpts, executors: 1 }, deps);
    expect(r.started.map((e) => e.name)).toEqual(['executor-alpha']);
    expect(r.warnings.some((w) => w.includes('no live window'))).toBe(true);
  });

  it('does not duplicate a window that exists without a roster entry', async () => {
    fake.windows = ['executor-alpha'];
    const r = await hierarchyUp({ ...baseOpts, executors: 1, noPlanner: true }, deps);
    expect(r.started.map((e) => e.name)).toEqual(['operator-dispatch']);
    expect(r.warnings.some((w) => w.includes('not in the roster'))).toBe(true);
  });

  it('records progress and reports when a window cannot be created', async () => {
    fake.failStartFor = 'executor-alpha';
    await expect(hierarchyUp({ ...baseOpts, executors: 2 }, deps)).rejects.toThrow(
      /could not start 'executor-alpha'/,
    );
    expect(readRoster(boardDir).sessions.map((s) => s.name)).toEqual([
      'planner',
      'operator-dispatch',
    ]);
  });

  it('attaches when asked', async () => {
    await hierarchyUp({ ...baseOpts, executors: 0, attach: true }, deps);
    expect(attached).toEqual(['ai-sdlc-hierarchy']);
  });

  it('rejects unsafe model and mode values before touching tmux', async () => {
    await expect(hierarchyUp({ ...baseOpts, plannerModel: 'x; rm -rf /' }, deps)).rejects.toThrow(
      /invalid --planner-model/,
    );
    await expect(hierarchyUp({ ...baseOpts, plannerPermissionMode: 'a b' }, deps)).rejects.toThrow(
      /invalid permission mode/,
    );
    expect(fake.calls).toEqual([]);
  });
});

describe('hierarchy status', () => {
  it('prints every roster entry with live state and inflight task', async () => {
    await hierarchyUp(baseOpts, deps);
    putInflight('AISDLC-100', 'executor-alpha');
    // beta is busy in the registry; the others stay idle.
    for (const f of ['4003.json']) {
      const file = path.join(registryDir, f);
      const doc = JSON.parse(readFileSync(file, 'utf-8'));
      writeFileSync(file, JSON.stringify({ ...doc, status: 'busy' }));
    }
    // dispatch window dies.
    fake.windows = fake.windows.filter((w) => w !== 'operator-dispatch');
    rmSync(path.join(registryDir, '4001.json'));

    const result = hierarchyStatus(deps);
    const byName = Object.fromEntries(result.rows.map((r) => [r.entry.name, r]));
    expect(byName['executor-alpha']).toMatchObject({ state: 'idle', inflightTask: 'AISDLC-100' });
    expect(byName['executor-beta']).toMatchObject({ state: 'busy' });
    expect(byName['executor-beta']?.inflightTask).toBeUndefined();
    expect(byName['operator-dispatch']?.state).toBe('gone');
    expect(result.board.inflight).toBe(1);

    const text = formatStatus(result).join('\n');
    expect(text).toContain('executor-alpha');
    expect(text).toContain('AISDLC-100');
    expect(text).toContain('busy');
    expect(text).toContain('board: 0 queued, 1 inflight');
  });

  it('reports starting when the window is alive but the registry has no entry', async () => {
    fake.register = false;
    await hierarchyUp({ ...baseOpts, executors: 0, noPlanner: true }, deps);
    expect(hierarchyStatus(deps).rows[0]?.state).toBe('starting');
  });

  it('reports gone when the window is dead even if a registry file exists', async () => {
    await hierarchyUp({ ...baseOpts, executors: 1, noPlanner: true }, deps);
    fake.windows = fake.windows.filter((w) => w !== 'executor-alpha');
    const row = hierarchyStatus(deps).rows.find((r) => r.entry.name === 'executor-alpha');
    expect(row?.state).toBe('gone');
  });

  it('maps an unknown registry status to unknown, not idle', async () => {
    await hierarchyUp({ ...baseOpts, executors: 0, noPlanner: true }, deps);
    const file = path.join(registryDir, '4000.json');
    const doc = JSON.parse(readFileSync(file, 'utf-8'));
    writeFileSync(file, JSON.stringify({ ...doc, status: 'weird' }));
    expect(hierarchyStatus(deps).rows[0]?.state).toBe('unknown');
  });

  it('handles an empty roster', () => {
    const result = hierarchyStatus(deps);
    expect(formatStatus(result)).toEqual(['no sessions in the roster']);
  });
});

describe('hierarchy down', () => {
  it('returns only the named executor manifest to the queue and removes only its window and entry', async () => {
    await hierarchyUp(baseOpts, deps);
    putInflight('AISDLC-200', 'executor-alpha');
    putInflight('AISDLC-201', 'executor-beta');

    const result = await hierarchyDown({ role: 'executor-beta' }, deps);

    expect(result.stopped).toEqual([
      { name: 'executor-beta', role: 'executor', requeued: 'AISDLC-201', forced: false },
    ]);
    expect(existsSync(path.join(boardDir, 'queue', 'AISDLC-201.dispatch.json'))).toBe(true);
    expect(existsSync(path.join(boardDir, 'inflight', 'AISDLC-201.dispatch.json'))).toBe(false);
    expect(existsSync(path.join(boardDir, 'inflight', 'AISDLC-200.dispatch.json'))).toBe(true);
    expect(fake.windows.sort()).toEqual(['executor-alpha', 'operator-dispatch', 'planner']);
    expect(readRoster(boardDir).sessions.map((s) => s.name)).toEqual([
      'planner',
      'operator-dispatch',
      'executor-alpha',
    ]);
  });

  it('closes the window itself when the session does not exit', async () => {
    await hierarchyUp({ ...baseOpts, executors: 1, noPlanner: true }, deps);
    fake.exitsOnRequest = false;
    const result = await hierarchyDown({ role: 'executor-alpha' }, deps);
    expect(result.stopped[0]?.forced).toBe(true);
    expect(fake.windows).toEqual(['operator-dispatch']);
  });

  it('selects every executor by role and every session without a filter', async () => {
    await hierarchyUp(baseOpts, deps);
    const r1 = await hierarchyDown({ role: 'executor' }, deps);
    expect(r1.stopped.map((s) => s.name)).toEqual(['executor-alpha', 'executor-beta']);
    const r2 = await hierarchyDown({}, deps);
    expect(r2.stopped.map((s) => s.name)).toEqual(['planner', 'operator-dispatch']);
    expect(readRoster(boardDir).sessions).toEqual([]);
  });

  it('rejects an unknown role', async () => {
    await expect(hierarchyDown({ role: 'executor-zeta' }, deps)).rejects.toThrow(
      /no session named/,
    );
  });

  it('still cleans up a session whose window is already gone', async () => {
    await hierarchyUp({ ...baseOpts, executors: 1, noPlanner: true }, deps);
    putInflight('AISDLC-300', 'executor-alpha');
    fake.windows = fake.windows.filter((w) => w !== 'executor-alpha');
    const r = await hierarchyDown({ role: 'executor-alpha' }, deps);
    expect(r.stopped[0]?.requeued).toBe('AISDLC-300');
  });
});

function craftedEntry(over: Record<string, unknown>) {
  return {
    role: 'executor',
    name: 'victim',
    tmuxSession: 'main',
    tmuxWindow: 'editor',
    paneId: '%1',
    pid: 1,
    model: 'sonnet',
    permissionMode: 'default',
    startedAt: NOW.toISOString(),
    status: 'running',
    ...over,
  };
}

function writeRawRoster(sessions: unknown[]): void {
  mkdirSync(boardDir, { recursive: true });
  writeFileSync(rosterPath(boardDir), JSON.stringify({ schemaVersion: 'v1', sessions }));
}

describe('untrusted roster entries', () => {
  it.each([
    ['another tmux session', { tmuxSession: 'main' }],
    ['another window name', { tmuxSession: 'ai-sdlc-hierarchy', tmuxWindow: 'a;b' }],
    ['a malformed pane id', { tmuxSession: 'ai-sdlc-hierarchy', paneId: '%1; rm' }],
  ])('down never sends keys to or kills an entry naming %s', async (_n, over) => {
    fake.windows = ['editor'];
    writeRawRoster([craftedEntry(over)]);
    const r = await hierarchyDown({}, deps);
    expect(r.stopped).toEqual([]);
    expect(
      fake.calls.filter((c) => c.args[0] === 'send-keys' || c.args[0] === 'kill-window'),
    ).toEqual([]);
    expect(fake.windows).toEqual(['editor']);
    expect(logs.some((l) => l.includes('ignored') && l.includes('not touched'))).toBe(true);
  });

  it('status and up report and skip a crafted entry', async () => {
    writeRawRoster([craftedEntry({})]);
    expect(hierarchyStatus(deps).rows).toEqual([]);
    expect(logs.some((l) => l.includes('ignored'))).toBe(true);
    const r = await hierarchyUp({ ...baseOpts, executors: 0, noPlanner: true }, deps);
    expect(r.warnings.some((w) => w.includes('ignored'))).toBe(true);
    expect(readRosterChecked(boardDir).roster.sessions.map((s) => s.name)).toEqual([
      'operator-dispatch',
    ]);
  });

  it('targets the window by name when the recorded pane id is stale', async () => {
    await hierarchyUp({ ...baseOpts, executors: 1, noPlanner: true }, deps);
    const roster = readRoster(boardDir);
    const alpha = roster.sessions.find((s) => s.name === 'executor-alpha');
    if (alpha) alpha.paneId = '%999';
    writeRoster(boardDir, roster);
    await hierarchyDown({ role: 'executor-alpha' }, deps);
    const send = fake.calls.find((c) => c.args[0] === 'send-keys');
    expect(send?.args[send.args.indexOf('-t') + 1]).toBe('=ai-sdlc-hierarchy:executor-alpha');
    expect(fake.windows).toEqual(['operator-dispatch']);
  });

  it('uses the pane id when it still belongs to the roster window', async () => {
    await hierarchyUp({ ...baseOpts, executors: 1, noPlanner: true }, deps);
    await hierarchyDown({ role: 'executor-alpha' }, deps);
    const send = fake.calls.find((c) => c.args[0] === 'send-keys');
    expect(send?.args[send.args.indexOf('-t') + 1]).toMatch(/^%[0-9]+$/);
  });

  it('matches inflight manifests by session name only, not window', async () => {
    fake.nameFor = (n) => (n === 'executor-alpha' ? 'executor-alpha-2' : n);
    await hierarchyUp({ ...baseOpts, executors: 1, noPlanner: true }, deps);
    putInflight('AISDLC-400', 'executor-alpha');
    const r = await hierarchyDown({ role: 'executor-alpha' }, deps);
    expect(r.stopped[0]?.requeued).toBeUndefined();
    expect(hierarchyStatus(deps).rows.every((x) => x.inflightTask === undefined)).toBe(true);
  });
});

describe('planner bypass guard', () => {
  it('refuses a bypassPermissions planner without the flag, allows it with the flag', async () => {
    writeSettings({
      crossSessionInbound: 'accept',
      permissions: { defaultMode: 'bypassPermissions' },
    });
    await expect(hierarchyUp(baseOpts, deps)).rejects.toThrow(/allow-planner-bypass/);
    expect(newWindowCommands()).toEqual([]);
    const r = await hierarchyUp({ ...baseOpts, allowPlannerBypass: true }, deps);
    expect(r.started[0]?.permissionMode).toBe('bypassPermissions');
  });

  it('does not check the planner mode when no planner will be started', async () => {
    await hierarchyUp({ ...baseOpts, executors: 0 }, deps);
    writeSettings({
      crossSessionInbound: 'accept',
      permissions: { defaultMode: 'bypassPermissions' },
    });
    const r = await hierarchyUp({ ...baseOpts, executors: 0 }, deps);
    expect(r.existing.map((e) => e.name)).toContain('planner');
    expect(r.started).toEqual([]);
  });
});

describe('roster', () => {
  it('writes through a unique temp name and leaves none behind', () => {
    writeRoster(boardDir, { schemaVersion: 'v1', sessions: [] });
    writeRoster(boardDir, { schemaVersion: 'v1', sessions: [] });
    expect(readdirSync(boardDir).filter((f) => f.includes('.tmp'))).toEqual([]);
    expect(existsSync(rosterPath(boardDir))).toBe(true);
  });

  it('returns an empty roster when the file is missing', () => {
    expect(readRoster(boardDir)).toEqual({ schemaVersion: 'v1', sessions: [] });
  });

  it('refuses to write an invalid roster and to read a corrupt one', () => {
    expect(() =>
      writeRoster(boardDir, { schemaVersion: 'v1', sessions: [{ role: 'x' }] } as never),
    ).toThrow(/invalid roster/);
    mkdirSync(boardDir, { recursive: true });
    writeFileSync(rosterPath(boardDir), '{nope');
    expect(() => readRoster(boardDir)).toThrow(/not valid JSON/);
    writeFileSync(rosterPath(boardDir), JSON.stringify({ schemaVersion: 'v2', sessions: [] }));
    expect(() => readRoster(boardDir)).toThrow(/roster schema/);
  });
});

describe('registry helpers', () => {
  it('skips malformed and non-json files and prefers an exact name match', () => {
    mkdirSync(registryDir, { recursive: true });
    writeFileSync(path.join(registryDir, 'a.json'), '{bad');
    writeFileSync(path.join(registryDir, 'b.key'), 'x');
    writeFileSync(path.join(registryDir, 'c.json'), JSON.stringify({ name: 1 }));
    writeFileSync(path.join(registryDir, 'd.json'), JSON.stringify({ pid: 5, name: 'p-2' }));
    writeFileSync(
      path.join(registryDir, 'e.json'),
      JSON.stringify({ pid: 6, name: 'p', startedAt: 10, status: 'busy', cwd: '/x' }),
    );
    const reg = readSessionRegistry(registryDir);
    expect(reg.map((r) => r.pid).sort()).toEqual([5, 6]);
    expect(readSessionRegistry(path.join(tmp, 'missing'))).toEqual([]);
    expect(findStartedSession(reg, 'p', 0, new Set())?.pid).toBe(6);
    expect(findStartedSession(reg, 'p', 0, new Set(['p']))?.pid).toBe(5);
    expect(findStartedSession(reg, 'p', 100, new Set())).toBeUndefined();
  });

  it('does not adopt a longer unrelated name as the requested one', () => {
    const reg = [
      { pid: 1, name: 'planner-notes', startedAt: 10, status: 'idle' },
      { pid: 2, name: 'planner-2', startedAt: 10, status: 'idle' },
    ];
    expect(findStartedSession(reg, 'planner', 0, new Set())?.pid).toBe(2);
    expect(findStartedSession(reg.slice(0, 1), 'planner', 0, new Set())).toBeUndefined();
  });
});

describe('inflight view', () => {
  it('skips malformed task ids and lists workers', () => {
    putInflight('AISDLC-1', 'w1');
    writeFileSync(path.join(boardDir, 'inflight', 'bad id.dispatch.json'), '{}');
    expect(listInflight(boardDir)).toEqual([{ taskId: 'AISDLC-1', workerId: 'w1' }]);
    expect(listInflight(path.join(tmp, 'none'))).toEqual([]);
  });
});

describe('validation helpers', () => {
  it('validates task ids and session names', () => {
    expect(isValidTaskId('AISDLC-664.1')).toBe(true);
    expect(isValidTaskId('aisdlc-1')).toBe(false);
    expect(isValidTaskId('A-1; rm')).toBe(false);
    expect(isValidSessionName('executor-alpha')).toBe(true);
    expect(isValidSessionName('Bad Name')).toBe(false);
    expect(isValidSessionName('a:b')).toBe(false);
  });

  it('parses executor counts and names them', () => {
    expect(parseExecutorCount('5')).toBe(5);
    expect(parseExecutorCount(0)).toBe(0);
    expect(() => parseExecutorCount('x')).toThrow(/whole number/);
    expect(() => parseExecutorCount('-1')).toThrow(/whole number/);
    expect(executorNames(3)).toEqual(['executor-alpha', 'executor-beta', 'executor-gamma']);
    expect(roleOfDefaultName('executor-delta')).toBe('executor');
    expect(roleOfDefaultName('planner')).toBe('planner');
    expect(roleOfDefaultName('operator-dispatch')).toBe('operator-dispatch');
    expect(roleOfDefaultName('other')).toBeUndefined();
  });

  it('quotes shell arguments', () => {
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
    expect(
      buildClaudeCommand('claude', {
        role: 'executor',
        name: 'x',
        model: 'm',
        permissionMode: 'p',
        prompt: "a'b",
      }),
    ).toBe(`'claude' --name 'x' --model 'm' --permission-mode 'p' 'a'\\''b'`);
  });
});

describe('preflight helpers', () => {
  it('reads layered settings, later files winning, ignoring bad files', () => {
    const a = path.join(tmp, 'a.json');
    const b = path.join(tmp, 'b.json');
    const c = path.join(tmp, 'c.json');
    writeFileSync(
      a,
      JSON.stringify({ crossSessionInbound: 'refuse', permissions: { defaultMode: 'plan' } }),
    );
    writeFileSync(b, '[1]');
    writeFileSync(c, JSON.stringify({ crossSessionInbound: 'accept' }));
    expect(readSettingsView([a, b, c, path.join(tmp, 'nope.json')])).toEqual({
      crossSessionInbound: 'accept',
      defaultMode: 'plan',
    });
    writeFileSync(b, '{bad');
    expect(readSettingsView([b])).toEqual({});
  });

  it('parses vm_stat and /proc/meminfo output', () => {
    const vm = [
      'Mach Virtual Memory Statistics: (page size of 16384 bytes)',
      'Pages free:                               1000.',
      'Pages inactive:                           2000.',
      'Pages speculative:                         500.',
    ].join('\n');
    expect(parseVmStat(vm)).toBe(3500 * 16384);
    expect(parseVmStat('nothing')).toBeNull();
    expect(parseVmStat('Pages free: 10.')).toBe(10 * 4096);
    expect(parseMemInfo('MemTotal: 1 kB\nMemAvailable:   2048 kB\n')).toBe(2048 * 1024);
    expect(parseMemInfo('x')).toBeNull();
  });

  it('evaluates the resource gate', () => {
    const ok = { availableBytes: 8 * 1024 ** 3, loadAvg1: 1, cpus: 4 };
    expect(evaluateResourceGate(ok)).toBeNull();
    expect(evaluateResourceGate({ ...ok, availableBytes: null })).toBeNull();
    expect(evaluateResourceGate({ ...ok, availableBytes: 1024 ** 3 })).toMatch(/memory/);
    expect(evaluateResourceGate({ ...ok, loadAvg1: 4 })).toMatch(/load average/);
    expect(
      evaluateResourceGate(
        { ...ok, loadAvg1: 9 },
        { AI_SDLC_EXECUTE_PARALLEL_SKIP_RESOURCE_GATE: '1' },
      ),
    ).toBeNull();
  });
});

describe('system runner', () => {
  it('captures output and status without a shell', () => {
    const run = createSystemRunner();
    const r = run(process.execPath, ['-e', 'process.stdout.write("a b"); process.exit(3)']);
    expect(r).toMatchObject({ status: 3, stdout: 'a b' });
    const missing = run('definitely-not-a-real-binary-xyz', []);
    expect(missing.status).toBeNull();
    expect(missing.stderr.length).toBeGreaterThan(0);
  });

  it('exposes an attach helper', () => {
    expect(typeof attachTmuxSession).toBe('function');
  });
});
