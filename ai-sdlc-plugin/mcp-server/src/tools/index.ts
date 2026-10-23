import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolDeps } from '../types.js';
import { registerCheckPrStatus } from './check-pr-status.js';
import { registerCheckIssue } from './check-issue.js';
import { registerGetGovernanceContext } from './get-governance-context.js';
import { registerListDetectedPatterns } from './list-detected-patterns.js';
import { registerGetReviewPolicy } from './get-review-policy.js';
import { registerTaskCreate } from './task-create.js';
import { registerTaskEdit } from './task-edit.js';
import { registerTaskComplete } from './task-complete.js';
import { registerNextTaskId } from './next-task-id.js';

export function registerAllTools(server: McpServer, deps: ToolDeps): void {
  registerCheckPrStatus(server, deps);
  registerCheckIssue(server, deps);
  registerGetGovernanceContext(server, deps);
  registerListDetectedPatterns(server, deps);
  registerGetReviewPolicy(server, deps);
  registerTaskCreate(server, deps);
  registerTaskEdit(server, deps);
  registerTaskComplete(server, deps);
  // AISDLC-559: worktree-aware backlog task ID allocator — union of git refs
  // (all branches/remotes/tags), sibling worktree filesystems, and the
  // current worktree. Registered before task_create in no particular order
  // (both are independent tools); task_create itself also consumes the
  // scanner + lock directly for its own cross-source collision refusal.
  registerNextTaskId(server, deps);
  // RFC-0056 phase 3 (AISDLC-993): the pipeline_step_* tools are removed; `next-step` is the one orchestrator.
}
