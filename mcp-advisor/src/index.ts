// Server factory
export { createMcpServer, type CreateServerOptions } from './server.js';

// Session management
export {
  SessionManager,
  type SessionState,
  type IssueLinkMethod,
  type UsageEntry,
  type AccumulatedCost,
  type CreateSessionOpts,
} from './session.js';

// Issue linker
export { resolveIssue, type IssueResolution } from './issue-linker.js';

// Shared types
export type { ServerDeps } from './types.js';

// Plugin interface
export type { McpAdvisorPlugin } from './plugin.js';

// Tool handlers (for direct testing / programmatic use)
export { handleSessionStart } from './tools/session-start.js';
export { handleGetContext } from './tools/get-context.js';
export { handleCheckTask } from './tools/check-task.js';
export { handleTrackUsage } from './tools/track-usage.js';
export { handleCheckFile } from './tools/check-file.js';
export { handleSessionEnd } from './tools/session-end.js';
