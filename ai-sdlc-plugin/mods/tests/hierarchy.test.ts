import { describe, expect, it, vi } from 'vitest';
import {
  IDLE_MARKER,
  ROTATION_KEY,
  VERDICT_MARKER,
  VERSION_FLOOR,
  atLeast,
  innerText,
  measuredTokens,
  senderOf,
} from '../../hooks/hierarchy/executor.ts';
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
        k === 'HIERARCHY_ROLE' ? (over.role === undefined ? 'executor' : over.role) : undefined,
    },
    session: {
      version: async () => over.version ?? '2.1.309',
      identity: async () => over.identity ?? null,
      compact: vi.fn(async () => result('compact')),
      send: vi.fn(),
      usage: vi.fn(),
    },
    store: {
      get: async (k: string) => kv.get(k),
      set: async (k: string, v: unknown) => void kv.set(k, v),
    },
    command: {
      run: vi.fn(async (a: any) => result(a.command)),
    },
    prompt: { submit: vi.fn(async () => result('submit')) },
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
// The gate probes each primitive with an empty payload; assertions look only at real calls.
const ran = (s: ReturnType<typeof setup>) =>
  s.$.command.run.mock.calls.map((c: any[]) => c[0].command).filter(Boolean);
const submits = (s: ReturnType<typeof setup>) =>
  s.$.prompt.submit.mock.calls.filter((c: any[]) => c[0].text);
const compacts = (s: ReturnType<typeof setup>) =>
  s.$.session.compact.mock.calls.filter((c: any[]) => c[0].instructions);

describe('hierarchy module: gate', () => {
  it('registers only the session.start gate and nothing else without a role', async () => {
    const s = setup({ role: null });
    await s.start();
    expect([...s.handlers.keys()]).toEqual(['session.start']);
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

  it('records a user tier without identity, and registers nothing for another role', async () => {
    const s = setup({ role: 'planner' });
    await s.start();
    expect(logOf(s.kv)[0]).toContain('tier=user identity=none');
    expect([...s.handlers.keys()]).toEqual(['session.start']);
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

  it('reads the role from the launcher env name, or the module option', async () => {
    const s = setup({ role: null });
    s.$.env = { get: (k: string) => (k === 'AI_SDLC_HIERARCHY_ROLE' ? 'executor' : undefined) };
    await s.start();
    expect(s.handlers.has('turn.start')).toBe(true);
  });

  it('takes the role from the module option, or from the role carried across a clear', async () => {
    const a = setup({ role: null });
    const handlers = new Map<string, any>();
    register((n: string, h: any) => handlers.set(n, h), { role: 'executor' });
    await handlers.get('session.start')(a.$, {}, a.next);
    expect(handlers.has('turn.complete')).toBe(true);
    const b = setup({ role: null });
    b.kv.set(ROTATION_KEY, { role: 'executor', resume: '/ai-sdlc:executor', lastReply: 'r' });
    await b.start();
    expect(b.handlers.has('turn.complete')).toBe(true);
    expect(submits(b)).toEqual([[{ text: '/ai-sdlc:executor' }]]);
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
    expect(submits(s)).toEqual([[{ text: '/ai-sdlc:executor' }]]);
    // a second enqueue while the task runs is consumed without another submit
    await recv(s.$, { text: env('proj-operator-dispatch', 'enqueue AISDLC-2') }, s.next);
    expect(submits(s)).toHaveLength(1);
  });

  it('logs a refused wake, consumes status noise, passes everything else through', async () => {
    const s = setup();
    await s.start();
    const recv = s.handlers.get('session.receive');
    s.$.prompt.submit.mockResolvedValueOnce({ drop: 'busy' });
    await recv(s.$, { text: env('proj-operator-dispatch', 'enqueue x') }, s.next);
    expect(logOf(s.kv).some((l) => l.includes('wake refused'))).toBe(true);
    expect(await recv(s.$, { text: env('proj-operator-dispatch', 'status ok') }, s.next)).toEqual({
      consumed: 'hierarchy:status',
    });
    const other = { text: env('proj-operator-dispatch', 'please look at this') };
    expect(await recv(s.$, other, s.next)).toBe(other);
    const stranger = { text: env('someone-else', 'enqueue x') };
    expect(await recv(s.$, stranger, s.next)).toBe(stranger);
    expect(submits(s)).toHaveLength(1);
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
    expect(s.kv.get(ROTATION_KEY)).toEqual({
      role: 'executor',
      resume: '/ai-sdlc:executor',
      lastReply: `done\n${VERDICT_MARKER}`,
    });
    // the next session.start (after the clear) resumes the loop and empties the carried state
    await s.start();
    expect(submits(s)).toEqual([[{ text: '/ai-sdlc:executor' }]]);
    expect(s.kv.get(ROTATION_KEY)).toBeNull();
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
