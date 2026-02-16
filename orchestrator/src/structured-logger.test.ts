import { describe, it, expect } from 'vitest';
import {
  createStructuredConsoleLogger,
  createStructuredBufferLogger,
} from './structured-logger.js';
import type { Logger } from './logger.js';

describe('Structured logger', () => {
  it('createStructuredConsoleLogger satisfies Logger interface', () => {
    const logger: Logger = createStructuredConsoleLogger('test');
    expect(typeof logger.stage).toBe('function');
    expect(typeof logger.stageEnd).toBe('function');
    expect(typeof logger.info).toBe('function');
    expect(typeof logger.error).toBe('function');
    expect(typeof logger.summary).toBe('function');
  });

  it('buffer logger captures stage events', () => {
    const logger = createStructuredBufferLogger('test');
    logger.stage('load-config');
    logger.stageEnd('load-config');

    const entries = logger.getEntries();
    expect(entries.length).toBeGreaterThanOrEqual(2);
    const stageStart = entries.find((e) => e.message === 'stage:start:load-config');
    const stageEnd = entries.find((e) => e.message === 'stage:end:load-config');
    expect(stageStart).toBeDefined();
    expect(stageEnd).toBeDefined();
  });

  it('buffer logger captures info messages', () => {
    const logger = createStructuredBufferLogger('test');
    logger.info('test info message');

    const entries = logger.getEntries();
    expect(entries.some((e) => e.message === 'test info message')).toBe(true);
  });

  it('buffer logger captures error messages', () => {
    const logger = createStructuredBufferLogger('test');
    logger.error('test error');

    const entries = logger.getEntries();
    expect(entries.some((e) => e.message === 'test error')).toBe(true);
    expect(entries.some((e) => e.level === 'error')).toBe(true);
  });

  it('buffer logger clear() empties entries', () => {
    const logger = createStructuredBufferLogger('test');
    logger.info('before clear');
    expect(logger.getEntries().length).toBeGreaterThan(0);

    logger.clear();
    expect(logger.getEntries()).toHaveLength(0);
  });

  it('summary includes total pipeline time', () => {
    const logger = createStructuredBufferLogger('test');
    logger.stage('test-stage');
    logger.stageEnd('test-stage');
    logger.summary();

    const entries = logger.getEntries();
    const summaryEntry = entries.find((e) => e.message === 'pipeline-summary');
    expect(summaryEntry).toBeDefined();
  });

  it('stage timing is recorded in stageEnd events', () => {
    const logger = createStructuredBufferLogger('test');
    logger.stage('fast-stage');
    logger.stageEnd('fast-stage');

    const entries = logger.getEntries();
    const endEntry = entries.find((e) => e.message === 'stage:end:fast-stage');
    expect(endEntry).toBeDefined();
    expect(endEntry!.attributes).toBeDefined();
  });

  it('can be used as a Logger drop-in replacement', () => {
    // Verifies type compatibility by running pipeline-like calls
    const logger = createStructuredBufferLogger('test');
    logger.stage('validate-issue');
    logger.info('Issue #42 validated');
    logger.stageEnd('validate-issue');
    logger.stage('agent');
    logger.error('Agent failed');
    logger.stageEnd('agent');
    logger.summary();

    const entries = logger.getEntries();
    expect(entries.length).toBeGreaterThanOrEqual(6);
  });
});
