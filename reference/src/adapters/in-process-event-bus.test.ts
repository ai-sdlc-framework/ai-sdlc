import { describe, it, expect, vi } from 'vitest';
import { createInProcessEventBus } from './in-process-event-bus.js';

describe('InProcessEventBus', () => {
  it('delivers published events to subscribers', async () => {
    const bus = createInProcessEventBus();
    const handler = vi.fn();

    bus.subscribe('test-topic', handler);
    await bus.publish('test-topic', { data: 'hello' });

    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith({ data: 'hello' });
  });

  it('supports multiple subscribers on the same topic', async () => {
    const bus = createInProcessEventBus();
    const handler1 = vi.fn();
    const handler2 = vi.fn();

    bus.subscribe('events', handler1);
    bus.subscribe('events', handler2);
    await bus.publish('events', 'payload');

    expect(handler1).toHaveBeenCalledWith('payload');
    expect(handler2).toHaveBeenCalledWith('payload');
  });

  it('isolates topics from each other', async () => {
    const bus = createInProcessEventBus();
    const handler = vi.fn();

    bus.subscribe('topic-a', handler);
    await bus.publish('topic-b', 'wrong');

    expect(handler).not.toHaveBeenCalled();
  });

  it('unsubscribe stops delivery', async () => {
    const bus = createInProcessEventBus();
    const handler = vi.fn();

    const unsub = bus.subscribe('topic', handler);
    await bus.publish('topic', 'first');
    expect(handler).toHaveBeenCalledOnce();

    unsub();
    await bus.publish('topic', 'second');
    expect(handler).toHaveBeenCalledOnce(); // still 1
  });

  it('tracks subscriber count', () => {
    const bus = createInProcessEventBus();
    expect(bus.subscriberCount('topic')).toBe(0);

    const unsub1 = bus.subscribe('topic', () => {});
    const unsub2 = bus.subscribe('topic', () => {});
    expect(bus.subscriberCount('topic')).toBe(2);

    unsub1();
    expect(bus.subscriberCount('topic')).toBe(1);

    unsub2();
    expect(bus.subscriberCount('topic')).toBe(0);
  });

  it('handles publishing to topics with no subscribers', async () => {
    const bus = createInProcessEventBus();
    // Should not throw
    await bus.publish('empty-topic', { data: 'nobody listening' });
  });

  it('delivers events in order', async () => {
    const bus = createInProcessEventBus();
    const received: number[] = [];

    bus.subscribe('ordered', (payload) => {
      received.push(payload as number);
    });

    await bus.publish('ordered', 1);
    await bus.publish('ordered', 2);
    await bus.publish('ordered', 3);

    expect(received).toEqual([1, 2, 3]);
  });

  it('supports various payload types', async () => {
    const bus = createInProcessEventBus();
    const received: unknown[] = [];

    bus.subscribe('types', (p) => received.push(p));

    await bus.publish('types', 'string');
    await bus.publish('types', 42);
    await bus.publish('types', null);
    await bus.publish('types', { nested: true });

    expect(received).toEqual(['string', 42, null, { nested: true }]);
  });
});
