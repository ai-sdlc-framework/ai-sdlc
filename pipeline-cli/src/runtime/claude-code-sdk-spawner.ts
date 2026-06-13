/**
 * `ClaudeCodeSDKSpawner` — Tier 2 alternative `SubagentSpawner` (RFC-0012 §8.2).
 *
 * Uses the `@anthropic-ai/claude-code` SDK programmatically rather than
 * shelling out to the `claude` CLI. Authenticates via an explicit
 * `ANTHROPIC_API_KEY` (or `CLAUDE_CODE_USE_BEDROCK` / `CLAUDE_CODE_USE_VERTEX`
 * etc. — the SDK reads its own env). Designed for environments without
 * subscription auth: bare CI runners, customer tenants on their own keys,
 * webhooks invoked from servers that aren't logged into a Claude Code session.
 *
 * ## Why NOT bundle the SDK as a hard dependency
 *
 * `@ai-sdlc/pipeline-cli` is the SHARED core library (RFC-0012 §5). Bundling
 * `@anthropic-ai/claude-code` as a `dependencies` entry would force every
 * Tier 1 (subscription) consumer to install ~50MB of SDK code they'll never
 * use. Instead we lazy-import via a dynamic `import()` at first `spawn` call,
 * which makes the SDK an OPTIONAL runtime requirement — only the
 * API-key-billed path needs it on disk.
 *
 * The lazy import lets `defaultSpawner()` even ATTEMPT to construct this
 * class without crashing when the SDK isn't installed; the failure is
 * deferred until first `spawn` and surfaces as a clear `status: 'error'`
 * with `error: 'Claude Code SDK not installed: ...'`.
 *
 * ## SDK API contract the spawner expects
 *
 * The SDK's exported entry shape varies between versions; rather than pin a
 * specific API surface (which would lock us to a particular SDK release),
 * the spawner accepts an `invoke` callback that callers / `defaultSpawner`
 * can wire to whichever method the installed SDK version exposes. The
 * default invoker tries the documented SDK shapes in order:
 *
 *   1. `import('@anthropic-ai/claude-code').query({ prompt, ... })` — the
 *      streaming-async-iterable API documented for SDK v1+.
 *   2. `new ClaudeCode({apiKey}).runAgent({subagentType, prompt, cwd})` —
 *      the higher-level wrapper sketched in the RFC §8.2 sample.
 *
 * Whichever shape resolves wins; the unrecognised one throws and the
 * spawner returns the error to the caller. This decouples the pipeline-cli
 * release cadence from SDK API churn.
 *
 * ## Q5 (RFC §15) — system-prompt selection in the SDK path
 *
 * The CLI's `--agent <type>` flag has a direct SDK analogue: every documented
 * SDK shape accepts an `agent` / `subagentType` option. The spawner forwards
 * `opts.type` so the SDK loads the right plugin agent's system prompt.
 *
 * @see RFC-0012 §8 (SubagentSpawner abstraction)
 * @see ./shell-claude-p-spawner.ts (the subscription-billed alternative)
 */

import type { SpawnOpts, SubagentResult, SubagentSpawner, SubagentType } from '../types.js';

/**
 * Caller-pluggable invoker. The default implementation lazy-imports
 * `@anthropic-ai/claude-code` at first call and dispatches to the first
 * method shape it recognises. Tests inject a mock invoker so they don't
 * need the SDK installed.
 */
export type SDKInvoker = (params: {
  type: SubagentType;
  prompt: string;
  cwd: string;
  apiKey?: string;
  model?: string;
  timeoutMs?: number;
}) => Promise<SDKInvokeResult>;

/** What the invoker is expected to return. */
export interface SDKInvokeResult {
  /** Raw text/JSON output from the agent (whatever the SDK gave us). */
  output: string;
  /** Already-parsed structured payload, if the SDK exposed one. */
  parsed?: unknown;
}

/** Constructor options for `ClaudeCodeSDKSpawner`. */
export interface ClaudeCodeSDKSpawnerOptions {
  /**
   * Anthropic API key (default: `process.env.ANTHROPIC_API_KEY`).
   * Surfaced explicitly so callers can route per-tenant keys without mutating
   * the process environment (Forge multi-tenant case in RFC-0012 §15 Q6).
   */
  apiKey?: string;
  /**
   * Model alias or full ID. Default: leave undefined and let the SDK pick.
   * Forwarded to the SDK invoker; the SDK then validates against its own
   * model allowlist.
   */
  model?: string;
  /**
   * Per-spawn timeout (ms). Per-call `SpawnOpts.timeout` overrides this.
   * Default: 30 minutes.
   */
  defaultTimeoutMs?: number;
  /**
   * Override the default lazy-import dispatcher. Required for tests (so they
   * don't need `@anthropic-ai/claude-code` on disk) and useful if a caller
   * wants to wire a specific SDK shape (e.g. their own custom agent runner).
   */
  invoker?: SDKInvoker;
}

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

export class ClaudeCodeSDKSpawner implements SubagentSpawner {
  private readonly apiKey: string | undefined;
  private readonly model: string | undefined;
  private readonly defaultTimeoutMs: number;
  private readonly invoker: SDKInvoker;

  constructor(options: ClaudeCodeSDKSpawnerOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.ANTHROPIC_API_KEY;
    this.model = options.model;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.invoker = options.invoker ?? defaultSDKInvoker;
  }

  async spawnParallel(opts: SpawnOpts[]): Promise<SubagentResult[]> {
    return Promise.all(opts.map((o) => this.spawn1(o)));
  }

  spawn(opts: SpawnOpts): Promise<SubagentResult> {
    return this.spawn1(opts);
  }

  private async spawn1(opts: SpawnOpts): Promise<SubagentResult> {
    const start = Date.now();
    const timeoutMs = opts.timeout ?? this.defaultTimeoutMs;

    if (!this.apiKey) {
      return {
        type: opts.type,
        output: '',
        status: 'error',
        error:
          'ClaudeCodeSDKSpawner: no API key — pass `apiKey` in constructor or set ANTHROPIC_API_KEY',
        durationMs: Date.now() - start,
      };
    }

    try {
      const result = await withTimeout(
        this.invoker({
          type: opts.type,
          prompt: opts.prompt,
          cwd: opts.cwd,
          apiKey: this.apiKey,
          model: this.model,
          timeoutMs,
        }),
        timeoutMs,
      );
      return {
        type: opts.type,
        output: result.output,
        parsed: result.parsed,
        status: 'success',
        durationMs: Date.now() - start,
      };
    } catch (err) {
      if (err instanceof TimeoutError) {
        return {
          type: opts.type,
          output: '',
          status: 'timeout',
          error: err.message,
          durationMs: Date.now() - start,
        };
      }
      return {
        type: opts.type,
        output: '',
        status: 'error',
        error: stringifyError(err),
        durationMs: Date.now() - start,
      };
    }
  }
}

/** Minimal SDK module shape the dispatcher recognises (both v1+ and the older wrapper API). */
export interface SDKModule {
  query?: (args: Record<string, unknown>) => AsyncIterable<unknown>;
  ClaudeCode?: new (init: { apiKey?: string; model?: string }) => {
    runAgent: (args: {
      subagentType?: string;
      agent?: string;
      prompt: string;
      cwd: string;
    }) => Promise<unknown>;
  };
  default?: SDKModule;
}

/**
 * Dispatcher that maps an already-imported SDK module shape to one of the
 * recognised entry points. Pure and synchronous — tests can build a fake
 * module object and call this directly without the lazy-import dance.
 *
 * Exported so callers wiring a custom invoker can reuse the dispatch logic.
 */
export async function dispatchToSDK(
  sdk: SDKModule,
  args: { type: SubagentType; prompt: string; cwd: string; apiKey?: string; model?: string },
  pkg = '@anthropic-ai/claude-code',
): Promise<SDKInvokeResult> {
  // Some SDK builds export from `default`, some from the module root. Resolve.
  const root: SDKModule = sdk.default ?? sdk;
  const { type, prompt, cwd, apiKey, model } = args;

  // Shape 1: `query({ prompt, agent, cwd, ... })` returning an async iterable.
  if (typeof root.query === 'function') {
    const iter = root.query({ prompt, cwd, agent: type, apiKey, model });
    let output = '';
    let parsed: unknown;
    for await (const chunk of iter) {
      // Each SDK release shapes its events slightly differently. Be defensive:
      // capture text content and the final structured payload if either is present.
      if (typeof chunk === 'string') {
        output += chunk;
        continue;
      }
      if (chunk && typeof chunk === 'object') {
        const c = chunk as Record<string, unknown>;
        if (typeof c.text === 'string') output += c.text;
        if (c.type === 'result' && 'result' in c) {
          parsed = c.result;
          if (typeof c.result === 'string') {
            output = output || c.result;
          }
        }
      }
    }
    return { output, parsed };
  }

  // Shape 2: `new ClaudeCode({apiKey}).runAgent({subagentType, prompt, cwd})`.
  if (typeof root.ClaudeCode === 'function') {
    const client = new root.ClaudeCode({ apiKey, model });
    const raw = await client.runAgent({ subagentType: type, agent: type, prompt, cwd });
    return normaliseRunAgentResponse(raw);
  }

  throw new Error(
    `Claude Code SDK at \`${pkg}\` does not expose a recognised entry point ` +
      `(neither \`query\` nor \`ClaudeCode\`). The SDK API may have shifted; ` +
      `pass a custom \`invoker\` to ClaudeCodeSDKSpawner to bridge the new shape.`,
  );
}

/**
 * Default SDK invoker. Lazy-imports `@anthropic-ai/claude-code` and dispatches
 * via `dispatchToSDK`. When the SDK isn't installed, throws a clear error the
 * caller surfaces via `SubagentResult.error`.
 *
 * Exported so tests can spy on / replace it without monkey-patching, and so
 * power users wiring a custom SDK invoker can reuse the same import-and-
 * dispatch dance without copy-pasting it.
 */
export const defaultSDKInvoker: SDKInvoker = async (args) => {
  // Use a string variable to keep TypeScript from resolving the import at
  // type-check time (the package is intentionally NOT a dep of pipeline-cli).
  const pkg = '@anthropic-ai/claude-code';
  let sdk: SDKModule;
  try {
    sdk = (await import(/* @vite-ignore */ pkg)) as SDKModule;
  } catch (err) {
    throw new Error(
      `Claude Code SDK not installed: \`${pkg}\` could not be imported. ` +
        `Install it with \`pnpm add @anthropic-ai/claude-code\` or pass a custom ` +
        `\`invoker\` to ClaudeCodeSDKSpawner. Original error: ${stringifyError(err)}`,
      { cause: err },
    );
  }
  return dispatchToSDK(sdk, args, pkg);
};

/**
 * Coerce whatever the SDK's `runAgent` returned into our `SDKInvokeResult`
 * shape. Documented response shapes return either a plain string, a stream,
 * or an object with `output` / `result` / `text` keys; this normaliser
 * accepts all of them.
 *
 * Exported for direct unit testing.
 */
export function normaliseRunAgentResponse(raw: unknown): SDKInvokeResult {
  if (typeof raw === 'string') {
    return { output: raw };
  }
  if (raw && typeof raw === 'object') {
    const r = raw as Record<string, unknown>;
    const output =
      typeof r.output === 'string'
        ? r.output
        : typeof r.text === 'string'
          ? r.text
          : typeof r.result === 'string'
            ? r.result
            : JSON.stringify(raw);
    const parsed = typeof r.result === 'object' ? r.result : undefined;
    return { output, parsed };
  }
  return { output: '' };
}

class TimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`ClaudeCodeSDKSpawner: SDK call timed out after ${timeoutMs}ms`);
    this.name = 'TimeoutError';
  }
}

function withTimeout<T>(p: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError(timeoutMs)), timeoutMs);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

function stringifyError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
