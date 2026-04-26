/**
 * ClaudeCodeAdapter — wraps Claude Code CLI behind the HarnessAdapter contract.
 * Phase 2.7 ships the adapter as a thin facade; the existing ClaudeCodeRunner remains
 * the runtime entry point until Phase 3 routes dispatch through the adapter registry.
 */

import { createHash } from 'node:crypto';
import { probeVersion } from '../version-probe.js';
import type {
  HarnessAdapter,
  HarnessAvailability,
  HarnessCapabilities,
  HarnessEvent,
  HarnessInput,
  HarnessName,
  HarnessRequires,
  HarnessResult,
} from '../types.js';

const DEFAULT_AVAILABLE_MODELS = [
  'claude-haiku-4-5-20251001',
  'claude-sonnet-4-6',
  'claude-opus-4-7',
  'claude-opus-4-7[1m]',
];

export interface ClaudeCodeAdapterDeps {
  env?: NodeJS.ProcessEnv;
  /** Override the actual invocation path; tests inject a stub. */
  invoke?: (input: HarnessInput, onEvent?: (e: HarnessEvent) => void) => Promise<HarnessResult>;
  /** Override version probe for tests. */
  probe?: () => Promise<HarnessAvailability>;
}

export class ClaudeCodeAdapter implements HarnessAdapter {
  readonly name: HarnessName = 'claude-code';

  readonly capabilities: HarnessCapabilities = {
    freshContext: true,
    customTools: true,
    streaming: true,
    worktreeAwareCwd: true,
    skills: true,
    artifactWrites: true,
    maxContextTokens: 1_000_000,
  };

  readonly requires: HarnessRequires = {
    binary: 'claude',
    versionRange: '>=2.0.0',
    versionProbe: {
      args: ['--version'],
      parse: (stdout) => stdout.match(/(\d+\.\d+\.\d+)/)?.[1] ?? '',
    },
  };

  private cachedAvailability: HarnessAvailability | null = null;

  constructor(private readonly deps: ClaudeCodeAdapterDeps = {}) {}

  async getAccountId(): Promise<string | null> {
    const env = this.deps.env ?? process.env;
    const tokenSources = [env.ANTHROPIC_API_KEY, env.CLAUDE_CODE_API_KEY, env.ANTHROPIC_AUTH_TOKEN];
    for (const source of tokenSources) {
      if (source && source.length > 0) {
        return createHash('sha256').update(`claude-code:${source}`).digest('hex').slice(0, 16);
      }
    }
    // No credential discoverable from env — fall back to ambiguous so the ledger
    // degrades to per-pipeline keying with LedgerKeyAmbiguous warning (RFC §14.12).
    return null;
  }

  async isAvailable(): Promise<HarnessAvailability> {
    if (this.cachedAvailability) return this.cachedAvailability;
    const result = this.deps.probe ? await this.deps.probe() : await probeVersion(this.requires);
    this.cachedAvailability = result;
    return result;
  }

  async invoke(input: HarnessInput, onEvent?: (e: HarnessEvent) => void): Promise<HarnessResult> {
    if (this.deps.invoke) return this.deps.invoke(input, onEvent);
    // Phase 2.7 default: not yet wired through the orchestrator dispatch path.
    // Phase 3 (concurrency + worker pool) replaces this stub with the actual invocation.
    throw new Error(
      'ClaudeCodeAdapter.invoke is not wired into dispatch yet (Phase 3 work). ' +
        'Tests should inject deps.invoke; production code should not call this method directly until Phase 3.',
    );
  }

  async availableModels(): Promise<string[]> {
    return DEFAULT_AVAILABLE_MODELS;
  }
}
