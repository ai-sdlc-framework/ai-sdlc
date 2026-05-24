/**
 * Helper for loading a classifier `LlmInvoker` from an operator-supplied
 * module at runtime (RFC-0024 Refit Phase 3 — AISDLC-275).
 *
 * Pipeline-cli is SDK-free by design — the substrate (AISDLC-321) takes
 * an `LlmInvoker` injection so production callers wire an Anthropic
 * Haiku adapter from a downstream consumer module, and tests inject a
 * `FakeLlmInvoker`. The `cli-capture` CLI runs in operator/CI/agent
 * contexts where there's no obvious place to thread an invoker instance,
 * so we use a module-resolution shim:
 *
 *   1. The operator sets `AI_SDLC_CLASSIFIER_INVOKER_MODULE=<absolute-or-relative-path>`
 *      pointing at an ESM module that default-exports (or named-exports
 *      as `invoker`) an `LlmInvoker` instance.
 *   2. `loadConfiguredInvoker()` dynamically imports the module and
 *      returns the invoker. Failures (module not found, no expected
 *      export, import throws) return `null` — the caller falls back to
 *      skipping auto-classification entirely.
 *
 * **Why dynamic import + env var** (rather than a static dependency):
 * pipeline-cli MUST NOT depend on `@anthropic-ai/sdk` (build size, audit
 * surface, multi-harness portability — same reasoning that produced
 * `LlmInvoker` in the first place). The env-var shim lets operators wire
 * whatever invoker fits their harness (Anthropic SDK, Vertex, mock)
 * without amending pipeline-cli.
 *
 * The resolution is cached per-process so multiple `cli-capture file`
 * calls in the same process share one invoker instance.
 *
 * @module capture/invoker-loader
 */

import { existsSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { LlmInvoker } from '../classifier/substrate/index.js';

// Per-process cache. The cached value is `undefined` until the first
// resolution attempt; thereafter it is either the resolved invoker or
// `null` (resolution failed; don't retry per call — operator should fix
// the env var).
let cached: LlmInvoker | null | undefined = undefined;

/**
 * Reset the per-process cache. Test-only — production callers don't
 * need this. Exported so unit tests can re-resolve after mutating
 * `process.env.AI_SDLC_CLASSIFIER_INVOKER_MODULE`.
 */
export function resetInvokerCache(): void {
  cached = undefined;
}

/**
 * Attempt to resolve the classifier invoker module via
 * `AI_SDLC_CLASSIFIER_INVOKER_MODULE`. Returns the invoker on success,
 * `null` on any failure (no env var, file not found, import throws,
 * module shape unexpected). Never throws.
 *
 * The module is expected to export either:
 *   - `export default <invoker>` (default export), OR
 *   - `export const invoker = <invoker>` (named export).
 *
 * The invoker is duck-typed: any object with an `invoke()` method passes.
 */
export async function loadConfiguredInvoker(opts?: {
  repoRoot?: string;
}): Promise<LlmInvoker | null> {
  if (cached !== undefined) return cached;
  const env = process.env.AI_SDLC_CLASSIFIER_INVOKER_MODULE;
  if (!env || env.length === 0) {
    cached = null;
    return null;
  }
  const repoRoot = opts?.repoRoot ?? process.cwd();
  const absPath = isAbsolute(env) ? env : resolve(repoRoot, env);
  if (!existsSync(absPath)) {
    cached = null;
    return null;
  }
  let imported: unknown;
  try {
    imported = await import(pathToFileURL(absPath).href);
  } catch {
    cached = null;
    return null;
  }
  const candidate = pickInvokerFromImport(imported);
  cached = candidate;
  return candidate;
}

function pickInvokerFromImport(imported: unknown): LlmInvoker | null {
  if (!imported || typeof imported !== 'object') return null;
  const m = imported as Record<string, unknown>;
  const candidate = (m.invoker ?? m.default) as unknown;
  if (!candidate || typeof candidate !== 'object') return null;
  const c = candidate as { invoke?: unknown };
  if (typeof c.invoke !== 'function') return null;
  return candidate as LlmInvoker;
}
