/**
 * OpenCodeAdapter — wraps the opencode CLI (v2) behind the HarnessAdapter contract.
 *
 * Adapter-only (DEC-0081, AISDLC-792): capabilities, version probe, account-id
 * derivation and model listing are wired and tested here. The dispatch runner,
 * `.opencode/` agents and plugins, and contrib runners from PR #1102 are NOT
 * part of this change; `invoke` is shell-only until dispatcher integration,
 * matching the Codex adapter pattern.
 */

import { scrypt } from 'node:crypto';
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

const DEFAULT_MODEL = 'lmstudio/qwen/qwen3.8-27b';

/** Fixed domain-separation salt: the id must be stable across runs (ledger key). */
const ACCOUNT_ID_SALT = 'ai-sdlc:harness-account-id:opencode';

export interface OpenCodeAdapterDeps {
  /** Env for credential/model introspection (defaults to process.env). */
  env?: NodeJS.ProcessEnv;
  /** Override the actual invocation path; tests inject a stub. */
  invoke?: (input: HarnessInput, onEvent?: (e: HarnessEvent) => void) => Promise<HarnessResult>;
  /** Override the version probe for tests. */
  probe?: () => Promise<HarnessAvailability>;
}

/** One-way, deterministic credential derivation using a password-grade KDF (scrypt). */
function deriveAccountId(secret: string): Promise<string> {
  return new Promise((resolve, reject) => {
    scrypt(secret, ACCOUNT_ID_SALT, 16, (err, key) => {
      if (err) reject(err);
      else resolve(key.toString('hex'));
    });
  });
}

export class OpenCodeAdapter implements HarnessAdapter {
  readonly name: HarnessName = 'opencode';

  readonly capabilities: HarnessCapabilities = {
    freshContext: true, // `run --standalone`: a fresh private session per invocation
    customTools: true, // MCP servers via config
    streaming: true, // NDJSON stream on stdout
    worktreeAwareCwd: true,
    skills: true,
    artifactWrites: true,
    // RFC-0010 §13.3 lists this as "varies" per model; use the largest window
    // so context-budget math stays conservative (same precedent as claude-code).
    maxContextTokens: 1_000_000,
  };

  readonly requires: HarnessRequires = {
    binary: 'opencode',
    versionRange: '>=2.0.0',
    versionProbe: {
      args: ['--version'],
      // `opencode --version` prints "opencode v2.0.18"
      parse: (stdout) => stdout.match(/(\d+\.\d+\.\d+)/)?.[1] ?? '',
    },
  };

  private cachedAvailability: HarnessAvailability | null = null;

  constructor(private readonly deps: OpenCodeAdapterDeps = {}) {}

  async getAccountId(): Promise<string | null> {
    const env = this.deps.env ?? process.env;
    // opencode authenticates per provider. Local inference (LM Studio / Ollama)
    // sets none of these, so there is no account to pool against: null.
    const sources = [env.OPENCODE_API_KEY, env.ANTHROPIC_API_KEY, env.OPENAI_API_KEY];
    for (const source of sources) {
      if (source && source.length > 0) {
        return deriveAccountId(source);
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

  async availableModels(): Promise<string[]> {
    const env = this.deps.env ?? process.env;
    return [env.OPENCODE_MODEL ?? env.AI_SDLC_MODEL ?? DEFAULT_MODEL];
  }

  async invoke(input: HarnessInput, onEvent?: (e: HarnessEvent) => void): Promise<HarnessResult> {
    if (this.deps.invoke) return this.deps.invoke(input, onEvent);
    throw new Error(
      'OpenCodeAdapter.invoke is not wired into dispatch (adapter-only, DEC-0081). ' +
        'Tests should inject deps.invoke; the opencode dispatch runner is a separate change.',
    );
  }
}
