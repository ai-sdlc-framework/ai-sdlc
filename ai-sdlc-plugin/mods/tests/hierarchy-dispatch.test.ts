import { describe, expect, it, vi } from 'vitest';
import {
  classify,
  deliverRotateRequests,
  newDispatchState,
  recordSend,
  renderBoard,
} from '../../hooks/hierarchy/dispatch.ts';
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

function setup(
  tickResult: unknown = EMPTY_TICK,
  opts: { binDir?: string; tickFails?: boolean } = {},
  failSubs: Set<string> = new Set(),
) {
  const handlers = registerStrict({});
  const kv = new Map<string, any>();
  let timer: (() => Promise<void>) | undefined;
  const runs: string[][] = [];
  let tickOut: unknown = tickResult;
  let failTick = opts.tickFails === true;
  const stores: Array<[string, any]> = [];
  const argvs: string[][] = [];
  const $: any = {
    env: {
      get: (k: string) =>
        k === 'HIERARCHY_ROLE'
          ? 'operator-dispatch'
          : k === 'CLAUDE_PROJECT_DIR'
            ? '/proj'
            : undefined,
    },
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
      set: async (k: string, v: unknown) => {
        stores.push([k, v]);
        kv.set(k, v);
      },
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
        argvs.push(a);
        const sub = a[2];
        if (a[1] === '-e' && String(a[2]).includes('.binDir'))
          return { exitCode: 0, stdout: opts.binDir ?? '' };
        if (typeof sub === 'string' && failSubs.has(sub))
          return { exitCode: 1, stdout: '', stderr: `${sub} exploded\n  at x` };
        if (sub === 'tick' && failTick)
          return { exitCode: 1, stdout: '', stderr: 'Cannot find module x\n    at foo' };
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
    setFail: (v: boolean) => (failTick = v),
    failSubs,
    stores,
    argvs,
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
    // board-file writes (`node -e`, the AISDLC-1464 receipt) aside, only the pane refresh runs
    expect(s.runs.filter((a) => a[0] !== '-e').every((a) => a[1] === 'status')).toBe(true);
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

  it('names the exit code or signal and the duration of a failed tick (AISDLC-1382)', async () => {
    const s = setup();
    await s.start();
    s.setTick(undefined);
    await s.timer();
    const msg = (argv: string[]) => argv[argv.indexOf('--message') + 1];
    const empty = s.runs.find((a) => a[1] === 'escalation-file' && a.includes('TICK'))!;
    expect(msg(empty)).toMatch(
      /^cli-hierarchy tick did not return a result: no output \(exit code 0, after \d+\.\ds\)$/,
    );
    s.runs.length = 0;
    const run = s.$.process.run;
    s.$.process.run = vi.fn(async (a: string[]) =>
      a[2] === 'tick' ? { exitCode: null, signal: 'SIGKILL', stdout: '', stderr: '' } : run(a),
    );
    await s.timer();
    const killed = s.runs.find((a) => a[1] === 'escalation-file' && a.includes('TICK'));
    expect(killed).toBeUndefined(); // same failure text as the last one: not escalated again
    s.$.process.run = vi.fn(async (a: string[]) =>
      a[2] === 'tick' ? { exitCode: null, signal: 'SIGKILL', stdout: '', stderr: 'oom' } : run(a),
    );
    await s.timer();
    const oom = s.runs.find((a) => a[1] === 'escalation-file' && a.includes('TICK'))!;
    expect(msg(oom)).toMatch(/: oom \(signal SIGKILL, after \d+\.\ds\)$/);
  });

  it('classifies an executor status line with a doubled sender prefix (AISDLC-1382)', async () => {
    const s = setup();
    await s.start();
    s.runs.length = 0;
    const from = 'ai-sdlc-executor-aisdlc-1374';
    expect(await s.receive(from, `${from}: AISDLC-1374 success, PR 2919, decisions none`)).toEqual({
      consumed: 'hierarchy:verdict',
    });
    expect(s.runs.some((a) => a[1] === 'escalation-file')).toBe(false);
    expect(s.runs.some((a) => a[1] === 'collect-verdicts')).toBe(true);
    expect(classify('AISDLC-1374 failed, PR 2919')).toMatchObject({
      kind: 'verdict',
      taskId: 'AISDLC-1374',
    });
    expect(classify('AISDLC-1374 is odd')).toMatchObject({ kind: 'unknown' });
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

  describe('reconcile cadence follows webhook health (AISDLC-1379)', () => {
    const reconciles = (s: ReturnType<typeof setup>) =>
      s.runs.filter((a) => a[0].endsWith('cli-dispatch.mjs') && a[1] === 'reconcile').length;
    const sweeps = (s: ReturnType<typeof setup>) =>
      s.runs.filter((a) => a[0].endsWith('cli-ci.mjs') && a[1] === 'sweep').length;

    it('healthy with no wake: the timer skips reconcile and sweep until the slow interval passes, a newer wake runs it', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        vi.setSystemTime(new Date('2026-11-23T00:00:00Z'));
        const s = setup({ ...EMPTY_TICK, webhookGate: { class: 'healthy', wakeAtMs: 1000 } });
        await s.start();
        await flush();
        s.runs.length = 0;
        for (let i = 0; i < 10; i++) {
          vi.advanceTimersByTime(30_000);
          await s.timer();
        }
        expect(reconciles(s)).toBe(0);
        expect(sweeps(s)).toBe(0);
        s.setTick({ ...EMPTY_TICK, webhookGate: { class: 'healthy', wakeAtMs: 2000 } });
        await s.timer();
        expect(reconciles(s)).toBe(1);
        vi.advanceTimersByTime(15 * 60_000);
        await s.timer();
        expect(reconciles(s)).toBe(2);
        expect(sweeps(s)).toBe(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it('down, none, or an absent gate: reconcile runs on every timer fire', async () => {
      for (const gate of [
        { class: 'down', wakeAtMs: 1 },
        { class: 'none', wakeAtMs: null },
        undefined,
      ]) {
        const s = setup({ ...EMPTY_TICK, ...(gate ? { webhookGate: gate } : {}) });
        await s.start();
        await flush();
        s.runs.length = 0;
        await s.timer();
        await s.timer();
        await s.timer();
        expect(reconciles(s)).toBe(3);
      }
    });
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

  it('delivers a recorded rotate request through session.send once per request and records the send (AISDLC-1464)', async () => {
    const s = setup({ ...EMPTY_TICK, rotateRequests: { 'proj-planner': '2026-11-27T00:00:00Z' } });
    await s.start();
    await s.timer();
    await s.timer();
    expect(sends(s).filter((a: any) => a.text === 'rotate')).toEqual([
      { to: 'proj-planner', text: 'rotate' },
    ]);
    // the send record `cli-hierarchy status` compares with the receiver's receipt
    const record = s.argvs.find(
      (a) =>
        a[1] === '-e' &&
        String(a[3]).endsWith('/proj/.ai-sdlc/dispatch/handoff/sent-proj-planner.json'),
    );
    expect(JSON.parse(String(record?.[4]))).toMatchObject({
      to: 'proj-planner',
      text: 'rotate',
      ok: true,
    });
    // a newer request for the same session is delivered again
    s.setTick({ ...EMPTY_TICK, rotateRequests: { 'proj-planner': '2026-11-27T01:00:00Z' } });
    await s.timer();
    expect(sends(s).filter((a: any) => a.text === 'rotate')).toHaveLength(2);
  });

  it('retries a refused rotate request on the next tick and ignores a malformed list (AISDLC-1464)', async () => {
    const s = setup({ ...EMPTY_TICK, rotateRequests: { 'proj-planner': 'x', bad: 7 } });
    await s.start();
    s.$.session.send.mockImplementationOnce(async () => ({ drop: 'busy' }));
    await s.timer();
    await s.timer();
    expect(sends(s).filter((a: any) => a.text === 'rotate')).toHaveLength(2);
    expect(sends(s).some((a: any) => a.to === 'bad')).toBe(false);
  });

  it('never sends rotate to its own session, and records no send for an unsafe name (AISDLC-1464)', async () => {
    const send = vi.fn(async () => undefined);
    const runProcess = vi.fn(async () => ({ exitCode: 0, stdout: '' }));
    const p: any = {
      send,
      runProcess,
      storeGet: async () => undefined,
      storeSet: async () => undefined,
      runCommand: async () => undefined,
      uiOpen: async () => undefined,
    };
    const state = {
      ...newDispatchState({ boardDir: '/b' }),
      sessionName: 'proj-operator-dispatch',
    };
    await deliverRotateRequests(p, state, { 'proj-operator-dispatch': 'x', 'proj-planner': 'y' });
    expect(send.mock.calls).toEqual([[{ to: 'proj-planner', text: 'rotate' }]]);
    runProcess.mockClear();
    await recordSend(p, state, '../x', 'rotate', true);
    expect(runProcess).not.toHaveBeenCalled();
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

describe('reconcile and sweep failures reach the heartbeat (AISDLC-1357)', () => {
  const lastHealth = (s: ReturnType<typeof setup>): any =>
    s.stores.filter(([k]) => k.startsWith('hierarchy/health/')).at(-1)?.[1];

  it('records each failure with its first error line and a later success clears it', async () => {
    const s = setup();
    await s.start();
    s.failSubs.add('reconcile');
    await s.timer();
    expect(lastHealth(s)).toMatchObject({
      state: 'failing',
      reason: 'reconcile failed: reconcile exploded',
    });
    s.failSubs.clear();
    s.failSubs.add('sweep');
    await s.timer();
    expect(lastHealth(s)).toMatchObject({
      state: 'failing',
      reason: 'cli-ci sweep failed: sweep exploded',
    });
    s.failSubs.clear();
    await s.timer();
    expect(lastHealth(s).state).toBe('loaded');
  });
});

describe('heartbeat reports the last tick result (AISDLC-1358)', () => {
  const healths = (s: ReturnType<typeof setup>) =>
    s.stores.filter(([k]) => k.startsWith('hierarchy/health/')).map(([, v]) => v);
  const lastHealth = (s: ReturnType<typeof setup>) => healths(s).at(-1);

  it('a failing tick writes no loaded record before it and writes failing with the first error line', async () => {
    const s = setup(EMPTY_TICK, { tickFails: true });
    await s.start();
    const before = healths(s).length;
    await s.timer();
    const after = healths(s).slice(before);
    expect(after.map((h: any) => h.state)).toEqual(['failing']);
    expect(after[0].reason).toBe('Cannot find module x');
  });

  it('a tick that returns a result writes loaded; a later failure replaces it with failing', async () => {
    const s = setup();
    await s.start();
    await s.timer();
    expect(lastHealth(s).state).toBe('loaded');
    s.setFail(true);
    await s.timer();
    expect(lastHealth(s)).toMatchObject({ state: 'failing', reason: 'Cannot find module x' });
  });

  it('runs the bins from the directory recorded in cli-bin.json', async () => {
    const s = setup(EMPTY_TICK, { binDir: '/inst/pipeline-cli/bin' });
    await s.start();
    await s.timer();
    const tickRun = s.argvs.filter((a) => a[2] === 'tick').at(-1);
    expect(tickRun?.[1]).toBe('/inst/pipeline-cli/bin/cli-hierarchy.mjs');
    expect(lastHealth(s).state).toBe('loaded');
  });

  it('keeps the repository-relative bin path with no record', async () => {
    const s = setup();
    await s.start();
    await s.timer();
    expect(s.argvs.some((a) => a[1] === 'pipeline-cli/bin/cli-hierarchy.mjs')).toBe(true);
  });
});
