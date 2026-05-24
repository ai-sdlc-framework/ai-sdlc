/**
 * Test-only `LlmInvoker` implementation for the shared classifier
 * substrate (AISDLC-321 / RFC-0024 Refit Phase 2).
 *
 * Two flavours of scripted behaviour:
 *
 *   1. **Fixed**: every invocation returns the same response (handy for
 *      "always-high-confidence" tests).
 *   2. **Per-task / per-call**: a function that receives the request +
 *      a per-task-type call index, returning a tailored response.
 *
 * Production callers wire the real Anthropic Haiku adapter (lives in a
 * downstream consumer module — not in this package — because pipeline-cli
 * doesn't depend on `@anthropic-ai/sdk`).
 *
 * @module classifier/substrate/fake-invoker
 */

import type {
  ClassifierTaskType,
  LlmInvocationRequest,
  LlmInvocationResponse,
  LlmInvoker,
} from './types.js';

export type FakeInvokerFixture =
  | LlmInvocationResponse
  | ((req: LlmInvocationRequest, callIndex: number) => LlmInvocationResponse);

export class FakeLlmInvoker implements LlmInvoker {
  private callCounts: Partial<Record<ClassifierTaskType, number>> = {};

  constructor(
    private readonly fixtures: Partial<Record<ClassifierTaskType, FakeInvokerFixture>> & {
      /** Optional catch-all when a specific task-type fixture is absent. */
      default?: FakeInvokerFixture;
      /** When set, the invoker throws this on every call — for failure-path tests. */
      throws?: Error;
    },
  ) {}

  async invoke(req: LlmInvocationRequest): Promise<LlmInvocationResponse> {
    if (this.fixtures.throws) throw this.fixtures.throws;
    const callIndex = this.callCounts[req.taskType] ?? 0;
    this.callCounts[req.taskType] = callIndex + 1;
    const fixture = this.fixtures[req.taskType] ?? this.fixtures.default;
    if (!fixture) {
      throw new Error(
        `FakeLlmInvoker: no fixture for task type "${req.taskType}" and no default supplied`,
      );
    }
    return typeof fixture === 'function' ? fixture(req, callIndex) : { ...fixture };
  }

  getCallCount(taskType: ClassifierTaskType): number {
    return this.callCounts[taskType] ?? 0;
  }
}
