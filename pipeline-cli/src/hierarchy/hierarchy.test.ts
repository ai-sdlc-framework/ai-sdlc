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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { landingPath } from './reconcile.js';
import { schedulerDown, schedulerStatus } from './reconcile-scheduler.js';

import {
  ensureBoardDirs,
  readHeartbeat,
  releaseInflight,
  writeHeartbeat,
  writeManifest,
} from '../dispatch/board.js';
import type { DispatchManifest } from '../dispatch/types.js';
import {
  attachTmuxSession,
  buildClaudeCommand,
  executorMcpArgs,
  hasLaunchEnv,
  createSystemRunner,
  evaluateResourceGate,
  executorNames,
  findStartedSession,
  formatAge,
  formatStatus,
  hierarchyDown,
  hierarchyRegister,
  hierarchyRestart,
  hierarchyRestartAll,
  hierarchyStatus,
  hierarchyUp,
  isLegacyLayoutEntry,
  isValidSessionName,
  isValidTaskId,
  listInflight,
  parseExecutorCount,
  parseMemInfo,
  parseVmStat,
  PROJECT_SEPARATOR,
  qualifiedName,
  readRoster,
  readRosterChecked,
  readSessionRegistry,
  readSettingsView,
  roleOfDefaultName,
  rosterPath,
  sanitizeProject,
  shellQuote,
  splitSessionName,
  writeRoster,
  type CommandRunner,
  type HierarchyDeps,
  type RosterEntry,
  type UpOptions,
  unsafeEntryReason,
} from './index.js';
import { executorStart } from './executor-start.js';
import { isNodeInstalled, paneNodeVersion, readNvmrc } from './node-pin.js';

const NOW = new Date('2026-09-30T12:00:00.000Z');

/** Project name the tests start under: the basename of `deps.cwd` (`/repo`). */
const PROJECT = 'repo';
/** Project-qualified session name for a bare role name. */
const Q = (bare: string): string => `${PROJECT}-${bare}`;

interface FakeTmux {
  run: CommandRunner;
  calls: { file: string; args: string[]; options?: { cwd?: string } }[];
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
  /** Epoch ms the fake harness records as a started session's start time. */
  startedAtMs: number;
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
    startedAtMs: NOW.getTime(),
    run: () => ({ status: 1, stdout: '', stderr: '' }),
  };
  const paneOf = new Map<string, string>();
  const commandOf = new Map<string, string>();
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
  fake.run = (file, args, options) => {
    fake.calls.push({ file, args: [...args], options });
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
        commandOf.set(window, args[args.length - 1] as string);
        if (fake.register) {
          mkdirSync(registryDir, { recursive: true });
          writeFileSync(
            path.join(registryDir, `${pid}.json`),
            JSON.stringify({
              pid,
              name: fake.nameFor(window),
              startedAt: fake.startedAtMs,
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
        if (args[args.length - 1] === '#{pane_start_command}') {
          const window = target.split(':')[1] as string;
          return commandOf.has(window) ? ok(commandOf.get(window) + '\n') : fail('no pane');
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

let schedulerSpawns: string[][];

beforeEach(() => {
  // Never read the ambient executor session (AISDLC-1137).
  vi.stubEnv('AI_SDLC_EXECUTOR_TASK', '');
  vi.stubEnv('AI_SDLC_EXECUTOR_MCP', '');
  vi.stubEnv('AI_SDLC_EXECUTOR_MCP_CONFIG', '');
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
    resolveRoot: (c) => c,
    loadPolicy: () => ({ forcePushMode: 'lease', operational: [] }),
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
    // No registry entry is a live foreign process unless a test says so.
    isAlive: () => false,
    spawnScheduler: (f, a) => {
      schedulerSpawns.push([f, ...a]);
      return 4242;
    },
  };
  schedulerSpawns = [];
});

afterEach(() => {
  vi.unstubAllEnvs();
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

describe('formatStatus dynamic executors (AISDLC-1075)', () => {
  it('lists each dynamic executor with its task id and age', () => {
    const row = (taskId: string | undefined, startedAt: string) =>
      ({
        entry: {
          role: 'executor',
          name: taskId ? `ai-sdlc-executor-${taskId.toLowerCase()}` : 'p-executor-alpha',
          tmuxSession: 'x',
          tmuxWindow: 'x',
          model: 'sonnet',
          permissionMode: 'bypassPermissions',
          startedAt,
          ...(taskId ? { taskId } : {}),
        },
        state: 'busy',
        attached: false,
        module: { state: 'absent' },
      }) as never;
    const now = Date.parse('2026-10-27T12:00:00Z');
    const lines = formatStatus(
      {
        rows: [row('AISDLC-9', '2026-10-27T11:55:00Z'), row(undefined, '2026-10-27T01:00:00Z')],
        board: { queued: 0, inflight: 0, done: 0, failed: 0 },
        webhook: { running: false },
        scheduler: { running: false },
      } as never,
      now,
    );
    const dyn = lines.filter((l) => l.startsWith('dynamic executor:'));
    expect(dyn).toEqual([
      'dynamic executor: ai-sdlc-executor-aisdlc-9 task AISDLC-9 age 5m (busy)',
    ]);
    const withErrors = formatStatus(
      {
        rows: [],
        board: { queued: 0, inflight: 0, done: 0, failed: 0 },
        webhook: { running: false },
        scheduler: { running: false },
        spawnErrors: [{ taskId: 'AISDLC-785', error: 'boom' }],
      } as never,
      now,
    );
    expect(withErrors).toContain('spawn error: task AISDLC-785: boom');
    expect(formatAge('2026-10-27T09:50:00Z', now)).toBe('2h10m');
    expect(formatAge('garbage', now)).toBe('?');
  });
});

describe('hierarchy up VS Code tasks (AISDLC-754)', () => {
  const HINT =
    'VS Code: run task "hierarchy: open all agents" (Terminal > Run Task) to open one terminal per agent';
  let repo: string;
  const tasksFile = () => path.join(repo, '.vscode', 'tasks.json');

  beforeEach(() => {
    repo = path.join(tmp, 'repo');
    mkdirSync(repo, { recursive: true });
    deps.cwd = repo;
    deps.binPath = '/x/bin/cli-hierarchy.mjs';
  });

  it('creates a marked tasks file listing every agent, and leaves it byte-identical on a no-op up', async () => {
    await hierarchyUp({ ...baseOpts, vscodeTasks: true }, deps);
    const first = readFileSync(tasksFile(), 'utf-8');
    const doc = JSON.parse(first);
    expect(doc['ai-sdlc']).toEqual({
      generated: true,
      roster: path.join(boardDir, 'hierarchy.json'),
    });
    expect(doc.tasks.map((t: { label: string }) => t.label)).toEqual([
      Q('planner'),
      Q('operator-dispatch'),
      Q('executor-alpha'),
      Q('executor-beta'),
      'hierarchy: open all agents',
    ]);
    const second = await hierarchyUp({ ...baseOpts, vscodeTasks: true }, deps);
    expect(second.started).toEqual([]);
    expect(readFileSync(tasksFile(), 'utf-8')).toBe(first);
  });

  it('regenerates when more executors start', async () => {
    await hierarchyUp({ ...baseOpts, vscodeTasks: true }, deps);
    await hierarchyUp({ ...baseOpts, executors: 3, vscodeTasks: true }, deps);
    expect(readFileSync(tasksFile(), 'utf-8')).toContain(Q('executor-gamma'));
  });

  it('never modifies an unmarked file and prints the merge hint', async () => {
    mkdirSync(path.dirname(tasksFile()), { recursive: true });
    writeFileSync(tasksFile(), '{"version":"2.0.0","tasks":[]}');
    await hierarchyUp({ ...baseOpts, vscodeTasks: true }, deps);
    expect(readFileSync(tasksFile(), 'utf-8')).toBe('{"version":"2.0.0","tasks":[]}');
    expect(logs.filter((l) => l.includes('terminals --vscode --print'))).toHaveLength(1);
  });

  it('skips regeneration when vscodeTasks is not set (--no-vscode-tasks)', async () => {
    deps.env = { TERM_PROGRAM: 'vscode' };
    await hierarchyUp(baseOpts, deps);
    expect(existsSync(tasksFile())).toBe(false);
    expect(logs).not.toContain(HINT);
  });

  it('ends with the run-task hint under TERM_PROGRAM=vscode or VSCODE_GIT_IPC_HANDLE, and omits it otherwise', async () => {
    deps.env = { TERM_PROGRAM: 'vscode' };
    await hierarchyUp({ ...baseOpts, vscodeTasks: true }, deps);
    expect(logs[logs.length - 1]).toBe(HINT);

    logs.length = 0;
    deps.env = { VSCODE_GIT_IPC_HANDLE: '/tmp/sock' };
    await hierarchyUp({ ...baseOpts, vscodeTasks: true }, deps);
    expect(logs[logs.length - 1]).toBe(HINT);

    logs.length = 0;
    deps.env = { TERM_PROGRAM: 'vscode', AI_SDLC_VSCODE_HIERARCHY: '1' };
    await hierarchyUp({ ...baseOpts, vscodeTasks: true }, deps);
    expect(logs).not.toContain(HINT);

    logs.length = 0;
    deps.env = {};
    await hierarchyUp({ ...baseOpts, vscodeTasks: true }, deps);
    expect(logs).not.toContain(HINT);
  });

  it('warns instead of failing when the tasks file cannot be written', async () => {
    writeFileSync(path.join(repo, '.vscode'), 'a file where the directory should be');
    const r = await hierarchyUp({ ...baseOpts, vscodeTasks: true }, deps);
    expect(r.started.length).toBeGreaterThan(0);
    expect(logs.some((l) => l.startsWith('warning: could not write .vscode/tasks.json'))).toBe(
      true,
    );
  });
});

describe('hierarchy up', () => {
  it('starts one session per agent, titled and with an attach hint, and writes a valid roster', async () => {
    const result = await hierarchyUp(baseOpts, deps);

    expect(result.started.map((e) => e.name)).toEqual([
      Q('planner'),
      Q('operator-dispatch'),
      Q('executor-alpha'),
      Q('executor-beta'),
    ]);
    // AISDLC-963: every launch puts the gh shim first on PATH and names the call log.
    for (const c of newWindowCommands()) {
      expect(c).toMatch(/^PATH='[^']+\/bin':"\$PATH" AI_SDLC_GH_CALL_LOG='[^']+gh-calls\.jsonl' /);
    }
    expect(
      newWindowCommands().map((c) => c.replace(/^PATH=\S+ AI_SDLC_GH_CALL_LOG=\S+ /, '')),
    ).toEqual([
      `CLAUDE_PROJECT_DIR='/repo' AI_SDLC_HIERARCHY_SESSION='${Q('planner')}' AI_SDLC_HIERARCHY_ROLE='planner' 'claude' --name '${Q('planner')}' --model 'fable' --permission-mode 'bypassPermissions' '/ai-sdlc planner'`,
      `CLAUDE_PROJECT_DIR='/repo' AI_SDLC_HIERARCHY_SESSION='${Q('operator-dispatch')}' AI_SDLC_HIERARCHY_ROLE='operator-dispatch' 'claude' --name '${Q('operator-dispatch')}' --model 'opus' --permission-mode 'bypassPermissions' '/ai-sdlc operator-dispatch'`,
      `CLAUDE_PROJECT_DIR='/repo' AI_SDLC_HIERARCHY_SESSION='${Q('executor-alpha')}' AI_SDLC_HIERARCHY_ROLE='executor' 'claude' --name '${Q('executor-alpha')}' --model 'sonnet' --permission-mode 'bypassPermissions' '/ai-sdlc executor'`,
      `CLAUDE_PROJECT_DIR='/repo' AI_SDLC_HIERARCHY_SESSION='${Q('executor-beta')}' AI_SDLC_HIERARCHY_ROLE='executor' 'claude' --name '${Q('executor-beta')}' --model 'sonnet' --permission-mode 'bypassPermissions' '/ai-sdlc executor'`,
    ]);
    // One detached session per agent, named after it; never a shared session or a new window.
    const creates = fake.calls.filter((c) =>
      ['new-session', 'new-window'].includes(c.args[0] as string),
    );
    expect(creates.map((c) => c.args.slice(0, 7))).toEqual(
      [Q('planner'), Q('operator-dispatch'), Q('executor-alpha'), Q('executor-beta')].map((n) => [
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
    for (const n of [Q('planner'), Q('executor-beta')]) {
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
    for (const n of [
      Q('planner'),
      Q('operator-dispatch'),
      Q('executor-alpha'),
      Q('executor-beta'),
    ]) {
      expect(logs.filter((l) => l.includes(`cli-hierarchy attach ${n}`))).toHaveLength(1);
    }

    const roster = JSON.parse(readFileSync(rosterPath(boardDir), 'utf-8'));
    expect(validateHierarchyRoster(roster).valid).toBe(true);
    expect(roster.sessions).toHaveLength(4);
    const alpha = roster.sessions.find((s: { name: string }) => s.name === Q('executor-alpha'));
    for (const s of roster.sessions as { name: string; tmuxSession: string }[]) {
      expect(s.tmuxSession).toBe(s.name);
    }
    expect(alpha).toMatchObject({
      role: 'executor',
      tmuxSession: Q('executor-alpha'),
      tmuxWindow: Q('executor-alpha'),
      model: 'sonnet',
      permissionMode: 'bypassPermissions',
      status: 'running',
      startedAt: NOW.toISOString(),
    });
    expect(alpha.pid).toBeGreaterThan(0);
    expect(alpha.paneId).toMatch(/^%/);
  });

  it('prints a deprecation line for --executors above 0 and none for the default 0 (AISDLC-1075)', async () => {
    const logs: string[] = [];
    const logDeps = { ...deps, log: (l: string) => void logs.push(l) };
    await hierarchyUp({ ...baseOpts, executors: 0, noPlanner: true }, logDeps);
    expect(logs.some((l) => l.includes('deprecated: --executors'))).toBe(false);
    await hierarchyUp({ ...baseOpts, executors: 2, noPlanner: true }, logDeps);
    expect(logs.some((l) => l.includes('deprecated: --executors 2'))).toBe(true);
  });

  it('--executors 2 --no-planner issues one new-session per started agent and no new-window', async () => {
    const r = await hierarchyUp({ ...baseOpts, executors: 2, noPlanner: true }, deps);
    const sessions = fake.calls.filter((c) => c.args[0] === 'new-session');
    expect(sessions.map((c) => c.args[3])).toEqual([
      Q('operator-dispatch'),
      Q('executor-alpha'),
      Q('executor-beta'),
    ]);
    expect(fake.calls.some((c) => c.args[0] === 'new-window')).toBe(false);
    expect(r.started.map((e) => [e.tmuxSession, e.tmuxWindow])).toEqual([
      [Q('operator-dispatch'), Q('operator-dispatch')],
      [Q('executor-alpha'), Q('executor-alpha')],
      [Q('executor-beta'), Q('executor-beta')],
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

  it('honours an explicit planner permission mode and --no-planner', async () => {
    await hierarchyUp({ ...baseOpts, executors: 0, plannerPermissionMode: 'plan' }, deps);
    expect(newWindowCommands()[0]).toContain("--permission-mode 'plan'");

    fake = makeFakeTmux(registryDir);
    rmSync(rosterPath(boardDir));
    const r = await hierarchyUp({ ...baseOpts, executors: 1, noPlanner: true }, deps);
    expect(r.started.map((e) => e.name)).toEqual([Q('operator-dispatch'), Q('executor-alpha')]);
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
    expect(r.started.map((e) => e.name)).toEqual([Q('executor-gamma')]);
    expect(readRoster(boardDir).sessions).toHaveLength(5);
  });

  it('writes a harness-suffixed name back to the roster', async () => {
    fake.nameFor = (n) => (n === Q('executor-alpha') ? `${Q('executor-alpha')}-2` : n);
    // An older session already owns the plain name.
    mkdirSync(registryDir, { recursive: true });
    writeFileSync(
      path.join(registryDir, '1.json'),
      JSON.stringify({
        pid: 1,
        name: Q('executor-alpha'),
        startedAt: NOW.getTime() - 60_000,
        status: 'busy',
      }),
    );

    await hierarchyUp({ ...baseOpts, executors: 1 }, deps);

    const alpha = readRoster(boardDir).sessions.find((s) => s.tmuxWindow === Q('executor-alpha'));
    expect(alpha?.name).toBe(`${Q('executor-alpha')}-2`);
    expect(alpha?.pid).not.toBe(1);
    expect(logs.some((l) => l.includes(`registered as '${Q('executor-alpha')}-2'`))).toBe(true);
  });

  it('keeps the requested name and warns when the registry never lists the session', async () => {
    fake.register = false;
    const r = await hierarchyUp({ ...baseOpts, executors: 0, noPlanner: true }, deps);
    expect(r.started[0]).toMatchObject({ name: Q('operator-dispatch'), status: 'starting' });
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
    // A planner recorded under a default session name other than the usual one.
    writeRoster(boardDir, {
      schemaVersion: 'v1',
      sessions: [
        {
          role: 'planner',
          project: PROJECT,
          name: 'my-planner',
          tmuxSession: Q('executor-epsilon'),
          tmuxWindow: Q('executor-epsilon'),
          paneId: '%1',
          pid: 10,
          model: 'fable',
          permissionMode: 'default',
          startedAt: NOW.toISOString(),
          status: 'running',
        },
      ],
    });
    fake.windows = [Q('executor-epsilon')];

    await expect(hierarchyUp(baseOpts, deps)).rejects.toThrow(/second one/);
    expect(newWindowCommands()).toEqual([]);

    // --no-planner leaves it alone and starts the rest.
    const r = await hierarchyUp({ ...baseOpts, noPlanner: true, executors: 0 }, deps);
    expect(r.started.map((e) => e.name)).toEqual([Q('operator-dispatch')]);
  });

  it('refuses when the resource gate is enabled and refuses', async () => {
    deps.resources = () => ({ availableBytes: 1024 ** 3, loadAvg1: 0, cpus: 4 });
    deps.resourceGate = true;
    await expect(hierarchyUp(baseOpts, deps)).rejects.toThrow(/resource gate refused/);
  });

  it('does not call the resource gate unless hierarchy.resourceGate is true (AISDLC-1104)', async () => {
    let probed = 0;
    deps.resources = () => {
      probed++;
      return { availableBytes: 1024 ** 3, loadAvg1: 99, cpus: 4 };
    };
    // no override: the config default (false) applies
    await expect(hierarchyUp(baseOpts, deps)).resolves.toBeDefined();
    expect(probed).toBe(0);
  });

  it('drops roster entries whose window is gone and restarts them', async () => {
    await hierarchyUp({ ...baseOpts, executors: 1 }, deps);
    fake.windows = fake.windows.filter((w) => w !== Q('executor-alpha'));
    const r = await hierarchyUp({ ...baseOpts, executors: 1 }, deps);
    expect(r.started.map((e) => e.name)).toEqual([Q('executor-alpha')]);
    expect(r.warnings.some((w) => w.includes('no live tmux session'))).toBe(true);
  });

  it('does not duplicate or kill a session that has an agent name but is not in the roster', async () => {
    fake.windows = [Q('executor-alpha')];
    const r = await hierarchyUp({ ...baseOpts, executors: 1, noPlanner: true }, deps);
    expect(r.started.map((e) => e.name)).toEqual([Q('operator-dispatch')]);
    expect(r.warnings.some((w) => w.includes('not in the roster'))).toBe(true);
    const verbs = fake.calls.map((c) => c.args[0]);
    expect(verbs).not.toContain('send-keys');
    expect(verbs).not.toContain('kill-window');
    expect(verbs).not.toContain('kill-session');
    const started = fake.calls.filter((c) => c.args[0] === 'new-session').map((c) => c.args[3]);
    expect(started).toEqual([Q('operator-dispatch')]);
    expect(fake.windows).toContain(Q('executor-alpha'));
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
    fake.failStartFor = Q('executor-alpha');
    await expect(hierarchyUp({ ...baseOpts, executors: 2 }, deps)).rejects.toThrow(
      /could not start 'repo-executor-alpha'/,
    );
    expect(readRoster(boardDir).sessions.map((s) => s.name)).toEqual([
      Q('planner'),
      Q('operator-dispatch'),
    ]);
  });

  it('attaches to the planner when one was started, using the attach/switch rule', async () => {
    await hierarchyUp({ ...baseOpts, executors: 0, attach: true }, deps);
    expect(attached).toEqual([['attach-session', '-t', `=${Q('planner')}`]]);

    // Inside tmux the same flag switches the client.
    fake = makeFakeTmux(registryDir);
    rmSync(rosterPath(boardDir));
    attached.length = 0;
    deps.env = { TMUX: '/tmp/tmux-1/default,123,0' };
    await hierarchyUp({ ...baseOpts, executors: 0, attach: true }, deps);
    expect(attached).toEqual([['switch-client', '-t', `=${Q('planner')}`]]);
  });

  it('attaches to the dispatch session when no planner was started', async () => {
    await hierarchyUp({ ...baseOpts, executors: 1, noPlanner: true, attach: true }, deps);
    expect(attached).toEqual([['attach-session', '-t', `=${Q('operator-dispatch')}`]]);
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
      if (started && a[0] === 'has-session' && a.includes(`=${Q('planner')}`)) {
        return { status: 1, stdout: '', stderr: 'gone' };
      }
      return realRun(f, a, o);
    };
    const r2 = await hierarchyUp({ ...baseOpts, executors: 0, attach: true }, deps);
    expect(r2.attachExitCode).toBe(1);
    expect(logs.some((l) => l.includes(`could not attach to '${Q('planner')}'`))).toBe(true);
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
    putInflight('AISDLC-100', Q('executor-alpha'));
    // beta is busy in the registry; the others stay idle.
    for (const f of ['4003.json']) {
      const file = path.join(registryDir, f);
      const doc = JSON.parse(readFileSync(file, 'utf-8'));
      writeFileSync(file, JSON.stringify({ ...doc, status: 'busy' }));
    }
    // dispatch window dies.
    fake.windows = fake.windows.filter((w) => w !== Q('operator-dispatch'));
    rmSync(path.join(registryDir, '4001.json'));

    writeFileSync(
      path.join(boardDir, 'usage.json'),
      JSON.stringify({
        available: true,
        samples: [],
        windows: {},
        sample: {
          at: '2026-10-23T18:30:00Z',
          sevenDay: { utilization: 91, resetsAt: '2026-10-27T18:30:00Z' },
        },
      }),
    );
    const result = hierarchyStatus(deps);
    expect(formatStatus(result)[0]).toBeDefined();
    expect(formatStatus(result).join('\n')).toContain('BUDGET 7d 91%');
    const byName = Object.fromEntries(result.rows.map((r) => [r.entry.name, r]));
    expect(byName[Q('executor-alpha')]).toMatchObject({
      state: 'idle',
      inflightTask: 'AISDLC-100',
    });
    expect(byName[Q('executor-beta')]).toMatchObject({ state: 'busy' });
    expect(byName[Q('executor-beta')]?.inflightTask).toBeUndefined();
    expect(byName[Q('operator-dispatch')]?.state).toBe('gone');
    expect(result.board.inflight).toBe(1);

    const text = formatStatus(result).join('\n');
    expect(text).not.toContain('dynamic executor:');
    expect(text).toContain(Q('executor-alpha'));
    expect(text).toContain('AISDLC-100');
    expect(text).toContain('busy');
    expect(text).toContain('board: 0 queued, 1 inflight');
    expect(text).toContain('HIERARCHY_SESSION');
    expect(text).not.toContain('unbriefed');
    expect(result.contextThresholds).toEqual({
      planner: 150000,
      'operator-dispatch': 120000,
      executor: 120000,
    });
    expect(text).toContain(
      'context clear thresholds (tokens): planner 150000, operator-dispatch 120000, executor 120000',
    );
    const withGap = formatStatus({ ...result, unbriefed: ['AISDLC-5'] }).join('\n');
    expect(withGap).toContain('unbriefed');
    expect(withGap).toContain('AISDLC-5');
    expect(formatStatus({ ...result, rows: [], unbriefed: ['AISDLC-5'] }).join('\n')).toContain(
      'AISDLC-5',
    );
    expect(text).toContain('HIERARCHY_ROLE');
    const alphaLine = text.split('\n').find((l) => l.includes(Q('executor-alpha')));
    expect(alphaLine).toMatch(new RegExp(`${Q('executor-alpha')}\\s+executor$`));
  });

  it('shows an ENV column from the pane start command; a bare launch is missing (AISDLC-791)', async () => {
    await hierarchyUp({ ...baseOpts, executors: 1, noPlanner: true }, deps);
    const okResult = hierarchyStatus(deps);
    expect(okResult.rows.map((r) => r.launchEnv)).toEqual(['ok', 'ok']);
    expect(okResult.rows.every((r) => r.nextStep === undefined)).toBe(true);

    // The executor was started by an older build: a bare `claude --name ...` command.
    const realRun = fake.run;
    fake.run = (f, a, o) =>
      a[0] === 'display-message' &&
      a.includes('#{pane_start_command}') &&
      a.includes(`=${Q('executor-alpha')}:${Q('executor-alpha')}`)
        ? {
            status: 0,
            stdout: `'claude' --name '${Q('executor-alpha')}' '/ai-sdlc executor'\n`,
            stderr: '',
          }
        : realRun(f, a, o);
    const result = hierarchyStatus(deps);
    const alpha = result.rows.find((r) => r.entry.name === Q('executor-alpha'));
    expect(alpha?.launchEnv).toBe('missing');
    expect(alpha?.nextStep).toBe(
      "relaunch with `cli-hierarchy down --role executor` then `up` from the main checkout's build",
    );
    const json = JSON.parse(JSON.stringify(result)) as { rows: { launchEnv: string }[] };
    expect(json.rows.map((r) => r.launchEnv)).toEqual(['ok', 'missing']);
    const lines = formatStatus(result);
    expect(lines[0]).toMatch(
      /INFLIGHT\s+LANDING\s+ENV\s+NODE\s+MODULE\s+CONTEXT\s+HIERARCHY_SESSION/,
    );
    expect(lines.find((l) => l.includes('env missing on'))).toContain(
      'cli-hierarchy down --role executor',
    );
  });

  it('reads the double-quote-wrapped pane_start_command tmux returns as ok (AISDLC-791.1)', async () => {
    await hierarchyUp({ ...baseOpts, executors: 1, noPlanner: true }, deps);
    const name = Q('executor-alpha');
    const quoted = `"AI_SDLC_HIERARCHY_SESSION='${name}' AI_SDLC_HIERARCHY_ROLE='executor' 'claude' --name '${name}' '/ai-sdlc executor'"`;
    const realRun = fake.run;
    fake.run = (f, a, o) =>
      a[0] === 'display-message' &&
      a.includes('#{pane_start_command}') &&
      a.includes(`=${name}:${name}`)
        ? { status: 0, stdout: `${quoted}\n`, stderr: '' }
        : realRun(f, a, o);
    const result = hierarchyStatus(deps);
    const alpha = result.rows.find((r) => r.entry.name === name);
    expect(alpha?.launchEnv).toBe('ok');
    expect(alpha?.nextStep).toBeUndefined();
    expect(formatStatus(result).some((l) => l.includes('env missing on'))).toBe(false);
  });

  it('hasLaunchEnv unwraps one double-quote pair (AISDLC-791.1)', () => {
    expect(
      hasLaunchEnv(
        `"AI_SDLC_HIERARCHY_SESSION='x' AI_SDLC_HIERARCHY_ROLE='executor' 'claude' --name 'x'"`,
        'x',
        'executor',
      ),
    ).toBe(true);
    expect(
      hasLaunchEnv(
        '"AI_SDLC_HIERARCHY_SESSION=ai-sdlc-planner AI_SDLC_HIERARCHY_ROLE=planner claude --name x"',
        'ai-sdlc-planner',
        'planner',
      ),
    ).toBe(true);
    expect(hasLaunchEnv('"claude --name x"', 'x', 'executor')).toBe(false);
  });

  it('reports starting when the window is alive but the registry has no entry', async () => {
    fake.register = false;
    await hierarchyUp({ ...baseOpts, executors: 0, noPlanner: true }, deps);
    expect(hierarchyStatus(deps).rows[0]?.state).toBe('starting');
  });

  it('shows the executor-owned undelivered and delivered PR in LANDING and omits landed', async () => {
    await hierarchyUp({ ...baseOpts, executors: 3, noPlanner: true }, deps);
    const put = (pr: number, owner: string, extra: Record<string, unknown>): void => {
      mkdirSync(path.join(boardDir, 'landing'), { recursive: true });
      writeFileSync(
        path.join(boardDir, 'landing', `${pr}.json`),
        JSON.stringify({
          pr,
          kind: 'backlog',
          owner,
          state: 'green',
          action: 'none',
          history: [],
          ...extra,
        }),
      );
    };
    put(11, `executor:${Q('executor-alpha')}`, {});
    put(12, `executor:${Q('executor-beta')}`, {
      delivered: '2026-10-20T00:00:00Z',
      state: 'armed',
    });
    put(13, `executor:${Q('executor-gamma')}`, { delivered: 'x', landed: 'y', state: 'landed' });
    const rows = hierarchyStatus(deps).rows;
    const landing = (n: string) => rows.find((r) => r.entry.name === Q(n))?.landing;
    expect(landing('executor-alpha')).toBe('#11 undelivered:green');
    expect(landing('executor-beta')).toBe('#12 delivered:armed');
    expect(landing('executor-gamma')).toBeUndefined();
    const text = formatStatus(hierarchyStatus(deps)).join('\n');
    expect(text).toContain('#11 undelivered:green');
  });

  it('lists open PRs older than the aging window, oldest first (AISDLC-1092)', async () => {
    await hierarchyUp({ ...baseOpts, executors: 1, noPlanner: true }, deps);
    const nowMs = deps.now().getTime();
    const put = (pr: number, hoursAgo: number): void => {
      mkdirSync(path.join(boardDir, 'landing'), { recursive: true });
      writeFileSync(
        path.join(boardDir, 'landing', `${pr}.json`),
        JSON.stringify({
          pr,
          kind: 'task',
          owner: 'machine',
          state: 'real-failure',
          action: 'reenter',
          lastActionAt: new Date(nowMs - hoursAgo * 3_600_000).toISOString(),
          history: [],
        }),
      );
    };
    put(21, 7);
    put(22, 1);
    put(23, 30);
    const result = hierarchyStatus(deps);
    expect(result.agedPrs?.map((a) => a.pr)).toEqual([23, 21]);
    const text = formatStatus(result).join('\n');
    expect(text).toContain('aged PR #23: 30h0m, lane machine, last action reenter');
    expect(text).not.toContain('aged PR #22');
    // AISDLC-1095: the table lists every open PR with lane, action, reason, owner and age.
    expect(text).toContain(
      '#22 lane task, action reenter, reason real-failure, owner machine, age 1h0m',
    );
  });

  it('reports gone when the window is dead even if a registry file exists', async () => {
    await hierarchyUp({ ...baseOpts, executors: 1, noPlanner: true }, deps);
    fake.windows = fake.windows.filter((w) => w !== Q('executor-alpha'));
    const row = hierarchyStatus(deps).rows.find((r) => r.entry.name === Q('executor-alpha'));
    expect(row?.state).toBe('gone');
  });

  it('maps an unknown registry status to unknown, not idle', async () => {
    await hierarchyUp({ ...baseOpts, executors: 0, noPlanner: true }, deps);
    const file = path.join(registryDir, '4000.json');
    const doc = JSON.parse(readFileSync(file, 'utf-8'));
    writeFileSync(file, JSON.stringify({ ...doc, status: 'weird' }));
    expect(hierarchyStatus(deps).rows[0]?.state).toBe('unknown');
  });

  it('never reports idle after verdict: the dispatch tick clears, so the state cannot persist (AISDLC-1107)', async () => {
    fake.startedAtMs = NOW.getTime() - 10 * 60_000;
    await hierarchyUp({ ...baseOpts, executors: 1, noPlanner: true }, deps);
    const done = path.join(deps.boardDir, 'done');
    mkdirSync(done, { recursive: true });
    writeFileSync(
      path.join(done, 'AISDLC-9.verdict.json'),
      JSON.stringify({
        taskId: 'AISDLC-9',
        workerId: Q('executor-alpha'),
        completedAt: new Date(NOW.getTime() - 5 * 60_000).toISOString(),
      }),
    );
    const result = hierarchyStatus(deps);
    expect(result.rows.find((r) => r.entry.name === Q('executor-alpha'))).not.toHaveProperty(
      'idleAfterVerdict',
    );
    expect(formatStatus(result).join('\n')).not.toContain('idle after verdict');
  });

  it('handles an empty roster', () => {
    const result = hierarchyStatus(deps);
    expect(formatStatus(result)).toEqual([
      'no sessions in the roster',
      'webhook: off (no secret)',
      'scheduler: off',
      'last tick: never',
      'context clear thresholds (tokens): planner 150000, operator-dispatch 120000, executor 120000',
      'EXECUTOR CAP 3 (executors.max 3, board ceiling none, pacer allowance unlimited, load headroom 7; limited by executors.max)',
      'unowned PRs: 0',
      expect.stringContaining('attestation and leaf files:'),
    ]);
  });

  it('counts unowned open PRs from the landing records (AISDLC-1091)', () => {
    const record = (pr: number, owner: string) => ({
      pr,
      kind: 'docs',
      owner,
      state: 'green',
      action: 'route-to-planner',
      history: [],
    });
    mkdirSync(path.join(boardDir, 'landing'), { recursive: true });
    writeFileSync(landingPath(boardDir, 7), JSON.stringify(record(7, 'unowned')));
    writeFileSync(landingPath(boardDir, 8), JSON.stringify(record(8, 'machine')));
    const result = hierarchyStatus(deps);
    expect(result.unowned).toBe(1);
    expect(formatStatus(result)).toContain('unowned PRs: 1');
  });

  it('shows an ATTACHED column per session, yes only when a client is attached', async () => {
    await hierarchyUp({ ...baseOpts, executors: 1, noPlanner: true }, deps);
    fake.attachedClients[Q('executor-alpha')] = 1;
    const result = hierarchyStatus(deps);
    const byName = Object.fromEntries(result.rows.map((r) => [r.entry.name, r.attached]));
    expect(byName).toEqual({ [Q('operator-dispatch')]: false, [Q('executor-alpha')]: true });
    const json = JSON.parse(JSON.stringify(result)) as { rows: { attached: boolean }[] };
    expect(json.rows.map((r) => r.attached)).toEqual([false, true]);

    const lines = formatStatus(result);
    expect(lines[0]).toMatch(/STATE\s+ATTACHED\s+MODEL/);
    expect(lines.find((l) => l.includes(Q('executor-alpha')))).toMatch(/\byes\b/);
    expect(lines.find((l) => l.includes(Q('operator-dispatch')))).toMatch(/\bno\b/);
    // The query is session-scoped and read-only.
    const q = fake.calls.filter((c) => c.args.includes('#{session_attached}'));
    expect(q.map((c) => c.args)).toEqual([
      ['display-message', '-p', '-t', `=${Q('operator-dispatch')}`, '#{session_attached}'],
      ['display-message', '-p', '-t', `=${Q('executor-alpha')}`, '#{session_attached}'],
    ]);
  });

  it('reports not attached when tmux fails or the entry is gone', async () => {
    await hierarchyUp({ ...baseOpts, executors: 1, noPlanner: true }, deps);
    fake.attachedClients[Q('executor-alpha')] = 2;
    fake.windows = fake.windows.filter((w) => w !== Q('executor-alpha'));
    const rows = hierarchyStatus(deps).rows;
    expect(rows.find((r) => r.entry.name === Q('executor-alpha'))).toMatchObject({
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
  it('a full down stops executors, then dispatch, then the planner (AISDLC-1106)', async () => {
    await hierarchyUp(baseOpts, deps);
    const result = await hierarchyDown({}, deps);
    expect(result.stopped.map((o) => o.role)).toEqual([
      'executor',
      'executor',
      'operator-dispatch',
      'planner',
    ]);
  });

  it('refuses to stop the calling session, naming the alternatives (AISDLC-1106)', async () => {
    await hierarchyUp(baseOpts, deps);
    await expect(hierarchyDown({ callerName: Q('operator-dispatch') }, deps)).rejects.toThrow(
      /calling session/,
    );
    await expect(
      hierarchyDown({ role: Q('executor-alpha'), callerName: Q('executor-alpha') }, deps),
    ).rejects.toThrow(/calling session/);
    expect(readRoster(boardDir).sessions).toHaveLength(4);
  });

  it('returns only the named executor manifest to the queue and removes only its window and entry', async () => {
    await hierarchyUp(baseOpts, deps);
    putInflight('AISDLC-200', Q('executor-alpha'));
    putInflight('AISDLC-201', Q('executor-beta'));

    const result = await hierarchyDown({ role: 'executor-beta' }, deps);

    expect(result.stopped).toEqual([
      { name: Q('executor-beta'), role: 'executor', requeued: 'AISDLC-201', forced: false },
    ]);
    expect(existsSync(path.join(boardDir, 'queue', 'AISDLC-201.dispatch.json'))).toBe(true);
    expect(existsSync(path.join(boardDir, 'inflight', 'AISDLC-201.dispatch.json'))).toBe(false);
    expect(existsSync(path.join(boardDir, 'inflight', 'AISDLC-200.dispatch.json'))).toBe(true);
    expect(fake.windows.sort()).toEqual([
      Q('executor-alpha'),
      Q('operator-dispatch'),
      Q('planner'),
    ]);
    expect(readRoster(boardDir).sessions.map((s) => s.name)).toEqual([
      Q('planner'),
      Q('operator-dispatch'),
      Q('executor-alpha'),
    ]);
  });

  it('closes the window itself when the session does not exit', async () => {
    await hierarchyUp({ ...baseOpts, executors: 1, noPlanner: true }, deps);
    fake.exitsOnRequest = false;
    const result = await hierarchyDown({ role: 'executor-alpha' }, deps);
    expect(result.stopped[0]?.forced).toBe(true);
    expect(fake.windows).toEqual([Q('operator-dispatch')]);
  });

  it('closes a confirmed pane by id, not the window by name, after the grace period', async () => {
    await hierarchyUp({ ...baseOpts, executors: 1, noPlanner: true }, deps);
    const paneId = readRoster(boardDir).sessions.find(
      (e) => e.name === Q('executor-alpha'),
    )?.paneId;
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
    putInflight('AISDLC-600', Q('executor-alpha'));
    fake.exitsOnRequest = false;
    // The agent never exits; while down waits, the session is replaced by one that is not ours.
    deps.sleep = async () => {
      fake.owned.delete(Q('executor-alpha'));
    };
    const result = await hierarchyDown({ role: 'executor-alpha' }, deps);

    expect(result.stopped).toEqual([]);
    expect(result.refused.map((r) => r.name)).toEqual([Q('executor-alpha')]);
    expect(result.refused[0]?.reason).toMatch(/@ai-sdlc-hierarchy/);
    expect(
      fake.calls.filter((c) => c.args[0] === 'kill-pane' || c.args[0] === 'kill-window'),
    ).toEqual([]);
    expect(fake.windows).toContain(Q('executor-alpha'));
    expect(readRoster(boardDir).sessions.map((e) => e.name)).toContain(Q('executor-alpha'));
    expect(existsSync(path.join(boardDir, 'inflight', 'AISDLC-600.dispatch.json'))).toBe(true);
    expect(logs.some((l) => l.includes(`not closing '${Q('executor-alpha')}'`))).toBe(true);
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
    expect(r1.stopped.map((s) => s.name)).toEqual([Q('executor-alpha'), Q('executor-beta')]);
    const r2 = await hierarchyDown({}, deps);
    expect(r2.stopped.map((s) => s.name)).toEqual([Q('operator-dispatch'), Q('planner')]);
    expect(readRoster(boardDir).sessions).toEqual([]);
  });

  it('executor-start heartbeat worker id equals the session name, so status shows and down requeues its task (AISDLC-664.2)', async () => {
    await hierarchyUp({ ...baseOpts, executors: 1, noPlanner: true }, deps);
    ensureBoardDirs(boardDir);
    writeManifest(boardDir, manifest('AISDLC-700'));
    const alpha = readRoster(boardDir).sessions.find((s) => s.name === Q('executor-alpha'));
    if (!alpha) throw new Error('executor-alpha missing from the roster');

    // The board lives at <repo>/<x>/dispatch, so the repository root is two levels up.
    const repoRoot = path.dirname(path.dirname(boardDir));
    const started = await executorStart(
      { boardDir, cwd: repoRoot },
      {
        identity: {
          readSessions: () => [
            { name: alpha.name, role: 'executor', pid: alpha.pid, status: 'running' },
          ],
          parentPid: () => null,
          comm: () => 'claude',
          startPid: alpha.pid,
        },
        repoGit: () => path.join(repoRoot, '.git'),
      },
    );
    expect(started.taskId).toBe('AISDLC-700');
    // AC1: the heartbeat worker id is the session name.
    expect(readHeartbeat(boardDir, 'AISDLC-700')?.workerId).toBe(alpha.name);

    // AC2: status joins the inflight task to the executor ...
    const row = hierarchyStatus(deps).rows.find((r) => r.entry.name === alpha.name);
    expect(row?.inflightTask).toBe('AISDLC-700');

    // ... and down returns its manifest to the queue.
    const r = await hierarchyDown({ role: 'executor-alpha' }, deps);
    expect(r.stopped[0]?.requeued).toBe('AISDLC-700');
    expect(existsSync(path.join(boardDir, 'queue', 'AISDLC-700.dispatch.json'))).toBe(true);
    expect(existsSync(path.join(boardDir, 'inflight', 'AISDLC-700.dispatch.json'))).toBe(false);
  });

  it('rejects an unknown role', async () => {
    await expect(hierarchyDown({ role: 'executor-zeta' }, deps)).rejects.toThrow(
      /no session named/,
    );
  });

  it('still cleans up a session whose window is already gone', async () => {
    await hierarchyUp({ ...baseOpts, executors: 1, noPlanner: true }, deps);
    putInflight('AISDLC-300', Q('executor-alpha'));
    fake.windows = fake.windows.filter((w) => w !== Q('executor-alpha'));
    const r = await hierarchyDown({ role: 'executor-alpha' }, deps);
    expect(r.stopped[0]?.requeued).toBe('AISDLC-300');
  });
});

function craftedEntry(over: Record<string, unknown>) {
  // A project-qualified session name must record its project (see unsafeEntryReason).
  const qualified =
    typeof over.tmuxSession === 'string' && over.tmuxSession.startsWith(`${PROJECT}-`);
  return {
    ...(qualified ? { project: PROJECT } : {}),
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
    [
      'a session and window that differ',
      { tmuxSession: Q('planner'), tmuxWindow: Q('executor-alpha') },
    ],
    ['a non-default session named after its window', { tmuxSession: 'editor' }],
    [
      'a malformed pane id in the new layout',
      { tmuxSession: Q('planner'), tmuxWindow: Q('planner'), paneId: '%1; rm' },
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
      Q('operator-dispatch'),
    ]);
  });

  it('refuses, sending nothing, when the recorded pane id is stale', async () => {
    await hierarchyUp({ ...baseOpts, executors: 1, noPlanner: true }, deps);
    putInflight('AISDLC-400', Q('executor-alpha'));
    const roster = readRoster(boardDir);
    const alpha = roster.sessions.find((s) => s.name === Q('executor-alpha'));
    if (alpha) alpha.paneId = '%999';
    writeRoster(boardDir, roster);

    const r = await hierarchyDown({ role: 'executor-alpha' }, deps);

    expect(r.stopped).toEqual([]);
    expect(r.refused).toHaveLength(1);
    expect(r.refused[0]?.name).toBe(Q('executor-alpha'));
    expect(r.refused[0]?.reason).toMatch(
      /pane %999 does not belong to window 'repo-executor-alpha'/,
    );
    expect(
      fake.calls.filter((c) => c.args[0] === 'send-keys' || c.args[0] === 'kill-window'),
    ).toEqual([]);
    expect(fake.windows).toContain(Q('executor-alpha'));
    // left in the roster, inflight work untouched
    expect(readRoster(boardDir).sessions.map((e) => e.name)).toContain(Q('executor-alpha'));
    expect(existsSync(path.join(boardDir, 'inflight', 'AISDLC-400.dispatch.json'))).toBe(true);
    expect(logs.some((l) => l.includes(`not stopping '${Q('executor-alpha')}'`))).toBe(true);
  });

  it('uses the pane id when it still belongs to the roster window', async () => {
    await hierarchyUp({ ...baseOpts, executors: 1, noPlanner: true }, deps);
    await hierarchyDown({ role: 'executor-alpha' }, deps);
    const send = fake.calls.find((c) => c.args[0] === 'send-keys');
    expect(send?.args[send.args.indexOf('-t') + 1]).toMatch(/^%[0-9]+$/);
  });

  it('matches inflight manifests by session name only, not window', async () => {
    fake.nameFor = (n) => (n === Q('executor-alpha') ? `${Q('executor-alpha')}-2` : n);
    await hierarchyUp({ ...baseOpts, executors: 1, noPlanner: true }, deps);
    putInflight('AISDLC-400', Q('executor-alpha'));
    const r = await hierarchyDown({ role: 'executor-alpha' }, deps);
    expect(r.stopped[0]?.requeued).toBeUndefined();
    expect(hierarchyStatus(deps).rows.every((x) => x.inflightTask === undefined)).toBe(true);
  });
});

describe('session ownership marker', () => {
  const personal = (name: string) => ({
    project: PROJECT,
    role: name.endsWith('planner') ? 'planner' : 'executor',
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
      [Q('planner'), Q('operator-dispatch'), Q('executor-alpha'), Q('executor-beta')].map((n) => [
        'set-option',
        '-t',
        `=${n}:`,
        '@ai-sdlc-hierarchy',
        '1',
      ]),
    );
    expect([...fake.owned].sort()).toEqual(
      [Q('executor-alpha'), Q('executor-beta'), Q('operator-dispatch'), Q('planner')].sort(),
    );
    expect(marks.every((c) => !c.args.includes('-g'))).toBe(true);
  });

  it('warns, and keeps the agent, when a session cannot be marked; down then refuses it', async () => {
    fake.failMarkFor = Q('executor-alpha');
    const r = await hierarchyUp({ ...baseOpts, executors: 1, noPlanner: true }, deps);
    expect(r.started.map((e) => e.name)).toContain(Q('executor-alpha'));
    expect(
      r.warnings.some((w) => w.includes(Q('executor-alpha')) && w.includes('@ai-sdlc-hierarchy')),
    ).toBe(true);

    const down = await hierarchyDown({ role: 'executor-alpha' }, deps);
    expect(down.stopped).toEqual([]);
    expect(down.refused.map((x) => x.name)).toEqual([Q('executor-alpha')]);
  });

  it('down refuses a personal session with a default name and no marker: zero send-keys, nothing closed, roster and inflight kept', async () => {
    fake.windows = [Q('executor-alpha')];
    writeRawRoster([personal(Q('executor-alpha'))]);
    putInflight('AISDLC-500', Q('executor-alpha'));

    const r = await hierarchyDown({}, deps);

    expect(r.stopped).toEqual([]);
    expect(r.refused).toHaveLength(1);
    expect(r.refused[0]?.reason).toMatch(
      /tmux session 'repo-executor-alpha'.*@ai-sdlc-hierarchy.*did not start it/,
    );
    expect(
      fake.calls.filter((c) => c.args[0] === 'send-keys' || c.args[0] === 'kill-window'),
    ).toEqual([]);
    expect(fake.windows).toEqual([Q('executor-alpha')]);
    expect(readRosterChecked(boardDir).roster.sessions.map((e) => e.name)).toEqual([
      Q('executor-alpha'),
    ]);
    expect(existsSync(path.join(boardDir, 'inflight', 'AISDLC-500.dispatch.json'))).toBe(true);
    // the check reads the session option of that exact session, before anything else is sent
    const show = fake.calls.find((c) => c.args[0] === 'show-options');
    expect(show?.args).toEqual([
      'show-options',
      '-v',
      '-t',
      `=${Q('executor-alpha')}:`,
      '@ai-sdlc-hierarchy',
    ]);
  });

  it('down proceeds once the marker is present', async () => {
    fake.windows = [Q('executor-alpha')];
    fake.owned.add(Q('executor-alpha'));
    writeRawRoster([personal(Q('executor-alpha'))]);
    const r = await hierarchyDown({}, deps);
    expect(r.refused).toEqual([]);
    expect(r.stopped.map((x) => x.name)).toEqual([Q('executor-alpha')]);
    expect(fake.windows).toEqual([]);
  });

  it('down keeps going after a refusal: it stops the owned sessions and reports the rest', async () => {
    await hierarchyUp({ ...baseOpts, executors: 2, noPlanner: true }, deps);
    fake.owned.delete(Q('executor-alpha'));
    const r = await hierarchyDown({}, deps);
    expect(r.refused.map((x) => x.name)).toEqual([Q('executor-alpha')]);
    expect(r.stopped.map((x) => x.name).sort()).toEqual([
      Q('executor-beta'),
      Q('operator-dispatch'),
    ]);
    expect(readRoster(boardDir).sessions.map((e) => e.name)).toEqual([Q('executor-alpha')]);
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

describe('planner permission mode (AISDLC-752)', () => {
  const modeOf = (cmd: string | undefined) => /--permission-mode '([^']*)'/.exec(cmd ?? '')?.[1];

  it('starts every role in bypassPermissions by default', async () => {
    const r = await hierarchyUp({ ...baseOpts, executors: 1 }, deps);
    expect(r.started.map((e) => [e.role, e.permissionMode])).toEqual([
      ['planner', 'bypassPermissions'],
      ['operator-dispatch', 'bypassPermissions'],
      ['executor', 'bypassPermissions'],
    ]);
    const cmds = newWindowCommands();
    expect(cmds).toHaveLength(3);
    for (const c of cmds) expect(c).toContain("--permission-mode 'bypassPermissions'");
  });

  it('changes only the planner line under --planner-permission-mode', async () => {
    await hierarchyUp({ ...baseOpts, executors: 1, plannerPermissionMode: 'default' }, deps);
    expect(newWindowCommands().map(modeOf)).toEqual([
      'default',
      'bypassPermissions',
      'bypassPermissions',
    ]);
  });

  it('buildClaudeCommand carries the mode it is given for each role', () => {
    for (const role of ['planner', 'operator-dispatch', 'executor'] as const) {
      expect(
        buildClaudeCommand('claude', {
          role,
          name: 'x',
          model: 'm',
          permissionMode: 'bypassPermissions',
          prompt: 'p',
        }),
      ).toContain("--permission-mode 'bypassPermissions'");
    }
  });

  it.each(['plan', 'default'])('ignores a settings defaultMode of %s', async (mode) => {
    writeSettings({ crossSessionInbound: 'accept', permissions: { defaultMode: mode } });
    const r = await hierarchyUp({ ...baseOpts, executors: 0 }, deps);
    expect(r.started[0]?.permissionMode).toBe('bypassPermissions');
    expect(newWindowCommands()[0]).toContain("--permission-mode 'bypassPermissions'");
  });

  it('accepts --allow-planner-bypass as a no-op with a deprecation line', async () => {
    const r = await hierarchyUp({ ...baseOpts, executors: 0, allowPlannerBypass: true }, deps);
    expect(r.started[0]?.permissionMode).toBe('bypassPermissions');
    expect(logs.some((l) => /deprecated: --allow-planner-bypass/.test(l))).toBe(true);
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
    ).toBe(
      `AI_SDLC_HIERARCHY_SESSION='x' AI_SDLC_HIERARCHY_ROLE='executor' 'claude' --name 'x' --model 'm' --permission-mode 'p' 'a'\\''b'`,
    );
    for (const role of ['planner', 'operator-dispatch', 'executor'] as const) {
      const prefixed = buildClaudeCommand('claude', {
        role,
        name: `proj-${role}`,
        model: 'm',
        permissionMode: 'p',
        prompt: 'x',
      });
      expect(
        prefixed.startsWith(
          `AI_SDLC_HIERARCHY_SESSION='proj-${role}' AI_SDLC_HIERARCHY_ROLE='${role}' 'claude'`,
        ),
      ).toBe(true);
      expect(hasLaunchEnv(prefixed, `proj-${role}`, role)).toBe(true);
      expect(hasLaunchEnv("'claude' --name 'x'", `proj-${role}`, role)).toBe(false);
      const cmd = buildClaudeCommand('claude', {
        role,
        name: "proj-it's",
        model: 'm',
        permissionMode: 'p',
        prompt: 'x',
      });
      expect(cmd).toContain(`AI_SDLC_HIERARCHY_SESSION='proj-it'\\''s'`);
      expect(cmd).toContain(`AI_SDLC_HIERARCHY_ROLE='${role}'`);
    }
  });
});

describe('pinned Node (AISDLC-812)', () => {
  const sess = {
    role: 'executor',
    name: 'p-executor-alpha',
    model: 'm',
    permissionMode: 'p',
    prompt: 'x',
  } as const;

  it('executorMcpArgs limits only executors to the configured MCP servers (AISDLC-1067)', () => {
    expect(executorMcpArgs('planner', {})).toEqual([]);
    expect(executorMcpArgs('executor', {})).toEqual([]);
    expect(executorMcpArgs('executor', { AI_SDLC_EXECUTOR_MCP_CONFIG: '/a/m.json' })).toEqual([
      '--strict-mcp-config',
      '--mcp-config',
      "'/a/m.json'",
    ]);
    expect(executorMcpArgs('executor', { AI_SDLC_EXECUTOR_MCP: 'all' })).toEqual([]);
  });

  it('buildClaudeCommand prefixes the nvm activation for the version and keeps the launch env', () => {
    const cmd = buildClaudeCommand('claude', sess, '22.23.2');
    expect(cmd).toContain(`. "$NVM_DIR/nvm.sh"`);
    expect(cmd).toContain(
      `nvm use '22.23.2' >/dev/null && AI_SDLC_HIERARCHY_SESSION='p-executor-alpha'`,
    );
    expect(hasLaunchEnv(cmd, 'p-executor-alpha', 'executor')).toBe(true);
    expect(buildClaudeCommand('claude', sess).includes('nvm')).toBe(false);
  });

  it('up resolves the version from .nvmrc and passes it to every session command', async () => {
    const repo = path.join(tmp, 'repo');
    mkdirSync(repo);
    writeFileSync(path.join(repo, '.nvmrc'), 'v22.23.2\n');
    const installed: string[] = [];
    const d = { ...deps, cwd: repo, nodeInstalled: (v: string) => (installed.push(v), true) };
    await hierarchyUp({ ...baseOpts, executors: 1, noPlanner: true }, d);
    expect(installed).toEqual(['22.23.2']);
    const starts = fake.calls.filter((c) => c.args[0] === 'new-session');
    expect(starts.length).toBe(2);
    for (const c of starts) {
      expect(c.args[c.args.length - 1]).toContain(`nvm use '22.23.2'`);
    }
  });

  it('up refuses outside a repository and names the expected root (AISDLC-664.6)', async () => {
    const d = { ...deps, cwd: '/not/a/repo', resolveRoot: () => null };
    await expect(hierarchyUp({ ...baseOpts, executors: 0, noPlanner: true }, d)).rejects.toThrow(
      /\/not\/a\/repo.*repository root/s,
    );
    expect(fake.calls.some((c) => c.args[0] === 'new-session')).toBe(false);
  });

  it('up from a worktree launches every window at the root with CLAUDE_PROJECT_DIR (AISDLC-664.6)', async () => {
    const d = {
      ...deps,
      cwd: '/repo/.worktrees/x',
      resolveRoot: () => '/repo',
      loadPolicy: () => ({ forcePushMode: 'lease', operational: ['a', 'b'] }),
    };
    await hierarchyUp({ ...baseOpts, executors: 0, noPlanner: true }, d);
    const start = fake.calls.find((c) => c.args[0] === 'new-session');
    expect(start?.args[start.args.indexOf('-c') + 1]).toBe('/repo');
    expect(start?.options?.cwd).toBe('/repo');
    expect(start?.args[start.args.length - 1]).toContain(`CLAUDE_PROJECT_DIR='/repo'`);
    expect(logs).toContain('policy (/repo): allowForcePush=lease operational=[a, b]');
    expect(logs.some((l) => l.includes('resolves to never'))).toBe(false);
  });

  it('up warns when the policy resolves allowForcePush to never (AISDLC-664.6)', async () => {
    const d = { ...deps, loadPolicy: () => ({ forcePushMode: 'never', operational: [] }) };
    await hierarchyUp({ ...baseOpts, executors: 0, noPlanner: true }, d);
    expect(logs.some((l) => l.includes('allowForcePush=never'))).toBe(true);
    expect(logs.some((l) => l.includes('resolves to never'))).toBe(true);
  });

  it('--node overrides .nvmrc, and a bad value is refused', async () => {
    const repo = path.join(tmp, 'repo2');
    mkdirSync(repo);
    writeFileSync(path.join(repo, '.nvmrc'), '22.22.1\n');
    const d = { ...deps, cwd: repo, nodeInstalled: () => true };
    await hierarchyUp({ ...baseOpts, executors: 0, noPlanner: true, node: 'v22.19.0' }, d);
    const start = fake.calls.find((c) => c.args[0] === 'new-session');
    expect(start?.args[start.args.length - 1]).toContain(`nvm use '22.19.0'`);
    await expect(
      hierarchyUp({ ...baseOpts, executors: 0, noPlanner: true, node: 'lts/*; rm' }, d),
    ).rejects.toThrow(/not a node version/);
  });

  it('up refuses before starting anything when the version is not installed', async () => {
    const repo = path.join(tmp, 'repo3');
    mkdirSync(repo);
    writeFileSync(path.join(repo, '.nvmrc'), '22.23.2\n');
    const d = { ...deps, cwd: repo, nodeInstalled: () => false };
    await expect(hierarchyUp({ ...baseOpts, executors: 1, noPlanner: true }, d)).rejects.toThrow(
      /Node 22\.23\.2 is not installed.*nvm install 22\.23\.2/,
    );
    expect(fake.calls.some((c) => c.args[0] === 'new-session')).toBe(false);
  });

  it('default install check reads $NVM_DIR/versions/node', () => {
    const nvm = path.join(tmp, 'nvm');
    mkdirSync(path.join(nvm, 'versions', 'node', 'v22.23.2'), { recursive: true });
    expect(isNodeInstalled('22.23.2', { NVM_DIR: nvm })).toBe(true);
    expect(isNodeInstalled('22', { NVM_DIR: nvm })).toBe(true);
    expect(isNodeInstalled('22.19.0', { NVM_DIR: nvm })).toBe(false);
    expect(isNodeInstalled('22.23.2', { NVM_DIR: path.join(tmp, 'none') })).toBe(false);
    expect(readNvmrc(tmp)).toBeUndefined();
    writeFileSync(path.join(tmp, '.nvmrc'), 'lts/*\n');
    expect(readNvmrc(tmp)).toBeUndefined();
  });

  it('status shows a NODE column and flags a session on the wrong Node', async () => {
    const repo = path.join(tmp, 'repo4');
    mkdirSync(repo);
    writeFileSync(path.join(repo, '.nvmrc'), '22.23.2\n');
    const d = { ...deps, cwd: repo, nodeInstalled: () => true };
    await hierarchyUp({ ...baseOpts, executors: 1, noPlanner: true }, d);
    // Rosters written before AISDLC-906 carry no recorded version, so status probes.
    const rec = readRoster(deps.boardDir);
    writeRoster(deps.boardDir, {
      ...rec,
      sessions: rec.sessions.map(({ nodeVersion: _drop, ...e }) => e),
    });
    const home = '/h/.nvm/versions/node';
    const realRun = fake.run;
    d.run = (f, a, o) =>
      f === 'ps'
        ? {
            status: 0,
            stdout: [
              `  4000     1 /bin/zsh`,
              `  4100  4000 ${home}/v22.23.2/bin/node`,
              `  4001     1 /bin/zsh`,
              `  4200  4001 ${home}/v22.19.0/bin/node`,
              `  9999     1 ${home}/v20.0.0/bin/node`,
            ].join('\n'),
            stderr: '',
          }
        : realRun(f, a, o);
    const result = hierarchyStatus(d);
    const nodes = result.rows.map((r) => [r.nodeVersion, r.nodeMismatch]);
    expect(nodes).toEqual([
      ['22.23.2', undefined],
      ['22.19.0', true],
    ]);
    const lines = formatStatus(result);
    expect(lines[0]).toMatch(/ENV\s+NODE\s+MODULE\s+CONTEXT\s+HIERARCHY_SESSION/);
    expect(lines.join('\n')).toContain('22.19.0 MISMATCH');
    expect(lines.join('\n')).toContain('node mismatch on');
    // ps unreadable: no version, no flag.
    d.run = realRun;
    expect(hierarchyStatus(d).rows.every((r) => r.nodeVersion === undefined)).toBe(true);
  });
});

describe('paneNodeVersion (AISDLC-906)', () => {
  const home = '/h/.nvm/versions/node';
  const psRun = (lines: string[]) => () => ({ status: 0, stdout: lines.join('\n'), stderr: '' });

  it('ignores a child MCP server running a different Node', () => {
    const run = psRun([
      `  4000     1 /bin/zsh`,
      `  4100  4000 ${home}/v22.23.2/bin/node`,
      `  4200  4100 ${home}/v22.19.0/bin/node`,
    ]);
    expect(paneNodeVersion(run, 4000)).toBe('22.23.2');
  });

  it('is undefined for a bad pid, unreadable ps or no nvm node', () => {
    expect(paneNodeVersion(psRun([]), 0)).toBeUndefined();
    expect(paneNodeVersion(() => ({ status: 1, stdout: '', stderr: '' }), 5)).toBeUndefined();
    expect(paneNodeVersion(psRun(['  5     1 /bin/zsh']), 5)).toBeUndefined();
  });

  it('up records the full version and status reads it without probing', async () => {
    const repo = path.join(tmp, 'repo-rec');
    mkdirSync(repo);
    writeFileSync(path.join(repo, '.nvmrc'), '22.23.2\n');
    const d = { ...deps, cwd: repo, nodeInstalled: () => true };
    await hierarchyUp({ ...baseOpts, executors: 1, noPlanner: true }, d);
    const realRun = fake.run;
    d.run = (f, a, o) => {
      if (f === 'ps') throw new Error('must not probe');
      return realRun(f, a, o);
    };
    const result = hierarchyStatus(d);
    expect(result.rows.length).toBeGreaterThan(0);
    for (const r of result.rows) {
      expect(r.entry.nodeVersion).toBe('22.23.2');
      expect(r.nodeVersion).toBe('22.23.2');
      expect(r.nodeMismatch).toBeUndefined();
    }
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

describe('hierarchy up events', () => {
  it('records one HierarchySessionStarted event per started session', async () => {
    const events: Record<string, unknown>[] = [];
    await hierarchyUp({ ...baseOpts, executors: 1 }, { ...deps, emit: (e) => events.push(e) });
    expect(
      events.map(({ sessionModel, sessionPermissionMode, ...rest }) => {
        expect(typeof sessionModel).toBe('string');
        expect(typeof sessionPermissionMode).toBe('string');
        return rest;
      }),
    ).toEqual([
      { type: 'HierarchySessionStarted', sessionName: Q('planner'), sessionRole: 'planner' },
      {
        type: 'HierarchySessionStarted',
        sessionName: Q('operator-dispatch'),
        sessionRole: 'operator-dispatch',
      },
      {
        type: 'HierarchySessionStarted',
        sessionName: Q('executor-alpha'),
        sessionRole: 'executor',
      },
    ]);
  });

  it('records nothing for sessions that were already running', async () => {
    await hierarchyUp({ ...baseOpts, executors: 1 }, deps);
    const events: unknown[] = [];
    await hierarchyUp({ ...baseOpts, executors: 1 }, { ...deps, emit: (e) => events.push(e) });
    expect(events).toEqual([]);
  });
});

describe('project-scoped session names', () => {
  /** A harness registry file for a session started by something else. */
  function foreignRegistryEntry(file: string, over: Record<string, unknown>): void {
    mkdirSync(registryDir, { recursive: true });
    writeFileSync(
      path.join(registryDir, file),
      JSON.stringify({
        pid: 9001,
        name: 'planner',
        startedAt: NOW.getTime() - 60_000,
        status: 'idle',
        cwd: '/somewhere/else',
        ...over,
      }),
    );
  }

  it('qualifies every session with the project and records it in the roster', async () => {
    await hierarchyUp(baseOpts, deps);
    const roster = JSON.parse(readFileSync(rosterPath(boardDir), 'utf-8'));
    expect(validateHierarchyRoster(roster).valid).toBe(true);
    expect(roster.sessions.map((s: { name: string }) => s.name)).toEqual([
      'repo-planner',
      'repo-operator-dispatch',
      'repo-executor-alpha',
      'repo-executor-beta',
    ]);
    for (const s of roster.sessions as { project: string; tmuxSession: string; name: string }[]) {
      expect(s.project).toBe('repo');
      expect(s.tmuxSession).toBe(s.name);
    }
    expect(newWindowCommands()[0]).toContain("--name 'repo-planner'");
  });

  it('uses --project instead of the repository basename', async () => {
    await hierarchyUp({ ...baseOpts, executors: 1, noPlanner: true, project: 'proj-x' }, deps);
    const sessions = readRoster(boardDir).sessions;
    expect(sessions.map((s) => s.name)).toEqual([
      'proj-x-operator-dispatch',
      'proj-x-executor-alpha',
    ]);
    expect(sessions.every((s) => s.project === 'proj-x')).toBe(true);
  });

  it('rejects an invalid --project before touching tmux, and says what to pass', async () => {
    await expect(hierarchyUp({ ...baseOpts, project: 'Bad Name' }, deps)).rejects.toThrow(
      /invalid project 'Bad Name'.*--project <name>/,
    );
    await expect(hierarchyUp({ ...baseOpts, project: 'a'.repeat(31) }, deps)).rejects.toThrow(
      /invalid project/,
    );
    expect(fake.calls).toEqual([]);
  });

  it('asks for --project when the repository directory gives no usable name', async () => {
    await expect(hierarchyUp(baseOpts, { ...deps, cwd: '/___' })).rejects.toThrow(
      /--project <name>/,
    );
    expect(fake.calls).toEqual([]);
  });

  it('two hierarchies on one machine with the same role names get distinct names', async () => {
    const otherBoard = path.join(tmp, 'other-dispatch');
    await hierarchyUp({ ...baseOpts, executors: 1 }, deps);
    const second = await hierarchyUp(
      { ...baseOpts, executors: 1 },
      { ...deps, cwd: '/other-project', boardDir: otherBoard },
    );
    expect(second.started.map((e) => e.name)).toEqual([
      'other-project-planner',
      'other-project-operator-dispatch',
      'other-project-executor-alpha',
    ]);
    const first = readRoster(boardDir).sessions.map((s) => s.name);
    const other = readRoster(otherBoard).sessions.map((s) => s.name);
    expect(first.filter((n) => other.includes(n))).toEqual([]);
    // No tmux session was created twice, and none was closed to make room.
    const created = fake.calls.filter((c) => c.args[0] === 'new-session').map((c) => c.args[3]);
    expect(new Set(created).size).toBe(created.length);
    expect(
      fake.calls.some((c) => c.args[0] === 'kill-window' || c.args[0] === 'kill-session'),
    ).toBe(false);
  });

  it('refuses to start while sessions with the same bare role names run for another project', async () => {
    foreignRegistryEntry('9001.json', { name: 'planner' });
    foreignRegistryEntry('9002.json', { pid: 9002, name: 'executor-alpha' });
    deps.isAlive = () => true;
    const err = await hierarchyUp(baseOpts, deps).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    const message = (err as Error).message;
    expect(message).toContain("'planner' (pid 9001)");
    expect(message).toContain("'executor-alpha' (pid 9002)");
    // Ends with the next step: pass --project, or stop the other sessions.
    expect(message).toContain('--project <name>');
    expect(message).not.toMatch(/SKIP_|bypass|--no-verify/i);
    expect(newWindowCommands()).toEqual([]);
    expect(existsSync(rosterPath(boardDir))).toBe(false);
  });

  it('with an explicit --project it warns loudly and starts', async () => {
    foreignRegistryEntry('9001.json', { name: 'planner' });
    deps.isAlive = () => true;
    const r = await hierarchyUp({ ...baseOpts, executors: 0, project: 'mine' }, deps);
    expect(r.started.map((e) => e.name)).toEqual(['mine-planner', 'mine-operator-dispatch']);
    expect(r.warnings.some((w) => w.includes('another project') && w.includes("'planner'"))).toBe(
      true,
    );
  });

  it('ignores a dead session, and a session started in this same checkout', async () => {
    foreignRegistryEntry('9001.json', { name: 'planner' });
    deps.isAlive = () => false;
    await hierarchyUp({ ...baseOpts, executors: 0 }, deps);

    rmSync(rosterPath(boardDir));
    fake = makeFakeTmux(registryDir);
    rmSync(registryDir, { recursive: true, force: true });
    foreignRegistryEntry('9001.json', { name: 'planner', cwd: '/repo' });
    deps.isAlive = () => true;
    const r = await hierarchyUp({ ...baseOpts, executors: 0 }, deps);
    expect(r.started.map((e) => e.name)).toContain('repo-planner');
  });

  it('migrates a roster without project: read as the repository basename, rewritten by up', async () => {
    fake.windows = ['executor-alpha'];
    fake.owned.add('executor-alpha');
    writeRawRoster([
      craftedEntry({
        role: 'executor',
        name: 'executor-alpha',
        tmuxSession: 'executor-alpha',
        tmuxWindow: 'executor-alpha',
        paneId: '%1',
      }),
    ]);
    expect(readFileSync(rosterPath(boardDir), 'utf-8')).not.toContain('"project"');
    expect(readRosterChecked(boardDir, 'repo').roster.sessions[0]?.project).toBe('repo');

    const r = await hierarchyUp({ ...baseOpts, executors: 1, noPlanner: true }, deps);

    // The running session is kept under its old name, not duplicated, and is flagged.
    expect(r.existing.map((e) => e.name)).toEqual(['executor-alpha']);
    expect(r.started.map((e) => e.name)).toEqual(['repo-operator-dispatch']);
    expect(
      r.warnings.some((w) => w.includes('unqualified') && w.includes('repo-executor-alpha')),
    ).toBe(true);
    const raw = JSON.parse(readFileSync(rosterPath(boardDir), 'utf-8'));
    expect(validateHierarchyRoster(raw).valid).toBe(true);
    expect(raw.sessions.map((s: { project: string }) => s.project)).toEqual(['repo', 'repo']);
  });

  it('rewrites a roster without project even when nothing needs starting', async () => {
    fake.windows = ['operator-dispatch'];
    fake.owned.add('operator-dispatch');
    writeRawRoster([
      craftedEntry({
        role: 'operator-dispatch',
        name: 'operator-dispatch',
        tmuxSession: 'operator-dispatch',
        tmuxWindow: 'operator-dispatch',
        paneId: '%1',
      }),
    ]);
    await hierarchyUp({ ...baseOpts, executors: 0, noPlanner: true }, deps);
    expect(readRoster(boardDir).sessions[0]?.project).toBe('repo');
  });

  it('does not take a foreign session named like a role for one of ours', () => {
    // `my-planner` ends in a role name but records no project.
    expect(
      unsafeEntryReason(
        craftedEntry({
          role: 'planner',
          tmuxSession: 'my-planner',
          tmuxWindow: 'my-planner',
        }) as RosterEntry,
      ),
    ).toMatch(/not one of the default hierarchy session names/);
    // A qualified name must record the same project.
    const qualified = craftedEntry({
      role: 'planner',
      tmuxSession: 'repo-planner',
      tmuxWindow: 'repo-planner',
    }) as RosterEntry;
    expect(unsafeEntryReason({ ...qualified, project: 'repo' })).toBeUndefined();
    expect(unsafeEntryReason({ ...qualified, project: 'other' })).toMatch(
      /records project 'other'/,
    );
  });

  it('down accepts the unqualified role name within the own roster', async () => {
    await hierarchyUp({ ...baseOpts, executors: 1, noPlanner: true }, deps);
    const down = await hierarchyDown({ role: 'executor-alpha' }, deps);
    expect(down.stopped.map((s) => s.name)).toEqual(['repo-executor-alpha']);
  });

  it('name helpers: qualify, split, sanitise and keep roles recoverable', () => {
    expect(PROJECT_SEPARATOR).toBe('-');
    expect(qualifiedName('ai-sdlc', 'executor-beta')).toBe('ai-sdlc-executor-beta');
    expect(splitSessionName('ai-sdlc-executor-beta')).toEqual({
      project: 'ai-sdlc',
      bare: 'executor-beta',
    });
    expect(splitSessionName('planner')).toEqual({ project: undefined, bare: 'planner' });
    expect(splitSessionName('x-operator-dispatch')?.bare).toBe('operator-dispatch');
    expect(splitSessionName('something-else')).toBeUndefined();
    expect(roleOfDefaultName('ai-sdlc-executor-beta')).toBe('executor');
    expect(roleOfDefaultName('ai-sdlc-planner')).toBe('planner');
    expect(roleOfDefaultName('ai-sdlc-nothing')).toBeUndefined();
    expect(sanitizeProject('My_Project.v2')).toBe('my-project-v2');
    expect(sanitizeProject('___')).toBe('');
    expect(sanitizeProject('a'.repeat(50))).toHaveLength(30);
    // Longest name still fits the 48 character session-name limit.
    expect(isValidSessionName(qualifiedName('a'.repeat(30), 'operator-dispatch'))).toBe(true);
  });
});

describe('hierarchy restart and register (AISDLC-713)', () => {
  const alpha = Q('executor-alpha');
  const entryOf = (name: string) => readRoster(boardDir).sessions.find((e) => e.name === name);
  const later = NOW.getTime() + 60_000;

  beforeEach(async () => {
    await hierarchyUp(baseOpts, deps);
    logs.length = 0;
    fake.calls.length = 0;
  });

  it('restarts one executor, replaces only its roster entry and leaves the others alone', async () => {
    const before = readRoster(boardDir);
    const old = entryOf(alpha) as RosterEntry;
    fake.startedAtMs = later;
    deps.now = () => new Date(later);

    const result = await hierarchyRestart({ session: 'executor-alpha' }, deps);

    const after = readRoster(boardDir);
    const fresh = entryOf(alpha) as RosterEntry;
    expect(fresh.pid).not.toBe(old.pid);
    expect(fresh.startedAt).toBe(new Date(later).toISOString());
    expect(fresh.status).toBe('running');
    expect(fresh).toMatchObject({ model: old.model, permissionMode: old.permissionMode });
    expect(after.sessions.map((e) => e.name)).toEqual(before.sessions.map((e) => e.name));
    for (const e of before.sessions.filter((x) => x.name !== alpha)) {
      expect(after.sessions).toContainEqual(e);
    }
    expect(result).toMatchObject({
      name: alpha,
      before: { pid: old.pid },
      after: { pid: fresh.pid },
    });
    // only the executor was asked to exit, then started once with its launch environment
    expect(fake.calls.filter((c) => c.args[0] === 'send-keys')).toHaveLength(1);
    const started = newWindowCommands();
    expect(started).toHaveLength(1);
    expect(hasLaunchEnv(started[0] as string, alpha, 'executor')).toBe(true);
    expect(started[0]).toContain("'/ai-sdlc executor'");
    expect(validateHierarchyRoster(after).valid).toBe(true);
  });

  it('a planner-role caller restarts an executor; a second caller inside the lock window is refused naming the holder (AISDLC-1110)', async () => {
    const planner = Q('planner');
    const first = await hierarchyRestart({ session: alpha, callerName: planner }, deps);
    expect(first.name).toBe(alpha);
    await expect(
      hierarchyRestart({ session: alpha, callerName: Q('executor-beta') }, deps),
    ).rejects.toThrow(new RegExp(`'${planner}' holds its restart lock`));
    // after the window the lock is free again
    deps.now = () => new Date(NOW.getTime() + 121_000);
    await expect(
      hierarchyRestart({ session: alpha, callerName: Q('executor-beta') }, deps),
    ).resolves.toMatchObject({ name: alpha });
  });

  it('refuses a caller that restarts its own session (AISDLC-1110)', async () => {
    await expect(hierarchyRestart({ session: alpha, callerName: alpha }, deps)).rejects.toThrow(
      /calling session/,
    );
    expect(fake.calls.some((c) => c.args[0] === 'send-keys')).toBe(false);
  });

  it('starts a session whose window is already gone (after a crash)', async () => {
    fake.windows = fake.windows.filter((w) => w !== alpha);
    const result = await hierarchyRestart({ session: alpha }, deps);
    expect(fake.windows).toContain(alpha);
    expect(fake.calls.some((c) => c.args[0] === 'send-keys')).toBe(false);
    expect(result.name).toBe(alpha);
  });

  it('refuses while the executor holds a task, names --after-task and stops nothing', async () => {
    putInflight('AISDLC-300', alpha);
    const before = readRoster(boardDir);
    await expect(hierarchyRestart({ session: alpha }, deps)).rejects.toThrow(/--after-task/);
    expect(readRoster(boardDir)).toEqual(before);
    expect(fake.calls.some((c) => c.args[0] === 'send-keys' || c.args[0] === 'new-session')).toBe(
      false,
    );
  });

  it('--after-task waits for the task boundary, then restarts', async () => {
    putInflight('AISDLC-300', alpha);
    let sleeps = 0;
    deps.sleep = async () => {
      if (++sleeps === 2) releaseInflight(boardDir, 'AISDLC-300');
    };
    const result = await hierarchyRestart({ session: alpha, afterTask: true }, deps);
    expect(result.waitedFor).toBe('AISDLC-300');
    expect(newWindowCommands()).toHaveLength(1);
  });

  it('returns a manifest claimed between the last check and the stop to the queue', async () => {
    const run = deps.run;
    let claimed = false;
    deps.run = (f, a, o) => {
      if (a[0] === 'send-keys' && !claimed) {
        claimed = true;
        putInflight('AISDLC-301', alpha);
      }
      return run(f, a, o);
    };
    const result = await hierarchyRestart({ session: alpha, afterTask: true }, deps);
    expect(result.requeued).toBe('AISDLC-301');
    expect(existsSync(path.join(boardDir, 'inflight', 'AISDLC-301.dispatch.json'))).toBe(false);
    expect(existsSync(path.join(boardDir, 'queue', 'AISDLC-301.dispatch.json'))).toBe(true);
  });

  it('keeps an entry another writer changed during the --after-task wait', async () => {
    putInflight('AISDLC-300', alpha);
    const beta = Q('executor-beta');
    deps.sleep = async () => {
      releaseInflight(boardDir, 'AISDLC-300');
      const r = readRoster(boardDir);
      writeRoster(boardDir, {
        ...r,
        sessions: r.sessions.map((e) => (e.name === beta ? { ...e, pid: 7777 } : e)),
      });
    };
    await hierarchyRestart({ session: alpha, afterTask: true }, deps);
    expect(entryOf(beta)?.pid).toBe(7777);
    expect(entryOf(alpha)?.pid).not.toBe(7777);
  });

  it('--after-task gives up after --wait and stops nothing', async () => {
    putInflight('AISDLC-300', alpha);
    await expect(
      hierarchyRestart({ session: alpha, afterTask: true, waitSec: 10 }, deps),
    ).rejects.toThrow(/still holds AISDLC-300 after 10 s; nothing was stopped/);
    expect(fake.calls.some((c) => c.args[0] === 'send-keys')).toBe(false);
  });

  it('--after-task with nothing inflight restarts at once', async () => {
    const result = await hierarchyRestart({ session: alpha, afterTask: true }, deps);
    expect(result.waitedFor).toBeUndefined();
  });

  it('register applies to executors only and names the down/up path', async () => {
    expect(() => hierarchyRegister({ session: 'operator-dispatch' }, deps)).toThrow(
      /executors only.*cli-hierarchy down --role/,
    );
  });

  it('restarts operator-dispatch with its recorded model and mode and keeps inflight on the board (AISDLC-1104)', async () => {
    fake.startedAtMs = later;
    deps.now = () => new Date(later);
    putInflight('AISDLC-300', alpha);
    const disp = Q('operator-dispatch');
    const old = entryOf(disp) as RosterEntry;
    const result = await hierarchyRestart({ session: 'operator-dispatch' }, deps);
    const fresh = entryOf(disp) as RosterEntry;
    expect(fresh.pid).not.toBe(old.pid);
    expect(fresh).toMatchObject({ model: old.model, permissionMode: old.permissionMode });
    expect(result.requeued).toBeUndefined();
    expect(existsSync(path.join(boardDir, 'inflight', 'AISDLC-300.dispatch.json'))).toBe(true);
    const started = newWindowCommands();
    expect(started).toHaveLength(1);
    expect(hasLaunchEnv(started[0] as string, disp, 'operator-dispatch')).toBe(true);
    expect(started[0]).toContain("'/ai-sdlc operator-dispatch'");
  });

  it('restarts the planner with its recorded mode', async () => {
    fake.startedAtMs = later;
    deps.now = () => new Date(later);
    const planner = Q('planner');
    const old = entryOf(planner) as RosterEntry;
    await hierarchyRestart({ session: 'planner' }, deps);
    expect(entryOf(planner)).toMatchObject({ permissionMode: old.permissionMode });
    expect(entryOf(planner)?.pid).not.toBe(old.pid);
  });

  it('restart --all restarts dispatch and idle executors now and defers busy ones', async () => {
    fake.startedAtMs = later;
    deps.now = () => new Date(later);
    await hierarchyUp({ ...baseOpts, executors: 2 }, deps);
    const beta = Q('executor-beta');
    putInflight('AISDLC-300', beta);
    let sleeps = 0;
    deps.sleep = async () => {
      if (++sleeps === 1) releaseInflight(boardDir, 'AISDLC-300');
    };
    const res = await hierarchyRestartAll({}, deps);
    expect(res.failed).toEqual([]);
    expect(res.restarted.map((r) => r.name)).toEqual([Q('operator-dispatch'), alpha, beta]);
    expect(res.deferred).toEqual([beta]);
    expect(entryOf(Q('planner'))?.pid).toBe(
      readRoster(boardDir).sessions.find((e) => e.role === 'planner')?.pid,
    );
  });

  it('restart --all collects a failure and keeps going', async () => {
    fake.startedAtMs = later;
    deps.now = () => new Date(later);
    fake.failStartFor = Q('operator-dispatch');
    const res = await hierarchyRestartAll({}, deps);
    expect(res.failed.map((f) => f.name)).toEqual([Q('operator-dispatch')]);
    expect(res.restarted.map((r) => r.name)).toEqual([alpha, Q('executor-beta')]);
  });

  it('refuses an unknown session', async () => {
    await expect(hierarchyRestart({ session: 'executor-zeta' }, deps)).rejects.toThrow(
      /no session named 'executor-zeta'.*cli-hierarchy status/,
    );
  });

  it('refuses a session without the ownership marker and leaves it running', async () => {
    fake.owned.delete(alpha);
    const before = readRoster(boardDir);
    await expect(hierarchyRestart({ session: alpha }, deps)).rejects.toThrow(
      /does not carry the @ai-sdlc-hierarchy marker.*Nothing was stopped/,
    );
    expect(readRoster(boardDir)).toEqual(before);
    expect(fake.windows).toContain(alpha);
  });

  it('refuses an old single-session layout entry', async () => {
    writeRawRoster([legacyEntry('executor-alpha', 'executor')]);
    await expect(hierarchyRestart({ session: 'executor-alpha' }, deps)).rejects.toThrow(
      /old single-session layout/,
    );
  });

  it('drops the dead entry and says how to recover when the new session cannot start', async () => {
    fake.failStartFor = alpha;
    await expect(hierarchyRestart({ session: alpha }, deps)).rejects.toThrow(
      /could not start.*dropped from the roster.*cli-hierarchy up/,
    );
    expect(entryOf(alpha)).toBeUndefined();
    expect(entryOf(Q('executor-beta'))).toBeDefined();
  });

  describe('register', () => {
    /** Simulate an operator restarting the process by hand: a new live registry entry. */
    const handRestart = (pid: number, name = alpha) => {
      writeFileSync(
        path.join(registryDir, `${pid}.json`),
        JSON.stringify({ pid, name, startedAt: later, status: 'idle', cwd: '/repo' }),
      );
      deps.isAlive = (p) => p === pid;
      const panePid = (entryOf(name) as RosterEntry).pid;
      // the new process runs under the pane's shell
      deps.parentPid = (p) => (p === pid ? panePid : null);
    };

    it('re-records a session whose pid changed, touching only its entry', () => {
      const before = readRoster(boardDir);
      handRestart(9999);
      const result = hierarchyRegister({ session: alpha }, deps);
      expect(entryOf(alpha)).toMatchObject({
        pid: 9999,
        startedAt: new Date(later).toISOString(),
        status: 'running',
      });
      expect(result.after.pid).toBe(9999);
      for (const e of before.sessions.filter((x) => x.name !== alpha)) {
        expect(readRoster(boardDir).sessions).toContainEqual(e);
      }
    });

    it('does nothing when the roster already matches the live session', () => {
      const old = entryOf(alpha) as RosterEntry;
      deps.isAlive = (p) => p === old.pid;
      const result = hierarchyRegister({ session: alpha }, deps);
      expect(result.unchanged).toBe(true);
      expect(entryOf(alpha)).toEqual(old);
    });

    it('refuses when no live harness session carries the name', () => {
      expect(() => hierarchyRegister({ session: alpha }, deps)).toThrow(
        /no live harness session is registered.*cli-hierarchy restart/,
      );
    });

    it('accepts a pid several levels below the pane process', () => {
      handRestart(9999);
      const panePid = (entryOf(alpha) as RosterEntry).pid;
      deps.parentPid = (p) => ({ 9999: 9998, 9998: panePid })[p] ?? null;
      hierarchyRegister({ session: alpha }, deps);
      expect(entryOf(alpha)?.pid).toBe(9999);
    });

    it('refuses a live pid that is not under the tmux pane', () => {
      handRestart(9999);
      deps.parentPid = () => null;
      const before = readRoster(boardDir);
      expect(() => hierarchyRegister({ session: alpha }, deps)).toThrow(
        /not the tmux pane's process.*cli-hierarchy restart/,
      );
      expect(readRoster(boardDir)).toEqual(before);
    });

    it('refuses a pid that belongs to another roster entry', () => {
      const other = entryOf(Q('executor-beta')) as RosterEntry;
      handRestart(other.pid);
      expect(() => hierarchyRegister({ session: alpha }, deps)).toThrow(/already belongs/);
    });

    it('refuses a closed window, a missing marker and an unreadable pane', () => {
      fake.owned.delete(alpha);
      expect(() => hierarchyRegister({ session: alpha }, deps)).toThrow(/marker/);
      fake.owned.add(alpha);
      const run = deps.run;
      deps.run = (f, a, o) =>
        a[0] === 'display-message' && a.includes('#{pane_id} #{pane_pid}')
          ? { status: 1, stdout: '', stderr: '' }
          : run(f, a, o);
      expect(() => hierarchyRegister({ session: alpha }, deps)).toThrow(/pane cannot be read/);
      deps.run = run;
      fake.windows = fake.windows.filter((w) => w !== alpha);
      expect(() => hierarchyRegister({ session: alpha }, deps)).toThrow(/is not open/);
    });

    it('refuses a pane whose command lacks the launch environment', () => {
      handRestart(9999);
      const run = deps.run;
      deps.run = (f, a, o) =>
        a[0] === 'display-message' && a.includes('#{pane_start_command}')
          ? { status: 0, stdout: 'claude --name x\n', stderr: '' }
          : run(f, a, o);
      expect(() => hierarchyRegister({ session: alpha }, deps)).toThrow(
        /AI_SDLC_HIERARCHY_SESSION/,
      );
    });
  });
});

describe('reconcile scheduler ownership (AISDLC-932)', () => {
  const opts = { ...baseOpts, executors: 0, noPlanner: true };

  it('up starts reconcile --watch detached and records its pid', async () => {
    await hierarchyUp(opts, deps);
    expect(schedulerSpawns).toHaveLength(1);
    expect(schedulerSpawns[0]?.slice(1)).toEqual([
      path.join(path.dirname(process.argv[1] ?? ''), 'cli-dispatch.mjs'),
      'reconcile',
      '--watch',
      '--board-dir',
      boardDir,
    ]);
    deps.isAlive = (p) => p === 4242;
    expect(schedulerStatus(deps)).toEqual({ state: 'up', pid: 4242 });
  });

  it('a second up with a live scheduler starts no other', async () => {
    await hierarchyUp(opts, deps);
    deps.isAlive = (p) => p === 4242;
    await hierarchyUp(opts, deps);
    expect(schedulerSpawns).toHaveLength(1);
  });

  it('a failed spawn warns and does not fail up', async () => {
    deps.spawnScheduler = () => undefined;
    await hierarchyUp(opts, deps);
    expect(logs.some((l) => l.includes('reconcile scheduler not started'))).toBe(true);
  });

  it('status reports it in text and json', async () => {
    await hierarchyUp(opts, deps);
    deps.isAlive = (p) => p === 4242;
    const result = hierarchyStatus(deps);
    expect(result.scheduler).toEqual({ state: 'up', pid: 4242 });
    expect(formatStatus(result)).toContain('scheduler: up (pid 4242)');
  });

  it('down stops it, a role-limited down leaves it', async () => {
    await hierarchyUp(opts, deps);
    deps.isAlive = (p) => p === 4242;
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    try {
      await hierarchyDown({ role: 'operator-dispatch' }, deps);
      expect(kill).not.toHaveBeenCalledWith(4242, 'SIGTERM');
      await hierarchyDown({}, deps);
      expect(kill).toHaveBeenCalledWith(4242, 'SIGTERM');
    } finally {
      kill.mockRestore();
    }
    deps.isAlive = () => false;
    expect(schedulerStatus(deps)).toEqual({ state: 'off' });
    expect(schedulerDown(deps)).toBe(false);
  });
});

describe('hierarchy status gh calls (AISDLC-963)', () => {
  it('prints calls per session in the last hour and live remaining quota', () => {
    const lines = formatStatus({
      rows: [],
      board: { queued: 0, inflight: 0, done: 0, failed: 0 },
      webhook: { state: 'off', reason: 'no secret' },
      scheduler: { state: 'off' },
      ghCallsPerHour: { a: 2, b: 9 },
      quota: { core: 4000, graphql: 12 },
    } as Parameters<typeof formatStatus>[0]);
    expect(lines).toContain('gh calls last hour: b 9, a 2; remaining core 4000, graphql 12');
  });
});
