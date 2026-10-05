/**
 * AISDLC-720 — producer of the untrusted-run signal.
 *
 * The PreToolUse hook (ai-sdlc-plugin/hooks) treats a session as untrusted only
 * when `AI_SDLC_UNTRUSTED_RUN` is set in ITS OWN process environment. For
 * agents spawned by the pipeline on outside input (the `gh-issue` source kind)
 * this module wraps the spawner so every spawned agent process inherits that
 * signal. The agent cannot clear it: env is fixed at spawn time.
 *
 * Spawners that do not launch a subprocess (the SDK spawner, MockSpawner)
 * ignore `SpawnOpts.env`; the signal only reaches the hook for subprocess
 * spawners such as `ShellClaudePSpawner`.
 */

import type { SpawnOpts, SubagentResult, SubagentSpawner } from '../types.js';

export const UNTRUSTED_SPAWN_ENV: Readonly<Record<string, string>> = Object.freeze({
  AI_SDLC_UNTRUSTED_RUN: '1',
  AI_SDLC_UNTRUSTED_REASON: 'gh-issue source',
});

function mark(o: SpawnOpts): SpawnOpts {
  // The untrusted keys are applied LAST so a caller-supplied env cannot downgrade them.
  return { ...o, env: { ...(o.env ?? {}), ...UNTRUSTED_SPAWN_ENV } };
}

/** Wrap a spawner so every spawn carries the untrusted-run signal. */
export function withUntrustedEnv(inner: SubagentSpawner): SubagentSpawner {
  return {
    spawn: (o: SpawnOpts): Promise<SubagentResult> => inner.spawn(mark(o)),
    spawnParallel: (os: SpawnOpts[]): Promise<SubagentResult[]> =>
      inner.spawnParallel(os.map(mark)),
  };
}
