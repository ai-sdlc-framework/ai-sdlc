/**
 * AgentRunner abstraction — decouples agent invocation from execution environment.
 * The ClaudeCodeRunner is the initial implementation; swap to
 * Codespaces / devcontainers by implementing this interface.
 */

import type { AgentMemory } from '@ai-sdlc/reference';
import type { CodebaseContext } from '../analysis/types.js';

export interface AgentContext {
  issueId: string;
  /** @deprecated Use `issueId` instead. Populated for numeric IDs only. */
  issueNumber?: number;
  issueTitle: string;
  issueBody: string;
  workDir: string;
  branch: string;
  constraints: {
    maxFilesPerChange: number;
    requireTests: boolean;
    blockedPaths: string[];
  };
  /** CI failure logs, populated only during fix-CI retries. */
  ciErrors?: string;
  /** Review findings from PR reviews, populated only during fix-review retries. */
  reviewFindings?: string;
  /** Agent memory for long-term/episodic recall. */
  memory?: AgentMemory;
  /** Override the default tool allowlist for the agent subprocess. */
  allowedTools?: string[];
  /** Timeout in milliseconds for the agent subprocess (default 300000). */
  timeoutMs?: number;
  /** Override the default model for this agent invocation. */
  model?: string;
  /** Codebase context for intelligent agent prompting. */
  codebaseContext?: CodebaseContext;
  /** Enriched episodic context from prior runs. */
  episodicContext?: string;
  /** Lint command for agent prompt (e.g., `npm run lint`). */
  lintCommand?: string;
  /** Format command for agent prompt (e.g., `npm run format`). */
  formatCommand?: string;
  /** Commit message template with `{issueNumber}` and `{issueTitle}` placeholders. */
  commitMessageTemplate?: string;
  /** Co-author line for commits. */
  commitCoAuthor?: string;
  /** OpenShell sandbox ID — when set, the runner spawns the agent inside this sandbox. */
  sandboxId?: string;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  model: string;
}

export interface AgentResult {
  success: boolean;
  filesChanged: string[];
  summary: string;
  error?: string;
  /** Token usage parsed from the agent subprocess. */
  tokenUsage?: TokenUsage;
}

export interface AgentRunner {
  run(context: AgentContext): Promise<AgentResult>;
}
