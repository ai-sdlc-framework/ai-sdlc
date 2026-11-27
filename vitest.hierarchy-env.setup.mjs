/**
 * Vitest per-worker setup (AISDLC-1151): drop ambient hierarchy session variables.
 *
 * The orchestrator runs `pnpm test` inside the executor session, which exports
 * AI_SDLC_HIERARCHY_ROLE, AI_SDLC_HIERARCHY_SESSION, AI_SDLC_EXECUTOR_TASK and
 * AI_SDLC_GH_CALL_LOG. Tests that depend on their absence failed under that
 * environment. Tests that need any of them set them explicitly.
 */
for (const k of [
  'AI_SDLC_HIERARCHY_ROLE',
  'AI_SDLC_HIERARCHY_SESSION',
  'AI_SDLC_EXECUTOR_TASK',
  'AI_SDLC_GH_CALL_LOG',
]) {
  delete process.env[k];
}

// AISDLC-1414: tests never append to the operator's timings file (~/.ai-sdlc/timings.jsonl).
// Spawned bins and verify-slot waits inherit `off`; a test that checks recording sets
// AI_SDLC_TIMINGS_FILE to a temporary file itself.
process.env.AI_SDLC_TIMINGS_FILE = 'off';
