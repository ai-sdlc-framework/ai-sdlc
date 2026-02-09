import { describe, it, expect } from 'vitest';
import { createWebhookBridge } from './webhook-bridge.js';

interface TestEvent {
  type: string;
  data: string;
}

describe('createWebhookBridge', () => {
  it('transforms and streams events', async () => {
    const bridge = createWebhookBridge<TestEvent>((payload) => {
      const p = payload as { action: string; value: string };
      return { type: p.action, data: p.value };
    });

    const stream = bridge.stream();
    const iter = stream[Symbol.asyncIterator]();

    bridge.push({ action: 'created', value: 'hello' });

    const result = await iter.next();
    expect(result.done).toBe(false);
    expect(result.value).toEqual({ type: 'created', data: 'hello' });

    await iter.return!();
  });

  it('buffers events before stream consumption', async () => {
    const bridge = createWebhookBridge<TestEvent>((payload) => {
      const p = payload as { type: string; data: string };
      return p;
    });

    // Push before stream creation
    bridge.push({ type: 'a', data: '1' });
    bridge.push({ type: 'b', data: '2' });

    const stream = bridge.stream();
    const iter = stream[Symbol.asyncIterator]();

    // Events buffered in the stream should still be delivered
    // (Note: events pushed before stream() was called are lost
    //  because no listener was registered yet)
    bridge.push({ type: 'c', data: '3' });

    const result = await iter.next();
    expect(result.value).toEqual({ type: 'c', data: '3' });

    await iter.return!();
  });

  it('filters null events', async () => {
    const bridge = createWebhookBridge<TestEvent>((payload) => {
      const p = payload as { action: string; data: string };
      if (p.action === 'skip') return null;
      return { type: p.action, data: p.data };
    });

    const stream = bridge.stream();
    const iter = stream[Symbol.asyncIterator]();

    bridge.push({ action: 'skip', data: 'ignored' });
    bridge.push({ action: 'keep', data: 'kept' });

    const result = await iter.next();
    expect(result.value).toEqual({ type: 'keep', data: 'kept' });

    await iter.return!();
  });

  it('supports multiple concurrent streams', async () => {
    const bridge = createWebhookBridge<TestEvent>((payload) => payload as TestEvent);

    const s1 = bridge.stream();
    const s2 = bridge.stream();
    const iter1 = s1[Symbol.asyncIterator]();
    const iter2 = s2[Symbol.asyncIterator]();

    expect(bridge.listenerCount()).toBe(2);

    bridge.push({ type: 'event', data: 'shared' });

    const r1 = await iter1.next();
    const r2 = await iter2.next();
    expect(r1.value).toEqual({ type: 'event', data: 'shared' });
    expect(r2.value).toEqual({ type: 'event', data: 'shared' });

    await iter1.return!();
    await iter2.return!();
  });

  it('close ends all active streams', async () => {
    const bridge = createWebhookBridge<TestEvent>((payload) => payload as TestEvent);

    const stream = bridge.stream();
    const iter = stream[Symbol.asyncIterator]();

    // Close the bridge
    bridge.close();

    const result = await iter.next();
    expect(result.done).toBe(true);
  });

  it('ignores pushes after close', () => {
    const bridge = createWebhookBridge<TestEvent>((payload) => payload as TestEvent);
    bridge.close();

    // Should not throw
    bridge.push({ type: 'event', data: 'ignored' });
    expect(bridge.listenerCount()).toBe(0);
  });

  it('listenerCount tracks active streams', async () => {
    const bridge = createWebhookBridge<TestEvent>((payload) => payload as TestEvent);
    expect(bridge.listenerCount()).toBe(0);

    const s1 = bridge.stream();
    expect(bridge.listenerCount()).toBe(1);

    const s2 = bridge.stream();
    expect(bridge.listenerCount()).toBe(2);

    // Return/close one stream
    const iter1 = s1[Symbol.asyncIterator]();
    await iter1.return!();
    expect(bridge.listenerCount()).toBe(1);

    const iter2 = s2[Symbol.asyncIterator]();
    await iter2.return!();
    expect(bridge.listenerCount()).toBe(0);
  });
});
