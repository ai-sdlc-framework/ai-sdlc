/**
 * MCP server factory for the AI-SDLC Claude Code plugin.
 *
 * Exposes governance tools that Claude can call during a session:
 * - check_pr_status: PR checks, reviews, merge readiness
 * - check_issue: Issue details, labels, PPA scoring context
 * - get_governance_context: Current agent-role.yaml constraints
 * - list_detected_patterns: Workflow patterns from telemetry
 * - get_review_policy: Review policy calibration content
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerAllTools } from './tools/index.js';
import { resolveProjectRoot } from './lib/resolve-project-root.js';

export function createPluginMcpServer() {
  const server = new McpServer({
    name: 'ai-sdlc-plugin',
    version: '0.7.0',
  });

  // Project-root resolution (AISDLC-99). Tools that touch the filesystem
  // (task_edit, task_complete, get_governance_context, ...) need the actual
  // project root the user is working in — NOT the plugin's data dir, which
  // is what `${CLAUDE_PLUGIN_DATA}` (the env var the plugin's `plugin.json`
  // sets `AI_SDLC_PROJECT_ROOT` to) resolves to. The resolver walks up from
  // cwd when the env var is missing or doesn't contain a `backlog/` dir.
  //
  // We resolve lazily (with a fallback) so MCP server boot doesn't crash on
  // sessions where no backlog/ is reachable — those sessions still get the
  // non-filesystem tools (check_pr_status, check_issue, ...). The
  // filesystem-touching tools surface a clear error at call time.
  let projectDir: string;
  try {
    projectDir = resolveProjectRoot();
  } catch {
    projectDir = process.cwd();
  }

  registerAllTools(server, { projectDir });

  return { server };
}
