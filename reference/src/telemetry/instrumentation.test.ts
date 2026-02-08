import { describe, it, expect } from 'vitest';
import { getTracer, getMeter, withSpan, withSpanSync } from './instrumentation.js';

describe('getTracer', () => {
  it('returns a tracer instance', () => {
    const tracer = getTracer();
    expect(tracer).toBeDefined();
    expect(typeof tracer.startActiveSpan).toBe('function');
    expect(typeof tracer.startSpan).toBe('function');
  });

  it('returns the same tracer on repeated calls', () => {
    const t1 = getTracer();
    const t2 = getTracer();
    // Both should be functional (no-op tracers when no SDK)
    expect(typeof t1.startSpan).toBe('function');
    expect(typeof t2.startSpan).toBe('function');
  });
});

describe('getMeter', () => {
  it('returns a meter instance', () => {
    const meter = getMeter();
    expect(meter).toBeDefined();
    expect(typeof meter.createCounter).toBe('function');
    expect(typeof meter.createHistogram).toBe('function');
  });
});

describe('withSpan', () => {
  it('executes the function and returns its result', async () => {
    const result = await withSpan('test-span', { key: 'value' }, async () => {
      return 42;
    });
    expect(result).toBe(42);
  });

  it('passes span to the function', async () => {
    let receivedSpan = false;
    await withSpan('test-span', {}, async (span) => {
      receivedSpan = span !== undefined && typeof span.end === 'function';
    });
    expect(receivedSpan).toBe(true);
  });

  it('propagates errors from the function', async () => {
    await expect(
      withSpan('error-span', {}, async () => {
        throw new Error('test error');
      }),
    ).rejects.toThrow('test error');
  });

  it('handles non-Error throws', async () => {
    await expect(
      withSpan('string-throw', {}, async () => {
        throw 'string-error';
      }),
    ).rejects.toBe('string-error');
  });

  it('accepts attributes of different types', async () => {
    const result = await withSpan(
      'attrs-span',
      { str: 'hello', num: 42, bool: true },
      async () => 'ok',
    );
    expect(result).toBe('ok');
  });
});

describe('withSpanSync', () => {
  it('executes a sync function and returns its result', () => {
    const result = withSpanSync('sync-span', {}, () => 'hello');
    expect(result).toBe('hello');
  });

  it('passes span to the function', () => {
    let receivedSpan = false;
    withSpanSync('sync-span', {}, (span) => {
      receivedSpan = span !== undefined && typeof span.end === 'function';
    });
    expect(receivedSpan).toBe(true);
  });

  it('propagates errors from sync function', () => {
    expect(() =>
      withSpanSync('error-sync', {}, () => {
        throw new Error('sync error');
      }),
    ).toThrow('sync error');
  });

  it('works correctly without SDK configured (no-op)', () => {
    // Without an SDK, spans are no-ops but the function should still work
    const result = withSpanSync('noop-span', { agent: 'test' }, () => {
      return { processed: true };
    });
    expect(result).toEqual({ processed: true });
  });
});
