/**
 * `ClaudeCliInlineSpawner` — Option 3 "Co-located process / inline orchestrator"
 * implementation for `--spawner claude-cli` (AISDLC-198).
 *
 * ## Design rationale
 *
 * The core problem: the autonomous orchestrator (`cli-orchestrator`) runs as a
 * TypeScript process that calls `executePipeline()` to dispatch subagents. But
 * subagent invocations via the `Agent` tool are only available INSIDE an active
 * Claude Code session — a CLI cannot call the Agent tool directly.
 *
 * Option 3 sidesteps this by NOT trying to cross process boundaries. Instead,
 * the orchestrator runs INSIDE the operator's Claude Code session (via a
 * slash command body with `ScheduleWakeup` between ticks). The spawner's job is
 * to produce a **dispatch manifest** — a JSON descriptor of the Agent call the
 * slash command body should make — rather than actually invoking a subprocess.
 *
 * ## Protocol
 *
 * 1. The slash command body starts the orchestrator with `--spawner claude-cli`.
 * 2. The orchestrator calls `spawner.spawn(opts)` for each admitted task.
 * 3. `ClaudeCliInlineSpawner.spawn()` writes a manifest to
 *    `$ARTIFACTS_DIR/_orchestrator/dispatch-manifest.json` and returns a
 *    `SubagentResult` with `status: 'manifest-emitted'`.
 * 4. The slash command body detects `manifest-emitted`, reads the manifest,
 *    and invokes the `Agent` tool with the described parameters.
 * 5. The slash command body converts the Agent result back into a
 *    `SubagentResult` and passes it back to the pipeline via the normal result
 *    shape (the `parsed` field carries the developer's JSON return).
 *
 * ## Why the manifest is written to disk
 *
 * Writing to a well-known path makes the manifest an observability artifact:
 * operators can inspect `dispatch-manifest.json` between ticks to see what the
 * orchestrator most recently decided to dispatch. The file is overwritten on
 * every spawn call so it always reflects the LATEST decision.
 *
 * ## `spawnParallel` behaviour
 *
 * Parallel dispatch is not supported in inline mode — the slash command body
 * can only invoke one `Agent` tool call at a time (Claude Code filters the
 * Agent tool to one level deep; no nested parallelism). `spawnParallel` falls
 * back to sequential `spawn` calls.
 *
 * @see docs/operations/claude-cli-spawner.md — full design evaluation
 * @see pipeline-cli/src/cli/execute.ts — `resolveSpawner` wiring
 * @module runtime/spawners/claude-cli-inline
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { SpawnOpts, SubagentResult, SubagentSpawner, SubagentType } from '../../types.js';

/**
 * A dispatch manifest describing the Agent call the slash command body
 * should make. Written atomically to
 * `$ARTIFACTS_DIR/_orchestrator/dispatch-manifest.json`.
 *
 * The manifest is a pure data type — no Agent call is made inside the
 * TypeScript spawner. The calling slash command body is responsible for
 * reading the manifest and invoking the Agent tool.
 */
export interface DispatchManifest {
  /** Schema version — increment when the shape changes. */
  version: 1;
  /** Task being dispatched. */
  taskId: string;
  /** Which plugin agent to invoke (maps to `ai-sdlc-plugin/agents/<type>.md`). */
  subagentType: SubagentType;
  /**
   * Model to request for the subagent. `null` means "use the session default".
   * Matches the per-role model split (CLAUDE.md: Sonnet for dev + code/test
   * reviewers, Opus for security).
   */
  model: string | null;
  /** Full prompt text to pass to the Agent tool. */
  prompt: string;
  /** Working directory the subagent should operate in (usually the worktree path). */
  cwd: string | undefined;
  /**
   * Whether the slash command body should invoke the Agent tool in the
   * background (non-blocking). Default false — the orchestrator tick loop
   * awaits each dispatch before moving on.
   */
  runInBackground: boolean;
  /** ISO-8601 wall-clock timestamp when this manifest was emitted. */
  emittedAt: string;
}

/**
 * Extended result status for inline-mode dispatches. When the spawner emits a
 * manifest instead of running a subprocess, the result status is
 * `'manifest-emitted'` so the calling slash command body knows it must
 * invoke the Agent tool before the pipeline can continue.
 *
 * The `manifest` field carries the manifest that was written so the caller
 * does not need to re-read the file (the file is also written for observability).
 */
export interface ManifestEmittedResult extends SubagentResult {
  status: 'manifest-emitted';
  /** The manifest that was written to disk. */
  manifest: DispatchManifest;
}

/**
 * Type guard — narrows a `SubagentResult` to a `ManifestEmittedResult`.
 * Slash command bodies use this to detect inline-mode dispatches.
 */
export function isManifestEmitted(result: SubagentResult): result is ManifestEmittedResult {
  return result.status === 'manifest-emitted';
}

/** Constructor options for `ClaudeCliInlineSpawner`. */
export interface ClaudeCliInlineSpawnerOptions {
  /**
   * Absolute path where the dispatch manifest is written.
   *
   * Default: `process.env.ARTIFACTS_DIR/_orchestrator/dispatch-manifest.json`
   * (falls back to `<process.cwd()>/artifacts/_orchestrator/dispatch-manifest.json`
   * when `ARTIFACTS_DIR` is unset).
   */
  manifestPath?: string;
  /**
   * Task ID to stamp onto the manifest. Not part of `SpawnOpts` (the
   * SubagentSpawner interface is task-agnostic), so it's injected at
   * construction time by the orchestrator tick loop which knows the task ID
   * for each dispatch slot.
   *
   * When the spawner is constructed outside of the orchestrator (e.g. by the
   * `execute` subcommand), pass the task ID explicitly. Falls back to an empty
   * string when omitted so the manifest still parses correctly.
   */
  taskId?: string;
  /**
   * Per-subagent-type model selection. When absent for a given type the
   * spawner emits `null` (session default).
   *
   * Per-role defaults (CLAUDE.md subagent model selection):
   *   - developer, code-reviewer, test-reviewer → claude-sonnet-4-6
   *   - security-reviewer → claude-opus-4-6 (reasoning-heavy)
   */
  modelOverrides?: Partial<Record<SubagentType, string>>;
  /**
   * Wall-clock override for `emittedAt` — tests inject a fixed string so the
   * manifest is deterministic.
   */
  now?: () => string;
}

/** Per-subagent-type model defaults (CLAUDE.md). */
const DEFAULT_MODELS: Partial<Record<SubagentType, string>> = {
  developer: 'claude-sonnet-4-6',
  'code-reviewer': 'claude-sonnet-4-6',
  'test-reviewer': 'claude-sonnet-4-6',
  'security-reviewer': 'claude-opus-4-6',
};

/**
 * Resolve the manifest output path from options or environment.
 * Exported for tests.
 */
export function resolveManifestPath(overridePath?: string): string {
  if (overridePath) return overridePath;
  const artifactsDir = process.env.ARTIFACTS_DIR ?? `${process.cwd()}/artifacts`;
  return `${artifactsDir}/_orchestrator/dispatch-manifest.json`;
}

/**
 * `ClaudeCliInlineSpawner` — the Option 3 inline-mode spawner.
 *
 * Writes a dispatch manifest to disk and returns a `ManifestEmittedResult`.
 * The actual `Agent` tool call is deferred to the calling slash command body.
 */
export class ClaudeCliInlineSpawner implements SubagentSpawner {
  private readonly manifestPath: string;
  private readonly taskId: string;
  private readonly modelOverrides: Partial<Record<SubagentType, string>>;
  private readonly now: () => string;

  constructor(options: ClaudeCliInlineSpawnerOptions = {}) {
    this.manifestPath = resolveManifestPath(options.manifestPath);
    this.taskId = options.taskId ?? '';
    this.modelOverrides = options.modelOverrides ?? {};
    this.now = options.now ?? (() => new Date().toISOString());
  }

  /**
   * Build the dispatch manifest for a given spawn request.
   * Exported (via the instance method) so the slash command body can call it
   * without going through the full `spawn()` flow (useful for pre-flight checks
   * and tests).
   */
  buildManifest(opts: SpawnOpts): DispatchManifest {
    const modelMap: Partial<Record<SubagentType, string>> = {
      ...DEFAULT_MODELS,
      ...this.modelOverrides,
    };
    return {
      version: 1,
      taskId: this.taskId,
      subagentType: opts.type,
      model: modelMap[opts.type] ?? null,
      prompt: opts.prompt,
      cwd: opts.cwd,
      runInBackground: false,
      emittedAt: this.now(),
    };
  }

  /**
   * Emit a dispatch manifest to disk and return a `ManifestEmittedResult`.
   *
   * The manifest is written atomically (write to the final path — Node's
   * `writeFileSync` is synchronous and creates the file before returning, so
   * there is no partial-write window observable by a concurrent reader in
   * typical single-process usage). Parent directories are created recursively
   * if they don't exist.
   */
  spawn(opts: SpawnOpts): Promise<SubagentResult> {
    const start = Date.now();
    const manifest = this.buildManifest(opts);

    try {
      mkdirSync(dirname(this.manifestPath), { recursive: true });
      writeFileSync(this.manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return Promise.resolve({
        type: opts.type,
        output: '',
        status: 'error',
        error: `ClaudeCliInlineSpawner: failed to write manifest to ${this.manifestPath}: ${msg}`,
        durationMs: Date.now() - start,
      });
    }

    const result: ManifestEmittedResult = {
      type: opts.type,
      output: '',
      status: 'manifest-emitted',
      manifest,
      durationMs: Date.now() - start,
    };
    return Promise.resolve(result);
  }

  /**
   * Parallel dispatch is not supported in inline mode — only one `Agent` tool
   * call can be in flight at a time inside a Claude Code session. Falls back
   * to sequential `spawn` calls.
   */
  async spawnParallel(opts: SpawnOpts[]): Promise<SubagentResult[]> {
    const results: SubagentResult[] = [];
    for (const o of opts) {
      results.push(await this.spawn(o));
    }
    return results;
  }
}
