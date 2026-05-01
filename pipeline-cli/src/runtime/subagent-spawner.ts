/**
 * SubagentSpawner interface (RFC-0012 §8.1) and a MockSpawner suitable for
 * unit/integration tests inside this package. The production implementations
 * (`ShellClaudePSpawner`, `ClaudeCodeSDKSpawner`) land in Phase 2 (AISDLC-100.2).
 *
 * Re-exporting the type here so consumers can import either from `./types` or
 * from `./runtime` — the MCP wrapper layer (Phase 3) prefers `./runtime`.
 */

import type { SpawnOpts, SubagentResult, SubagentSpawner, SubagentType } from '../types.js';

export type { SpawnOpts, SubagentResult, SubagentSpawner, SubagentType };

/**
 * Deterministic, in-memory spawner for tests.
 *
 * Either provide a fixed map of `type → SubagentResult` (for "every code-reviewer
 * call returns this result") or a function-per-type so tests can vary by
 * iteration / prompt content.
 *
 * @example
 *   const spawner = new MockSpawner({
 *     developer: () => ({
 *       type: 'developer',
 *       output: '{"summary":"ok","commitSha":"abc1234",...}',
 *       parsed: { summary: 'ok', commitSha: 'abc1234', ... },
 *       status: 'success',
 *       durationMs: 100,
 *     }),
 *   });
 */
export class MockSpawner implements SubagentSpawner {
  private callCounts: Record<string, number> = {};

  constructor(
    private readonly fixtures: Partial<
      Record<
        SubagentType,
        SubagentResult | ((opts: SpawnOpts, callIndex: number) => SubagentResult)
      >
    >,
  ) {}

  async spawn(opts: SpawnOpts): Promise<SubagentResult> {
    const callIndex = this.callCounts[opts.type] ?? 0;
    this.callCounts[opts.type] = callIndex + 1;
    const fixture = this.fixtures[opts.type];
    if (!fixture) {
      return {
        type: opts.type,
        output: '',
        status: 'error',
        error: `MockSpawner: no fixture for subagent type "${opts.type}"`,
        durationMs: 0,
      };
    }
    return typeof fixture === 'function' ? fixture(opts, callIndex) : { ...fixture };
  }

  async spawnParallel(opts: SpawnOpts[]): Promise<SubagentResult[]> {
    return Promise.all(opts.map((o) => this.spawn(o)));
  }

  /** Number of times `spawn` was called for a given subagent type (test introspection). */
  getCallCount(type: SubagentType): number {
    return this.callCounts[type] ?? 0;
  }
}
