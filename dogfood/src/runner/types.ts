/**
 * AgentRunner abstraction — decouples agent invocation from execution environment.
 * The GitHub Actions runner is the initial implementation; swap to
 * Codespaces / devcontainers by implementing this interface.
 */

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
