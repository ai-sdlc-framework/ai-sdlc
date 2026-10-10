import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { writeRoster } from './roster.js';
import {
  buildVscodeTasks,
  hierarchyTerminals,
  inspectVscodeTasks,
  OPEN_ALL_LABEL,
  syncVscodeTasks,
} from './terminals.js';
import type { HierarchyDeps, RosterEntry } from './types.js';

const BIN = '/opt/My Tools/pipeline-cli/bin/cli-hierarchy.mjs';
let tmp: string;
let logs: string[];
let calls: string[][];
let deps: HierarchyDeps;

function entry(name: string, role: RosterEntry['role'] = 'executor'): RosterEntry {
  return {
    role,
    name,
    tmuxSession: name,
    tmuxWindow: name,
    paneId: '',
    pid: 1,
    model: 'sonnet',
    permissionMode: 'default',
    startedAt: '2026-10-03T12:00:00.000Z',
    status: 'running',
  };
}

function seedRoster(): void {
  writeRoster(deps.boardDir, {
    schemaVersion: 'v1',
    sessions: [
      entry('planner', 'planner'),
      entry('operator-dispatch', 'operator-dispatch'),
      entry('executor-alpha'),
    ],
  });
}

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'hierarchy-terminals-'));
  logs = [];
  calls = [];
  deps = {
    run: (_f, args) => {
      calls.push([...args]);
      return { status: 1, stdout: '', stderr: '' };
    },
    boardDir: path.join(tmp, 'dispatch'),
    cwd: path.join(tmp, 'repo'),
    registryDir: path.join(tmp, 'sessions'),
    settingsFiles: [],
    userSettingsFile: path.join(tmp, 'settings.json'),
    resources: () => ({ availableBytes: null, loadAvg1: 0, cpus: 1 }),
    env: {},
    now: () => new Date('2026-10-03T12:00:00.000Z'),
    sleep: async () => {},
    log: (l) => logs.push(l),
    attach: () => 0,
    claudeBin: 'claude',
    pollAttempts: 1,
    pollIntervalMs: 1,
    binPath: BIN,
  };
  mkdirSync(deps.cwd, { recursive: true });
});

afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const OPTS = { force: false, print: false };

describe('buildVscodeTasks', () => {
  it('builds one task per name plus a parallel compound task', () => {
    const doc = buildVscodeTasks(['planner', 'executor-alpha'], BIN, '/board/hierarchy.json') as {
      version: string;
      tasks: Record<string, unknown>[];
      'ai-sdlc': unknown;
    };
    expect(doc.version).toBe('2.0.0');
    expect(doc.tasks).toHaveLength(3);
    expect(doc.tasks[0]).toMatchObject({
      label: 'planner',
      type: 'shell',
      command: 'node',
      args: [BIN, 'attach', 'planner'],
      isBackground: true,
      presentation: {
        reveal: 'always',
        panel: 'dedicated',
        showReuseMessage: false,
        echo: false,
        clear: true,
        focus: false,
      },
    });
    expect(doc['ai-sdlc']).toEqual({ generated: true, roster: '/board/hierarchy.json' });
    expect(doc.tasks[2]).toMatchObject({
      label: OPEN_ALL_LABEL,
      dependsOn: ['planner', 'executor-alpha'],
      dependsOrder: 'parallel',
    });
  });
});

describe('hierarchyTerminals', () => {
  it('--print emits valid JSON for every roster entry and writes no file', () => {
    seedRoster();
    const r = hierarchyTerminals({ ...OPTS, print: true }, deps);
    const doc = JSON.parse(logs.join('\n')) as { tasks: { label: string; args?: string[] }[] };
    expect(doc.tasks.map((t) => t.label)).toEqual([
      'planner',
      'operator-dispatch',
      'executor-alpha',
      OPEN_ALL_LABEL,
    ]);
    expect(doc.tasks.slice(0, 3).map((t) => t.args)).toEqual([
      [BIN, 'attach', 'planner'],
      [BIN, 'attach', 'operator-dispatch'],
      [BIN, 'attach', 'executor-alpha'],
    ]);
    expect(r.file).toBeUndefined();
    expect(existsSync(path.join(deps.cwd, '.vscode'))).toBe(false);
    expect(calls).toEqual([]);
  });

  it('--print does not care about an existing tasks.json', () => {
    seedRoster();
    mkdirSync(path.join(deps.cwd, '.vscode'));
    writeFileSync(path.join(deps.cwd, '.vscode', 'tasks.json'), 'keep');
    expect(() => hierarchyTerminals({ ...OPTS, print: true }, deps)).not.toThrow();
    expect(readFileSync(path.join(deps.cwd, '.vscode', 'tasks.json'), 'utf-8')).toBe('keep');
  });

  it('writes <cwd>/.vscode/tasks.json by default, atomically', () => {
    seedRoster();
    const r = hierarchyTerminals(OPTS, deps);
    const file = path.join(deps.cwd, '.vscode', 'tasks.json');
    expect(r.file).toBe(file);
    expect(JSON.parse(readFileSync(file, 'utf-8')).tasks).toHaveLength(4);
    expect(readdirSync(path.dirname(file))).toEqual(['tasks.json']);
    expect(logs).toEqual([`wrote ${file}`]);
  });

  it('honours --out, relative to the working directory', () => {
    seedRoster();
    const r = hierarchyTerminals({ ...OPTS, out: 'custom/dir' }, deps);
    expect(r.file).toBe(path.join(deps.cwd, 'custom', 'dir', 'tasks.json'));
    expect(existsSync(r.file as string)).toBe(true);
  });

  it('refuses to overwrite an existing tasks.json without --force, and replaces it with it', () => {
    seedRoster();
    const dir = path.join(deps.cwd, '.vscode');
    mkdirSync(dir);
    const file = path.join(dir, 'tasks.json');
    writeFileSync(file, 'mine');
    expect(() => hierarchyTerminals(OPTS, deps)).toThrow(/already exists.*--force/);
    expect(readFileSync(file, 'utf-8')).toBe('mine');
    hierarchyTerminals({ ...OPTS, force: true }, deps);
    expect(JSON.parse(readFileSync(file, 'utf-8')).version).toBe('2.0.0');
  });

  it('never follows a symlinked tasks.json, even with --force', () => {
    seedRoster();
    const dir = path.join(deps.cwd, '.vscode');
    mkdirSync(dir);
    const victim = path.join(tmp, 'victim.txt');
    writeFileSync(victim, 'precious');
    symlinkSync(victim, path.join(dir, 'tasks.json'));
    expect(() => hierarchyTerminals({ ...OPTS, force: true }, deps)).toThrow(/not a regular file/);
    expect(readFileSync(victim, 'utf-8')).toBe('precious');
  });

  it('errors clearly on an empty roster', () => {
    expect(() => hierarchyTerminals(OPTS, deps)).toThrow(/no sessions in the roster/);
    expect(existsSync(path.join(deps.cwd, '.vscode'))).toBe(false);
  });

  it('works for a legacy-layout roster, naming each agent by its window', () => {
    writeRoster(deps.boardDir, {
      schemaVersion: 'v1',
      sessions: [{ ...entry('executor-alpha'), tmuxSession: 'ai-sdlc-hierarchy' }],
    });
    hierarchyTerminals({ ...OPTS, print: true }, deps);
    expect(logs.join('\n')).toContain('"executor-alpha"');
  });

  it('skips and reports a roster entry that is not safe', () => {
    seedRoster();
    const file = path.join(deps.boardDir, 'hierarchy.json');
    const doc = JSON.parse(readFileSync(file, 'utf-8'));
    doc.sessions.push({ ...entry('victim'), tmuxSession: 'victim' });
    writeFileSync(file, JSON.stringify(doc));
    hierarchyTerminals({ ...OPTS, print: true }, deps);
    expect(logs[0]).toMatch(/ignored/);
    expect(logs.join('\n')).not.toContain('attach victim');
  });
});

describe('syncVscodeTasks', () => {
  const file = () => path.join(deps.cwd, '.vscode', 'tasks.json');

  it('writes the file when absent, with the marker, and is byte-identical on a re-run', () => {
    seedRoster();
    expect(inspectVscodeTasks(deps)).toBe('absent');
    expect(syncVscodeTasks(deps)).toBe('written');
    const first = readFileSync(file(), 'utf-8');
    const doc = JSON.parse(first);
    expect(doc['ai-sdlc']).toEqual({
      generated: true,
      roster: path.join(deps.boardDir, 'hierarchy.json'),
    });
    expect(inspectVscodeTasks(deps)).toBe('ours');
    expect(syncVscodeTasks(deps)).toBe('unchanged');
    expect(readFileSync(file(), 'utf-8')).toBe(first);
  });

  it('rewrites a marked file when the roster changed', () => {
    seedRoster();
    syncVscodeTasks(deps);
    writeRoster(deps.boardDir, {
      schemaVersion: 'v1',
      sessions: [entry('planner', 'planner'), entry('executor-beta')],
    });
    expect(syncVscodeTasks(deps)).toBe('written');
    expect(readFileSync(file(), 'utf-8')).toContain('executor-beta');
  });

  it('never overwrites a file without the marker, nor an unparseable one', () => {
    seedRoster();
    mkdirSync(path.join(deps.cwd, '.vscode'));
    writeFileSync(file(), '{ "version": "2.0.0", "tasks": [] }');
    expect(syncVscodeTasks(deps)).toBe('foreign');
    expect(inspectVscodeTasks(deps)).toBe('foreign');
    writeFileSync(file(), '// comment\n{}');
    expect(syncVscodeTasks(deps)).toBe('foreign');
    expect(readFileSync(file(), 'utf-8')).toBe('// comment\n{}');
  });

  it('skips on an empty roster', () => {
    expect(syncVscodeTasks(deps)).toBe('skipped');
    expect(existsSync(file())).toBe(false);
  });

  it('defaults the bin to process.argv[1] made absolute', () => {
    seedRoster();
    delete deps.binPath;
    hierarchyTerminals({ ...OPTS, print: true }, deps);
    expect(logs.join('\n')).toContain(JSON.stringify(path.resolve(process.argv[1] ?? '')));
  });
});
