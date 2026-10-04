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
  isLegacyLayoutEntry,
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
  type RosterEntry,
  type UpOptions,
  unsafeEntryReason,
} from './index.js';

const NOW = new Date('2026-09-30T12:00:00.000Z');

interface FakeTmux {
  run: CommandRunner;
  calls: { file: string; args: string[] }[];
  /** Live agents in the current layout: each is a session with one window of the same name. */
  windows: string[];
  /** Windows of the shared legacy 'ai-sdlc-hierarchy' session (old layout). */
  legacyWindows: string[];
  /** Attached client count per session name. */
  attachedClients: Record<string, number>;
  /** Names the fake harness gives to started sessions (default: requested). */
  nameFor: (requested: string) => string;
  /** When false, sessions never appear in the registry. */
  register: boolean;
  /** When false, `send-keys /exit` does not close the window. */
  exitsOnRequest: boolean;
  failStartFor?: string;
  /** Sessions carrying the @ai-sdlc-hierarchy ownership option (set by `up`). */
  owned: Set<string>;
  /** When set, marking this session fails (tmux set-option errors). */
  failMarkFor?: string;
}

function makeFakeTmux(registryDir: string): FakeTmux {
  let nextPid = 4000;
  const fake: FakeTmux = {
    calls: [],
    windows: [],
    legacyWindows: [],
    attachedClients: {},
    nameFor: (n) => n,
    register: true,
    exitsOnRequest: true,
    owned: new Set<string>(),
    run: () => ({ status: 1, stdout: '', stderr: '' }),
  };
  const paneOf = new Map<string, string>();
  const removeWindow = (w: string) => {
    fake.windows = fake.windows.filter((x) => x !== w);
    fake.legacyWindows = fake.legacyWindows.filter((x) => x !== w);
  };
  const sessionWindows = (session: string): string[] | undefined => {
    if (session === 'ai-sdlc-hierarchy') {
      return fake.legacyWindows.length > 0 ? fake.legacyWindows : undefined;
    }
    return fake.windows.includes(session) ? [session] : undefined;
  };
  fake.run = (file, args) => {
    fake.calls.push({ file, args: [...args] });
    if (file !== 'tmux') return { status: 1, stdout: '', stderr: 'unexpected binary' };
    const [cmd] = args;
    const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' });
    const fail = (stderr = '') => ({ status: 1, stdout: '', stderr });
    const targetOf = () =>
      (args[args.indexOf('-t') + 1] as string).replace(/^=/, '').replace(/:$/, '');
    switch (cmd) {
      case 'has-session':
        return sessionWindows(targetOf()) ? ok() : fail();
      case 'list-windows': {
        const w = sessionWindows(targetOf());
        return w ? ok(w.join('\n') + '\n') : fail();
      }
      case 'new-session': {
        const session = args[args.indexOf('-s') + 1] as string;
        const window = args[args.indexOf('-n') + 1] as string;
        if (fake.failStartFor === window) return fail('boom');
        if (sessionWindows(session)) return fail('duplicate session');
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
        if (args[args.length - 1] === '#{session_attached}') {
          const session = target.replace(/^=/, '');
          if (!sessionWindows(session)) return fail('no such session');
          return ok(`${fake.attachedClients[session] ?? 0}\n`);
        }
        const pane = paneOf.get(target.split(':')[1] as string) ?? '';
        return ok((args[args.length - 1] === '#{pane_id}' ? pane.split(' ')[0] : pane) + '\n');
      }
      case 'send-keys': {
        if (fake.exitsOnRequest) {
          const target = args[args.indexOf('-t') + 1] as string;
          for (const [w, pane] of paneOf) {
            if (pane.startsWith(`${target} `) || target.endsWith(`:${w}`)) removeWindow(w);
          }
          // Legacy windows have no recorded pane; they are targeted by name.
          for (const w of [...fake.legacyWindows]) {
            if (target.endsWith(`:${w}`)) removeWindow(w);
          }
        }
        return ok();
      }
      case 'kill-pane': {
        const pane = args[args.indexOf('-t') + 1] as string;
        for (const [w, p] of paneOf) if (p.startsWith(`${pane} `)) removeWindow(w);
        return ok();
      }
      case 'kill-window': {
        const target = args[args.indexOf('-t') + 1] as string;
        removeWindow(target.split(':')[1] as string);
        return ok();
      }
      case 'set-option': {
        if (args.includes('@ai-sdlc-hierarchy')) {
          const session = targetOf();
          if (fake.failMarkFor === session) return fail('boom');
          fake.owned.add(session);
        }
        return ok();
      }
      case 'show-options': {
        const session = targetOf();
        return args.includes('@ai-sdlc-hierarchy') && fake.owned.has(session)
          ? ok('1\n')
          : fail('unknown option');
      }
      case 'select-window':
        return ok();
      default:
        return fail('unknown');
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
let attached: string[][];
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
    attach: (args) => {
      attached.push([...args]);
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

function legacyEntry(name: string, role: 'planner' | 'operator-dispatch' | 'executor') {
  return craftedEntry({
    role,
    name,
    tmuxSession: 'ai-sdlc-hierarchy',
    tmuxWindow: name,
    paneId: '',
  });
}

describe('hierarchy up', () => {
  it('starts one session per agent, titled and with an attach hint, and writes a valid roster', async () => {
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
    // One detached session per agent, named after it; never a shared session or a new window.
    const creates = fake.calls.filter((c) =>
      ['new-session', 'new-window'].includes(c.args[0] as string),
    );
    expect(creates.map((c) => c.args.slice(0, 7))).toEqual(
      ['planner', 'operator-dispatch', 'executor-alpha', 'executor-beta'].map((n) => [
        'new-session',
        '-d',
        '-s',
        n,
        '-n',
        n,
        '-c',
      ]),
    );
    expect(fake.calls.some((c) => c.args[0] === 'new-window')).toBe(false);
    expect(creates.every((c) => c.args[7] === '/repo')).toBe(true);
    expect(fake.calls.some((c) => c.args.includes('ai-sdlc-hierarchy'))).toBe(false);

    // The ownership marker, then the titles, each scoped to its own session.
    for (const n of ['planner', 'executor-beta']) {
      const opts = fake.calls.filter((c) => c.args[0] === 'set-option' && c.args[2] === `=${n}:`);
      expect(opts.map((c) => c.args)).toEqual([
        ['set-option', '-t', `=${n}:`, '@ai-sdlc-hierarchy', '1'],
        ['set-option', '-t', `=${n}:`, 'set-titles', 'on'],
        ['set-option', '-t', `=${n}:`, 'set-titles-string', n],
        ['set-option', '-t', `=${n}:`, 'status-left', `[${n}] `],
      ]);
    }
    // No global or server option, anywhere.
    for (const c of fake.calls.filter((x) => x.args[0] === 'set-option')) {
      expect(c.args).not.toContain('-g');
      expect(c.args).not.toContain('-s');
      expect(c.args[1]).toBe('-t');
    }

    // One attach hint per started agent.
    for (const n of ['planner', 'operator-dispatch', 'executor-alpha', 'executor-beta']) {
      expect(logs.filter((l) => l.includes(`cli-hierarchy attach ${n}`))).toHaveLength(1);
    }

    const roster = JSON.parse(readFileSync(rosterPath(boardDir), 'utf-8'));
    expect(validateHierarchyRoster(roster).valid).toBe(true);
    expect(roster.sessions).toHaveLength(4);
    const alpha = roster.sessions.find((s: { name: string }) => s.name === 'executor-alpha');
    for (const s of roster.sessions as { name: string; tmuxSession: string }[]) {
      expect(s.tmuxSession).toBe(s.name);
    }
    expect(alpha).toMatchObject({
      role: 'executor',
      tmuxSession: 'executor-alpha',
      tmuxWindow: 'executor-alpha',
      model: 'sonnet',
      permissionMode: 'bypassPermissions',
      status: 'running',
      startedAt: NOW.toISOString(),
    });
    expect(alpha.pid).toBeGreaterThan(0);
    expect(alpha.paneId).toMatch(/^%/);
  });

  it('--executors 2 --no-planner issues one new-session per started agent and no new-window', async () => {
    const r = await hierarchyUp({ ...baseOpts, executors: 2, noPlanner: true }, deps);
    const sessions = fake.calls.filter((c) => c.args[0] === 'new-session');
    expect(sessions.map((c) => c.args[3])).toEqual([
      'operator-dispatch',
      'executor-alpha',
      'executor-beta',
    ]);
    expect(fake.calls.some((c) => c.args[0] === 'new-window')).toBe(false);
    expect(r.started.map((e) => [e.tmuxSession, e.tmuxWindow])).toEqual([
      ['operator-dispatch', 'operator-dispatch'],
      ['executor-alpha', 'executor-alpha'],
      ['executor-beta', 'executor-beta'],
    ]);
  });

  it('never emits a global option from up, status, attach or down', async () => {
    await hierarchyUp(baseOpts, deps);
    hierarchyStatus(deps);
    await hierarchyDown({ role: 'executor-beta' }, deps);
    const globals = fake.calls.filter((c) => c.args.includes('-g') || c.args.includes('-s'));
    // '-s' only appears as new-session's session-name flag, never with set-option.
    expect(globals.every((c) => c.args[0] === 'new-session')).toBe(true);
    expect(fake.calls.some((c) => c.args[0] === 'set-option' && c.args.includes('-g'))).toBe(false);
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
    // A planner recorded under a default session name other than 'planner'.
    writeRoster(boardDir, {
      schemaVersion: 'v1',
      sessions: [
        {
          role: 'planner',
          name: 'my-planner',
          tmuxSession: 'executor-epsilon',
          tmuxWindow: 'executor-epsilon',
          paneId: '%1',
          pid: 10,
          model: 'fable',
          permissionMode: 'default',
          startedAt: NOW.toISOString(),
          status: 'running',
        },
      ],
    });
    fake.windows = ['executor-epsilon'];

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
    expect(r.warnings.some((w) => w.includes('no live tmux session'))).toBe(true);
  });

  it('does not duplicate or kill a session that has an agent name but is not in the roster', async () => {
    fake.windows = ['executor-alpha'];
    const r = await hierarchyUp({ ...baseOpts, executors: 1, noPlanner: true }, deps);
    expect(r.started.map((e) => e.name)).toEqual(['operator-dispatch']);
    expect(r.warnings.some((w) => w.includes('not in the roster'))).toBe(true);
    const verbs = fake.calls.map((c) => c.args[0]);
    expect(verbs).not.toContain('send-keys');
    expect(verbs).not.toContain('kill-window');
    expect(verbs).not.toContain('kill-session');
    const started = fake.calls.filter((c) => c.args[0] === 'new-session').map((c) => c.args[3]);
    expect(started).toEqual(['operator-dispatch']);
    expect(fake.windows).toContain('executor-alpha');
  });

  it('refuses up over a roster with any legacy-layout entry, before touching tmux or the roster', async () => {
    writeRawRoster([legacyEntry('operator-dispatch', 'operator-dispatch')]);
    const before = readFileSync(rosterPath(boardDir), 'utf-8');
    fake.legacyWindows = ['operator-dispatch'];

    const err = await hierarchyUp(baseOpts, deps).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('cli-hierarchy down');
    expect((err as Error).message).not.toContain('\n');
    expect(fake.calls).toEqual([]);
    expect(readFileSync(rosterPath(boardDir), 'utf-8')).toBe(before);

    // A mixed roster (one legacy, one new-layout entry) is refused too.
    writeRawRoster([
      legacyEntry('executor-alpha', 'executor'),
      craftedEntry({
        name: 'planner',
        role: 'planner',
        tmuxSession: 'planner',
        tmuxWindow: 'planner',
      }),
    ]);
    await expect(hierarchyUp(baseOpts, deps)).rejects.toThrow(/cli-hierarchy down/);
    expect(fake.calls).toEqual([]);
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

  it('attaches to the planner when one was started, using the attach/switch rule', async () => {
    await hierarchyUp({ ...baseOpts, executors: 0, attach: true }, deps);
    expect(attached).toEqual([['attach-session', '-t', '=planner']]);

    // Inside tmux the same flag switches the client.
    fake = makeFakeTmux(registryDir);
    rmSync(rosterPath(boardDir));
    attached.length = 0;
    deps.env = { TMUX: '/tmp/tmux-1/default,123,0' };
    await hierarchyUp({ ...baseOpts, executors: 0, attach: true }, deps);
    expect(attached).toEqual([['switch-client', '-t', '=planner']]);
  });

  it('attaches to the dispatch session when no planner was started', async () => {
    await hierarchyUp({ ...baseOpts, executors: 1, noPlanner: true, attach: true }, deps);
    expect(attached).toEqual([['attach-session', '-t', '=operator-dispatch']]);
  });

  it('reports the exit code of the attach, and a warning (not a throw) when it cannot run', async () => {
    deps.attach = (args) => {
      attached.push([...args]);
      return 3;
    };
    const r = await hierarchyUp({ ...baseOpts, executors: 0, attach: true }, deps);
    expect(r.attachExitCode).toBe(3);

    // The target session vanishes between start and attach: a warning and exit code 1.
    fake = makeFakeTmux(registryDir);
    rmSync(rosterPath(boardDir));
    const realRun = fake.run;
    let started = false;
    fake.run = (f, a, o) => {
      if (a[0] === 'new-session') started = true;
      // has-session on the planner is only asked again by attach, after the start
      if (started && a[0] === 'has-session' && a.includes('=planner')) {
        return { status: 1, stdout: '', stderr: 'gone' };
      }
      return realRun(f, a, o);
    };
    const r2 = await hierarchyUp({ ...baseOpts, executors: 0, attach: true }, deps);
    expect(r2.attachExitCode).toBe(1);
    expect(logs.some((l) => l.includes("could not attach to 'planner'"))).toBe(true);
  });

  it('has no attach exit code when --attach was not requested', async () => {
    const r = await hierarchyUp({ ...baseOpts, executors: 0 }, deps);
    expect(r.attachExitCode).toBeUndefined();
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

  it('shows an ATTACHED column per session, yes only when a client is attached', async () => {
    await hierarchyUp({ ...baseOpts, executors: 1, noPlanner: true }, deps);
    fake.attachedClients['executor-alpha'] = 1;
    const result = hierarchyStatus(deps);
    const byName = Object.fromEntries(result.rows.map((r) => [r.entry.name, r.attached]));
    expect(byName).toEqual({ 'operator-dispatch': false, 'executor-alpha': true });
    const json = JSON.parse(JSON.stringify(result)) as { rows: { attached: boolean }[] };
    expect(json.rows.map((r) => r.attached)).toEqual([false, true]);

    const lines = formatStatus(result);
    expect(lines[0]).toMatch(/STATE\s+ATTACHED\s+MODEL/);
    expect(lines.find((l) => l.includes('executor-alpha'))).toMatch(/\byes\b/);
    expect(lines.find((l) => l.includes('operator-dispatch'))).toMatch(/\bno\b/);
    // The query is session-scoped and read-only.
    const q = fake.calls.filter((c) => c.args.includes('#{session_attached}'));
    expect(q.map((c) => c.args)).toEqual([
      ['display-message', '-p', '-t', '=operator-dispatch', '#{session_attached}'],
      ['display-message', '-p', '-t', '=executor-alpha', '#{session_attached}'],
    ]);
  });

  it('reports not attached when tmux fails or the entry is gone', async () => {
    await hierarchyUp({ ...baseOpts, executors: 1, noPlanner: true }, deps);
    fake.attachedClients['executor-alpha'] = 2;
    fake.windows = fake.windows.filter((w) => w !== 'executor-alpha');
    const rows = hierarchyStatus(deps).rows;
    expect(rows.find((r) => r.entry.name === 'executor-alpha')).toMatchObject({
      state: 'gone',
      attached: false,
    });
    // A garbled count is treated as not attached.
    const garbled = hierarchyStatus({
      ...deps,
      run: (f, a, o) =>
        a.includes('#{session_attached}')
          ? { status: 0, stdout: 'x\n', stderr: '' }
          : fake.run(f, a, o),
    });
    expect(garbled.rows.every((r) => r.attached === false)).toBe(true);
  });

  it('reports a legacy single-session roster from list-windows', async () => {
    writeRawRoster([
      legacyEntry('operator-dispatch', 'operator-dispatch'),
      legacyEntry('executor-alpha', 'executor'),
    ]);
    fake.legacyWindows = ['operator-dispatch'];
    fake.attachedClients['ai-sdlc-hierarchy'] = 1;
    const result = hierarchyStatus(deps);
    expect(result.rows.map((r) => [r.entry.name, r.state, r.attached])).toEqual([
      ['operator-dispatch', 'starting', true],
      ['executor-alpha', 'gone', false],
    ]);
    const listed = fake.calls.filter((c) => c.args[0] === 'list-windows');
    expect(listed.map((c) => c.args[2])).toEqual(['=ai-sdlc-hierarchy']);
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

  it('closes a confirmed pane by id, not the window by name, after the grace period', async () => {
    await hierarchyUp({ ...baseOpts, executors: 1, noPlanner: true }, deps);
    const paneId = readRoster(boardDir).sessions.find((e) => e.name === 'executor-alpha')?.paneId;
    fake.exitsOnRequest = false;
    const result = await hierarchyDown({ role: 'executor-alpha' }, deps);
    expect(result.stopped[0]?.forced).toBe(true);
    expect(fake.calls.filter((c) => c.args[0] === 'kill-pane').map((c) => c.args)).toEqual([
      ['kill-pane', '-t', paneId],
    ]);
    expect(fake.calls.some((c) => c.args[0] === 'kill-window')).toBe(false);
  });

  it('re-checks ownership immediately before the forced close: the marker vanishing during the grace period means no kill', async () => {
    await hierarchyUp({ ...baseOpts, executors: 1, noPlanner: true }, deps);
    putInflight('AISDLC-600', 'executor-alpha');
    fake.exitsOnRequest = false;
    // The agent never exits; while down waits, the session is replaced by one that is not ours.
    deps.sleep = async () => {
      fake.owned.delete('executor-alpha');
    };
    const result = await hierarchyDown({ role: 'executor-alpha' }, deps);

    expect(result.stopped).toEqual([]);
    expect(result.refused.map((r) => r.name)).toEqual(['executor-alpha']);
    expect(result.refused[0]?.reason).toMatch(/@ai-sdlc-hierarchy/);
    expect(
      fake.calls.filter((c) => c.args[0] === 'kill-pane' || c.args[0] === 'kill-window'),
    ).toEqual([]);
    expect(fake.windows).toContain('executor-alpha');
    expect(readRoster(boardDir).sessions.map((e) => e.name)).toContain('executor-alpha');
    expect(existsSync(path.join(boardDir, 'inflight', 'AISDLC-600.dispatch.json'))).toBe(true);
    expect(logs.some((l) => l.includes("not closing 'executor-alpha'"))).toBe(true);
    // the exit request had already gone out on the first (passing) gate
    expect(fake.calls.filter((c) => c.args[0] === 'send-keys')).toHaveLength(1);
  });

  it('closes a legacy window by name after the grace period (no marker, no pane to confirm)', async () => {
    fake.legacyWindows = ['executor-alpha'];
    writeRawRoster([
      {
        role: 'executor',
        name: 'executor-alpha',
        tmuxSession: 'ai-sdlc-hierarchy',
        tmuxWindow: 'executor-alpha',
        paneId: '',
        pid: 1,
        model: 'sonnet',
        permissionMode: 'default',
        startedAt: NOW.toISOString(),
        status: 'running',
      },
    ]);
    fake.exitsOnRequest = false;
    const r = await hierarchyDown({}, deps);
    expect(r.stopped[0]?.forced).toBe(true);
    expect(fake.calls.filter((c) => c.args[0] === 'kill-window').map((c) => c.args)).toEqual([
      ['kill-window', '-t', '=ai-sdlc-hierarchy:executor-alpha'],
    ]);
    expect(fake.calls.some((c) => c.args[0] === 'show-options')).toBe(false);
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
    ['a session and window that differ', { tmuxSession: 'planner', tmuxWindow: 'executor-alpha' }],
    ['a non-default session named after its window', { tmuxSession: 'editor' }],
    [
      'a malformed pane id in the new layout',
      { tmuxSession: 'planner', tmuxWindow: 'planner', paneId: '%1; rm' },
    ],
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

  it('refuses, sending nothing, when the recorded pane id is stale', async () => {
    await hierarchyUp({ ...baseOpts, executors: 1, noPlanner: true }, deps);
    putInflight('AISDLC-400', 'executor-alpha');
    const roster = readRoster(boardDir);
    const alpha = roster.sessions.find((s) => s.name === 'executor-alpha');
    if (alpha) alpha.paneId = '%999';
    writeRoster(boardDir, roster);

    const r = await hierarchyDown({ role: 'executor-alpha' }, deps);

    expect(r.stopped).toEqual([]);
    expect(r.refused).toHaveLength(1);
    expect(r.refused[0]?.name).toBe('executor-alpha');
    expect(r.refused[0]?.reason).toMatch(/pane %999 does not belong to window 'executor-alpha'/);
    expect(
      fake.calls.filter((c) => c.args[0] === 'send-keys' || c.args[0] === 'kill-window'),
    ).toEqual([]);
    expect(fake.windows).toContain('executor-alpha');
    // left in the roster, inflight work untouched
    expect(readRoster(boardDir).sessions.map((e) => e.name)).toContain('executor-alpha');
    expect(existsSync(path.join(boardDir, 'inflight', 'AISDLC-400.dispatch.json'))).toBe(true);
    expect(logs.some((l) => l.includes("not stopping 'executor-alpha'"))).toBe(true);
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

describe('session ownership marker', () => {
  const personal = (name: string) => ({
    role: name === 'planner' ? 'planner' : 'executor',
    name,
    tmuxSession: name,
    tmuxWindow: name,
    paneId: '',
    pid: 1,
    model: 'sonnet',
    permissionMode: 'default',
    startedAt: NOW.toISOString(),
    status: 'running',
  });

  it('up marks every session it starts, session-scoped and never globally', async () => {
    await hierarchyUp(baseOpts, deps);
    const marks = fake.calls.filter(
      (c) => c.args[0] === 'set-option' && c.args.includes('@ai-sdlc-hierarchy'),
    );
    expect(marks.map((c) => c.args)).toEqual(
      ['planner', 'operator-dispatch', 'executor-alpha', 'executor-beta'].map((n) => [
        'set-option',
        '-t',
        `=${n}:`,
        '@ai-sdlc-hierarchy',
        '1',
      ]),
    );
    expect([...fake.owned].sort()).toEqual(
      ['executor-alpha', 'executor-beta', 'operator-dispatch', 'planner'].sort(),
    );
    expect(marks.every((c) => !c.args.includes('-g'))).toBe(true);
  });

  it('warns, and keeps the agent, when a session cannot be marked; down then refuses it', async () => {
    fake.failMarkFor = 'executor-alpha';
    const r = await hierarchyUp({ ...baseOpts, executors: 1, noPlanner: true }, deps);
    expect(r.started.map((e) => e.name)).toContain('executor-alpha');
    expect(
      r.warnings.some((w) => w.includes("'executor-alpha'") && w.includes('@ai-sdlc-hierarchy')),
    ).toBe(true);

    const down = await hierarchyDown({ role: 'executor-alpha' }, deps);
    expect(down.stopped).toEqual([]);
    expect(down.refused.map((x) => x.name)).toEqual(['executor-alpha']);
  });

  it('down refuses a personal session with a default name and no marker: zero send-keys, nothing closed, roster and inflight kept', async () => {
    fake.windows = ['executor-alpha'];
    writeRawRoster([personal('executor-alpha')]);
    putInflight('AISDLC-500', 'executor-alpha');

    const r = await hierarchyDown({}, deps);

    expect(r.stopped).toEqual([]);
    expect(r.refused).toHaveLength(1);
    expect(r.refused[0]?.reason).toMatch(
      /tmux session 'executor-alpha'.*@ai-sdlc-hierarchy.*did not start it/,
    );
    expect(
      fake.calls.filter((c) => c.args[0] === 'send-keys' || c.args[0] === 'kill-window'),
    ).toEqual([]);
    expect(fake.windows).toEqual(['executor-alpha']);
    expect(readRosterChecked(boardDir).roster.sessions.map((e) => e.name)).toEqual([
      'executor-alpha',
    ]);
    expect(existsSync(path.join(boardDir, 'inflight', 'AISDLC-500.dispatch.json'))).toBe(true);
    // the check reads the session option of that exact session, before anything else is sent
    const show = fake.calls.find((c) => c.args[0] === 'show-options');
    expect(show?.args).toEqual([
      'show-options',
      '-v',
      '-t',
      '=executor-alpha:',
      '@ai-sdlc-hierarchy',
    ]);
  });

  it('down proceeds once the marker is present', async () => {
    fake.windows = ['executor-alpha'];
    fake.owned.add('executor-alpha');
    writeRawRoster([personal('executor-alpha')]);
    const r = await hierarchyDown({}, deps);
    expect(r.refused).toEqual([]);
    expect(r.stopped.map((x) => x.name)).toEqual(['executor-alpha']);
    expect(fake.windows).toEqual([]);
  });

  it('down keeps going after a refusal: it stops the owned sessions and reports the rest', async () => {
    await hierarchyUp({ ...baseOpts, executors: 2, noPlanner: true }, deps);
    fake.owned.delete('executor-alpha');
    const r = await hierarchyDown({}, deps);
    expect(r.refused.map((x) => x.name)).toEqual(['executor-alpha']);
    expect(r.stopped.map((x) => x.name).sort()).toEqual(['executor-beta', 'operator-dispatch']);
    expect(readRoster(boardDir).sessions.map((e) => e.name)).toEqual(['executor-alpha']);
  });

  it('names the session with a trailing colon for every option call, never a bare =name', async () => {
    await hierarchyUp({ ...baseOpts, executors: 1, noPlanner: true }, deps);
    await hierarchyDown({ role: 'executor-alpha' }, deps);
    const optionCalls = fake.calls.filter(
      (c) => c.args[0] === 'set-option' || c.args[0] === 'show-options',
    );
    // marker + 3 title options per session started, one show-options for the down check
    expect(optionCalls.length).toBeGreaterThanOrEqual(9);
    for (const c of optionCalls) {
      const target = c.args[c.args.indexOf('-t') + 1] as string;
      expect(target).toMatch(/^=[a-z][a-z0-9-]*:$/);
    }
  });

  it('applies no ownership check to a legacy-layout roster (it predates the marker)', async () => {
    fake.legacyWindows = ['executor-alpha'];
    writeRawRoster([
      {
        ...personal('executor-alpha'),
        tmuxSession: 'ai-sdlc-hierarchy',
        paneId: '',
      },
    ]);
    const r = await hierarchyDown({}, deps);
    expect(r.refused).toEqual([]);
    expect(r.stopped.map((x) => x.name)).toEqual(['executor-alpha']);
    expect(fake.calls.some((c) => c.args[0] === 'show-options')).toBe(false);
  });
});

describe('roster entry safety (both layouts)', () => {
  const entry = (over: Record<string, unknown>) => craftedEntry(over) as RosterEntry;

  it('accepts a legacy entry and a new-layout default-named entry', () => {
    expect(
      unsafeEntryReason(
        entry({ tmuxSession: 'ai-sdlc-hierarchy', tmuxWindow: 'executor-beta', paneId: '' }),
      ),
    ).toBeUndefined();
    for (const name of ['planner', 'operator-dispatch', 'executor-alpha', 'executor-epsilon']) {
      expect(
        unsafeEntryReason(entry({ tmuxSession: name, tmuxWindow: name, paneId: '%12' })),
      ).toBeUndefined();
    }
  });

  it('rejects arbitrary sessions, mismatched session and window, and bad pane ids', () => {
    expect(unsafeEntryReason(entry({ tmuxSession: 'main', tmuxWindow: 'main' }))).toMatch(
      /default hierarchy session/,
    );
    expect(unsafeEntryReason(entry({ tmuxSession: 'main', tmuxWindow: 'planner' }))).toMatch(
      /neither/,
    );
    expect(
      unsafeEntryReason(entry({ tmuxSession: 'planner', tmuxWindow: 'operator-dispatch' })),
    ).toMatch(/neither/);
    expect(unsafeEntryReason(entry({ tmuxSession: 'planner', tmuxWindow: 'a:b' }))).toMatch(
      /invalid tmux window/,
    );
    expect(
      unsafeEntryReason(entry({ tmuxSession: 'planner', tmuxWindow: 'planner', paneId: 'x' })),
    ).toMatch(/invalid pane id/);
    // The legacy session name is not a default agent name, so it cannot pass as a new-layout entry.
    expect(
      unsafeEntryReason(entry({ tmuxSession: 'ai-sdlc-hierarchy', tmuxWindow: 'a b' })),
    ).toMatch(/invalid tmux window/);
  });

  it('fails closed on a custom agent name, even a well-formed self-consistent one', () => {
    // Fail-closed by design: only the default hierarchy names are accepted in the new
    // layout, so a roster with other names is never acted on by down or brief --notify.
    for (const name of ['executor-zeta', 'my-planner', 'executor-alpha-2']) {
      expect(
        unsafeEntryReason(entry({ tmuxSession: name, tmuxWindow: name, paneId: '%1' })),
      ).toMatch(/not one of the default hierarchy session names/);
    }
  });

  it('keeps legacy and new entries through readRosterChecked and rejects the rest', () => {
    writeRawRoster([
      legacyEntry('executor-alpha', 'executor'),
      craftedEntry({ name: 'planner', tmuxSession: 'planner', tmuxWindow: 'planner' }),
      craftedEntry({ name: 'bad', tmuxSession: 'victim', tmuxWindow: 'victim' }),
    ]);
    const { roster, rejected } = readRosterChecked(boardDir);
    expect(roster.sessions.map((s) => s.name)).toEqual(['executor-alpha', 'planner']);
    expect(rejected).toHaveLength(1);
    expect(isLegacyLayoutEntry(roster.sessions[0] as RosterEntry)).toBe(true);
    expect(isLegacyLayoutEntry(roster.sessions[1] as RosterEntry)).toBe(false);
  });

  it('still validates a roster written by the old layout against the schema', () => {
    const doc = { schemaVersion: 'v1', sessions: [legacyEntry('planner', 'planner')] };
    expect(validateHierarchyRoster(doc).valid).toBe(true);
    const bad = { schemaVersion: 'v1', sessions: [craftedEntry({ tmuxSession: 'Bad Name' })] };
    expect(validateHierarchyRoster(bad).valid).toBe(false);
  });
});

describe('hierarchy down on an old single-session roster', () => {
  it('stops legacy entries through their window in the shared session and updates the roster', async () => {
    writeRawRoster([
      legacyEntry('operator-dispatch', 'operator-dispatch'),
      legacyEntry('executor-alpha', 'executor'),
    ]);
    fake.legacyWindows = ['operator-dispatch', 'executor-alpha'];
    putInflight('AISDLC-500', 'executor-alpha');

    const result = await hierarchyDown({ role: 'executor-alpha' }, deps);

    expect(result.stopped).toEqual([
      { name: 'executor-alpha', role: 'executor', requeued: 'AISDLC-500', forced: false },
    ]);
    const send = fake.calls.find((c) => c.args[0] === 'send-keys');
    expect(send?.args[send.args.indexOf('-t') + 1]).toBe('=ai-sdlc-hierarchy:executor-alpha');
    expect(fake.legacyWindows).toEqual(['operator-dispatch']);
    expect(readRoster(boardDir).sessions.map((s) => s.name)).toEqual(['operator-dispatch']);

    const rest = await hierarchyDown({}, deps);
    expect(rest.stopped.map((s) => s.name)).toEqual(['operator-dispatch']);
    expect(readRoster(boardDir).sessions).toEqual([]);
  });

  it('closes a legacy window that does not exit', async () => {
    writeRawRoster([legacyEntry('executor-alpha', 'executor')]);
    fake.legacyWindows = ['executor-alpha'];
    fake.exitsOnRequest = false;
    const r = await hierarchyDown({}, deps);
    expect(r.stopped[0]?.forced).toBe(true);
    const kill = fake.calls.find((c) => c.args[0] === 'kill-window');
    expect(kill?.args).toEqual(['kill-window', '-t', '=ai-sdlc-hierarchy:executor-alpha']);
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
