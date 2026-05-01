import { describe, expect, it } from 'vitest';
import { DEFAULT_LOGGER, StepError } from './types.js';

describe('types — DEFAULT_LOGGER', () => {
  it('emits progress lines in canonical [ai-sdlc-progress] format', () => {
    const messages: string[] = [];
    const orig = console.log;
    console.log = (m: string) => messages.push(m);
    try {
      DEFAULT_LOGGER.progress('plan', 'doing the thing');
    } finally {
      console.log = orig;
    }
    expect(messages[0]).toBe('[ai-sdlc-progress] plan: doing the thing');
  });

  it('info/warn/error wrap console', () => {
    const out: string[] = [];
    const origLog = console.log,
      origWarn = console.warn,
      origErr = console.error;
    console.log = (m: string) => out.push(`log:${m}`);
    console.warn = (m: string) => out.push(`warn:${m}`);
    console.error = (m: string) => out.push(`err:${m}`);
    try {
      DEFAULT_LOGGER.info('a');
      DEFAULT_LOGGER.warn('b');
      DEFAULT_LOGGER.error('c');
    } finally {
      console.log = origLog;
      console.warn = origWarn;
      console.error = origErr;
    }
    expect(out).toEqual(['log:a', 'warn:b', 'err:c']);
  });
});

describe('types — StepError', () => {
  it('captures step name + cause', () => {
    const cause = new Error('underlying');
    const e = new StepError('boom', '07-build-review-prompts', cause);
    expect(e.message).toBe('boom');
    expect(e.step).toBe('07-build-review-prompts');
    expect(e.cause).toBe(cause);
    expect(e.name).toBe('StepError');
  });
});
