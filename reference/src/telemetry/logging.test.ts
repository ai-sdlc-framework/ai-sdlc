import { describe, it, expect } from 'vitest';
import { createNoOpLogger, createBufferLogger, createConsoleLogger } from './logging.js';

describe('createNoOpLogger', () => {
  it('does not throw on any log level', () => {
    const logger = createNoOpLogger();
    expect(() => logger.debug('test')).not.toThrow();
    expect(() => logger.info('test')).not.toThrow();
    expect(() => logger.warn('test')).not.toThrow();
    expect(() => logger.error('test')).not.toThrow();
  });
});

describe('createBufferLogger', () => {
  it('captures entries for all log levels', () => {
    const logger = createBufferLogger('test-logger');
    logger.debug('d');
    logger.info('i');
    logger.warn('w');
    logger.error('e');

    const entries = logger.getEntries();
    expect(entries).toHaveLength(4);
    expect(entries[0].level).toBe('debug');
    expect(entries[1].level).toBe('info');
    expect(entries[2].level).toBe('warn');
    expect(entries[3].level).toBe('error');
  });

  it('attaches attributes to entries', () => {
    const logger = createBufferLogger();
    logger.info('action', { agent: 'builder', step: 3 });

    const entry = logger.getEntries()[0];
    expect(entry.attributes).toEqual({ agent: 'builder', step: 3 });
  });

  it('records error message', () => {
    const logger = createBufferLogger();
    logger.error('failed', {}, new Error('boom'));

    const entry = logger.getEntries()[0];
    expect(entry.error).toBe('boom');
  });

  it('entries have ISO-8601 timestamps', () => {
    const logger = createBufferLogger();
    logger.info('test');

    const entry = logger.getEntries()[0];
    expect(entry.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('records logger name', () => {
    const logger = createBufferLogger('my-module');
    logger.info('test');

    expect(logger.getEntries()[0].logger).toBe('my-module');
  });

  it('clear removes all entries', () => {
    const logger = createBufferLogger();
    logger.info('a');
    logger.info('b');
    expect(logger.getEntries()).toHaveLength(2);

    logger.clear();
    expect(logger.getEntries()).toHaveLength(0);
  });

  it('entries without attributes have undefined attributes', () => {
    const logger = createBufferLogger();
    logger.info('no attrs');

    expect(logger.getEntries()[0].attributes).toBeUndefined();
  });

  it('error without Error object has no error field', () => {
    const logger = createBufferLogger();
    logger.error('fail');

    expect(logger.getEntries()[0].error).toBeUndefined();
  });
});

describe('createConsoleLogger', () => {
  it('can be created with a name', () => {
    const logger = createConsoleLogger('test');
    expect(logger).toBeDefined();
    expect(typeof logger.info).toBe('function');
  });
});
