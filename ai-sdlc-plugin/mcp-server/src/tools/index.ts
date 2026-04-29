import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolDeps } from '../types.js';
import { registerCheckPrStatus } from './check-pr-status.js';
import { registerCheckIssue } from './check-issue.js';
import { registerGetGovernanceContext } from './get-governance-context.js';
import { registerListDetectedPatterns } from './list-detected-patterns.js';
import { registerGetReviewPolicy } from './get-review-policy.js';
import { registerTaskEdit } from './task-edit.js';
import { registerTaskComplete } from './task-complete.js';

export function registerAllTools(server: McpServer, deps: ToolDeps): void {
  registerCheckPrStatus(server, deps);
  registerCheckIssue(server, deps);
  registerGetGovernanceContext(server, deps);
  registerListDetectedPatterns(server, deps);
  registerGetReviewPolicy(server, deps);
  registerTaskEdit(server, deps);
  registerTaskComplete(server, deps);
}
