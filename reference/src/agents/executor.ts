/**
 * Agent orchestration execution engine.
 * Runs OrchestrationPlan instances produced by the plan builders.
 */

import type { AgentRole } from '../core/types.js';
import type { OrchestrationPlan } from './orchestration.js';
import type { AuthorizationHook, AuthorizationContext } from '../policy/authorization.js';
import type { AuditLog } from '../audit/types.js';

export type AgentExecutionState = 'pending' | 'running' | 'completed' | 'failed';

export interface StepResult {
  agent: string;
  state: AgentExecutionState;
  output?: unknown;
  error?: string;
}

export interface OrchestrationResult {
  plan: OrchestrationPlan;
  stepResults: StepResult[];
  success: boolean;
}

export type TaskFn = (agent: AgentRole, input?: unknown) => Promise<unknown>;

export interface ExecutionOptions {
  authorize?: AuthorizationHook;
  auditLog?: AuditLog;
}

export interface HandoffValidationError {
  from: string;
  to: string;
  message: string;
}

/**
 * Execute an orchestration plan using an injected task function.
 * Steps run concurrently when their dependencies are satisfied.
 */
export async function executeOrchestration(
  plan: OrchestrationPlan,
  agents: Map<string, AgentRole>,
  taskFn: TaskFn,
  options?: ExecutionOptions,
): Promise<OrchestrationResult> {
  const results = new Map<string, StepResult>();

  // Initialize all steps as pending
  for (const step of plan.steps) {
    results.set(step.agent, { agent: step.agent, state: 'pending' });
  }

  const completed = new Set<string>();
  const failed = new Set<string>();

  while (completed.size + failed.size < plan.steps.length) {
    // Find ready steps: dependencies all completed, not yet started
    const ready = plan.steps.filter((step) => {
      const r = results.get(step.agent)!;
      if (r.state !== 'pending') return false;
      const deps = step.dependsOn ?? [];
      // If any dependency failed, this step fails immediately
      if (deps.some((d) => failed.has(d))) return false;
      return deps.every((d) => completed.has(d));
    });

    // Fail steps whose dependencies have failed
    const blocked = plan.steps.filter((step) => {
      const r = results.get(step.agent)!;
      if (r.state !== 'pending') return false;
      const deps = step.dependsOn ?? [];
      return deps.some((d) => failed.has(d));
    });

    for (const step of blocked) {
      const result: StepResult = {
        agent: step.agent,
        state: 'failed',
        error: 'Dependency failed',
      };
      results.set(step.agent, result);
      failed.add(step.agent);
    }

    if (ready.length === 0 && blocked.length === 0) break;
    if (ready.length === 0) continue;

    // Mark ready steps as running
    for (const step of ready) {
      results.set(step.agent, { agent: step.agent, state: 'running' });
    }

    // Execute ready steps concurrently
    await Promise.all(
      ready.map(async (step) => {
        const agentRole = agents.get(step.agent);
        if (!agentRole) {
          const result: StepResult = {
            agent: step.agent,
            state: 'failed',
            error: `Agent "${step.agent}" not found`,
          };
          results.set(step.agent, result);
          failed.add(step.agent);
          return;
        }

        // Gather outputs from dependencies as input
        const deps = step.dependsOn ?? [];
        let input: unknown;
        if (deps.length === 1) {
          input = results.get(deps[0])?.output;
        } else if (deps.length > 1) {
          const depOutputs: Record<string, unknown> = {};
          for (const d of deps) {
            depOutputs[d] = results.get(d)?.output;
          }
          input = depOutputs;
        }

        // Authorization check (if hook provided)
        if (options?.authorize) {
          const authCtx: AuthorizationContext = {
            agent: step.agent,
            action: 'execute',
            target: `plan/${plan.pattern}/${step.agent}`,
          };
          const authResult = options.authorize(authCtx);
          if (!authResult.allowed) {
            const result: StepResult = {
              agent: step.agent,
              state: 'failed',
              error: `Authorization denied: ${authResult.reason}`,
            };
            results.set(step.agent, result);
            failed.add(step.agent);
            if (options?.auditLog) {
              options.auditLog.record({
                actor: step.agent,
                action: 'execute',
                resource: `plan/${plan.pattern}/${step.agent}`,
                decision: 'denied',
                details: { reason: authResult.reason },
              });
            }
            return;
          }
        }

        try {
          const output = await taskFn(agentRole, input);
          results.set(step.agent, {
            agent: step.agent,
            state: 'completed',
            output,
          });
          completed.add(step.agent);
          if (options?.auditLog) {
            options.auditLog.record({
              actor: step.agent,
              action: 'execute',
              resource: `plan/${plan.pattern}/${step.agent}`,
              decision: 'allowed',
            });
          }
        } catch (err) {
          results.set(step.agent, {
            agent: step.agent,
            state: 'failed',
            error: err instanceof Error ? err.message : String(err),
          });
          failed.add(step.agent);
        }
      }),
    );
  }

  const stepResults = plan.steps.map((s) => results.get(s.agent)!);
  return {
    plan,
    stepResults,
    success: failed.size === 0,
  };
}

/**
 * Schema resolver: maps a schema reference string to a JSON Schema object.
 */
export type SchemaResolver = (schemaRef: string) => Record<string, unknown> | undefined;

export interface SchemaValidationError {
  path: string;
  message: string;
}

/**
 * Simple structural JSON Schema validator.
 * Checks `type`, `required`, and `properties` without full AJV dependency.
 */
export function simpleSchemaValidate(
  schema: Record<string, unknown>,
  data: unknown,
  path = '',
): SchemaValidationError[] {
  const errors: SchemaValidationError[] = [];

  if (data === null || data === undefined) {
    errors.push({ path: path || '/', message: 'Value is null or undefined' });
    return errors;
  }

  // Type check
  if (schema['type']) {
    const expectedType = schema['type'] as string;
    const actualType = Array.isArray(data) ? 'array' : typeof data;
    if (expectedType === 'integer') {
      if (typeof data !== 'number' || !Number.isInteger(data)) {
        errors.push({ path: path || '/', message: `Expected integer, got ${actualType}` });
      }
    } else if (actualType !== expectedType) {
      errors.push({ path: path || '/', message: `Expected ${expectedType}, got ${actualType}` });
    }
  }

  // Required fields
  if (schema['required'] && typeof data === 'object' && !Array.isArray(data)) {
    const obj = data as Record<string, unknown>;
    for (const field of schema['required'] as string[]) {
      if (!(field in obj)) {
        errors.push({ path: `${path}/${field}`, message: `Missing required field "${field}"` });
      }
    }
  }

  // Properties
  if (schema['properties'] && typeof data === 'object' && !Array.isArray(data)) {
    const props = schema['properties'] as Record<string, Record<string, unknown>>;
    const obj = data as Record<string, unknown>;
    for (const [key, propSchema] of Object.entries(props)) {
      if (key in obj) {
        const nested = simpleSchemaValidate(propSchema, obj[key], `${path}/${key}`);
        errors.push(...nested);
      }
    }
  }

  return errors;
}

/**
 * Validate a handoff contract's payload against its schema reference.
 */
export function validateHandoffContract(
  handoff: { contract?: { schema?: string; requiredFields?: string[] } },
  payload: Record<string, unknown>,
  schemaResolver?: SchemaResolver,
): HandoffValidationError | null {
  if (!handoff.contract?.schema || !schemaResolver) {
    return null;
  }

  const schema = schemaResolver(handoff.contract.schema);
  if (!schema) {
    // Schema not found is a warning, not a blocking error
    return null;
  }

  const errors = simpleSchemaValidate(schema, payload);
  if (errors.length > 0) {
    return {
      from: '',
      to: '',
      message: `Schema validation failed: ${errors.map((e) => `${e.path}: ${e.message}`).join('; ')}`,
    };
  }

  return null;
}

/**
 * Validate a handoff between two agents.
 * Returns null if valid, or a HandoffValidationError if invalid.
 */
export function validateHandoff(
  from: AgentRole,
  to: AgentRole,
  payload: Record<string, unknown>,
  schemaResolver?: SchemaResolver,
): HandoffValidationError | null {
  const handoff = from.spec.handoffs?.find((h) => h.target === to.metadata.name);

  if (!handoff) {
    return {
      from: from.metadata.name,
      to: to.metadata.name,
      message: `No handoff declaration from "${from.metadata.name}" to "${to.metadata.name}"`,
    };
  }

  if (handoff.contract?.requiredFields) {
    const missing = handoff.contract.requiredFields.filter((f) => !(f in payload));
    if (missing.length > 0) {
      return {
        from: from.metadata.name,
        to: to.metadata.name,
        message: `Missing required fields: ${missing.join(', ')}`,
      };
    }
  }

  // Validate against schema if resolver provided
  if (handoff.contract?.schema && schemaResolver) {
    const schemaError = validateHandoffContract(handoff, payload, schemaResolver);
    if (schemaError) {
      return {
        from: from.metadata.name,
        to: to.metadata.name,
        message: schemaError.message,
      };
    }
  }

  return null;
}
