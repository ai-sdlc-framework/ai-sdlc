import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ACTIVE_STALE_MS,
  IDLE_MARKER,
  RESUME_COMMAND,
  ROTATION_TTL_MS,
  ROTATION_KEY,
  VERDICT_MARKER,
  VERSION_FLOOR,
  atLeast,
  innerText,
  measuredTokens,
  senderOf,
} from '../../hooks/hierarchy/executor.ts';
import {
  PLANNER_RESUME_COMMAND,
  PLANNER_ROTATE_AT_TOKENS,
  lastReplyKey,
} from '../../hooks/hierarchy/planner.ts';
import { register } from '../../hooks/hierarchy/register.tsx';

const env = (from: string, text: string) =>
  `<cross-session-message from="${from}" id="1"><agent-message kind="text">${text}</agent-message></cross-session-message>`;

function setup(
  over: {
    role?: string | null;
    version?: string;
    drop?: string[];
    omit?: string;
    identity?: unknown;
    name?: string;
  } = {},
) {
  const handlers = new Map<string, any>();
  register((n: string, h: any) => handlers.set(n, h), {});
  const kv = new Map<string, any>();
  const drop = new Set(over.drop ?? []);
  const result = (name: string) => (drop.has(name) ? { drop: 'busy' } : undefined);
  const $: any = {
    env: {
      get: (k: string) =>
        k === 'HIERARCHY_ROLE'
          ? over.role === undefined
            ? 'executor'
            : over.role
          : k === 'AI_SDLC_HIERARCHY_SESSION'
            ? over.name
            : undefined,
    },
    session: {
      version: async () => over.version ?? '2.1.309',
      identity: async () => over.identity ?? null,
      // like a typed host boundary: a payload without the field is rejected before any action
      compact: vi.fn(async (a: any) => {
        if (typeof a?.instructions !== 'string') throw new Error('compact: instructions required');
        return result('compact');
      }),
      send: vi.fn(),
      usage: vi.fn(),
    },
    store: {
      get: async (k: string) => kv.get(k),
      set: async (k: string, v: unknown) => void kv.set(k, v),
    },
    command: {
      run: vi.fn(async (a: any) => {
        if (typeof a?.command !== 'string') throw new Error('command.run: command required');
        return result(a.command);
      }),
    },
    prompt: {
      submit: vi.fn(async (a: any) => {
        if (typeof a?.text !== 'string') throw new Error('prompt.submit: text required');
        return result('submit');
      }),
    },
  };
  if (over.omit) {
    const [a, b] = over.omit.split('.');
    delete $[a][b];
  }
  const next = vi.fn(async (e: unknown) => e);
  const start = () => handlers.get('session.start')($, { reason: 'startup' }, next);
  return { handlers, $, kv, next, start };
}

const logOf = (kv: Map<string, any>) => (kv.get('hierarchy/log') as string[]) ?? [];
// The gate probes each primitive with a bare string (rejected by the host); assertions look only at real calls.
const ran = (s: ReturnType<typeof setup>) =>
  s.$.command.run.mock.calls.map((c: any[]) => c[0]?.command).filter(Boolean);
const submits = (s: ReturnType<typeof setup>) =>
  s.$.prompt.submit.mock.calls.filter((c: any[]) => c[0]?.text);
const compacts = (s: ReturnType<typeof setup>) =>
  s.$.session.compact.mock.calls.filter((c: any[]) => c[0]?.instructions);

afterEach(() => vi.useRealTimers());

describe('hierarchy module: gate', () => {
  it('registers only the session.start gate and nothing else without a role', async () => {
    const s = setup({ role: null });
    await s.start();
    expect([...s.handlers.keys()]).toEqual(['session.start']);
    for (const h of ['turn.start', 'session.receive', 'turn.complete', 'session.measure'])
      expect(s.handlers.has(h)).toBe(false);
    expect(logOf(s.kv)).toEqual([]);
    expect(s.next).toHaveBeenCalled();
  });

  it('registers the executor hooks once and logs role, tier and identity', async () => {
    const s = setup({ identity: { user: 'dl' } });
    await s.start();
    await s.start();
    expect([...s.handlers.keys()].sort()).toEqual([
      'session.measure',
      'session.receive',
      'session.start',
      'turn.complete',
      'turn.start',
    ]);
    expect(logOf(s.kv)[0]).toContain('role=executor tier=managed');
  });

  it('records a user tier without identity for the dispatch role', async () => {
    const s = setup({ role: 'operator-dispatch' });
    await s.start();
    expect(logOf(s.kv)[0]).toContain('tier=user identity=none');
  });

  it('refuses below the version floor and names it', async () => {
    const s = setup({ version: '2.1.300' });
    await s.start();
    expect([...s.handlers.keys()]).toEqual(['session.start']);
    expect(logOf(s.kv)).toHaveLength(1);
    expect(logOf(s.kv)[0]).toContain(`floor ${VERSION_FLOOR}`);
  });

  it.each(['prompt.submit', 'command.run', 'session.compact', 'session.usage', 'session.send'])(
    'refuses and names the missing primitive %s',
    async (omit) => {
      const s = setup({ omit });
      await s.start();
      expect([...s.handlers.keys()]).toEqual(['session.start']);
      const want = omit === 'session.usage' ? 'session.measure' : omit;
      expect(logOf(s.kv)[0]).toContain(`primitive ${want} is missing`);
      expect(logOf(s.kv)[0]).toContain(VERSION_FLOOR);
    },
  );

  it('probes without acting: a host that rejects the probe still registers, nothing compacts or submits', async () => {
    const s = setup();
    await s.start();
    expect(s.handlers.has('turn.complete')).toBe(true);
    expect(compacts(s)).toEqual([]);
    expect(submits(s)).toEqual([]);
    expect(ran(s)).toEqual([]);
  });

  it('reads the role from the launcher env name, or the module option', async () => {
    const s = setup({ role: null });
    s.$.env = { get: (k: string) => (k === 'AI_SDLC_HIERARCHY_ROLE' ? 'executor' : undefined) };
    await s.start();
    expect(s.handlers.has('turn.start')).toBe(true);
  });

  it('takes the role from the module option, never from a record carried in the store', async () => {
    const a = setup({ role: null });
    const handlers = new Map<string, any>();
    register((n: string, h: any) => handlers.set(n, h), { role: 'executor' });
    await handlers.get('session.start')(a.$, {}, a.next);
    expect(handlers.has('turn.complete')).toBe(true);
    const b = setup({ role: null });
    b.kv.set(ROTATION_KEY, {
      role: 'executor',
      resume: RESUME_COMMAND,
      lastReply: 'r',
      at: Date.now(),
    });
    await b.start();
    expect([...b.handlers.keys()]).toEqual(['session.start']);
    expect(b.kv.get(ROTATION_KEY)).toBeNull();
    expect(ran(b)).toEqual([]);
  });

  it('helpers parse versions, envelopes and measures', () => {
    expect(atLeast('v2.2.0', '2.1.307')).toBe(true);
    expect(atLeast('2.1.307', '2.1.307')).toBe(true);
    expect(atLeast('garbage', '2.1.307')).toBe(false);
    expect(senderOf(env('proj-operator-dispatch', 'x'))).toBe('proj-operator-dispatch');
    expect(senderOf('plain')).toBe('');
    expect(innerText(env('a', ' hi '))).toBe('hi');
    expect(measuredTokens({ tokens: 5 })).toBe(5);
    expect(measuredTokens({ usage: { input: 1, cacheRead: 2, output: 3 } })).toBe(6);
    expect(measuredTokens(undefined)).toBe(0);
  });
});

describe('hierarchy module: executor wake', () => {
  it('consumes an enqueue from dispatch and starts the executor command', async () => {
    const s = setup();
    await s.start();
    const recv = s.handlers.get('session.receive');
    const r = await recv(s.$, { text: env('proj-operator-dispatch', 'enqueue AISDLC-1') }, s.next);
    expect(r).toEqual({ consumed: 'hierarchy:enqueue' });
    expect(ran(s)).toEqual([RESUME_COMMAND]);
    // a second enqueue while the task runs is consumed without another submit
    await recv(s.$, { text: env('proj-operator-dispatch', 'enqueue AISDLC-2') }, s.next);
    expect(ran(s)).toHaveLength(1);
    expect(submits(s)).toEqual([]);
  });

  it('a task with no activity for a while no longer mutes wakes', async () => {
    vi.useFakeTimers();
    const s = setup();
    await s.start();
    const recv = s.handlers.get('session.receive');
    await recv(s.$, { text: env('proj-operator-dispatch', 'enqueue 1') }, s.next);
    vi.setSystemTime(Date.now() + ACTIVE_STALE_MS + 1000);
    await recv(s.$, { text: env('proj-operator-dispatch', 'enqueue 2') }, s.next);
    expect(ran(s)).toEqual([RESUME_COMMAND, RESUME_COMMAND]);
  });

  it('logs a refused wake, consumes status noise, passes everything else through', async () => {
    const s = setup();
    await s.start();
    const recv = s.handlers.get('session.receive');
    s.$.command.run.mockResolvedValueOnce({ drop: 'busy' });
    await recv(s.$, { text: env('proj-operator-dispatch', 'enqueue x') }, s.next);
    expect(logOf(s.kv).some((l) => l.includes('wake refused'))).toBe(true);
    expect(await recv(s.$, { text: env('proj-operator-dispatch', 'status ok') }, s.next)).toEqual({
      consumed: 'hierarchy:status',
    });
    const other = { text: env('proj-operator-dispatch', 'please look at this') };
    expect(await recv(s.$, other, s.next)).toBe(other);
    const stranger = { text: env('someone-else', 'enqueue x') };
    expect(await recv(s.$, stranger, s.next)).toBe(stranger);
    expect(ran(s)).toHaveLength(1);
  });
});

describe('hierarchy module: rotation', () => {
  async function verdict(s: ReturnType<typeof setup>) {
    await s.start();
    await s.handlers.get('turn.start')(s.$, {}, s.next);
    await s.handlers.get('turn.complete')(s.$, { text: `done\n${VERDICT_MARKER}` }, s.next);
  }

  it('writes the handoff, then clears with role, resume command and last reply in the store', async () => {
    const s = setup();
    await verdict(s);
    expect(ran(s)).toEqual(['ai-sdlc:hierarchy', 'clear']);
    expect(s.kv.get(ROTATION_KEY)).toMatchObject({
      role: 'executor',
      resume: RESUME_COMMAND,
      lastReply: `done\n${VERDICT_MARKER}`,
    });
    expect(s.kv.get(ROTATION_KEY)).toMatchObject({ resume: RESUME_COMMAND });
  });

  it('resumes from the first hook of the new session, since session.start does not fire after a clear', async () => {
    const s = setup();
    await verdict(s);
    await s.handlers.get('session.measure')(s.$, { tokens: 10 }, s.next);
    expect(ran(s)).toEqual(['ai-sdlc:hierarchy', 'clear', RESUME_COMMAND]);
    expect(submits(s)).toEqual([]);
    expect(s.kv.get(ROTATION_KEY)).toBeNull();
    // run once only
    await s.handlers.get('turn.start')(s.$, {}, s.next);
    expect(ran(s)).toHaveLength(3);
  });

  it('does not resume from a stale record, and session.start clears a stale one', async () => {
    vi.useFakeTimers();
    const s = setup();
    await verdict(s);
    vi.setSystemTime(Date.now() + ROTATION_TTL_MS + 1000);
    await s.handlers.get('turn.start')(s.$, {}, s.next);
    expect(ran(s)).toEqual(['ai-sdlc:hierarchy', 'clear']);
    const t = setup();
    t.kv.set(ROTATION_KEY, { role: 'executor', resume: RESUME_COMMAND, at: Date.now() });
    await t.start();
    expect(t.kv.get(ROTATION_KEY)).toBeNull();
    expect(ran(t)).toEqual([]);
  });

  it('does not rotate on a verdict marker quoted mid-reply', async () => {
    const s = setup();
    await s.start();
    await s.handlers.get('turn.start')(s.$, {}, s.next);
    await s.handlers.get('turn.complete')(s.$, { text: `${VERDICT_MARKER}\nmore work` }, s.next);
    expect(ran(s)).toEqual([]);
  });

  it('compacts with the hierarchy summary prompt when clear is dropped', async () => {
    const s = setup({ drop: ['clear'] });
    await verdict(s);
    expect(compacts(s)).toHaveLength(1);
    expect(compacts(s)[0][0].instructions).toContain('hierarchy executor');
    expect(ran(s)).not.toContain('exit');
    expect(s.kv.get(ROTATION_KEY)).toBeNull();
  });

  it('ends the session on a second failure, also when the calls throw', async () => {
    const s = setup({ drop: ['clear'] });
    s.$.session.compact.mockRejectedValue(new Error('boom'));
    await verdict(s);
    expect(ran(s)).toEqual(['ai-sdlc:hierarchy', 'clear', 'exit']);
    expect(logOf(s.kv).some((l) => l.includes('ending the session'))).toBe(true);
  });

  it('never rotates mid-task: a measure over the threshold waits for the last turn', async () => {
    const s = setup();
    await s.start();
    await s.handlers.get('turn.start')(s.$, {}, s.next);
    await s.handlers.get('turn.start')(s.$, { agentId: 'sub' }, s.next);
    await s.handlers.get('session.measure')(s.$, { tokens: 130_000 }, s.next);
    expect(ran(s)).toEqual([]);
    await s.handlers.get('turn.complete')(s.$, { agentId: 'sub', text: VERDICT_MARKER }, s.next);
    await s.handlers.get('turn.complete')(s.$, { text: 'still working' }, s.next);
    expect(ran(s)).toEqual([]);
    await s.handlers.get('turn.complete')(s.$, { text: `x\n${VERDICT_MARKER}` }, s.next);
    expect(ran(s)).toContain('clear');
  });

  it('rotates at once on a measure over the threshold when idle, and ignores a small one', async () => {
    const s = setup();
    await s.start();
    await s.handlers.get('session.measure')(s.$, { tokens: 1000 }, s.next);
    expect(ran(s)).toEqual([]);
    await s.handlers.get('session.measure')(s.$, { tokens: 120_000 }, s.next);
    expect(ran(s)).toContain('clear');
  });

  it('rotates after an idle marker when a measure was pending, and logs a refused handoff', async () => {
    const s = setup({ drop: ['ai-sdlc:hierarchy'] });
    await s.start();
    await s.handlers.get('turn.start')(s.$, {}, s.next);
    await s.handlers.get('session.measure')(s.$, { tokens: 200_000 }, s.next);
    await s.handlers.get('turn.complete')(s.$, { reply: IDLE_MARKER }, s.next);
    expect(ran(s)).toContain('clear');
    expect(logOf(s.kv).some((l) => l.includes('handoff write was refused'))).toBe(true);
  });
});

describe('hierarchy module: planner role (AISDLC-1036)', () => {
  const planner = () => setup({ role: 'planner', name: 'proj-planner' });
  const handoffs = (s: ReturnType<typeof setup>) =>
    s.$.command.run.mock.calls
      .map((c: any[]) => c[0])
      .filter((a: any) => a?.command === 'ai-sdlc:hierarchy');

  it('registers the planner hooks and nothing for the executor wake', async () => {
    const s = planner();
    await s.start();
    for (const h of ['turn.start', 'session.receive', 'turn.complete', 'session.measure'])
      expect(s.handlers.has(h)).toBe(true);
    expect(logOf(s.kv)[0]).toContain('role=planner');
  });

  it('at 150k writes the planner handoff, clears, and shows the stored last reply after the clear', async () => {
    const s = planner();
    await s.start();
    await s.handlers.get('turn.start')(s.$, {}, s.next);
    await s.handlers.get('turn.complete')(s.$, { text: 'ruling recorded' }, s.next);
    expect(s.kv.get(lastReplyKey('proj-planner'))).toBe('ruling recorded');
    expect(ran(s)).toEqual([]);
    await s.handlers.get('session.measure')(s.$, { tokens: PLANNER_ROTATE_AT_TOKENS }, s.next);
    expect(handoffs(s)).toEqual([
      { command: 'ai-sdlc:hierarchy', args: 'handoff write --role planner' },
    ]);
    expect(ran(s)).toEqual(['ai-sdlc:hierarchy', 'clear']);
    expect(s.kv.get(ROTATION_KEY)).toMatchObject({
      role: 'planner',
      resume: PLANNER_RESUME_COMMAND,
    });
    // the new session: the resume command receives the stored reply, which is still readable
    await s.handlers.get('turn.start')(s.$, {}, s.next);
    expect(s.$.command.run).toHaveBeenLastCalledWith({
      command: PLANNER_RESUME_COMMAND,
      args: 'last-reply: ruling recorded',
    });
    expect(s.kv.get(lastReplyKey('proj-planner'))).toBe('ruling recorded');
  });

  it('never rotates mid-turn: a measure during a turn waits for turn.complete', async () => {
    const s = planner();
    await s.start();
    await s.handlers.get('turn.start')(s.$, {}, s.next);
    await s.handlers.get('session.measure')(s.$, { tokens: 200_000 }, s.next);
    expect(ran(s)).toEqual([]);
    // a subagent's turn does not end the main thread's turn
    await s.handlers.get('turn.complete')(s.$, { agentId: 'a1', text: 'x' }, s.next);
    expect(ran(s)).toEqual([]);
    await s.handlers.get('turn.complete')(s.$, { text: 'final' }, s.next);
    expect(ran(s)).toEqual(['ai-sdlc:hierarchy', 'clear']);
  });

  it('a turn whose turn.complete never fired stops deferring rotation after the stale bound', async () => {
    vi.useFakeTimers();
    const s = planner();
    await s.start();
    await s.handlers.get('turn.start')(s.$, {}, s.next);
    await s.handlers.get('session.measure')(s.$, { tokens: 200_000 }, s.next);
    expect(ran(s)).toEqual([]);
    vi.setSystemTime(Date.now() + ACTIVE_STALE_MS + 1000);
    await s.handlers.get('session.measure')(s.$, { tokens: 200_000 }, s.next);
    expect(ran(s)).toEqual(['ai-sdlc:hierarchy', 'clear']);
  });

  it('ignores a measure under the threshold', async () => {
    const s = planner();
    await s.start();
    await s.handlers.get('session.measure')(s.$, { tokens: 1000 }, s.next);
    expect(ran(s)).toEqual([]);
  });

  it('falls back to compact, then ends the session, through the shared rotation', async () => {
    const s = setup({ role: 'planner', name: 'proj-planner', drop: ['clear'] });
    await s.start();
    await s.handlers.get('session.measure')(s.$, { tokens: 200_000 }, s.next);
    expect(compacts(s)).toHaveLength(1);
    expect(compacts(s)[0][0].instructions).toContain('planner');
    const t = setup({ role: 'planner', drop: ['clear', 'compact'] });
    await t.start();
    await t.handlers.get('session.measure')(t.$, { tokens: 200_000 }, t.next);
    expect(ran(t)).toEqual(['ai-sdlc:hierarchy', 'clear', 'exit']);
  });

  it('passes rulings and escalations through unchanged and consumes status noise from dispatch', async () => {
    const s = planner();
    await s.start();
    const recv = (from: string, text: string) =>
      s.handlers.get('session.receive')(s.$, { text: env(from, text) }, s.next);
    const ruling = env(
      'proj-operator-dispatch',
      'escalation: .ai-sdlc/dispatch/escalations/DEC-1.md',
    );
    const out = await s.handlers.get('session.receive')(s.$, { text: ruling }, s.next);
    expect(out).toEqual({ text: ruling });
    const r2 = await recv('proj-operator-dispatch', 'ruling needed: DEC-0300');
    expect(r2.text).toContain('ruling needed: DEC-0300');
    expect(await recv('proj-operator-dispatch', 'status: tick 4 idle')).toEqual({
      consumed: 'hierarchy:status',
    });
    expect(await recv('proj-operator-dispatch', 'ack')).toEqual({ consumed: 'hierarchy:status' });
    // status text from anyone else is not noise
    expect((await recv('someone-else', 'status: urgent')).text).toContain('status: urgent');
  });

  it('a receive failure never swallows the message', async () => {
    const s = planner();
    await s.start();
    s.$.store.get = async () => {
      throw new Error('boom');
    };
    const out = await s.handlers.get('session.receive')(s.$, { text: 'plain' }, s.next);
    expect(out).toEqual({ text: 'plain' });
  });
});
