/**
 * Handoff executor — runtime data passing between agents with contract validation and audit.
 *
 * Design decision D2: Wraps validateHandoff() with actual data serialization.
 * Each StepResult.output becomes the handoff payload, validated against the
 * contract schema before passing to the next step. Immutable handoff_events table.
 */

import {
  validateHandoff,
  simpleSchemaValidate,
  type AgentRole,
  type StepResult,
  type SchemaResolver,
  type HandoffValidationError,
} from '@ai-sdlc/reference';
import type { StateStore } from './state/store.js';
import type { HandoffEvent } from './state/types.js';

// ── Types ────────────────────────────────────────────────────────────

export interface HandoffPayload {
  fromAgent: string;
  toAgent: string;
  data: unknown;
  timestamp: string;
}

export interface HandoffResult {
  success: boolean;
  payload?: HandoffPayload;
  error?: string;
  validationError?: HandoffValidationError;
}

export interface HandoffExecutorOptions {
  /** State store for audit trail persistence. */
  stateStore?: StateStore;
  /** Schema resolver for contract validation. */
  schemaResolver?: SchemaResolver;
  /** Run ID for audit correlation. */
  runId?: string;
}

// ── Executor ─────────────────────────────────────────────────────────

export class HandoffExecutor {
  private stateStore?: StateStore;
  private schemaResolver?: SchemaResolver;
  private runId: string;

  constructor(options: HandoffExecutorOptions = {}) {
    this.stateStore = options.stateStore;
    this.schemaResolver = options.schemaResolver;
    this.runId = options.runId ?? `handoff-${Date.now()}`;
  }

  /**
   * Execute a handoff from one agent to another, validating the payload
   * against the handoff contract and recording an audit event.
   */
  executeHandoff(
    fromAgent: AgentRole,
    toAgent: AgentRole,
    stepResult: StepResult,
  ): HandoffResult {
    const payload = this.extractPayload(stepResult);
    const payloadHash = this.hashPayload(payload);

    // Validate handoff contract
    const validationError = validateHandoff(
      fromAgent,
      toAgent,
      payload as Record<string, unknown>,
      this.schemaResolver,
    );

    const result: HandoffResult = validationError
      ? {
          success: false,
          error: validationError.message,
          validationError,
        }
      : {
          success: true,
          payload: {
            fromAgent: fromAgent.metadata.name,
            toAgent: toAgent.metadata.name,
            data: payload,
            timestamp: new Date().toISOString(),
          },
        };

    // Record audit event
    this.recordHandoffEvent({
      runId: this.runId,
      fromAgent: fromAgent.metadata.name,
      toAgent: toAgent.metadata.name,
      payloadHash,
      validationResult: result.success ? 'valid' : 'invalid',
      errorMessage: result.error,
    });

    return result;
  }

  /**
   * Execute a chain of handoffs through a sequence of agents.
   * Each agent's output becomes the next agent's input.
   */
  executeChain(
    agents: AgentRole[],
    stepResults: StepResult[],
  ): HandoffResult[] {
    const results: HandoffResult[] = [];

    for (let i = 0; i < agents.length - 1; i++) {
      const from = agents[i];
      const to = agents[i + 1];
      const stepResult = stepResults[i];

      if (!stepResult) {
        results.push({
          success: false,
          error: `No step result for agent "${from.metadata.name}"`,
        });
        break;
      }

      const result = this.executeHandoff(from, to, stepResult);
      results.push(result);

      if (!result.success) break; // Stop chain on first failure
    }

    return results;
  }

  /**
   * Validate a handoff payload against a JSON Schema without executing.
   */
  validatePayload(
    schema: Record<string, unknown>,
    payload: unknown,
  ): { valid: boolean; errors: string[] } {
    const errors = simpleSchemaValidate(schema, payload);
    return {
      valid: errors.length === 0,
      errors: errors.map((e) => `${e.path}: ${e.message}`),
    };
  }

  /**
   * Get all handoff events for a run from the state store.
   */
  getHandoffEvents(runId?: string): HandoffEvent[] {
    if (!this.stateStore) return [];
    return this.stateStore.getHandoffEvents(runId ?? this.runId);
  }

  // ── Internal ─────────────────────────────────────────────────────

  private extractPayload(stepResult: StepResult): unknown {
    if (stepResult.output !== undefined && stepResult.output !== null) {
      return stepResult.output;
    }
    return {};
  }

  private hashPayload(payload: unknown): string {
    const str = JSON.stringify(payload ?? {});
    // Simple hash for audit purposes (not cryptographic)
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash + char) | 0;
    }
    return Math.abs(hash).toString(16).padStart(8, '0');
  }

  private recordHandoffEvent(event: Omit<HandoffEvent, 'id' | 'createdAt'>): void {
    if (!this.stateStore) return;
    this.stateStore.saveHandoffEvent(event);
  }
}
