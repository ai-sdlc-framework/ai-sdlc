import { describe, it, expect } from 'vitest';
import { createStubMessenger } from './messenger.js';

describe('createStubMessenger', () => {
  it('sends notifications and logs them', async () => {
    const messenger = createStubMessenger();
    await messenger.sendNotification({
      channel: '#general',
      message: 'Build passed',
      severity: 'info',
    });
    const log = messenger.getNotificationLog();
    expect(log).toHaveLength(1);
    expect(log[0].channel).toBe('#general');
    expect(log[0].message).toBe('Build passed');
    expect(log[0].timestamp).toBeTruthy();
  });

  it('creates threads with initial message', async () => {
    const messenger = createStubMessenger();
    const thread = await messenger.createThread({
      channel: '#incidents',
      title: 'Issue #42',
      message: 'Initial report',
    });
    expect(thread.id).toMatch(/^thread-/);
    expect(thread.url).toContain('threads');
    const messages = messenger.getThreadMessages(thread.id);
    expect(messages).toEqual(['Initial report']);
  });

  it('posts updates to threads', async () => {
    const messenger = createStubMessenger();
    const thread = await messenger.createThread({
      channel: '#ci',
      title: 'Build',
      message: 'Starting...',
    });
    await messenger.postUpdate(thread.id, 'Tests passed');
    await messenger.postUpdate(thread.id, 'Deployed');
    const messages = messenger.getThreadMessages(thread.id);
    expect(messages).toEqual(['Starting...', 'Tests passed', 'Deployed']);
  });

  it('throws when posting to unknown thread', async () => {
    const messenger = createStubMessenger();
    await expect(messenger.postUpdate('unknown', 'msg')).rejects.toThrow('not found');
  });

  it('accumulates multiple notifications', async () => {
    const messenger = createStubMessenger();
    await messenger.sendNotification({ channel: '#a', message: 'm1' });
    await messenger.sendNotification({ channel: '#b', message: 'm2' });
    await messenger.sendNotification({ channel: '#a', message: 'm3' });
    expect(messenger.getNotificationLog()).toHaveLength(3);
  });

  it('returns empty array for unknown thread messages', () => {
    const messenger = createStubMessenger();
    expect(messenger.getThreadMessages('nonexistent')).toEqual([]);
  });

  it('returns copy of notification log', async () => {
    const messenger = createStubMessenger();
    await messenger.sendNotification({ channel: '#ch', message: 'msg' });
    const log1 = messenger.getNotificationLog();
    const log2 = messenger.getNotificationLog();
    expect(log1).toEqual(log2);
    expect(log1).not.toBe(log2);
  });
});
