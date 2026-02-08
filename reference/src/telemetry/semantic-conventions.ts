/**
 * OpenTelemetry semantic conventions for AI-SDLC Framework.
 * Defines standard span names, metric names, and attribute keys.
 */

/** Standard span names following OpenTelemetry naming conventions. */
export const SPAN_NAMES = {
  /** A pipeline stage execution. */
  PIPELINE_STAGE: 'ai_sdlc.pipeline.stage',
  /** An agent task execution. */
  AGENT_TASK: 'ai_sdlc.agent.task',
  /** A quality gate evaluation. */
  GATE_EVALUATION: 'ai_sdlc.gate.evaluation',
  /** A reconciliation cycle. */
  RECONCILIATION_CYCLE: 'ai_sdlc.reconciliation.cycle',
  /** An agent-to-agent handoff. */
  HANDOFF: 'ai_sdlc.handoff',
} as const;

/** Standard metric names for AI-SDLC instrumentation. */
export const METRIC_NAMES = {
  /** Current autonomy level for an agent (gauge). */
  AUTONOMY_LEVEL: 'ai_sdlc.autonomy.level',
  /** Count of gate evaluations that passed (counter). */
  GATE_PASS_TOTAL: 'ai_sdlc.gate.pass.total',
  /** Count of gate evaluations that failed (counter). */
  GATE_FAIL_TOTAL: 'ai_sdlc.gate.fail.total',
  /** Duration of agent task execution in milliseconds (histogram). */
  TASK_DURATION_MS: 'ai_sdlc.task.duration_ms',
  /** Duration of reconciliation cycles in milliseconds (histogram). */
  RECONCILIATION_DURATION_MS: 'ai_sdlc.reconciliation.duration_ms',
  /** Count of successful task completions (counter). */
  TASK_SUCCESS_TOTAL: 'ai_sdlc.task.success.total',
  /** Count of failed task completions (counter). */
  TASK_FAILURE_TOTAL: 'ai_sdlc.task.failure.total',
  /** Count of autonomy promotions (counter). */
  PROMOTION_TOTAL: 'ai_sdlc.autonomy.promotion.total',
  /** Count of autonomy demotions (counter). */
  DEMOTION_TOTAL: 'ai_sdlc.autonomy.demotion.total',
  /** Total number of agent-to-agent handoffs (counter). */
  HANDOFF_TOTAL: 'ai_sdlc.handoff.total',
  /** Total number of failed handoffs (counter). */
  HANDOFF_FAILURE_TOTAL: 'ai_sdlc.handoff.failure.total',
  /** Time waiting for human approval in milliseconds (histogram). */
  APPROVAL_WAIT_MS: 'ai_sdlc.approval.wait_ms',
  /** Total number of sandbox constraint violations (counter). */
  SANDBOX_VIOLATION_TOTAL: 'ai_sdlc.sandbox.violation.total',
  /** Total number of kill switch activations (counter). */
  KILL_SWITCH_ACTIVATION_TOTAL: 'ai_sdlc.killswitch.activation.total',
  /** Compliance coverage percentage (gauge). */
  COMPLIANCE_COVERAGE_PERCENT: 'ai_sdlc.compliance.coverage_percent',
  /** Total number of healthy adapter checks (counter). */
  ADAPTER_HEALTH_TOTAL: 'ai_sdlc.adapter.health.total',
  /** Total number of agents discovered via A2A (counter). */
  AGENT_DISCOVERY_TOTAL: 'ai_sdlc.agent.discovery.total',
  /** Duration of admission pipeline in milliseconds (histogram). */
  ADMISSION_DURATION_MS: 'ai_sdlc.admission.duration_ms',
  /** Duration of LLM evaluation in milliseconds (histogram). */
  LLM_EVAL_DURATION_MS: 'ai_sdlc.llm_eval.duration_ms',
  /** LLM evaluation score (gauge). */
  LLM_EVAL_SCORE: 'ai_sdlc.llm_eval.score',
  /** Duration of expression evaluation in milliseconds (histogram). */
  EXPRESSION_EVAL_DURATION_MS: 'ai_sdlc.expression_eval.duration_ms',
} as const;

/** Standard attribute keys for spans and metrics. */
export const ATTRIBUTE_KEYS = {
  /** Pipeline resource name. */
  PIPELINE: 'ai_sdlc.pipeline',
  /** Pipeline stage name. */
  STAGE: 'ai_sdlc.stage',
  /** Agent role name. */
  AGENT: 'ai_sdlc.agent',
  /** Quality gate name. */
  GATE: 'ai_sdlc.gate',
  /** Enforcement level (advisory, soft-mandatory, hard-mandatory). */
  ENFORCEMENT: 'ai_sdlc.enforcement',
  /** Result of an operation (pass, fail, override, error). */
  RESULT: 'ai_sdlc.result',
  /** Resource kind (Pipeline, AgentRole, etc.). */
  RESOURCE_KIND: 'ai_sdlc.resource.kind',
  /** Resource name. */
  RESOURCE_NAME: 'ai_sdlc.resource.name',
} as const;

/** The common prefix used by all AI-SDLC semantic conventions. */
export const AI_SDLC_PREFIX = 'ai_sdlc.' as const;
