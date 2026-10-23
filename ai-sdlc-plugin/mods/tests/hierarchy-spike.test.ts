import { describe, expect, it, vi } from 'vitest';
import { innerText, register, STORE_LOG_KEY } from '../../hooks/hierarchy-spike/hooks/register.ts';

function setup() {
  const handlers = new Map<string, any>();
  register((n: string, h: any) => handlers.set(n, h));
  const kv = new Map<string, any>();
  const $ = {
    session: { id: async () => 's1', compact: vi.fn(async () => ({ drop: 'busy' })) },
    store: {
      get: async (k: string) => kv.get(k),
      set: async (k: string, v: unknown) => void kv.set(k, v),
    },
    command: { run: vi.fn(async () => ({ drop: 'unsupported' })) },
    prompt: { submit: vi.fn(async () => undefined) },
  };
  return { handlers, $, kv, next: vi.fn(async (e: unknown) => e) };
}

describe('hierarchy-spike', () => {
  it('registers all six handlers without touching process', () => {
    expect([...setup().handlers.keys()].sort()).toEqual([
      'session.end',
      'session.measure',
      'session.receive',
      'session.start',
      'turn.complete',
      'turn.start',
    ]);
  });

  it('logs hooks, consumes, and runs the clear then ping sequence', async () => {
    const { handlers, $, next, kv } = setup();
    const recv = handlers.get('session.receive');
    expect(await recv($, { text: 'hier:consume' }, next)).toEqual({ consumed: 'hier:consume' });
    expect(await recv($, { text: 'hello' }, next)).toEqual({ text: 'hello' });
    await recv($, { text: 'hier:run clear' }, next);
    await recv($, { text: 'hier:run compact' }, next);
    expect(kv.get('hierarchy-spike/marker')).toBe('written-before-compact');
    await handlers.get('session.start')($, { reason: 'clear' }, next);
    expect($.prompt.submit).toHaveBeenCalledWith({ text: '/hierarchy-spike:hier-ping' });
    for (const n of ['turn.start', 'turn.complete', 'session.measure', 'session.end']) {
      await handlers.get(n)($, {}, next);
    }
    const lines = (kv.get(STORE_LOG_KEY) as string[]).map((l) => JSON.parse(l));
    expect(lines.map((l) => l.event)).toContain('session.receive.consumed');
    expect(lines.find((l) => l.event === 'clear.result')).toMatchObject({
      ran: false,
      drop: 'unsupported',
    });
  });

  it('matches commands on the inner text of the real cross-session envelope', async () => {
    const env = (t: string) =>
      `<cross-session-message from="alpha" id="1"><\\agent-message from="beta" kind="text">${t}<\\/agent-message></cross-session-message>`;
    const plain = (t: string) =>
      `<cross-session-message from="alpha" id="1"><agent-message kind="text">${t}</agent-message></cross-session-message>`;
    expect(innerText(env('hier:consume 1'))).toBe('hier:consume 1');
    expect(innerText(plain('hier:consume 1'))).toBe('hier:consume 1');
    const cases: [string, string][] = [
      ['hier:consume 1', 'hier:consume'],
      ['hier:dump', 'hier:dump'],
      ['hier:run clear', 'hier:clear'],
      ['hier:run compact', 'hier:compact'],
    ];
    for (const wrap of [env, plain]) {
      for (const [cmd, consumed] of cases) {
        const { handlers, $, next } = setup();
        const recv = handlers.get('session.receive');
        expect(await recv($, { text: wrap(cmd) }, next)).toEqual({ consumed });
      }
    }
    const { handlers, $, next, kv } = setup();
    const raw = env('hello');
    await handlers.get('session.receive')($, { text: raw }, next);
    expect((kv.get(STORE_LOG_KEY) as string[])[0]).toContain('cross-session-message');
  });

  it('hier:dump submits the log, and records a refused submit', async () => {
    const { handlers, $, next, kv } = setup();
    const recv = handlers.get('session.receive');
    expect(await recv($, { text: 'hier:dump' }, next)).toEqual({ consumed: 'hier:dump' });
    expect($.prompt.submit).toHaveBeenCalledTimes(1);
    expect(($.prompt.submit.mock.calls[0] as any)[0].text).toContain('session.receive');
    $.prompt.submit.mockResolvedValueOnce({ drop: 'busy' } as any);
    await recv($, { text: 'hier:dump' }, next);
    $.prompt.submit.mockRejectedValueOnce(new Error('boom'));
    await recv($, { text: 'hier:dump' }, next);
    const dumps = (kv.get(STORE_LOG_KEY) as string[])
      .map((l) => JSON.parse(l))
      .filter((l) => l.event === 'dump');
    expect(dumps).toMatchObject([
      { ran: true },
      { ran: false, drop: 'busy' },
      { ran: false, threw: 'boom' },
    ]);
  });

  it('records the pending ping outcome and tolerates thrown host calls', async () => {
    const { handlers, $, next, kv } = setup();
    $.command.run.mockRejectedValueOnce(new Error('no clear'));
    $.session.id = async () => {
      throw new Error('no id');
    };
    await handlers.get('session.receive')($, { text: 'hier:run clear' }, next);
    $.prompt.submit.mockResolvedValueOnce({ drop: 'busy' } as any);
    await handlers.get('session.start')($, undefined, next);
    const lines = (kv.get(STORE_LOG_KEY) as string[]).map((l) => JSON.parse(l));
    expect(lines.find((l) => l.event === 'clear.result')).toMatchObject({ threw: 'no clear' });
    expect(lines.find((l) => l.event === 'session.start')).toMatchObject({ sessionId: null });
    expect(lines.find((l) => l.event === 'prompt.submit')).toMatchObject({
      after: 'clear',
      drop: 'busy',
    });
    expect(kv.get('hierarchy-spike/pending')).toBeNull();
  });
});
