/**
 * HarnessAdapter framework per RFC-0010 §13. Decouples the orchestrator from any single
 * coding-agent runtime. Each adapter declares static capabilities + binary requirements;
 * the orchestrator validates at pipeline-load and dispatches at runtime, with the
 * fallback chain handling availability failures.
 */

export type HarnessName =
  | 'claude-code'
  | 'codex'
  | 'gemini-cli'
  | 'opencode'
  | 'aider'
  | 'generic-api';

export interface HarnessCapabilities {
  /** Can spawn a clean session per invocation (no leaked context). */
  freshContext: boolean;
  /** Supports MCP tools / custom tool definitions. */
  customTools: boolean;
  /** Emits incremental output (for heartbeats). */
  streaming: boolean;
  /** Honors a per-invocation cwd. */
  worktreeAwareCwd: boolean;
  /** Supports loadable skills / system prompts. */
  skills: boolean;
  /** Can write files to $ARTIFACTS_DIR mid-stage. */
  artifactWrites: boolean;
  /** Largest context window across this harness's models. */
  maxContextTokens: number;
}

export interface HarnessRequires {
  /** Executable name resolved against PATH. */
  binary: string;
  /** semver range. Open-ended upper bound by default (RFC §13.8). */
  versionRange: string;
  /** Probe configuration: how to extract the installed version. */
  versionProbe: {
    args: string[];
    parse: (stdout: string) => string;
  };
}

export interface HarnessAvailability {
  available: boolean;
  reason?: 'binary-missing' | 'version-out-of-range' | 'probe-failed' | 'health-check-failed';
  detail?: string;
  installedVersion?: string;
}

export interface HarnessInput {
  prompt: string;
  /** Worktree path (cwd for the agent invocation). */
  cwd: string;
  /** Resolved physical model ID, not alias. */
  model: string;
  /** Allocated dev-server port (optional). */
  port?: number;
  /** $ARTIFACTS_DIR/<issue-id>/ for the run. */
  artifactsDir: string;
  /** Optional MCP tools / tool definitions. */
  tools?: ToolDefinition[];
  /** Optional skill names to load. */
  skills?: string[];
  /** ISO 8601 duration. */
  timeout?: string;
  /** Per-stage cost ceiling. */
  maxBudgetUsd?: number;
}

export interface ToolDefinition {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export type HarnessResultStatus =
  | 'success'
  | 'failure'
  | 'timeout'
  | 'budget-exceeded'
  | 'unavailable';

export interface HarnessResult {
  status: HarnessResultStatus;
  exitCode: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  /** Files the harness wrote to $ARTIFACTS_DIR. */
  artifactPaths: string[];
  errorDetail?: string;
}

export type HarnessEvent =
  | { type: 'started'; timestamp: string }
  | { type: 'heartbeat'; timestamp: string; message?: string }
  | { type: 'progress'; timestamp: string; tokensConsumed: number }
  | { type: 'completed'; timestamp: string; status: HarnessResultStatus };

export interface HarnessAdapter {
  readonly name: HarnessName;
  readonly capabilities: HarnessCapabilities;
  readonly requires: HarnessRequires;

  /**
   * Stable identifier for the credential / account in scope. Used as the SubscriptionLedger
   * key per RFC §14.12. MUST be a one-way derivation (e.g., SHA-256 of the API key).
   * Returns null when the harness cannot derive an account identity (e.g., generic-api
   * with no auth scheme).
   */
  getAccountId(): Promise<string | null>;

  /**
   * Cheap liveness probe used at pipeline-load and by the fallback chain. Combines binary
   * presence + version-range check + adapter-specific health. May be cached for the
   * orchestrator's lifetime; operator restart picks up newly-installed binaries.
   */
  isAvailable(): Promise<HarnessAvailability>;

  /**
   * Execute one stage end-to-end. Streams progress via onEvent. Adapters MUST validate
   * any schema-conformant artifact they produce per RFC §13.9.
   */
  invoke(input: HarnessInput, onEvent?: (e: HarnessEvent) => void): Promise<HarnessResult>;

  /** List models the harness can drive (after env-var introspection). */
  availableModels(): Promise<string[]>;
}
