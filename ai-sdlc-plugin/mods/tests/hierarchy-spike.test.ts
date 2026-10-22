import { afterEach, describe, expect, it, vi } from 'vitest';
import { register, STORE_LOG_KEY } from '../../hooks/hierarchy-spike/hooks/register.ts';

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
  afterEach(() => {
    delete process.env.AI_SDLC_HIERARCHY_SPIKE;
  });

  it('registers nothing without the env guard', () => {
    expect(setup().handlers.size).toBe(0);
  });

  it('logs hooks, consumes, and runs the clear then ping sequence', async () => {
    process.env.AI_SDLC_HIERARCHY_SPIKE = '1';
    const { handlers, $, next, kv } = setup();
    const recv = handlers.get('session.receive');
    expect(await recv($, { text: 'hier:consume' }, next)).toEqual({ consumed: true });
    expect(await recv($, { text: 'hello' }, next)).toEqual({ text: 'hello' });
    await recv($, { text: 'hier:run clear' }, next);
    await recv($, { text: 'hier:run compact' }, next);
    expect(kv.get('hierarchy-spike/marker')).toBe('written-before-compact');
    await handlers.get('session.start')($, { reason: 'clear' }, next);
    expect($.prompt.submit).toHaveBeenCalledWith({ text: '/hier-ping' });
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
});
