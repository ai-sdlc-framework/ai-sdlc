/**
 * `dispatch-result` — AISDLC-225 consumer-bridge protocol helpers.
 *
 * ## Context
 *
 * The `cli-orchestrator tick --continue-from-result` flag (AISDLC-225) reads a
 * pre-completed Agent result from disk and feeds it back into `executePipeline()`
 * as the developer's spawn output. The original producer was the
 * `ClaudeCliInlineSpawner` (AISDLC-198) inline-manifest path, removed in
 * RFC-0041 Phase 3.3 (AISDLC-377.6). The result-file half of the protocol is
 * retained because:
 *
 *   - The `/ai-sdlc orchestrator-tick` slash command body still uses
 *     `write-dispatch-result` to hand its Agent output back to a subsequent
 *     orchestrator tick.
 *   - Bespoke / programmatic dispatchers can write a `dispatch-result.json`
 *     to drive `executePipeline()` Steps 6+ without re-running the developer.
 *
 * This module provides the helpers both sides need:
 *   - `resolveResultPath` — canonical path resolution.
 *   - `writeDispatchResult` — the consumer bridge writes the Agent result here.
 *   - `readDispatchResult` — the orchestrator tick loop reads the result back
 *     and converts it to a `SubagentResult` for `executePipeline()`.
 *   - `isDispatchResult` — type-guard for the result file shape.
 *
 * ## File lifecycle
 *
 * 1. A producer (slash command body, CI consumer, custom dispatcher) calls
 *    `writeDispatchResult()` with the Agent output.
 * 2. Orchestrator tick loop calls `readDispatchResult()` to recover the
 *    `SubagentResult` and continues `executePipeline()` Steps 6+.
 * 3. The result file persists between ticks as an observability artifact —
 *    operators can inspect it to see what the subagent most recently returned.
 *
 * @module runtime/spawners/dispatch-result
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { SubagentResult, SubagentType } from '../../types.js';

/** Schema version for the dispatch-result file. */
export const DISPATCH_RESULT_VERSION = 1 as const;

/**
 * The dispatch result written by the slash command body after the Agent
 * call completes. The orchestrator tick loop reads this file to recover
 * the `SubagentResult` it needs to continue `executePipeline()` Steps 6+.
 */
export interface DispatchResult {
  /** Schema version — increment when the shape changes. */
  version: typeof DISPATCH_RESULT_VERSION;
  /** Task that was dispatched (matches the manifest's `taskId`). */
  taskId: string;
  /** Subagent type that was invoked (matches the manifest's `subagentType`). */
  subagentType: SubagentType;
  /**
   * Outcome of the Agent call:
   *   - `'success'` — Agent ran and returned output (may or may not have
   *     parseable JSON in `parsed`).
   *   - `'error'` — Agent call failed (timeout, session error, etc.).
   *     `error` carries the diagnostic message.
   */
  status: 'success' | 'error';
  /** Raw output from the Agent call (stdout + natural language). */
  output: string;
  /**
   * Parsed structured payload from the Agent output. For developer subagents,
   * this is the JSON return envelope `executePipeline()` expects. For
   * reviewer subagents, this is the verdict object.
   *
   * `undefined` when the Agent returned non-JSON output or `status === 'error'`.
   */
  parsed?: unknown;
  /** Error message when `status === 'error'`. */
  error?: string;
  /** Wall-clock duration of the Agent call in milliseconds. */
  durationMs: number;
  /** ISO-8601 timestamp when this result was written. */
  writtenAt: string;
}

/**
 * Options for `writeDispatchResult`.
 */
export interface WriteDispatchResultOptions {
  /**
   * Absolute path where the result is written.
   * Defaults to `resolveResultPath()`.
   */
  resultPath?: string;
  /**
   * Wall-clock override for `writtenAt` — tests inject a fixed string so
   * the result is deterministic.
   */
  now?: () => string;
}

/**
 * Resolve the dispatch-result output path from options or environment.
 * Exported for tests.
 */
export function resolveResultPath(overridePath?: string): string {
  if (overridePath) return overridePath;
  const artifactsDir = process.env.ARTIFACTS_DIR ?? `${process.cwd()}/artifacts`;
  return `${artifactsDir}/_orchestrator/dispatch-result.json`;
}

/**
 * Type guard — narrows an unknown value to a `DispatchResult`.
 * Validates the minimum required fields; callers should treat `parsed`
 * as `unknown` and apply their own narrowing.
 */
export function isDispatchResult(value: unknown): value is DispatchResult {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    obj['version'] === DISPATCH_RESULT_VERSION &&
    typeof obj['taskId'] === 'string' &&
    typeof obj['subagentType'] === 'string' &&
    (obj['status'] === 'success' || obj['status'] === 'error') &&
    typeof obj['output'] === 'string' &&
    typeof obj['durationMs'] === 'number' &&
    typeof obj['writtenAt'] === 'string'
  );
}

/**
 * Write a dispatch result to disk.
 *
 * Called by the `/ai-sdlc orchestrator-tick` slash command body after the
 * Agent tool call completes. The orchestrator tick loop reads this file via
 * `readDispatchResult()` to recover the `SubagentResult` it needs to
 * continue `executePipeline()` Steps 6+.
 *
 * The file is written atomically (synchronous write — no partial-write
 * window observable by a concurrent reader in typical single-process usage).
 * Parent directories are created recursively if they don't exist.
 */
export function writeDispatchResult(
  result: Omit<DispatchResult, 'version' | 'writtenAt'>,
  options: WriteDispatchResultOptions = {},
): DispatchResult {
  const resultPath = resolveResultPath(options.resultPath);
  const now = options.now ?? (() => new Date().toISOString());

  const envelope: DispatchResult = {
    version: DISPATCH_RESULT_VERSION,
    writtenAt: now(),
    ...result,
  };

  mkdirSync(dirname(resultPath), { recursive: true });
  writeFileSync(resultPath, JSON.stringify(envelope, null, 2) + '\n', 'utf8');

  return envelope;
}

/**
 * Options for `readDispatchResult`.
 */
export interface ReadDispatchResultOptions {
  /**
   * Absolute path to read the result from.
   * Defaults to `resolveResultPath()`.
   */
  resultPath?: string;
}

/**
 * Read and parse the dispatch result from disk.
 *
 * Called by the orchestrator tick loop continuation after the slash command
 * body has written the Agent result via `writeDispatchResult()`. Converts
 * the on-disk `DispatchResult` back to a `SubagentResult` so
 * `executePipeline()` can continue from Step 6.
 *
 * Returns `null` when the file doesn't exist (no pre-completed dispatch
 * result is staged) or when the file content doesn't parse as a valid
 * `DispatchResult`.
 */
export function readDispatchResult(options: ReadDispatchResultOptions = {}): DispatchResult | null {
  const resultPath = resolveResultPath(options.resultPath);

  let raw: string;
  try {
    raw = readFileSync(resultPath, 'utf8');
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!isDispatchResult(parsed)) return null;
  return parsed;
}

/**
 * Convert a `DispatchResult` (on-disk format) to a `SubagentResult`
 * (in-memory pipeline format) so the orchestrator tick loop can pass
 * it to `executePipeline()` as if the subagent ran normally.
 *
 * This is the critical bridge: `executePipeline()` expects a `SubagentResult`
 * with a `parsed` field carrying the developer's JSON return. The dispatch
 * result written by the slash command body contains exactly that information.
 */
export function dispatchResultToSubagentResult(result: DispatchResult): SubagentResult {
  if (result.status === 'error') {
    return {
      type: result.subagentType,
      output: result.output,
      status: 'error',
      error: result.error ?? 'dispatch-result: error status with no error message',
      durationMs: result.durationMs,
    };
  }

  return {
    type: result.subagentType,
    output: result.output,
    parsed: result.parsed,
    status: 'success',
    durationMs: result.durationMs,
  };
}
