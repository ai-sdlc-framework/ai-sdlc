export {
  type HarnessAdapter,
  type HarnessAvailability,
  type HarnessCapabilities,
  type HarnessEvent,
  type HarnessInput,
  type HarnessName,
  type HarnessRequires,
  type HarnessResult,
  type HarnessResultStatus,
  type ToolDefinition,
} from './types.js';

export { HarnessRegistry, UnknownHarnessError } from './registry.js';

export { probeVersion, matchesRange } from './version-probe.js';

export {
  enforceIndependence,
  validateIndependenceGraph,
  CyclicIndependenceConstraintError,
  type IndependenceResult,
  type UpstreamRun,
} from './independence.js';

export { ClaudeCodeAdapter, type ClaudeCodeAdapterDeps } from './adapters/claude-code.js';
export { CodexAdapter, type CodexAdapterDeps } from './adapters/codex.js';

import { HarnessRegistry } from './registry.js';
import { ClaudeCodeAdapter } from './adapters/claude-code.js';
import { CodexAdapter } from './adapters/codex.js';

/**
 * Create a registry pre-populated with the v1 adapters (claude-code, codex).
 * Future adapters (gemini-cli, opencode, aider, generic-api) register themselves
 * the same way once their adapter implementations land.
 */
export function createDefaultHarnessRegistry(): HarnessRegistry {
  const reg = new HarnessRegistry();
  reg.register(new ClaudeCodeAdapter());
  reg.register(new CodexAdapter());
  return reg;
}
