import { describe, it, expect } from 'vitest';
import {
  buildRunnerEnv,
  resolveOutputCapBytes,
  TailBuffer,
  truncationNote,
  DEFAULT_RUNNER_OUTPUT_CAP_BYTES,
  RUNNER_CREDENTIAL_ENV,
} from './runner-env.js';

describe('buildRunnerEnv (AISDLC-1396)', () => {
  const parent: NodeJS.ProcessEnv = {
    PATH: '/usr/bin',
    HOME: '/home/u',
    LC_ALL: 'C',
    XDG_CONFIG_HOME: '/home/u/.config',
    https_proxy: 'http://proxy:3128',
    GITHUB_TOKEN: 'gh-secret',
    OPENAI_API_KEY: 'openai-secret',
    CURSOR_API_KEY: 'cursor-key',
    AI_SDLC_ACTIVE_TASK_ID: 'AISDLC-1',
    AI_SDLC_SIGNING_KEY: 'signing-secret',
    AI_SDLC_WEBHOOK_SECRET: 'webhook-secret',
    FOO: 'bar',
    BAZ: 'qux',
  };

  it('keeps the base allow-list and the runner credential, drops the rest', () => {
    const env = buildRunnerEnv(RUNNER_CREDENTIAL_ENV.cursor, parent);
    expect(env).toEqual({
      PATH: '/usr/bin',
      HOME: '/home/u',
      LC_ALL: 'C',
      XDG_CONFIG_HOME: '/home/u/.config',
      https_proxy: 'http://proxy:3128',
      CURSOR_API_KEY: 'cursor-key',
      AI_SDLC_ACTIVE_TASK_ID: 'AISDLC-1',
    });
  });

  it('adds comma-separated passthrough names, ignoring blanks', () => {
    const env = buildRunnerEnv([], {
      ...parent,
      AI_SDLC_RUNNER_ENV_PASSTHROUGH: ' FOO , ,BAZ,MISSING',
    });
    expect(env.FOO).toBe('bar');
    expect(env.BAZ).toBe('qux');
    expect('MISSING' in env).toBe(false);
    expect(env.GITHUB_TOKEN).toBeUndefined();
  });

  it('passthrough can name a secret-looking AI_SDLC_ variable explicitly', () => {
    const env = buildRunnerEnv([], {
      ...parent,
      AI_SDLC_RUNNER_ENV_PASSTHROUGH: 'AI_SDLC_SIGNING_KEY',
    });
    expect(env.AI_SDLC_SIGNING_KEY).toBe('signing-secret');
    expect(env.AI_SDLC_WEBHOOK_SECRET).toBeUndefined();
  });

  it('skips undefined values and defaults to process.env', () => {
    expect(buildRunnerEnv([], { PATH: undefined })).toEqual({});
    expect(buildRunnerEnv([]).PATH).toBe(process.env.PATH);
  });
});

describe('resolveOutputCapBytes', () => {
  it('reads a positive integer override, else the default', () => {
    expect(resolveOutputCapBytes({ AI_SDLC_RUNNER_OUTPUT_CAP_BYTES: '1024' })).toBe(1024);
    expect(resolveOutputCapBytes({ AI_SDLC_RUNNER_OUTPUT_CAP_BYTES: '0' })).toBe(
      DEFAULT_RUNNER_OUTPUT_CAP_BYTES,
    );
    expect(resolveOutputCapBytes({ AI_SDLC_RUNNER_OUTPUT_CAP_BYTES: 'abc' })).toBe(
      DEFAULT_RUNNER_OUTPUT_CAP_BYTES,
    );
    expect(resolveOutputCapBytes({})).toBe(DEFAULT_RUNNER_OUTPUT_CAP_BYTES);
  });
});

describe('TailBuffer', () => {
  it('holds everything under the cap', () => {
    const buf = new TailBuffer(10);
    buf.push(Buffer.from('abc'));
    buf.push(Buffer.from('def'));
    expect(buf.toString()).toBe('abcdef');
    expect(buf.truncated).toBe(false);
    expect(buf.droppedBytes).toBe(0);
  });

  it('keeps the tail across many small chunks with bounded memory', () => {
    const buf = new TailBuffer(16);
    let written = '';
    for (let i = 0; i < 10_000; i++) {
      const piece = `${i % 10}`.repeat(3);
      written += piece;
      buf.push(Buffer.from(piece));
      expect(buf.heldBytes).toBeLessThanOrEqual(16);
    }
    expect(buf.toString()).toBe(written.slice(-16));
    expect(buf.droppedBytes).toBe(written.length - 16);
    expect(buf.truncated).toBe(true);
  });

  it('keeps the tail of a single chunk larger than the cap', () => {
    const buf = new TailBuffer(4);
    buf.push(Buffer.from('xy'));
    buf.push(Buffer.from('0123456789'));
    expect(buf.toString()).toBe('6789');
    expect(buf.droppedBytes).toBe(8);
    expect(buf.heldBytes).toBe(4);
  });

  it('defaults its cap from the environment', () => {
    expect(new TailBuffer().capBytes).toBe(resolveOutputCapBytes());
  });
});

describe('truncationNote', () => {
  it('names dropped and kept byte counts', () => {
    expect(truncationNote(100, 64)).toBe(
      '[output truncated: dropped the first 100 bytes, kept the last 64]',
    );
  });
});
