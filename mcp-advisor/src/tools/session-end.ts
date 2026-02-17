import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import type { ServerDeps } from '../types.js';

export interface SessionEndResult {
  sessionId: string;
  durationMs: number;
  linkedIssue: number | null;
  totalCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  byModel: Record<string, { inputTokens: number; outputTokens: number; costUsd: number }>;
}

export function handleSessionEnd(
  deps: ServerDeps,
  input: { sessionId?: string; summary?: string },
): SessionEndResult | null {
  const sessionId = input.sessionId ?? deps.sessions.getActive()?.sessionId;
  if (!sessionId) return null;

  const session = deps.sessions.end(sessionId);
  if (!session) return null;

  const durationMs = Date.now() - new Date(session.startedAt).getTime();

  // Save episodic record
  deps.store.saveEpisodicRecord({
    issueNumber: session.linkedIssue ?? undefined,
    pipelineType: 'interactive',
    outcome: 'completed',
    durationMs,
    agentName: session.developer,
    costUsd: session.accumulatedCost.totalCostUsd,
    metadata: JSON.stringify({
      tool: session.tool,
      summary: input.summary,
      linkMethod: session.linkMethod,
      byModel: session.accumulatedCost.byModel,
    }),
  });

  // Save audit entry
  deps.store.saveAuditEntry({
    entryId: randomUUID(),
    actor: session.developer,
    action: 'session.end',
    resourceType: 'session',
    resourceId: session.sessionId,
    detail: JSON.stringify({
      durationMs,
      totalCostUsd: session.accumulatedCost.totalCostUsd,
      linkedIssue: session.linkedIssue,
      summary: input.summary,
    }),
  });

  return {
    sessionId: session.sessionId,
    durationMs,
    linkedIssue: session.linkedIssue,
    totalCostUsd: session.accumulatedCost.totalCostUsd,
    totalInputTokens: session.accumulatedCost.totalInputTokens,
    totalOutputTokens: session.accumulatedCost.totalOutputTokens,
    byModel: session.accumulatedCost.byModel,
  };
}

export function registerSessionEnd(server: McpServer, deps: ServerDeps): void {
  server.tool(
    'session_end',
    'End the current session and get a cost receipt with full breakdown.',
    {
      sessionId: z.string().optional().describe('Session ID (defaults to active session)'),
      summary: z.string().optional().describe('Brief summary of what was accomplished'),
    },
    async ({ sessionId, summary }) => {
      const result = handleSessionEnd(deps, { sessionId, summary });
      if (!result) {
        return { content: [{ type: 'text' as const, text: 'No active session to end.' }] };
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    },
  );
}
