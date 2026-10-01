/**
 * Direct usage reporting for model calls the framework makes itself with an
 * API key. Reports through the ledger's `recordModelCall`. A failure to write
 * (unwritable directory, invalid values) is swallowed: reporting must never
 * change the result of the call it describes.
 */

import { recordModelCall, type ModelCallTokens } from '@ai-sdlc/reference';

export interface DirectUsageReport {
  provider: string;
  model: string;
  tokens: Partial<ModelCallTokens>;
  /** Agent role of the caller, for example `review-critic`. */
  agentRole: string;
  /** Task or issue id, when the caller has one. */
  taskId?: string;
  /** Usage directory override (tests). Defaults to the machine-level ledger. */
  usageDir?: string;
}

/** Anthropic Messages API `usage` object, as far as the ledger needs it. */
export interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

/** Map an Anthropic `usage` object to ledger token classes. */
export function anthropicTokens(usage: AnthropicUsage): Partial<ModelCallTokens> {
  return {
    input: usage.input_tokens ?? 0,
    output: usage.output_tokens ?? 0,
    cacheRead: usage.cache_read_input_tokens ?? 0,
    cacheWrite5m: usage.cache_creation_input_tokens ?? 0,
  };
}

/** Report one API-key model call. Never throws. */
export function reportApiKeyCall(report: DirectUsageReport): void {
  try {
    recordModelCall(
      {
        provider: report.provider,
        model: report.model,
        tokens: report.tokens,
        billingPool: 'api-key',
        agentRole: report.agentRole,
        // The framework made this call itself, so it is framework scope and
        // keeps its task id.
        scope: 'framework',
        ...(report.taskId ? { taskId: report.taskId } : {}),
      },
      report.usageDir ? { dir: report.usageDir } : {},
    );
  } catch {
    // reporting is best effort
  }
}
