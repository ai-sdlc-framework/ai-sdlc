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
  updateAvailable?: string;
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

  // Check for package updates (non-blocking, cached)
  let updateAvailable: string | undefined;
  try {
    const versionCheck = await checkForUpdatesCached();
    if (versionCheck.hasUpdates) {
      const outdated = versionCheck.updates
        .filter((u) => u.updateAvailable)
        .map((u) => `${u.package} ${u.current} → ${u.latest}`)
        .join(', ');
      updateAvailable = `Update available: ${outdated}. Run: ${versionCheck.updateCommand}`;
    }
  } catch {
    // Version check is best-effort
  }

  const result: SessionStartResult = {
    sessionId: session.sessionId,
    linkedIssue: resolution.issueNumber,
    linkMethod: resolution.method,
    project: session.project,
  };
  if (updateAvailable) result.updateAvailable = updateAvailable;

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
