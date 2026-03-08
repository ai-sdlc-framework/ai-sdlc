import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ServerDeps } from '../types.js';
import { resolveIssue } from '../issue-linker.js';
import { randomUUID } from 'node:crypto';
import { checkForUpdatesCached } from '../version-check.js';

export interface SessionStartResult {
  sessionId: string;
  linkedIssue: number | null;
  linkMethod: string | null;
  project: string;
  updateNotice?: string;
}

export async function handleSessionStart(
  deps: ServerDeps,
  input: { developer: string; tool: string; issueNumber?: number },
): Promise<SessionStartResult> {
  const session = deps.sessions.create({
    developer: input.developer,
    tool: input.tool,
    repoPath: deps.repoPath,
  });

  const resolution = await resolveIssue(deps.repoPath, input.issueNumber);
  deps.sessions.linkIssue(session.sessionId, resolution.issueNumber, resolution.method);

  // Save audit entry
  deps.store.saveAuditEntry({
    entryId: randomUUID(),
    actor: input.developer,
    action: 'session.start',
    resourceType: 'session',
    resourceId: session.sessionId,
    detail: JSON.stringify({
      tool: input.tool,
      linkedIssue: resolution.issueNumber,
      linkMethod: resolution.method,
    }),
  });

  // Check for package updates and auto-update project deps (non-blocking, cached)
  let updateNotice: string | undefined;
  try {
    const projectDirs = deps.workspace ? deps.workspace.repos.map((r) => r.path) : [deps.repoPath];

    const versionCheck = await checkForUpdatesCached({ projectDirs });

    const notices: string[] = [];
    if (versionCheck.autoUpdated.length > 0) {
      notices.push(`Auto-updated: ${versionCheck.autoUpdated.join(', ')}`);
    }
    if (versionCheck.serverUpdateAvailable) {
      notices.push(
        `MCP server update: ${versionCheck.serverVersion} → ${versionCheck.serverLatest}. Restart to apply.`,
      );
    }
    if (notices.length > 0) updateNotice = notices.join('. ');
  } catch {
    // Version check is best-effort
  }

  const result: SessionStartResult = {
    sessionId: session.sessionId,
    linkedIssue: resolution.issueNumber,
    linkMethod: resolution.method,
    project: session.project,
  };
  if (updateNotice) result.updateNotice = updateNotice;

  return result;
}

export function registerSessionStart(server: McpServer, deps: ServerDeps): void {
  server.tool(
    'session_start',
    'Start a governed AI session. Returns session ID, linked issue, and project context.',
    {
      developer: z.string().describe('Developer name or identifier'),
      tool: z.enum(['claude-code', 'copilot', 'cursor', 'other']).describe('AI tool in use'),
      issueNumber: z.number().int().optional().describe('Explicit issue number to link'),
    },
    async ({ developer, tool, issueNumber }) => {
      const result = await handleSessionStart(deps, { developer, tool, issueNumber });
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    },
  );
}
