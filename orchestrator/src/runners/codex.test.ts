import { describe, it, expect } from 'vitest';
import { parseTokenUsage } from './codex.js';

describe('CodexRunner', () => {
  describe('parseTokenUsage', () => {
    it('parses usage from NDJSON events', () => {
      const stderr = [
        '{"event":"start","ts":1234}',
        '{"event":"usage","usage":{"input_tokens":100,"output_tokens":50}}',
        '{"event":"done"}',
      ].join('\n');

      const result = parseTokenUsage(stderr, 'codex-model');
      expect(result).toEqual({
        inputTokens: 100,
        outputTokens: 50,
        model: 'codex-model',
      });
    });

    it('accumulates usage across multiple events', () => {
      const stderr = [
        '{"usage":{"input_tokens":100,"output_tokens":50}}',
        '{"usage":{"input_tokens":200,"output_tokens":100}}',
      ].join('\n');

      const result = parseTokenUsage(stderr, 'codex-model');
      expect(result).toEqual({
        inputTokens: 300,
        outputTokens: 150,
        model: 'codex-model',
      });
    });

    it('supports token_usage alias', () => {
      const stderr = '{"token_usage":{"prompt_tokens":500,"completion_tokens":200}}';

      const result = parseTokenUsage(stderr, 'codex-model');
      expect(result).toEqual({
        inputTokens: 500,
        outputTokens: 200,
        model: 'codex-model',
      });
    });

    it('falls back to regex when no JSON events', () => {
      const stderr = 'Input tokens: 1,234\nOutput tokens: 567';

      const result = parseTokenUsage(stderr, 'codex-model');
      expect(result).toEqual({
        inputTokens: 1234,
        outputTokens: 567,
        model: 'codex-model',
      });
    });

    it('returns undefined for empty string', () => {
      expect(parseTokenUsage('', 'model')).toBeUndefined();
    });

    it('returns undefined when no token info', () => {
      expect(parseTokenUsage('codex exec complete', 'model')).toBeUndefined();
    });

    it('ignores JSON lines without usage fields', () => {
      const stderr = [
        '{"event":"start"}',
        '{"event":"message","content":"hello"}',
        '{"event":"done"}',
      ].join('\n');

      expect(parseTokenUsage(stderr, 'model')).toBeUndefined();
    });
  });
});
