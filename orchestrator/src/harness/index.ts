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
export { OpenCodeAdapter, type OpenCodeAdapterDeps } from './adapters/opencode.js';

import { HarnessRegistry } from './registry.js';
import { ClaudeCodeAdapter } from './adapters/claude-code.js';
import { CodexAdapter } from './adapters/codex.js';
import { OpenCodeAdapter } from './adapters/opencode.js';

/**
 * Create a registry pre-populated with the v1 adapters (claude-code, codex,
 * opencode). Future adapters (gemini-cli, aider, generic-api) register
 * themselves the same way once their implementations land.
 */
export function createDefaultHarnessRegistry(): HarnessRegistry {
  const reg = new HarnessRegistry();
  reg.register(new ClaudeCodeAdapter());
  reg.register(new CodexAdapter());
  reg.register(new OpenCodeAdapter());
  return reg;
}
