import { describe, it, expect, vi, afterEach } from 'vitest';
import { GenericLLMRunner, type ChatCompletionResponse } from './generic-llm.js';
import type { AgentContext } from './types.js';

function makeContext(overrides: Partial<AgentContext> = {}): AgentContext {
  return {
    issueId: '42',
    issueNumber: 42,
    issueTitle: 'Fix bug',
    issueBody: 'Fix the flaky test',
    workDir: '/tmp/test',
    branch: 'fix/42-bug',
    constraints: { maxFilesPerChange: 10, requireTests: true, blockedPaths: [] },
    ...overrides,
  };
}

function mockFetchResponse(response: ChatCompletionResponse, status = 200): void {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(response),
    text: () => Promise.resolve(JSON.stringify(response)),
  } as Response);
}

describe('GenericLLMRunner', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sends correct API request', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          id: 'test',
          choices: [{ message: { role: 'assistant', content: 'Done' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
          model: 'gpt-4',
        }),
    } as Response);

    const runner = new GenericLLMRunner({
      apiUrl: 'https://api.openai.com/v1/chat/completions',
      apiKey: 'sk-test',
      model: 'gpt-4',
    });

    await runner.run(makeContext());

    expect(fetchSpy).toHaveBeenCalledWith(
      'https://api.openai.com/v1/chat/completions',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer sk-test',
        }),
      }),
    );

    const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
    expect(body.model).toBe('gpt-4');
    expect(body.messages).toHaveLength(2); // system + user
  });

  it('parses token usage', async () => {
    mockFetchResponse({
      id: 'test',
      choices: [{ message: { role: 'assistant', content: 'Fixed it' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
      model: 'gpt-4',
    });

    const runner = new GenericLLMRunner({
      apiUrl: 'https://api.example.com/v1/chat/completions',
      apiKey: 'test',
      model: 'gpt-4',
    });

    const result = await runner.run(makeContext());

    expect(result.success).toBe(true);
    expect(result.tokenUsage).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      model: 'gpt-4',
    });
  });

  it('handles API errors', async () => {
    mockFetchResponse({ id: '', choices: [] } as ChatCompletionResponse, 500);

    const runner = new GenericLLMRunner({
      apiUrl: 'https://api.example.com/v1/chat/completions',
      apiKey: 'test',
      model: 'gpt-4',
    });

    const result = await runner.run(makeContext());
    expect(result.success).toBe(false);
    expect(result.error).toContain('API error');
  });

  it('handles empty response', async () => {
    mockFetchResponse({
      id: 'test',
      choices: [{ message: { role: 'assistant', content: '' }, finish_reason: 'stop' }],
    });

    const runner = new GenericLLMRunner({
      apiUrl: 'https://api.example.com/v1/chat/completions',
      apiKey: 'test',
      model: 'gpt-4',
    });

    const result = await runner.run(makeContext());
    expect(result.success).toBe(false);
    expect(result.error).toContain('No content');
  });

  it('extracts file paths from response', async () => {
    mockFetchResponse({
      id: 'test',
      choices: [
        {
          message: {
            role: 'assistant',
            content: 'I modified `src/index.ts` and created `src/utils.ts`',
          },
          finish_reason: 'stop',
        },
      ],
    });

    const runner = new GenericLLMRunner({
      apiUrl: 'https://api.example.com/v1/chat/completions',
      apiKey: 'test',
      model: 'gpt-4',
    });

    const result = await runner.run(makeContext());
    expect(result.success).toBe(true);
    expect(result.filesChanged).toContain('src/index.ts');
    expect(result.filesChanged).toContain('src/utils.ts');
  });

  it('uses custom system prompt', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          id: 'test',
          choices: [{ message: { role: 'assistant', content: 'Done' }, finish_reason: 'stop' }],
        }),
    } as Response);

    const runner = new GenericLLMRunner({
      apiUrl: 'https://api.example.com/v1/chat/completions',
      apiKey: 'test',
      model: 'gpt-4',
      systemPrompt: 'Custom system prompt',
    });

    await runner.run(makeContext());

    const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
    expect(body.messages[0].content).toBe('Custom system prompt');
  });
});
