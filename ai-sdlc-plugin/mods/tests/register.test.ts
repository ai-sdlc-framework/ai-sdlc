import { beforeEach, describe, expect, it, vi } from 'vitest';
import { register } from '../context-meter/hooks/register.tsx';
import type { El } from './stubs/jsx-runtime.ts';

type Handler = (...args: any[]) => Promise<any>;

const Box = Symbol('Box');
const Text = Symbol('Text');
const Button = Symbol('Button');

function setup(options: Record<string, unknown> = {}) {
  const handlers = new Map<string, Handler>();
  (register as any)((name: string, a: unknown, b?: Handler) => {
    handlers.set(name, (typeof a === 'function' ? a : b) as Handler);
  }, options);

  const $ = {
    store: new Map<string, unknown>(),
    command: { run: vi.fn(async () => undefined) },
    prompt: { submit: vi.fn(async () => undefined) },
    session: {
      compact: vi.fn(async () => undefined),
      usage: vi.fn(async (): Promise<any> => ({
        context: { tokens: 160_000, window: 1_000_000 },
        cost: { usd: 1.234 },
      })),
    },
    ui: { resolve: () => ({ Box, Text, Button }) },
  };
  const next = vi.fn(async (e: unknown) => e);
  return { handlers, $, next };
}

function walk(node: unknown, out: El[] = []): El[] {
  if (Array.isArray(node)) node.forEach((n) => walk(n, out));
  else if (node && typeof node === 'object' && 'props' in node) {
    out.push(node as El);
    walk((node as El).props.children, out);
  }
  return out;
}

const texts = (tree: unknown) =>
  walk(tree)
    .filter((n) => n.type === Text)
    .map((n) => [n.props.children].flat(5).join(''))
    .join('\n');
const buttons = (tree: unknown) => walk(tree).filter((n) => n.type === Button);
const press = async (tree: unknown, label: string) => {
  const b = buttons(tree).find((x) => x.props.label === label);
  expect(b, `button ${label}`).toBeDefined();
  await (b!.props.onPress as () => Promise<void>)();
};

const render = (h: Map<string, Handler>, $: unknown, next: unknown, props = {}) =>
  h.get('ui.render')!($, { props }, next);
const kv = (s: Map<string, unknown>, k: string) => s.get(`context-meter/${k}`);

describe('context-meter register', () => {
  let t: ReturnType<typeof setup>;
  beforeEach(() => {
    t = setup();
  });

  it('accumulates usage per turn and resets the pending confirmation', async () => {
    await t.handlers.get('turn.complete')!(
      t.$,
      { usage: { input_tokens: 5, output_tokens: 2 }, turnId: 't', reason: 'answer' },
      t.next,
    );
    expect(kv(t.$.store, 'totals')).toEqual({ input: 5, cacheWrite: 0, cacheRead: 0, output: 2 });
    expect(kv(t.$.store, 'confirm')).toBeNull();
    expect(t.next).toHaveBeenCalled();
  });

  it('tolerates a turn without usage', async () => {
    await t.handlers.get('turn.complete')!(t.$, { turnId: 't', reason: 'answer' }, t.next);
    expect(kv(t.$.store, 'totals')).toBeUndefined();
  });

  it('clears after the handoff turn answers, once', async () => {
    const tree = await render(t.handlers, t.$, t.next);
    await press(tree, 'Hand off + clear');
    await press(await render(t.handlers, t.$, t.next), 'Yes');
    expect(t.$.prompt.submit).toHaveBeenCalledTimes(1);
    const text = (t.$.prompt.submit.mock.calls[0] as any)[0].text as string;
    await t.handlers.get('turn.start')!(t.$, { turnId: 'h1', text }, t.next);
    await t.handlers.get('turn.complete')!(t.$, { turnId: 'h1', reason: 'answer' }, t.next);
    expect(t.$.command.run).toHaveBeenCalledWith({ command: 'clear' });
    expect(kv(t.$.store, 'handoff')).toEqual({ phase: 'idle' });
  });

  it('session.end resets state and zeroes totals only on clear', async () => {
    t.$.store.set('context-meter/totals', { input: 9, cacheWrite: 0, cacheRead: 0, output: 0 });
    t.$.store.set('context-meter/note', 'x');
    await t.handlers.get('session.end')!(t.$, { reason: 'other' }, t.next);
    expect(kv(t.$.store, 'totals')).toEqual({ input: 9, cacheWrite: 0, cacheRead: 0, output: 0 });
    expect(kv(t.$.store, 'note')).toBeNull();
    await t.handlers.get('session.end')!(t.$, { reason: 'clear' }, t.next);
    expect(kv(t.$.store, 'totals')).toEqual({ input: 0, cacheWrite: 0, cacheRead: 0, output: 0 });
  });

  describe('ui.render', () => {
    it('passes through when a survey is showing', async () => {
      const e = { props: { hasSurvey: true } };
      expect(await t.handlers.get('ui.render')!(t.$, e, t.next)).toBe(e);
      expect(t.$.session.usage).not.toHaveBeenCalled();
    });

    it('degrades to no output when usage is unavailable', async () => {
      t.$.session.usage.mockRejectedValueOnce(new Error('no metrics'));
      expect(await render(t.handlers, t.$, t.next)).toEqual({ props: {} });
    });

    it('degrades when the window is unknown', async () => {
      t.$.session.usage.mockResolvedValueOnce({ context: { tokens: 5 } });
      expect(await render(t.handlers, t.$, t.next)).toEqual({ props: {} });
    });

    it('renders the red band with cost and the action buttons', async () => {
      const tree = await render(t.handlers, t.$, t.next);
      const out = texts(tree);
      expect(out).toContain('ctx 160k / 1.00M (16.0%)');
      expect(out).toContain('clear now');
      expect(out).toContain('$1.23');
      expect(buttons(tree).map((b) => b.props.label)).toEqual([
        'Compact',
        'Clear',
        'Hand off + clear',
      ]);
    });

    it.each([
      [50_000, ''],
      [100_000, ''],
      [130_000, 'hand off soon'],
    ])('level text at %i tokens', async (tokens, expected) => {
      t.$.session.usage.mockResolvedValueOnce({ context: { tokens, window: 1_000_000 } });
      const out = texts(await render(t.handlers, t.$, t.next));
      if (expected) expect(out).toContain(expected);
      else expect(out).not.toMatch(/hand off soon|clear now/);
      expect(out).not.toContain('$');
    });

    it('honours configured thresholds', async () => {
      const c = setup({ amberAtPercent: 1, hotAtPercent: 2, redAtPercent: 90 });
      c.$.session.usage.mockResolvedValueOnce({ context: { tokens: 30_000, window: 1_000_000 } });
      expect(texts(await render(c.handlers, c.$, c.next))).toContain('hand off soon');
    });

    it('asks for confirmation, and Cancel backs out', async () => {
      await press(await render(t.handlers, t.$, t.next), 'Compact');
      const tree = await render(t.handlers, t.$, t.next);
      expect(texts(tree)).toContain('Run /compact? ');
      await press(tree, 'Cancel');
      expect(kv(t.$.store, 'confirm')).toBeNull();
    });

    it('Yes on compact calls session.compact', async () => {
      await press(await render(t.handlers, t.$, t.next), 'Compact');
      await press(await render(t.handlers, t.$, t.next), 'Yes');
      expect(t.$.session.compact).toHaveBeenCalledTimes(1);
      expect(kv(t.$.store, 'confirm')).toBeNull();
    });

    it('Yes on clear runs the clear command', async () => {
      await press(await render(t.handlers, t.$, t.next), 'Clear');
      await press(await render(t.handlers, t.$, t.next), 'Yes');
      expect(t.$.command.run).toHaveBeenCalledWith({ command: 'clear' });
    });

    it('shows a failure note when the action throws', async () => {
      t.$.session.compact.mockRejectedValueOnce(new Error('boom'));
      await press(await render(t.handlers, t.$, t.next), 'Compact');
      await press(await render(t.handlers, t.$, t.next), 'Yes');
      expect(texts(await render(t.handlers, t.$, t.next))).toContain('/compact failed: boom');
    });

    it('stringifies non-Error failures', async () => {
      t.$.command.run.mockRejectedValueOnce('nope' as never);
      await press(await render(t.handlers, t.$, t.next), 'Clear');
      await press(await render(t.handlers, t.$, t.next), 'Yes');
      expect(texts(await render(t.handlers, t.$, t.next))).toContain('/clear failed: nope');
    });

    it('disarms the handoff when the prompt cannot be submitted', async () => {
      t.$.prompt.submit.mockRejectedValueOnce(new Error('busy'));
      await press(await render(t.handlers, t.$, t.next), 'Hand off + clear');
      await press(await render(t.handlers, t.$, t.next), 'Yes');
      expect(kv(t.$.store, 'handoff')).toEqual({ phase: 'idle' });
      expect(texts(await render(t.handlers, t.$, t.next))).toContain(
        'hand off, then /clear failed: busy',
      );
    });
  });
});
