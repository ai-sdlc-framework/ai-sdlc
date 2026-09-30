/**
 * OpenCodeAdapter — wraps the opencode CLI (v2) behind the HarnessAdapter contract.
 *
 * Built on the contract verified against the installed opencode v2.0.18 binary
 * (see runners/opencode.ts and docs/operations/opencode-harness.md):
 *  - `run --standalone --auto --format json` per invocation — a private server
 *    per stage, so parallel stages in the worktree pool never contend for one
 *    shared background service (RFC §13.1 isolation).
 *  - `--auto` auto-approves everything not explicitly denied; deny rules
 *    (declarative opencode.json permissions + the in-repo governance plugin)
 *    keep their veto under `--auto`.
 *
 * `invoke` delegates to `runOpenCode` (the runner's spawn primitive) rather than
 * `OpenCodeRunner`: the dispatcher passes a complete stage prompt via
 * HarnessInput.prompt, so the issue-framing buildPrompt is not applied on top.
 */

import { createHash } from 'node:crypto';
import { probeVersion } from '../version-probe.js';
import {
  runOpenCode,
  type RunOpenCodeOptions,
  type RunOpenCodeResult,
} from '../../runners/opencode.js';
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

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

export interface OpenCodeAdapterDeps {
  /** Env for credential/model introspection (defaults to process.env). */
  env?: NodeJS.ProcessEnv;
  /** Override the actual invocation path; tests inject a stub. */
  invoke?: (
    input: HarnessInput,
    onEvent?: (e: HarnessEvent) => void,
  ) => Promise<HarnessResult>;
  /** Override the version probe for tests. */
  probe?: () => Promise<HarnessAvailability>;
  /** Override the runOpenCode primitive (tests inject a fake). */
  runFn?: (opts: RunOpenCodeOptions) => Promise<RunOpenCodeResult>;
}

export class OpenCodeAdapter implements HarnessAdapter {
  readonly name: HarnessName = 'opencode';

  readonly capabilities: HarnessCapabilities = {
    freshContext: true, // --standalone: a fresh private session per invocation
    customTools: true, // MCP servers via config (v2 local MCP boot verified)
    streaming: true, // NDJSON stream on stdout
    worktreeAwareCwd: true, // cwd = the stage worktree
    skills: true, // skill discovery (.claude/skills, ~/.claude/skills, ~/.agents/skills)
    artifactWrites: true, // write/edit tools
    // RFC §13.3 lists this as "varies" per model — 1M mirrors the claude-code
    // precedent: the largest window any opencode-addressable model can have,
    // so context-budget math stays conservative.
    maxContextTokens: 1_000_000,
  };

  readonly requires: HarnessRequires = {
    binary: 'opencode',
    // The v2 contract (run --standalone, NDJSON --format json, v1/v2 config
    // normalizer) does not exist in v1 — an installed v1 binary is unusable
    // for these stages, not merely "older".
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
    // opencode authenticates per provider; introspect the common key envs to
    // derive a stable ledger key (RFC §14.12). Local inference (LM Studio /
    // Ollama) sets none of these → null → no subscription pooling, which is
    // correct: there is no account to pool against.
    const sources = [env.OPENCODE_API_KEY, env.ANTHROPIC_API_KEY, env.OPENAI_API_KEY];
    for (const source of sources) {
      if (source && source.length > 0) {
        return createHash('sha256').update(`opencode:${source}`).digest('hex').slice(0, 16);
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
    // The operator's configured opencode model, defaulting to the local
    // LM Studio setup this deployment runs on. Harness-side alias expansion
    // (RFC §13.x) happens downstream of this list.
    const model = env.OPENCODE_MODEL ?? env.AI_SDLC_MODEL ?? 'lmstudio/qwen/qwen3.8-27b';
    return [model];
  }

  async invoke(input: HarnessInput, onEvent?: (e: HarnessEvent) => void): Promise<HarnessResult> {
    if (this.deps.invoke) return this.deps.invoke(input, onEvent);
    return this.runDefault(input, onEvent);
  }

  private async runDefault(
    input: HarnessInput,
    onEvent?: (e: HarnessEvent) => void,
  ): Promise<HarnessResult> {
    const timeoutMs = parseDurationMs(input.timeout) ?? DEFAULT_TIMEOUT_MS;
    // HarnessInput.model is a resolved physical model ID — opencode refs are
    // provider/model#variant (split on the first slash); prefix bare ids so
    // the ref stays unambiguous, same rule as the runner.
    const model = input.model.includes('/') ? input.model : `anthropic/${input.model}`;

    onEvent?.({ type: 'started', timestamp: new Date().toISOString() });

    let status: HarnessResult['status'];
    let exitCode: number;
    let costUsd = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let outputText: string | undefined;
    let errorDetail: string | undefined;

    try {
      const result = await (this.deps.runFn ?? runOpenCode)({
        workDir: input.cwd,
        prompt: input.prompt,
        model,
        timeoutMs,
        onProgress: (e) => {
          // Forward the runner's 30s heartbeat; finer-grained progress events
          // (text / tool_start) are richer than the harness contract needs.
          if (e.type === 'text' && e.message?.startsWith('heartbeat:')) {
            onEvent?.({
              type: 'heartbeat',
              timestamp: new Date().toISOString(),
              message: e.message,
            });
          }
        },
      });
      costUsd = result.costUsd ?? 0;
      inputTokens = result.tokenUsage?.inputTokens ?? 0;
      outputTokens = result.tokenUsage?.outputTokens ?? 0;
      outputText = result.stdout;
      // Exit 0, but the stream reported a transport error (e.g. an LM Studio
      // socket drop) and produced no final text — a failure, not a success.
      if (result.streamError && !result.stdout.trim()) {
        status = 'failure';
        errorDetail = result.streamError;
      } else {
        status = 'success';
      }
      exitCode = 0;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      status = /signal (SIGTERM|SIGKILL)/.test(message) ? 'timeout' : 'failure';
      exitCode = -1;
      errorDetail = message.slice(-500);
    }

    onEvent?.({ type: 'completed', timestamp: new Date().toISOString(), status });
    return {
      status,
      exitCode,
      costUsd,
      inputTokens,
      outputTokens,
      artifactPaths: [],
      outputText,
      errorDetail,
    };
  }
}

/** ISO 8601 duration (P[n]DT[n]H[n]M[n]S) → milliseconds; null when unset/unparseable. */
function parseDurationMs(duration: string | undefined): number | null {
  if (!duration) return null;
  const m = duration.match(/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
  if (!m) return null;
  const days = Number.parseInt(m[1] ?? '0', 10);
  const hours = Number.parseInt(m[2] ?? '0', 10);
  const minutes = Number.parseInt(m[3] ?? '0', 10);
  const seconds = Number.parseInt(m[4] ?? '0', 10);
  return (((days * 24 + hours) * 60 + minutes) * 60 + seconds) * 1000;
}
