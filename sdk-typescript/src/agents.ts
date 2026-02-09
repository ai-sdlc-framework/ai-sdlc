/**
 * Agent orchestration patterns, executor, memory, and discovery.
 * Subpath: @ai-sdlc/sdk/agents
 */
export {
  // Orchestration patterns
  sequential,
  parallel,
  hybrid,
  hierarchical,
  swarm,
  router,
  collaborative,
  type OrchestrationPattern,
  type OrchestrationStep,
  type OrchestrationPlan,

  // Executor
  executeOrchestration,
  validateHandoff,
  validateHandoffContract,
  simpleSchemaValidate,
  type AgentExecutionState,
  type StepResult,
  type OrchestrationResult,
  type TaskFn,
  type ExecutionOptions,
  type HandoffValidationError,
  type SchemaResolver,
  type SchemaValidationError,

  // Memory
  createAgentMemory,
  type MemoryTier,
  type MemoryEntry,
  type WorkingMemory,
  type ShortTermMemory,
  type LongTermMemory,
  type SharedMemory,
  type EpisodicMemory,
  type AgentMemory,

  // Discovery
  createAgentDiscovery,
  matchAgentBySkill,
  createStubAgentCardFetcher,
  type AgentDiscovery,
  type AgentFilter,
  type AgentCardFetcher,
  type A2AAgentCard,
} from '@ai-sdlc/reference';
