/**
 * Direct reporter for framework code that calls a model itself.
 */

import { randomUUID } from 'node:crypto';
import { appendModelCalls } from './store.js';
import type {
  BillingPool,
  ModelCallRecord,
  ModelCallTokens,
  UsageScope,
  UsageStoreOptions,
} from './types.js';

export interface DirectCallInput {
  /** Provider message id. A random id is generated when the provider gives none. */
  callId?: string;
  requestId?: string;
  ts?: string;
  provider: string;
  model: string;
  tokens: Partial<ModelCallTokens>;
  billingPool?: BillingPool;
  sessionId?: string;
  agentId?: string;
  agentRole?: string;
  scope?: UsageScope;
  repo?: string;
  taskId?: string;
}

export interface RecordModelCallResult {
  recorded: boolean;
  callId: string;
}

/**
 * Report one model call made by framework code. Never throws: a write failure
 * (unwritable directory, invalid input) yields `recorded: false`.
 */
export function recordModelCall(
  partial: DirectCallInput,
  opts: UsageStoreOptions = {},
): RecordModelCallResult {
  let callId: string = randomUUID();
  try {
    callId = partial.callId || callId;
    const t = partial.tokens ?? {};
    const record: ModelCallRecord = {
      schemaVersion: 'v1',
      callId,
      ...(partial.requestId ? { requestId: partial.requestId } : {}),
      ts: partial.ts ?? new Date().toISOString(),
      harness: 'direct',
      provider: partial.provider,
      model: partial.model,
      tokens: {
        input: t.input ?? 0,
        cacheWrite5m: t.cacheWrite5m ?? 0,
        cacheWrite1h: t.cacheWrite1h ?? 0,
        cacheRead: t.cacheRead ?? 0,
        output: t.output ?? 0,
        ...(t.reasoning !== undefined ? { reasoning: t.reasoning } : {}),
      },
      billingPool: partial.billingPool ?? 'unknown',
      sessionId: partial.sessionId ?? 'direct',
      ...(partial.agentId ? { agentId: partial.agentId } : {}),
      agentRole: partial.agentRole ?? 'direct',
      scope: partial.scope ?? 'other',
      ...(partial.repo ? { repo: partial.repo } : {}),
      ...(partial.taskId ? { taskId: partial.taskId } : {}),
    };
    const res = appendModelCalls([record], opts);
    return { recorded: res.written === 1, callId };
  } catch {
    return { recorded: false, callId };
  }
}
