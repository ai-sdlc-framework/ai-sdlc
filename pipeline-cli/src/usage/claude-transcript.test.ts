import { describe, expect, it } from 'vitest';
import {
  billingPoolFor,
  mapUsageTokens,
  parseTranscriptLine,
  peekCwd,
} from './claude-transcript.js';

const line = (o: Record<string, unknown>): string => JSON.stringify(o);

describe('parseTranscriptLine', () => {
  const base = {
    type: 'assistant',
    timestamp: '2026-09-02T10:00:00Z',
    message: { id: 'm', model: 'claude-x', usage: { input_tokens: 1, output_tokens: 2 } },
  };

  it('parses a call and normalises the timestamp', () => {
    const r = parseTranscriptLine(
      line({ ...base, cwd: '/a', gitBranch: 'b', agentId: 'ag', isSidechain: true }),
    );
    expect(r).toMatchObject({
      kind: 'call',
      call: {
        callId: 'm',
        ts: '2026-09-02T10:00:00.000Z',
        cwd: '/a',
        gitBranch: 'b',
        agentId: 'ag',
        isSidechain: true,
      },
    });
  });

  it('ignores non-assistant lines, lines without usage and non-objects', () => {
    expect(parseTranscriptLine(line({ type: 'user' }))).toEqual({ kind: 'ignore' });
    expect(parseTranscriptLine(line({ type: 'assistant', message: { id: 'm' } }))).toEqual({
      kind: 'ignore',
    });
    expect(parseTranscriptLine(line({ type: 'assistant', message: 'x' }))).toEqual({
      kind: 'ignore',
    });
    expect(parseTranscriptLine('[1]')).toEqual({ kind: 'ignore' });
  });

  it('reports invalid JSON and unusable fields as errors', () => {
    expect(parseTranscriptLine('{oops')).toEqual({ kind: 'error' });
    expect(parseTranscriptLine(line({ ...base, timestamp: 'nope' }))).toEqual({ kind: 'error' });
    expect(
      parseTranscriptLine(line({ ...base, message: { ...base.message, id: 'a'.repeat(300) } })),
    ).toEqual({ kind: 'error' });
    expect(parseTranscriptLine(line({ ...base, message: { ...base.message, model: '' } }))).toEqual(
      { kind: 'error' },
    );
  });

  it('classifies limit notices with string or array content and drops unrelated synthetics', () => {
    const syn = (content: unknown) =>
      parseTranscriptLine(
        line({
          type: 'assistant',
          timestamp: '2026-09-02T10:00:00Z',
          sessionId: 's',
          message: { model: '<synthetic>', content },
        }),
      );
    expect(syn('You have hit your limit')).toMatchObject({
      kind: 'limit',
      category: 'usage-limit',
      sessionId: 's',
    });
    expect(syn([{ type: 'text', text: 'Too many requests' }])).toMatchObject({
      category: 'rate-limit',
    });
    expect(syn([{ type: 'text', text: 'hello' }])).toEqual({ kind: 'ignore' });
    expect(syn(42)).toEqual({ kind: 'ignore' });
    const noTs = parseTranscriptLine(
      line({
        type: 'assistant',
        message: { model: '<synthetic>', content: 'usage limit reached' },
      }),
    );
    expect(noTs).toEqual({ kind: 'ignore' });
    const out = JSON.stringify(syn('SECRET usage limit reached'));
    expect(out).not.toContain('SECRET');
  });
});

describe('mapUsageTokens', () => {
  it('uses the split fields, the combined fallback and clamps bad numbers', () => {
    expect(
      mapUsageTokens({
        cache_creation_input_tokens: 10,
        cache_creation: { ephemeral_5m_input_tokens: 6, ephemeral_1h_input_tokens: 4 },
      }),
    ).toMatchObject({ cacheWrite5m: 6, cacheWrite1h: 4 });
    expect(mapUsageTokens({ cache_creation_input_tokens: 10, cache_creation: {} })).toMatchObject({
      cacheWrite5m: 10,
      cacheWrite1h: 0,
    });
    const t = mapUsageTokens({
      input_tokens: -5,
      output_tokens: 'x',
      cache_read_input_tokens: 2.9,
    });
    expect(t).toEqual({ input: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 2, output: 0 });
    expect(mapUsageTokens({ output_tokens_details: { thinking_tokens: 3 } }).reasoning).toBe(3);
    expect(
      mapUsageTokens({ output_tokens_details: { thinking_tokens: 'x' } }).reasoning,
    ).toBeUndefined();
  });
});

describe('peekCwd / billingPoolFor', () => {
  it('peeks a cwd from any line type and tolerates garbage', () => {
    expect(peekCwd(line({ type: 'user', cwd: '/x' }))).toBe('/x');
    expect(peekCwd('nope')).toBeUndefined();
    expect(peekCwd('[]')).toBeUndefined();
    expect(peekCwd(line({ cwd: 'bad\u0000' }))).toBeUndefined();
  });

  it('maps only stated entrypoints', () => {
    expect(billingPoolFor('cli')).toBe('subscription-interactive');
    expect(billingPoolFor('sdk-ts')).toBe('agent-sdk-credit');
    expect(billingPoolFor('sdk-py')).toBe('agent-sdk-credit');
    expect(billingPoolFor(undefined)).toBe('unknown');
    expect(billingPoolFor('claude-vscode')).toBe('unknown');
  });
});
