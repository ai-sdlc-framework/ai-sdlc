/**
 * Generic LLM runner — HTTP-based, OpenAI-compatible API runner.
 *
 * Design decision D4: Calls LLM APIs directly via HTTP (not CLI subprocess).
 * Accepts apiUrl, apiKey, model config. Enables non-Claude agents.
 */

import type { AgentRunner, AgentContext, AgentResult, TokenUsage } from './types.js';
import {
  DEFAULT_LLM_TIMEOUT_MS,
  DEFAULT_LLM_MAX_TOKENS,
  DEFAULT_LLM_SYSTEM_PROMPT,
} from '../defaults.js';

export interface GenericLLMConfig {
  /** API endpoint URL (e.g., https://api.openai.com/v1/chat/completions). */
  apiUrl: string;
  /** API key for authentication. */
  apiKey: string;
  /** Model identifier (e.g., gpt-4, claude-3-opus, etc.). */
  model: string;
  /** Maximum tokens to generate. Defaults to 4096. */
  maxTokens?: number;
  /** Request timeout in milliseconds. Defaults to 120000. */
  timeoutMs?: number;
  /** System prompt prefix. */
  systemPrompt?: string;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatCompletionResponse {
  id: string;
  choices: Array<{
    message: { role: string; content: string };
    finish_reason: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  model?: string;
}

export class GenericLLMRunner implements AgentRunner {
  private config: GenericLLMConfig;

  constructor(config: GenericLLMConfig) {
    this.config = config;
  }

  async run(ctx: AgentContext): Promise<AgentResult> {
    const messages = this.buildMessages(ctx);

    try {
      const response = await this.callAPI(messages);

      if (!response.choices?.[0]?.message?.content) {
        return {
          success: false,
          filesChanged: [],
          summary: 'LLM returned empty response',
          error: 'No content in response',
        };
      }

      const content = response.choices[0].message.content;
      const tokenUsage = this.parseTokenUsage(response);

      return {
        success: true,
        filesChanged: this.extractFilesFromResponse(content),
        summary: content.slice(0, 2000),
        tokenUsage,
      };
    } catch (err) {
      return {
        success: false,
        filesChanged: [],
        summary: 'LLM API call failed',
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private buildMessages(ctx: AgentContext): ChatMessage[] {
    const messages: ChatMessage[] = [];

    if (this.config.systemPrompt) {
      messages.push({ role: 'system', content: this.config.systemPrompt });
    } else {
      messages.push({
        role: 'system',
        content: DEFAULT_LLM_SYSTEM_PROMPT,
      });
    }

    const userContent = [
      `Issue #${ctx.issueNumber}: ${ctx.issueTitle}`,
      '',
      ctx.issueBody,
      '',
      `Working directory: ${ctx.workDir}`,
      `Branch: ${ctx.branch}`,
      `Max files: ${ctx.constraints.maxFilesPerChange}`,
      `Require tests: ${ctx.constraints.requireTests}`,
    ];

    if (ctx.codebaseContext) {
      userContent.push('', `Codebase: ${JSON.stringify(ctx.codebaseContext)}`);
    }

    messages.push({ role: 'user', content: userContent.join('\n') });

    return messages;
  }

  private async callAPI(messages: ChatMessage[]): Promise<ChatCompletionResponse> {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      this.config.timeoutMs ?? DEFAULT_LLM_TIMEOUT_MS,
    );

    try {
      const res = await fetch(this.config.apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify({
          model: this.config.model,
          messages,
          max_tokens: this.config.maxTokens ?? DEFAULT_LLM_MAX_TOKENS,
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`API error ${res.status}: ${text.slice(0, 200)}`);
      }

      return (await res.json()) as ChatCompletionResponse;
    } finally {
      clearTimeout(timeout);
    }
  }

  private parseTokenUsage(response: ChatCompletionResponse): TokenUsage | undefined {
    if (!response.usage) return undefined;
    return {
      inputTokens: response.usage.prompt_tokens,
      outputTokens: response.usage.completion_tokens,
      model: response.model ?? this.config.model,
    };
  }

  private extractFilesFromResponse(content: string): string[] {
    // Extract file paths from common patterns in LLM responses
    const patterns = [
      /(?:modified|created|updated|changed|edited)\s+[`"]?([^\s`"]+\.[a-z]+)/gi,
      /```[\w]*\s*\/\/\s*(\S+\.[a-z]+)/g,
    ];

    const files = new Set<string>();
    for (const pattern of patterns) {
      let match;
      while ((match = pattern.exec(content)) !== null) {
        const file = match[1].replace(/[`'"]/g, '');
        if (file.includes('/') || file.includes('.')) {
          files.add(file);
        }
      }
    }

    return [...files];
  }
}
