/**
 * Tests for dispatch brief generation. Synthetic task trees under a temp dir;
 * tmux is a fake runner and the notify sender is injected.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runHierarchyCli } from '../cli/hierarchy.js';
import {
  briefMessage,
  createTmuxBriefSender,
  generateBrief,
  GROUP_PATTERN,
  MAX_BRIEF_BYTES,
  MAX_BRIEF_ENTRIES,
  isTrustSensitivePath,
  notifyDispatch,
  parseBrief,
  planBrief,
  renderBrief,
  renderBriefBlock,
  writeRoster,
  type BriefSender,
  type BriefTask,
  type CommandRunner,
  type HierarchyDeps,
  type RosterEntry,
} from './index.js';

const NOW = new Date('2026-09-30T12:00:00.000Z');
const RFC = 'spec/rfcs/RFC-0099-demo.md';

let tmp: string;
let logs: string[];
let deps: HierarchyDeps;

function task(
  dir: 'tasks' | 'completed',
  id: string,
  opts: {
    deps?: string[];
    refs?: string[];
    dispatchable?: boolean;
    status?: string;
    priority?: string;
    title?: string;
  } = {},
): void {
  const fm = [
    '---',
    `id: ${id}`,
    `title: ${opts.title ?? `Task ${id}`}`,
    `status: ${opts.status ?? (dir === 'completed' ? 'Done' : 'To Do')}`,
    `priority: ${opts.priority ?? 'medium'}`,
    'dependencies:',
    ...(opts.deps ?? []).map((d) => `  - ${d}`),
    'references:',
    ...(opts.refs ?? []).map((r) => `  - ${r}`),
    ...(opts.dispatchable === false ? ['dispatchable: false'] : []),
    '---',
    '',
    'body',
    '',
  ].join('\n');
  mkdirSync(path.join(tmp, 'backlog', dir), { recursive: true });
  writeFileSync(path.join(tmp, 'backlog', dir, `${id.toLowerCase()} - t.md`), fm);
}

function seedSixTasks(): void {
  task('completed', 'DEMO-0');
  task('tasks', 'DEMO-1', { deps: ['DEMO-0'], refs: [RFC, 'pkg/src/generated-schemas.ts'] });
  task('tasks', 'DEMO-2', { deps: ['DEMO-1'], refs: [RFC, 'reference/src/index.ts'] });
  task('tasks', 'DEMO-3', { deps: ['DEMO-1'], refs: [RFC, 'pkg/src/shared.ts'] });
  task('tasks', 'DEMO-4', {
    deps: ['DEMO-2', 'DEMO-3'],
    refs: [RFC, 'pkg/src/shared.ts', 'ai-sdlc-plugin/hooks/guard.js'],
  });
  task('tasks', 'DEMO-5', {
    refs: [RFC, '.github/workflows/ci.yml'],
    dispatchable: false,
  });
  task('tasks', 'DEMO-6', { deps: ['DEMO-5', 'EXT-9'], refs: [RFC, 'pkg/src/events.ts'] });
  task('tasks', 'EXT-9', { refs: ['pkg/other.ts'] });
}

function rosterEntry(over: Partial<RosterEntry>): RosterEntry {
  return {
    role: 'operator-dispatch',
    name: 'operator-dispatch',
    tmuxSession: 'ai-sdlc-hierarchy',
    tmuxWindow: 'operator-dispatch',
    paneId: '%7',
    pid: 1,
    model: 'opus',
    permissionMode: 'acceptEdits',
    startedAt: NOW.toISOString(),
    status: 'running',
    ...over,
  };
}

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'brief-'));
  logs = [];
  deps = {
    run: () => ({ status: 1, stdout: '', stderr: 'no tmux in tests' }),
    boardDir: path.join(tmp, '.ai-sdlc', 'dispatch'),
    cwd: tmp,
    registryDir: path.join(tmp, 'sessions'),
    settingsFiles: [],
    userSettingsFile: path.join(tmp, 'settings.json'),
    resources: () => ({ availableBytes: null, loadAvg1: 0, cpus: 1 }),
    env: {},
    now: () => NOW,
    sleep: async () => {},
    log: (l) => logs.push(l),
    attach: () => 0,
    claudeBin: 'claude',
    pollAttempts: 1,
    pollIntervalMs: 1,
  };
  seedSixTasks();
});

afterEach(() => rmSync(tmp, { recursive: true, force: true }));

function brief(sel: { tasks?: string; rfc?: string }, extra: { force?: boolean } = {}) {
  return generateBrief({ ...sel, ...extra }, deps);
}

describe('waves and external prerequisites', () => {
  it('derives waves from the chain and lists out-of-set prerequisites', () => {
    const { plan } = brief({ rfc: 'RFC-0099' });
    const wave = Object.fromEntries(plan.entries.map((e) => [e.task, e.wave]));
    expect(wave).toEqual({ 'DEMO-1': 1, 'DEMO-2': 2, 'DEMO-3': 2, 'DEMO-4': 3, 'DEMO-6': 1 });
    expect(plan.entries.find((e) => e.task === 'DEMO-4')?.after).toEqual(['DEMO-2', 'DEMO-3']);
    // DEMO-0 is completed: not a prerequisite. EXT-9 is open and outside the set.
    expect(plan.external.map((x) => x.prerequisite).sort()).toEqual(['DEMO-5', 'EXT-9']);
    expect(plan.entries.find((e) => e.task === 'DEMO-6')?.after).toEqual([]);
  });

  it('reports an unknown dependency as not found', () => {
    const plan = planBrief([{ ...base('AB-1'), dependencies: ['NOPE-1'] }], () => undefined);
    expect(plan.external[0]?.reason).toMatch(/not found/);
  });

  it('rejects a dependency cycle', () => {
    expect(() =>
      planBrief(
        [
          { ...base('AB-1'), dependencies: ['AB-2'] },
          { ...base('AB-2'), dependencies: ['AB-1'] },
        ],
        () => true,
      ),
    ).toThrow(/cycle/);
  });
});

function base(id: string): BriefTask {
  return {
    id,
    title: id,
    priority: 'high',
    dependencies: [],
    references: [],
    dispatchable: true,
  };
}

describe('sequence groups', () => {
  it('groups shared files and uses the fixed names for the well-known surfaces', () => {
    const { plan } = brief({ rfc: 'RFC-0099' });
    const group = Object.fromEntries(plan.entries.map((e) => [e.task, e.sequenceGroup]));
    expect(group['DEMO-1']).toBe('schema-regen');
    expect(group['DEMO-2']).toBe('root-barrel');
    expect(group['DEMO-6']).toBe('events');
    expect(group['DEMO-3']).toBe('shared.ts');
    expect(group['DEMO-4']).toBe('shared.ts');
  });

  it('prefers a fixed name over a more widely shared file and notes the overlap', () => {
    const plan = planBrief(
      [
        { ...base('AB-1'), references: ['x/shared.ts', 'y/events.ts'] },
        { ...base('AB-2'), references: ['x/shared.ts'] },
      ],
      () => true,
    );
    expect(plan.entries[0]?.sequenceGroup).toBe('events');
    expect(plan.secondaryOverlaps).toEqual([{ task: 'AB-1', file: 'x/shared.ts' }]);
    expect(plan.entries[1]?.sequenceGroup).toBe('shared.ts');
  });

  it('gives a file referenced by a single task no group', () => {
    const plan = planBrief([{ ...base('AB-1'), references: ['only/here.ts', RFC] }], () => true);
    expect(plan.entries[0]?.sequenceGroup).toBeUndefined();
  });
});

describe('flags', () => {
  it('lists a non-dispatchable task under do-not-dispatch and keeps it out of the YAML', () => {
    const { file, plan } = brief({ rfc: 'RFC-0099' });
    const md = readFileSync(file, 'utf-8');
    expect(plan.doNotDispatch).toEqual(['DEMO-5']);
    const section = md.split('## Do not dispatch')[1]!.split('## ')[0]!;
    expect(section).toContain('DEMO-5');
    expect(parseBrief(md).entries.map((e) => e.task)).not.toContain('DEMO-5');
  });

  it('lists hook and workflow references as trust-sensitive', () => {
    const { file } = brief({ rfc: 'RFC-0099' });
    const section = readFileSync(file, 'utf-8').split('## Trust-sensitive')[1]!.split('## ')[0]!;
    expect(section).toContain('DEMO-4');
    expect(section).toContain('ai-sdlc-plugin/hooks/guard.js');
    expect(section).toContain('DEMO-5');
    expect(section).not.toContain('DEMO-2');
  });

  it('classifies trust-sensitive paths', () => {
    for (const p of [
      'hooks/a.sh',
      'x/enforce-hook.js',
      '.github/workflows/ci.yml',
      'docs/governance/x.md',
      'ai-sdlc-plugin/commands/execute.md',
    ]) {
      expect(isTrustSensitivePath(p)).toBe(true);
    }
    expect(isTrustSensitivePath('ai-sdlc-plugin/commands/planner.md')).toBe(false);
  });
});

describe('brief file and contract with the ingester', () => {
  it('round-trips through parseBrief with the generator values and names the sessions', () => {
    writeRoster(deps.boardDir, {
      schemaVersion: 'v1',
      sessions: [
        rosterEntry({ role: 'planner', name: 'planner', tmuxWindow: 'planner', paneId: '%1' }),
        rosterEntry({}),
      ],
    });
    const { file, plan } = brief({ rfc: 'RFC-0099' });
    expect(file).toBe(path.join(deps.boardDir, 'briefs', 'rfc-0099.md'));
    const md = readFileSync(file, 'utf-8');
    expect(md).toContain('Planner session: `planner`');
    expect(md).toContain('Dispatch session: `operator-dispatch`');
    expect(parseBrief(md).entries).toEqual(plan.entries);
  });

  it('handles --tasks, skips completed tasks and refuses to overwrite without force', () => {
    const r = brief({ tasks: 'DEMO-0,DEMO-1,DEMO-1,DEMO-2' });
    expect(r.file).toMatch(/tasks-demo-1-plus-1\.md$/);
    expect(r.plan.entries.map((e) => e.task)).toEqual(['DEMO-1', 'DEMO-2']);
    expect(logs.join('\n')).toMatch(/DEMO-0 is already completed/);
    expect(() => brief({ tasks: 'DEMO-0,DEMO-1,DEMO-1,DEMO-2' })).toThrow(/--force/);
    expect(() => brief({ tasks: 'DEMO-0,DEMO-1,DEMO-1,DEMO-2' }, { force: true })).not.toThrow();
  });

  it('keeps an edited brief when asked to notify', () => {
    const first = brief({ tasks: 'DEMO-1' });
    writeFileSync(first.file, 'edited by the planner\n');
    const again = generateBrief({ tasks: 'DEMO-1', keepExisting: true }, deps);
    expect(again.reused).toBe(true);
    expect(readFileSync(first.file, 'utf-8')).toBe('edited by the planner\n');
  });

  it('uses a single-task slug and warns when the roster has no sessions', () => {
    const r = brief({ tasks: 'demo-3' });
    expect(r.file).toMatch(/tasks-demo-3\.md$/);
    expect(readFileSync(r.file, 'utf-8')).toContain('not in the roster');
  });

  it('honours --out relative to the working directory', () => {
    const r = generateBrief({ tasks: 'DEMO-1', out: 'sub/mine.md' }, deps);
    expect(r.file).toBe(path.join(tmp, 'sub', 'mine.md'));
  });

  it('rejects bad selections', () => {
    expect(() => brief({})).toThrow(/exactly one/);
    expect(() => brief({ tasks: 'DEMO-1', rfc: 'RFC-0099' })).toThrow(/exactly one/);
    expect(() => brief({ rfc: 'RFC-9' })).toThrow(/invalid --rfc/);
    expect(() => brief({ rfc: 'RFC-0500' })).toThrow(/no open task/);
    expect(() => brief({ tasks: ' , ' })).toThrow(/at least one/);
    expect(() => brief({ tasks: 'bad id' })).toThrow(/invalid task id/);
    expect(() => brief({ tasks: 'DEMO-77' })).toThrow(/not found/);
    expect(() => brief({ tasks: 'DEMO-0' })).toThrow(/already completed/);
  });

  it('ignores roster entries that fail validation', () => {
    mkdirSync(deps.boardDir, { recursive: true });
    writeFileSync(
      path.join(deps.boardDir, 'hierarchy.json'),
      JSON.stringify({
        schemaVersion: 'v1',
        sessions: [rosterEntry({ tmuxSession: 'someone-elses' })],
      }),
    );
    const r = brief({ tasks: 'DEMO-1' });
    expect(r.dispatch).toBeUndefined();
    expect(logs.join('\n')).toMatch(/ignored/);
  });
});

describe('parseBrief', () => {
  const entries = [
    { task: 'AB-1', after: [], wave: 1 },
    { task: 'AB-2', after: ['AB-1'], sequenceGroup: 'g', wave: 2, priority: 1 },
  ];

  it('round-trips rendered entries', () => {
    expect(parseBrief(`# t\n\n${renderBriefBlock(entries)}\n`).entries).toEqual(entries);
  });

  it('accepts an empty list and ignores unrelated yaml blocks', () => {
    expect(parseBrief('```yaml\nother: 1\n```\n```yaml\ndispatchBrief:\n```\n').entries).toEqual(
      [],
    );
  });

  it.each([
    ['no block', '# nothing', /no 'dispatchBrief'/],
    ['two blocks', `${renderBriefBlock(entries)}\n${renderBriefBlock(entries)}`, /more than one/],
    ['bad yaml', '```yaml\na: [\n```', /not valid YAML/],
    ['not a list', '```yaml\ndispatchBrief: 3\n```', /must be a list/],
    ['not a mapping', '```yaml\ndispatchBrief: [3]\n```', /must be a mapping/],
    ['bad task', '```yaml\ndispatchBrief:\n  - {task: x, wave: 1}\n```', /valid task id/],
    [
      'after not list',
      '```yaml\ndispatchBrief:\n  - {task: AB-1, after: 1, wave: 1}\n```',
      /must be a list/,
    ],
    [
      'bad after',
      '```yaml\ndispatchBrief:\n  - {task: AB-1, after: [z], wave: 1}\n```',
      /invalid task id/,
    ],
    ['bad wave', '```yaml\ndispatchBrief:\n  - {task: AB-1, wave: 0}\n```', /wave/],
    [
      'bad group',
      '```yaml\ndispatchBrief:\n  - {task: AB-1, wave: 1, sequenceGroup: "a b"}\n```',
      /group/,
    ],
    [
      'bad priority',
      '```yaml\ndispatchBrief:\n  - {task: AB-1, wave: 1, priority: "Hi!"}\n```',
      /priority/,
    ],
    [
      'string priority',
      '```yaml\ndispatchBrief:\n  - {task: AB-1, wave: 1, priority: "2"}\n```',
      /priority/,
    ],
    [
      'non-integer priority',
      '```yaml\ndispatchBrief:\n  - {task: AB-1, wave: 1, priority: 1.5}\n```',
      /priority/,
    ],
    [
      'duplicate',
      '```yaml\ndispatchBrief:\n  - {task: AB-1, wave: 1}\n  - {task: AB-1, wave: 2}\n```',
      /more than once/,
    ],
  ])('rejects %s', (_n, md, re) => {
    expect(() => parseBrief(md as string)).toThrow(re as RegExp);
  });
});

describe('notify', () => {
  it('sends exactly one message to the dispatch session in the roster', () => {
    writeRoster(deps.boardDir, {
      schemaVersion: 'v1',
      sessions: [
        rosterEntry({ role: 'planner', name: 'planner', tmuxWindow: 'planner', paneId: '' }),
        rosterEntry({ name: 'dispatch-main' }),
      ],
    });
    const sent: { name: string; message: string }[] = [];
    const sender: BriefSender = (e, m) => sent.push({ name: e.name, message: m });
    const code = runHierarchyCliQuiet(['brief', '--rfc', 'RFC-0099', '--notify'], sender);
    return code.then((c) => {
      expect(c).toBe(0);
      expect(sent).toHaveLength(1);
      expect(sent[0]?.name).toBe('dispatch-main');
      expect(sent[0]?.message).toContain('.ai-sdlc/dispatch/briefs/rfc-0099.md');
      expect(sent[0]?.message).not.toMatch(/[\n\r]/);
    });
  });

  it('fails clearly when there is no dispatch session', () => {
    expect(() => notifyDispatch(undefined, '/x/b.md', '/x', () => {})).toThrow(
      /no dispatch session/,
    );
  });

  it('shows a path outside the working directory in full', () => {
    expect(briefMessage('/elsewhere/b.md', '/repo')).toContain('/elsewhere/b.md');
  });

  it('refuses to announce a path with characters outside the whitelist', () => {
    for (const bad of [
      '/repo/a\nb.md',
      '/repo/a b.md',
      '/repo/a;b.md',
      '/repo/$(x).md',
      '/repo/a`b.md',
    ]) {
      expect(() => briefMessage(bad, '/repo')).toThrow(/refusing to announce/);
    }
    expect(briefMessage('/repo/.ai-sdlc/dispatch/briefs/rfc-0051.md', '/repo')).toContain(
      '.ai-sdlc/dispatch/briefs/rfc-0051.md',
    );
  });
});

async function runHierarchyCliQuiet(argv: string[], sender: BriefSender): Promise<number> {
  const cwd = process.cwd();
  process.chdir(tmp);
  try {
    return await runHierarchyCli(argv, { ...deps, boardDir: deps.boardDir }, { sendBrief: sender });
  } finally {
    process.chdir(cwd);
  }
}

describe('tmux sender', () => {
  function runner(opts: { windows?: string[]; pane?: string; failKeys?: number } = {}) {
    const calls: string[][] = [];
    let keyCalls = 0;
    const run: CommandRunner = (_f, args) => {
      calls.push([...args]);
      if (args[0] === 'list-windows') {
        return {
          status: 0,
          stdout: (opts.windows ?? ['operator-dispatch']).join('\n'),
          stderr: '',
        };
      }
      if (args[0] === 'display-message') {
        return { status: 0, stdout: `${opts.pane ?? '%7'}\n`, stderr: '' };
      }
      if (args[0] === 'send-keys') {
        keyCalls++;
        return { status: keyCalls === opts.failKeys ? 1 : 0, stdout: '', stderr: 'bad' };
      }
      return { status: 1, stdout: '', stderr: '' };
    };
    return { run, calls };
  }

  it('types literally into the verified pane, then submits', () => {
    const { run, calls } = runner();
    createTmuxBriefSender(run)(rosterEntry({}), 'hello');
    const keys = calls.filter((c) => c[0] === 'send-keys');
    expect(keys).toEqual([
      ['send-keys', '-t', '%7', '-l', '--', 'hello'],
      ['send-keys', '-t', '%7', 'Enter'],
    ]);
  });

  it('falls back to the window name when the pane id no longer belongs to it', () => {
    const { run, calls } = runner({ pane: '%99' });
    createTmuxBriefSender(run)(rosterEntry({}), 'hello');
    expect(calls.find((c) => c[0] === 'send-keys')?.[2]).toBe(
      '=ai-sdlc-hierarchy:operator-dispatch',
    );
  });

  it('never targets a foreign session, window or pane', () => {
    for (const bad of [{ tmuxSession: 'mine' }, { tmuxWindow: 'Bad;Name' }, { paneId: '%1; rm' }]) {
      const { run, calls } = runner();
      expect(() => createTmuxBriefSender(run)(rosterEntry(bad), 'x')).toThrow(/refusing/);
      expect(calls).toEqual([]);
    }
  });

  it('refuses when the window is not open and reports key failures', () => {
    expect(() => createTmuxBriefSender(runner({ windows: [] }).run)(rosterEntry({}), 'x')).toThrow(
      /not open/,
    );
    expect(() => createTmuxBriefSender(runner({ failKeys: 1 }).run)(rosterEntry({}), 'x')).toThrow(
      /could not type/,
    );
    expect(() => createTmuxBriefSender(runner({ failKeys: 2 }).run)(rosterEntry({}), 'x')).toThrow(
      /could not submit/,
    );
  });
});

describe('cli brief', () => {
  it('prints the written path and reports errors with exit 1', async () => {
    const sender: BriefSender = () => {
      throw new Error('should not be called without --notify');
    };
    expect(await runHierarchyCliQuiet(['brief', '--tasks', 'DEMO-1'], sender)).toBe(0);
    expect(existsSync(path.join(deps.boardDir, 'briefs', 'tasks-demo-1.md'))).toBe(true);
    expect(logs.some((l) => l.startsWith('wrote '))).toBe(true);
    expect(await runHierarchyCliQuiet(['brief'], sender)).toBe(1);
    expect(await runHierarchyCliQuiet(['brief', '--tasks', '--force'], sender)).toBe(1);
  });

  it('keeps the brief and exits 1 when notify has no target', async () => {
    expect(await runHierarchyCliQuiet(['brief', '--rfc', 'RFC-0099', '--notify'], () => {})).toBe(
      1,
    );
    expect(existsSync(path.join(deps.boardDir, 'briefs', 'rfc-0099.md'))).toBe(true);
  });
});

describe('priority as an integer', () => {
  it('maps backlog priorities to integers and omits unknown ones', () => {
    const plan = planBrief(
      [
        { ...base('AB-1'), priority: 'high' },
        { ...base('AB-2'), priority: 'medium' },
        { ...base('AB-3'), priority: 'low' },
        { ...base('AB-4'), priority: 'urgent' },
        { ...base('AB-5'), priority: '' },
      ],
      () => true,
    );
    expect(plan.entries.map((e) => e.priority)).toEqual([1, 2, 3, undefined, undefined]);
    expect(parseBrief(`${renderBriefBlock(plan.entries)}\n`).entries).toEqual(plan.entries);
  });

  it('writes the integer into a generated brief that parses back equal', () => {
    task('tasks', 'PRI-1', { priority: 'high' });
    task('tasks', 'PRI-2', { priority: 'low' });
    const { file, plan } = brief({ tasks: 'PRI-1,PRI-2' });
    const md = readFileSync(file, 'utf-8');
    expect(md).toMatch(/priority: 1\n/);
    expect(md).toMatch(/1 is high, 2 is medium, 3 is low/);
    expect(parseBrief(md).entries).toEqual(plan.entries);
    expect(parseBrief(md).entries.map((e) => e.priority)).toEqual([1, 3]);
  });

  it('rejects a string priority in a hand-edited brief', () => {
    const md = readFileSync(brief({ tasks: 'DEMO-1' }).file, 'utf-8').replace(
      /priority: 2/,
      'priority: high',
    );
    expect(() => parseBrief(md)).toThrow(/priority/);
  });
});

describe('derived sequence group names', () => {
  const oddBases = [
    '.prettierrc',
    '_helpers.ts',
    '[id].tsx',
    'my file.ts',
    '...',
    '__',
    'a$b(c).ts',
    '日本語.ts',
    'x'.repeat(300) + '.ts',
  ];

  it('round-trips through parseBrief for odd basenames', () => {
    const tasks: BriefTask[] = [];
    oddBases.forEach((b, i) => {
      tasks.push({ ...base(`OD-${i * 2 + 1}`), references: [`dir${i}/${b}`] });
      tasks.push({ ...base(`OD-${i * 2 + 2}`), references: [`dir${i}/${b}`] });
    });
    const plan = planBrief(tasks, () => true);
    expect(plan.groups).toHaveLength(oddBases.length);
    for (const g of plan.groups) expect(GROUP_PATTERN.test(g.name)).toBe(true);
    expect(new Set(plan.groups.map((g) => g.name)).size).toBe(oddBases.length);
    for (const e of plan.entries) expect(e.sequenceGroup).toBeDefined();
    expect(parseBrief(`${renderBriefBlock(plan.entries)}\n`).entries).toEqual(plan.entries);
  });

  it('strips leading dots and underscores', () => {
    const plan = planBrief(
      [
        { ...base('AB-1'), references: ['.prettierrc'] },
        { ...base('AB-2'), references: ['.prettierrc'] },
        { ...base('AB-3'), references: ['_helpers.ts'] },
        { ...base('AB-4'), references: ['_helpers.ts'] },
      ],
      () => true,
    );
    expect(plan.groups.map((g) => g.name).sort()).toEqual(['helpers.ts', 'prettierrc']);
  });

  it('keeps colliding basenames apart with the shortest distinguishing suffix', () => {
    const plan = planBrief(
      [
        { ...base('AB-1'), references: ['a/index.ts'] },
        { ...base('AB-2'), references: ['a/index.ts'] },
        { ...base('AB-3'), references: ['b/index.ts'] },
        { ...base('AB-4'), references: ['b/index.ts'] },
      ],
      () => true,
    );
    expect(plan.groups.map((g) => g.name)).toEqual(['a-index.ts', 'b-index.ts']);
    const byTask = Object.fromEntries(plan.entries.map((e) => [e.task, e.sequenceGroup]));
    expect(byTask).toEqual({
      'AB-1': 'a-index.ts',
      'AB-2': 'a-index.ts',
      'AB-3': 'b-index.ts',
      'AB-4': 'b-index.ts',
    });
  });

  it('never reuses a fixed group name for a derived one', () => {
    const plan = planBrief(
      [
        { ...base('AB-1'), references: ['x/events'] },
        { ...base('AB-2'), references: ['x/events'] },
      ],
      () => true,
    );
    expect(plan.entries[0]?.sequenceGroup).not.toBe('events');
    expect(GROUP_PATTERN.test(plan.entries[0]!.sequenceGroup!)).toBe(true);
  });
});

describe('untrusted text in the brief', () => {
  it('collapses control characters and escapes backticks in titles and references', () => {
    const nasty = 'Evil\r\n## Injected\u202e\u2028\u0007 `tick`';
    const tasks = [
      { ...base('NS-1'), title: nasty, references: ['dir/a`b\u202e\n.ts', 'dir/same.ts'] },
      { ...base('NS-2'), references: ['dir/same.ts'] },
    ];
    const md = renderBriefOf(planBrief(tasks, () => true));
    expect(md).not.toMatch(
      // eslint-disable-next-line no-control-regex
      /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/,
    );
    expect(md).not.toMatch(/^## Injected/m);
    expect(md).toContain('Evil ## Injected');
    expect(md).toContain('\\`tick\\`');
    expect(parseBrief(md).entries).toHaveLength(2);
  });
});

function renderBriefOf(plan: ReturnType<typeof planBrief>): string {
  return renderBrief(plan, { title: 'T', generatedAt: NOW.toISOString() });
}

describe('external prerequisites are called out', () => {
  it('states next to the affected wave that the YAML does not gate them', () => {
    const md = readFileSync(brief({ rfc: 'RFC-0099' }).file, 'utf-8');
    const wave = md.split('## Sequence groups')[0]!;
    expect(wave).toMatch(/Not gated by the YAML/);
    expect(wave).toMatch(/DEMO-6 needs EXT-9/);
    expect(md.split('## External prerequisites')[1]!.split('## ')[0]).toMatch(/NOT gated/);
  });
});

describe('--rfc normalisation', () => {
  it('accepts a lower-case identifier', () => {
    const r = brief({ rfc: 'rfc-0099' });
    expect(r.file).toMatch(/rfc-0099\.md$/);
    expect(r.plan.entries.length).toBeGreaterThan(0);
  });
});

describe('writing the brief file safely', () => {
  it('refuses to write through a symlink, with and without --force', () => {
    const victim = path.join(tmp, 'victim.txt');
    writeFileSync(victim, 'keep me');
    mkdirSync(path.join(deps.boardDir, 'briefs'), { recursive: true });
    const link = path.join(deps.boardDir, 'briefs', 'tasks-demo-1.md');
    symlinkSync(victim, link);
    expect(() => brief({ tasks: 'DEMO-1' })).toThrow(/symbolic link/);
    expect(() => brief({ tasks: 'DEMO-1' }, { force: true })).toThrow(/symbolic link/);
    expect(readFileSync(victim, 'utf-8')).toBe('keep me');
  });

  it('refuses a dangling symlink given with --out', () => {
    const link = path.join(tmp, 'dangling.md');
    symlinkSync(path.join(tmp, 'nowhere.md'), link);
    expect(() => generateBrief({ tasks: 'DEMO-1', out: 'dangling.md' }, deps)).toThrow(
      /symbolic link/,
    );
    expect(existsSync(path.join(tmp, 'nowhere.md'))).toBe(false);
  });

  it('refuses a briefs directory that is a symlink', () => {
    const elsewhere = path.join(tmp, 'elsewhere');
    mkdirSync(elsewhere);
    mkdirSync(deps.boardDir, { recursive: true });
    symlinkSync(elsewhere, path.join(deps.boardDir, 'briefs'));
    expect(() => brief({ tasks: 'DEMO-1' })).toThrow(/symbolic link/);
    expect(existsSync(path.join(elsewhere, 'tasks-demo-1.md'))).toBe(false);
  });

  it('does not announce an existing symlink or a file outside the briefs directory', () => {
    const real = path.join(tmp, 'real.md');
    writeFileSync(real, 'x');
    mkdirSync(path.join(deps.boardDir, 'briefs'), { recursive: true });
    symlinkSync(real, path.join(deps.boardDir, 'briefs', 'tasks-demo-1.md'));
    expect(() => generateBrief({ tasks: 'DEMO-1', keepExisting: true }, deps)).toThrow(
      /symbolic link/,
    );
    expect(() =>
      generateBrief({ tasks: 'DEMO-1', keepExisting: true, out: 'real.md' }, deps),
    ).toThrow(/regular file inside/);
  });

  it('does not announce an existing directory in place of a brief', () => {
    mkdirSync(path.join(deps.boardDir, 'briefs', 'tasks-demo-1.md'), { recursive: true });
    expect(() => generateBrief({ tasks: 'DEMO-1', keepExisting: true }, deps)).toThrow(
      /regular file inside/,
    );
  });

  it('creates exclusively without --force', () => {
    const first = brief({ tasks: 'DEMO-1' });
    writeFileSync(first.file, 'edited');
    expect(() => brief({ tasks: 'DEMO-1' })).toThrow(/--force/);
    expect(readFileSync(first.file, 'utf-8')).toBe('edited');
  });
});

describe('parseBrief input caps', () => {
  it('rejects input over the size cap', () => {
    const big =
      renderBriefBlock([{ task: 'AB-1', after: [], wave: 1 }]) + '\n' + 'x'.repeat(MAX_BRIEF_BYTES);
    expect(() => parseBrief(big)).toThrow(/larger than/);
  });

  it('rejects more entries than the cap and accepts exactly the cap', () => {
    const mk = (n: number) =>
      renderBriefBlock(
        Array.from({ length: n }, (_, i) => ({ task: `AB-${i + 1}`, after: [], wave: 1 })),
      );
    expect(parseBrief(mk(MAX_BRIEF_ENTRIES)).entries).toHaveLength(MAX_BRIEF_ENTRIES);
    expect(() => parseBrief(mk(MAX_BRIEF_ENTRIES + 1))).toThrow(/more than 500 entries/);
  });
});
