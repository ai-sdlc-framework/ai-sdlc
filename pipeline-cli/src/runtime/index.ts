/**
 * Runtime barrel — exports the SubagentSpawner interface + MockSpawner,
 * plus the Runner abstraction (and defaultRunner) that every step accepts
 * for shelling out to git/gh/etc. Phase 5 consumers (e.g. dogfood/watch.ts)
 * import `Runner` / `defaultRunner` / `ExecResult` / `ExecOptions` from here
 * so they can extend or wrap execution without reaching into deep paths.
 *
 * Phase 2 will add ShellClaudePSpawner and ClaudeCodeSDKSpawner here.
 */
export * from './subagent-spawner.js';
export * from './exec.js';
