import { describe, expect, it, vi } from 'vitest';
import { classify, renderBoard } from '../../hooks/hierarchy/dispatch.ts';
import { registerStrict } from './stubs/hierarchy-strict-host.ts';

const env = (from: string, text: string) =>
  `<cross-session-message from="${from}" id="1"><agent-message kind="text">${text}</agent-message></cross-session-message>`;

const STATUS = {
  rows: [
    { entry: { role: 'operator-dispatch', name: 'operator-dispatch' }, state: 'busy' },
    { entry: { role: 'executor', name: 'executor-alpha' }, state: 'idle' },
    { entry: { role: 'executor', name: 'executor-beta' }, state: 'busy', inflightTask: 'AISDLC-7' },
  ],
  board: { queued: 2, inflight: 1, done: 5, failed: 1 },
  blocked: [{ taskId: 'AISDLC-9', reason: 'waits for 8' }],
};

const EMPTY_TICK = { blockers: [], ingested: [], verdicts: [], escalations: [], reports: [] };

function setup(tickResult: unknown = EMPTY_TICK) {
  const handlers = registerStrict({});
  const kv = new Map<string, any>();
  let timer: (() => Promise<void>) | undefined;
  const runs: string[][] = [];
  let tickOut: unknown = tickResult;
  const $: any = {
    env: { get: (k: string) => (k === 'HIERARCHY_ROLE' ? 'operator-dispatch' : undefined) },
    session: {
      version: async () => '2.1.309',
      identity: async () => null,
      send: vi.fn(async (a: any) => {
        if (typeof a?.to !== 'string') throw new Error('send: to required');
      }),
      usage: vi.fn(),
      compact: vi.fn(),
    },
    store: {
      get: async (k: string) => kv.get(k),
      set: async (k: string, v: unknown) => void kv.set(k, v),
    },
    command: { run: vi.fn(async () => undefined) },
    prompt: { submit: vi.fn(async () => undefined) },
    clock: {
      // The real host shape: every(ms, fn); an object first argument is refused (AISDLC-1082).
      every: vi.fn(async (ms: any, fn: any) => {
        if (typeof fn !== 'function') throw new TypeError('$.clock.every takes a function');
        if (typeof ms !== 'number') throw new Error('every: ms required');
        timer = fn;
      }),
    },
    ui: {
      open: vi.fn(async (a: any) => {
        if (typeof a?.id !== 'string') throw new Error('open: id required');
      }),
    },
    process: {
      run: vi.fn(async (a: any) => {
        // like the host: an argv list of strings, command first; { command, args } is rejected (AISDLC-1082)
        if (!Array.isArray(a) || a.length === 0 || a.some((x: unknown) => typeof x !== 'string'))
          throw new Error(
            'process.run: takes argv, a non-empty list of strings naming the command first',
          );
        runs.push(a.slice(1));
        const sub = a[2];
        if (sub === 'tick') {
          return tickOut === undefined
            ? { exitCode: 0, stdout: '' }
            : { exitCode: 0, stdout: JSON.stringify(tickOut) };
        }
        if (sub === 'status') return { exitCode: 0, stdout: JSON.stringify(STATUS) };
        if (sub === 'escalation-file')
          return { exitCode: 0, stdout: '{"file":"/b/escalations/x.json"}' };
        return { exitCode: 0, stdout: '[]' };
      }),
    },
  };
  const next = vi.fn(async (e: unknown) => e);
  return {
    $,
    handlers,
    kv,
    next,
    runs,
    setTick: (v: unknown) => (tickOut = v),
    start: async () => {
      await handlers.get('session.start')($, { reason: 'startup' }, next);
      next.mockClear();
    },
    timer: () => timer!(),
    receive: (from: string, text: string) =>
      handlers.get('session.receive')($, { text: env(from, text) }, next),
    render: () => handlers.get('ui.render')($, {}, next),
  };
}
const sends = (s: ReturnType<typeof setup>) =>
  s.$.session.send.mock.calls.map((c: any[]) => c[0]).filter((a: any) => a?.to);
const submits = (s: ReturnType<typeof setup>) =>
  s.$.prompt.submit.mock.calls.filter((c: any[]) => c[0]?.text);

const flush = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
};

describe('dispatch registration order (AISDLC-1064)', () => {
  it('keeps the tick registered and running when ui.open never resolves, logging each step in order', async () => {
    const s = setup();
    s.$.ui.open = vi.fn(() => new Promise(() => {}));
    await s.start();
    await flush();
    expect(s.$.clock.every).toHaveBeenCalledWith(30000, expect.any(Function));
    expect(s.runs.some((a) => a[1] === 'tick')).toBe(true);
    const log = (s.kv.get('hierarchy/log') as string[]).join('\n');
    const at = (t: string) => log.indexOf(t);
    expect(at('tick registered every 30000')).toBeGreaterThan(at('identity'));
    expect(at('first tick ran at')).toBeGreaterThan(at('tick registered'));
    expect(at('refreshPane ok')).toBeGreaterThan(-1);
    expect(log).not.toContain('ui.open ok');
    expect(s.kv.get('hierarchy/dispatch-board')).toBeTruthy();
  }, 15000);

  it('logs a rejecting store.set and still completes registration', async () => {
    const s = setup();
    s.$.store.set = async () => {
      throw new Error('disk full');
    };
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await s.start();
    await flush();
    expect(s.$.clock.every).toHaveBeenCalled();
    expect(err.mock.calls.flat().join('\n')).toContain('tick registered every');
    err.mockRestore();
  });

  it('logs a failed ui.open and a hung status call without blocking', async () => {
    const s = setup();
    s.$.ui.open = vi.fn(async () => {
      throw new Error('no pane');
    });
    await s.start();
    await flush();
    expect((s.kv.get('hierarchy/log') as string[]).join('\n')).toContain('ui.open failed no pane');
  });
});

describe('dispatch host (AISDLC-1035)', () => {
  it('arms one timer, opens the pane, and never submits a prompt over a simulated hour', async () => {
    const s = setup();
    await s.start();
    expect(s.$.clock.every).toHaveBeenCalledWith(30000, expect.any(Function));
    expect(s.$.ui.open).toHaveBeenCalledWith(expect.objectContaining({ id: 'board' }));
    // an hour of ticks at the default interval plus mixed events
    for (let i = 0; i < 120; i++) {
      await s.timer();
      if (i % 10 === 0) await s.receive('executor-alpha', 'verdict AISDLC-5 success');
      if (i % 15 === 0) await s.receive('executor-alpha', 'status idle');
      if (i % 20 === 0) await s.receive('executor-alpha', 'landed #12');
      if (i % 30 === 0) await s.receive('someone', 'planner: need a ruling');
      if (i % 40 === 0) await s.receive('someone', 'gibberish with AISDLC-3');
    }
    expect(submits(s)).toHaveLength(0);
    expect(s.runs.filter((a) => a[1] === 'tick').length).toBeGreaterThanOrEqual(120);
  });

  it('consumes a verdict, applies it with cli-dispatch and refreshes the pane', async () => {
    const s = setup();
    await s.start();
    await flush(); // AISDLC-1064: registration fires its first tick and pane refresh unawaited
    const r = await s.receive('executor-alpha', 'verdict AISDLC-5 success');
    expect(r).toEqual({ consumed: 'hierarchy:verdict' });
    expect(s.next).not.toHaveBeenCalled();
    const collect = s.runs.find(
      (a) => a[0].includes('cli-dispatch') && a[1] === 'collect-verdicts',
    );
    expect(collect).toBeTruthy();
    expect(s.runs.some((a) => a[1] === 'tick')).toBe(true);
  });

  it('consumes a PR-landed message with reconcile and a status message with a pane refresh only', async () => {
    const s = setup();
    await s.start();
    await flush(); // AISDLC-1064: registration fires its first tick and pane refresh unawaited
    expect(await s.receive('executor-alpha', 'landed #42')).toEqual({
      consumed: 'hierarchy:landed',
    });
    expect(s.runs.find((a) => a[1] === 'reconcile' && a.includes('--pr'))).toEqual(
      expect.arrayContaining(['reconcile', '--pr', '42']),
    );
    s.runs.length = 0;
    expect(await s.receive('executor-alpha', 'status idle')).toEqual({
      consumed: 'hierarchy:status',
    });
    expect(s.runs.every((a) => a[1] === 'status')).toBe(true);
    expect((await s.render()).text).toContain('status from executor-alpha');
  });

  it('forwards a planner-addressed message to the planner roster name', async () => {
    const s = setup();
    await s.start();
    expect(await s.receive('executor-beta', 'planner: which branch?')).toEqual({
      consumed: 'hierarchy:planner',
    });
    expect(sends(s)).toEqual([{ to: 'planner', text: 'from executor-beta: which branch?' }]);
    expect(s.next).not.toHaveBeenCalled();
  });

  it('writes an escalation file and sends one message for an unclassified tick result', async () => {
    const s = setup({
      ...EMPTY_TICK,
      escalations: [{ taskId: 'AISDLC-8', message: 'odd failure' }],
    });
    await s.start();
    await s.timer();
    const esc = s.runs.find((a) => a[1] === 'escalation-file')!;
    expect(esc).toEqual(
      expect.arrayContaining(['--task-id', 'AISDLC-8', '--message', 'odd failure']),
    );
    const out = sends(s);
    expect(out).toHaveLength(1);
    expect(out[0].to).toBe('planner');
    expect(out[0].text).toContain('/b/escalations/x.json');
    expect(submits(s)).toHaveLength(0);
  });

  it('escalates a tick that returns no result and a message of an unknown shape', async () => {
    const s = setup();
    await s.start();
    s.setTick(undefined);
    await s.timer();
    expect(s.runs.some((a) => a[1] === 'escalation-file' && a.includes('TICK'))).toBe(true);
    s.runs.length = 0;
    await s.receive('executor-alpha', 'what is AISDLC-3 doing');
    expect(s.runs.some((a) => a[1] === 'escalation-file' && a.includes('AISDLC-3'))).toBe(true);
  });

  it('escalates a persistent tick failure once and runs reconcile and sweep after a good tick', async () => {
    const s = setup();
    await s.start();
    await s.timer();
    expect(s.runs.some((a) => a[0].endsWith('cli-dispatch.mjs') && a[1] === 'reconcile')).toBe(
      true,
    );
    expect(s.runs.some((a) => a[0].endsWith('cli-ci.mjs') && a[1] === 'sweep')).toBe(true);
    s.setTick(undefined);
    s.runs.length = 0;
    await s.timer();
    await s.timer();
    await s.timer();
    expect(s.runs.filter((a) => a[1] === 'escalation-file')).toHaveLength(1);
  });

  it('renders roster, queue, inflight, done, failed and blockers, refreshed on tick and event', async () => {
    const s = setup({ ...EMPTY_TICK, blockers: ['gh quota low'] });
    await s.start();
    expect((await s.render()).lines).toMatchInlineSnapshot(`
      [
        "== roster ==",
        "operator-dispatch operator-dispatch busy",
        "executor executor-alpha idle",
        "executor executor-beta busy inflight AISDLC-7",
        "== queue ==",
        "queued 2",
        "== inflight ==",
        "inflight 1",
        "executor-beta: AISDLC-7",
        "== done ==",
        "done 5",
        "== failed ==",
        "failed 1",
        "== blockers ==",
        "AISDLC-9: waits for 8",
      ]
    `);
    await s.timer();
    const text = (await s.render()).text as string;
    expect(text).toContain('gh quota low');
    expect(text).toContain('== events ==');
    await s.receive('executor-alpha', 'status ok');
    expect((await s.render()).text as string).toContain('status from executor-alpha');
  });

  it('wakes one idle executor per ingested task with a single send each', async () => {
    const s = setup({ ...EMPTY_TICK, ingested: [{ file: 'b', tasks: ['AISDLC-20'] }] });
    await s.start();
    await s.timer();
    expect(sends(s)).toEqual([{ to: 'executor-alpha', text: 'enqueue AISDLC-20' }]);
  });

  it('wakes idle executors on a tick with eligible queued work and no ingest, backing off one tick (AISDLC-1089)', async () => {
    const s = setup({
      ...EMPTY_TICK,
      eligibleQueued: ['AISDLC-31', 'AISDLC-32'],
      idleExecutors: ['executor-alpha', 'executor-gamma'],
    });
    await s.start();
    await s.timer();
    expect(sends(s)).toEqual([
      { to: 'executor-alpha', text: 'enqueue AISDLC-31' },
      { to: 'executor-gamma', text: 'enqueue AISDLC-32' },
    ]);
    s.$.session.send.mockClear();
    await s.timer();
    expect(sends(s)).toEqual([]);
    await s.timer();
    expect(sends(s).map((a: any) => a.to)).toEqual(['executor-alpha', 'executor-gamma']);
  });

  it('a lifted hold clears the back-off so idle executors are woken at once (AISDLC-1089)', async () => {
    const base = {
      ...EMPTY_TICK,
      eligibleQueued: ['AISDLC-31'],
      idleExecutors: ['executor-alpha'],
    };
    const s = setup(base);
    await s.start();
    await s.timer();
    s.$.session.send.mockClear();
    s.setTick({ ...base, holdLifted: true });
    await s.timer();
    expect(sends(s)).toEqual([{ to: 'executor-alpha', text: 'enqueue AISDLC-31' }]);
  });

  it('does not wake without idle executors or while held (AISDLC-1089)', async () => {
    const s = setup({ ...EMPTY_TICK, eligibleQueued: ['AISDLC-31'], idleExecutors: [] });
    await s.start();
    await s.timer();
    expect(sends(s)).toEqual([]);
    s.setTick({
      ...EMPTY_TICK,
      held: { reason: 'x' },
      ingested: [{ file: 'b', tasks: ['AISDLC-5'] }],
      idleExecutors: ['executor-alpha'],
    });
    await s.timer();
    expect(sends(s)).toEqual([]);
  });

  it('forwards reports and a changed blocker list to the planner once', async () => {
    const s = setup({ ...EMPTY_TICK, blockers: ['b1'], reports: [{ text: 'weekly' }, 'plain'] });
    await s.start();
    await s.timer();
    await s.timer();
    const texts = sends(s).map((a: any) => a.text);
    expect(texts.filter((t: string) => t.startsWith('blockers changed'))).toHaveLength(1);
    expect(texts).toContain('weekly');
    expect(texts).toContain('plain');
  });

  it('rotates at 120k tokens', async () => {
    const s = setup();
    await s.start();
    const m = s.handlers.get('session.measure');
    await m(s.$, { contextTokens: 10 }, s.next);
    expect(s.$.command.run).not.toHaveBeenCalled();
    await m(s.$, { contextTokens: 130_000 }, s.next);
    expect(s.$.command.run).toHaveBeenCalledWith({ command: 'clear' });
  });

  it('refuses a host missing a primitive and passes through before the gate enables it', async () => {
    const t = setup();
    delete t.$.clock.every;
    await t.start();
    expect((t.kv.get('hierarchy/log') as string[]).join()).toContain('clock.every');
    const u = setup();
    await u.start();
    u.handlers.get('session.receive'); // registered once enabled
    expect(u.handlers.has('ui.render')).toBe(true);
  });

  it('keeps a slow tick from overlapping the next and survives a failed receive', async () => {
    const s = setup();
    await s.start();
    s.runs.length = 0;
    await Promise.all([s.timer(), s.timer()]);
    expect(s.runs.filter((a) => a[1] === 'tick')).toHaveLength(1);
    s.$.process.run.mockImplementation(async () => {
      throw new Error('boom');
    });
    expect(await s.receive('executor-alpha', 'landed #1')).toEqual({
      consumed: 'hierarchy:landed',
    });
  });

  it('classifies message shapes', () => {
    expect(classify('verdict AISDLC-1.2 failed')).toMatchObject({
      kind: 'verdict',
      taskId: 'AISDLC-1.2',
    });
    expect(classify('PR landed #5')).toMatchObject({ kind: 'landed', pr: '5' });
    expect(classify('to planner: hi')).toEqual({ kind: 'planner', text: 'hi' });
    expect(classify('verdict without id')).toMatchObject({ kind: 'unknown' });
    expect(renderBoard(null, [], [])).toContain('(no sessions)');
  });
});
