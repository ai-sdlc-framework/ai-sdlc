import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createAgentMemory } from './in-memory.js';

describe('AgentMemory', () => {
  describe('working memory', () => {
    it('stores and retrieves values', () => {
      const mem = createAgentMemory();
      mem.working.set('task', { id: 1, name: 'build' });
      expect(mem.working.get('task')).toEqual({ id: 1, name: 'build' });
    });

    it('returns undefined for missing keys', () => {
      const mem = createAgentMemory();
      expect(mem.working.get('missing')).toBeUndefined();
    });

    it('deletes keys', () => {
      const mem = createAgentMemory();
      mem.working.set('key', 'value');
      expect(mem.working.delete('key')).toBe(true);
      expect(mem.working.get('key')).toBeUndefined();
    });

    it('clears all entries', () => {
      const mem = createAgentMemory();
      mem.working.set('a', 1);
      mem.working.set('b', 2);
      mem.working.clear();
      expect(mem.working.keys()).toHaveLength(0);
    });

    it('lists keys', () => {
      const mem = createAgentMemory();
      mem.working.set('a', 1);
      mem.working.set('b', 2);
      expect(mem.working.keys().sort()).toEqual(['a', 'b']);
    });
  });

  describe('short-term memory', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('stores and retrieves before TTL', () => {
      const mem = createAgentMemory();
      mem.shortTerm.set('key', 'value', 5000);
      expect(mem.shortTerm.get('key')).toBe('value');
    });

    it('returns undefined after TTL expires', () => {
      const mem = createAgentMemory();
      mem.shortTerm.set('key', 'value', 1000);
      vi.advanceTimersByTime(1500);
      expect(mem.shortTerm.get('key')).toBeUndefined();
    });

    it('cleans up expired keys from keys()', () => {
      const mem = createAgentMemory();
      mem.shortTerm.set('alive', 'yes', 10000);
      mem.shortTerm.set('dead', 'no', 100);
      vi.advanceTimersByTime(500);
      expect(mem.shortTerm.keys()).toEqual(['alive']);
    });
  });

  describe('long-term memory', () => {
    it('stores and retrieves', () => {
      const mem = createAgentMemory();
      mem.longTerm.set('pattern', { type: 'retry', count: 3 });
      expect(mem.longTerm.get('pattern')).toEqual({ type: 'retry', count: 3 });
    });

    it('searches by prefix', () => {
      const mem = createAgentMemory();
      mem.longTerm.set('project/a', 'data-a');
      mem.longTerm.set('project/b', 'data-b');
      mem.longTerm.set('other/c', 'data-c');

      const results = mem.longTerm.search('project/');
      expect(results).toHaveLength(2);
      expect(results.map((r) => r.key).sort()).toEqual(['project/a', 'project/b']);
    });

    it('supports metadata', () => {
      const mem = createAgentMemory();
      mem.longTerm.set('key', 'value', { source: 'test' });
      const results = mem.longTerm.search('key');
      expect(results[0].metadata).toEqual({ source: 'test' });
    });
  });

  describe('shared memory', () => {
    it('isolates by namespace', () => {
      const mem = createAgentMemory();
      mem.shared.set('ns1', 'key', 'value1');
      mem.shared.set('ns2', 'key', 'value2');

      expect(mem.shared.get('ns1', 'key')).toBe('value1');
      expect(mem.shared.get('ns2', 'key')).toBe('value2');
    });

    it('lists keys per namespace', () => {
      const mem = createAgentMemory();
      mem.shared.set('ns', 'a', 1);
      mem.shared.set('ns', 'b', 2);
      expect(mem.shared.keys('ns').sort()).toEqual(['a', 'b']);
    });

    it('returns undefined for missing namespace', () => {
      const mem = createAgentMemory();
      expect(mem.shared.get('missing', 'key')).toBeUndefined();
    });
  });

  describe('episodic memory', () => {
    it('appends events', () => {
      const mem = createAgentMemory();
      const entry = mem.episodic.append({ key: 'task-completed', value: { id: 1 } });
      expect(entry.id).toBeTruthy();
      expect(entry.tier).toBe('episodic');
      expect(entry.key).toBe('task-completed');
    });

    it('returns recent entries in order', () => {
      const mem = createAgentMemory();
      mem.episodic.append({ key: 'event-1', value: 1 });
      mem.episodic.append({ key: 'event-2', value: 2 });
      mem.episodic.append({ key: 'event-3', value: 3 });

      const recent = mem.episodic.recent(2);
      expect(recent).toHaveLength(2);
      expect(recent[0].key).toBe('event-2');
      expect(recent[1].key).toBe('event-3');
    });

    it('searches by key', () => {
      const mem = createAgentMemory();
      mem.episodic.append({ key: 'error', value: 'fail-1' });
      mem.episodic.append({ key: 'success', value: 'ok-1' });
      mem.episodic.append({ key: 'error', value: 'fail-2' });

      const errors = mem.episodic.search('error');
      expect(errors).toHaveLength(2);
    });

    it('supports metadata on entries', () => {
      const mem = createAgentMemory();
      const entry = mem.episodic.append({
        key: 'decision',
        value: 'approved',
        metadata: { agent: 'reviewer' },
      });
      expect(entry.metadata).toEqual({ agent: 'reviewer' });
    });
  });
});
