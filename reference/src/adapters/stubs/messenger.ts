/**
 * Stub Messenger adapter for testing.
 * In-memory notification log and thread storage.
 */

import type { Messenger, NotificationInput, ThreadInput, Thread } from '../interfaces.js';

export interface NotificationLogEntry extends NotificationInput {
  timestamp: string;
}

export interface StubMessengerAdapter extends Messenger {
  /** Get all sent notifications. */
  getNotificationLog(): NotificationLogEntry[];
  /** Get all messages in a thread. */
  getThreadMessages(threadId: string): string[];
}

export function createStubMessenger(): StubMessengerAdapter {
  const notifications: NotificationLogEntry[] = [];
  const threads = new Map<string, { thread: Thread; messages: string[] }>();
  let nextId = 1;

  return {
    async sendNotification(input: NotificationInput): Promise<void> {
      notifications.push({
        ...input,
        timestamp: new Date().toISOString(),
      });
    },

    async createThread(input: ThreadInput): Promise<Thread> {
      const id = `thread-${nextId++}`;
      const thread: Thread = { id, url: `https://messenger.test/threads/${id}` };
      threads.set(id, { thread, messages: [input.message] });
      return thread;
    },

    async postUpdate(threadId: string, message: string): Promise<void> {
      const entry = threads.get(threadId);
      if (!entry) throw new Error(`Thread "${threadId}" not found`);
      entry.messages.push(message);
    },

    getNotificationLog(): NotificationLogEntry[] {
      return [...notifications];
    },

    getThreadMessages(threadId: string): string[] {
      return threads.get(threadId)?.messages ?? [];
    },
  };
}
