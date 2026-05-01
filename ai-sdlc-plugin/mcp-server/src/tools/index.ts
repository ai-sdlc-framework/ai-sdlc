import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolDeps } from '../types.js';
import { registerCheckPrStatus } from './check-pr-status.js';
import { registerCheckIssue } from './check-issue.js';
import { registerGetGovernanceContext } from './get-governance-context.js';
import { registerListDetectedPatterns } from './list-detected-patterns.js';
import { registerGetReviewPolicy } from './get-review-policy.js';
import { registerTaskEdit } from './task-edit.js';
import { registerTaskComplete } from './task-complete.js';
import { registerPipelineTools } from './pipeline-tools.js';

export function registerAllTools(server: McpServer, deps: ToolDeps): void {
  registerCheckPrStatus(server, deps);
  registerCheckIssue(server, deps);
  registerGetGovernanceContext(server, deps);
  registerListDetectedPatterns(server, deps);
  registerGetReviewPolicy(server, deps);
  registerTaskEdit(server, deps);
  registerTaskComplete(server, deps);
  // RFC-0012 Phase 3 (AISDLC-100.3): wrap each pipeline-cli step function
  // as an MCP tool (`pipeline_step_<N>_<name>`). The 14 tools live in their
  // own file because the registration block is large + uses the same
  // injection pattern as the existing tools above.
  registerPipelineTools(server);
}
