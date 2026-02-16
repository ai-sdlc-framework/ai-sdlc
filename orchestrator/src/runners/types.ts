/**
 * AgentRunner abstraction — decouples agent invocation from execution environment.
 * The ClaudeCodeRunner is the initial implementation; swap to
 * Codespaces / devcontainers by implementing this interface.
 */

import type { AgentMemory } from '@ai-sdlc/reference';

export interface AgentContext {
  issueNumber: number;
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
  /** Agent memory for long-term/episodic recall. */
  memory?: AgentMemory;
  /** Override the default tool allowlist for the agent subprocess. */
  allowedTools?: string[];
  /** Timeout in milliseconds for the agent subprocess (default 300000). */
  timeoutMs?: number;
}

export interface AgentResult {
  success: boolean;
  filesChanged: string[];
  summary: string;
  error?: string;
}

export interface AgentRunner {
  run(context: AgentContext): Promise<AgentResult>;
}
