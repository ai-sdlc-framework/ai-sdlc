/**
 * CodexAdapter — wraps OpenAI Codex CLI behind the HarnessAdapter contract.
 * Phase 2.7 ships the adapter shell; the actual end-to-end Codex invocation against a
 * fixture worktree is deferred to Phase 3 dispatcher integration. The adapter's
 * capabilities, version probe, and account-id derivation are wired and tested here.
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

const DEFAULT_AVAILABLE_MODELS = ['gpt-5', 'gpt-5-mini', 'o3', 'o3-mini'];

export interface CodexAdapterDeps {
  env?: NodeJS.ProcessEnv;
  invoke?: (input: HarnessInput, onEvent?: (e: HarnessEvent) => void) => Promise<HarnessResult>;
  probe?: () => Promise<HarnessAvailability>;
}

export class CodexAdapter implements HarnessAdapter {
  readonly name: HarnessName = 'codex';

  readonly capabilities: HarnessCapabilities = {
    freshContext: true,
    customTools: false, // Phase 2.7: partial MCP support; track via capability declaration.
    streaming: true,
    worktreeAwareCwd: true,
    skills: false,
    artifactWrites: true,
    maxContextTokens: 200_000,
  };

  readonly requires: HarnessRequires = {
    binary: 'codex',
    versionRange: '>=0.1.0',
    versionProbe: {
      args: ['--version'],
      parse: (stdout) => stdout.match(/(\d+\.\d+\.\d+)/)?.[1] ?? '',
    },
  };

  private cachedAvailability: HarnessAvailability | null = null;

  constructor(private readonly deps: CodexAdapterDeps = {}) {}

  async getAccountId(): Promise<string | null> {
    const env = this.deps.env ?? process.env;
    const tokenSources = [env.OPENAI_API_KEY, env.CODEX_API_KEY];
    for (const source of tokenSources) {
      if (source && source.length > 0) {
        return createHash('sha256').update(`codex:${source}`).digest('hex').slice(0, 16);
      }
    }
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
    throw new Error(
      'CodexAdapter.invoke is not wired into dispatch yet (Phase 3 work). ' +
        'Tests should inject deps.invoke; production code should not call this method directly until Phase 3.',
    );
  }

  async availableModels(): Promise<string[]> {
    return DEFAULT_AVAILABLE_MODELS;
  }
}
