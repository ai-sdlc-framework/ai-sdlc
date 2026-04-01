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

export function createPluginMcpServer() {
  const server = new McpServer({
    name: 'ai-sdlc-plugin',
    version: '0.7.0',
  });

  const projectDir =
    process.env.CLAUDE_PROJECT_DIR || process.env.AI_SDLC_PROJECT_ROOT || process.cwd();

  registerAllTools(server, { projectDir });

  return { server };
}
