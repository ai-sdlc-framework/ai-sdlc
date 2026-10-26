import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { register } from '../../hooks/hierarchy/register.tsx';

// Stands in for `claude plugin validate`, which CI cannot run: the validator is static and refuses an
// event registered twice without a matcher anywhere in the module, whatever the runtime role gate does.
const DIR = join(__dirname, '../../hooks/hierarchy');

describe('hierarchy module registers each event once', () => {
  it('never registers an event twice across executor, dispatch and planner armed in turn', async () => {
    const seen: string[] = [];
    let role = 'executor';
    const handlers = new Map<string, any>();
    let open = true;
    register((event: string, a: any, b?: any) => {
      if (!open) throw new Error('on() after register() returned');
      const matcher = typeof a === 'function' ? undefined : a;
      seen.push(`${event}|${JSON.stringify(matcher ?? null)}`);
      handlers.set(event, typeof a === 'function' ? a : b);
    }, {});
    open = false;
    const stub = () => vi.fn(async () => undefined);
    const $: any = {
      env: { get: (k: string) => (k === 'HIERARCHY_ROLE' ? role : undefined) },
      session: {
        version: async () => '2.1.309',
        identity: stub(),
        compact: stub(),
        send: stub(),
        usage: stub(),
      },
      store: { get: stub(), set: stub() },
      command: { run: stub() },
      prompt: { submit: stub() },
      clock: { every: stub() },
      process: { run: stub() },
      ui: { open: stub() },
    };
    for (const r of ['executor', 'operator-dispatch', 'planner']) {
      role = r;
      await handlers.get('session.start')($, { reason: 'startup' }, async (e: any) => e);
    }
    expect(seen.length).toBeGreaterThan(1);
    expect(new Set(seen).size).toBe(seen.length);
    for (const ev of [
      'session.receive',
      'turn.start',
      'turn.complete',
      'session.measure',
      'ui.render',
    ])
      expect(seen.filter((s) => s.startsWith(`${ev}|`)).length).toBeLessThanOrEqual(1);
  });

  it('has exactly one literal on(event) call per event in the module source', () => {
    const counts = new Map<string, number>();
    for (const f of readdirSync(DIR).filter((n) => /\.tsx?$/.test(n))) {
      const src = readFileSync(join(DIR, f), 'utf8');
      for (const m of src.matchAll(/\bon\(\s*['"]([\w.]+)['"]\s*,\s*(?!\$)/g))
        counts.set(m[1], (counts.get(m[1]) ?? 0) + 1);
    }
    for (const [event, n] of counts) expect({ event, n }).toEqual({ event, n: 1 });
  });
});
