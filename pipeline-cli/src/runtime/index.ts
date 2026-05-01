/**
 * Runtime barrel — exports the SubagentSpawner interface + MockSpawner +
 * the Phase 2 production spawners (ShellClaudePSpawner / ClaudeCodeSDKSpawner)
 * + the `defaultSpawner()` resolver, plus the Runner abstraction (and
 * defaultRunner) that every step accepts for shelling out to git/gh/etc.
 *
 * Phase 5 consumers (e.g. dogfood/watch.ts) import `Runner` / `defaultRunner`
 * / `ExecResult` / `ExecOptions` from here so they can extend or wrap
 * execution without reaching into deep paths.
 */
export * from './subagent-spawner.js';
export * from './shell-claude-p-spawner.js';
export * from './claude-code-sdk-spawner.js';
export * from './default-spawner.js';
export * from './exec.js';
