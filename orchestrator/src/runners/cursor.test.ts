import { describe, it, expect } from 'vitest';
import { parseStreamJson, parseTokenUsage } from './cursor.js';

describe('CursorRunner', () => {
  describe('parseStreamJson', () => {
    it('extracts final assistant message from NDJSON', () => {
      const stdout = [
        '{"role":"system","content":"You are a helpful assistant"}',
        '{"role":"user","content":"Fix the bug"}',
        '{"role":"assistant","content":"I found the issue in main.ts"}',
        '{"role":"assistant","content":"Fixed the bug by updating the handler"}',
      ].join('\n');

      expect(parseStreamJson(stdout)).toBe('Fixed the bug by updating the handler');
    });

    it('skips non-assistant messages', () => {
      const stdout = [
        '{"role":"user","content":"Fix it"}',
        '{"role":"assistant","content":"Done"}',
        '{"role":"user","content":"Thanks"}',
      ].join('\n');

      expect(parseStreamJson(stdout)).toBe('Done');
    });

    it('skips malformed JSON lines', () => {
      const stdout = [
        'not json at all',
        '{"role":"assistant","content":"Valid message"}',
        '{broken json',
      ].join('\n');

      expect(parseStreamJson(stdout)).toBe('Valid message');
    });

    it('falls back to raw stdout when no assistant messages', () => {
      const stdout = '{"role":"system","content":"setup"}\n{"event":"done"}';
      const result = parseStreamJson(stdout);
      expect(result).toBe(stdout.slice(0, 2000));
    });

    it('falls back to raw stdout for empty input', () => {
      expect(parseStreamJson('')).toBe('');
    });
  });

  describe('parseTokenUsage', () => {
    it('parses input/output token counts', () => {
      const result = parseTokenUsage('Input tokens: 2,500\nOutput tokens: 800', 'cursor-model');
      expect(result).toEqual({
        inputTokens: 2500,
        outputTokens: 800,
        model: 'cursor-model',
      });
    });

    it('parses total tokens and estimates split', () => {
      const result = parseTokenUsage('Total tokens: 5000', 'cursor-model');
      expect(result).toBeDefined();
      expect(result!.inputTokens).toBe(3500);
      expect(result!.outputTokens).toBe(1500);
    });

    it('returns undefined when no token info', () => {
      expect(parseTokenUsage('cursor-agent complete', 'model')).toBeUndefined();
    });

    it('returns undefined for empty string', () => {
      expect(parseTokenUsage('', 'model')).toBeUndefined();
    });
  });
});
