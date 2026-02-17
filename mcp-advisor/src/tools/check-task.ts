import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ServerDeps } from '../types.js';

export interface CheckTaskResult {
  issueNumber: number | null;
  autonomyLevel: number | null;
  pipelineRuns: number;
  constraints: string[];
  advisoryNotes: string[];
}

export function handleCheckTask(
  deps: ServerDeps,
  input: { sessionId?: string; issueNumber?: number },
): CheckTaskResult {
  const session = input.sessionId
    ? deps.sessions.get(input.sessionId)
    : deps.sessions.getActive();

  const issueNumber = input.issueNumber ?? session?.linkedIssue ?? null;

  const advisoryNotes: string[] = [];
  const constraints: string[] = [];

  // Look up pipeline runs for the issue
  const runs = issueNumber != null
    ? deps.store.getPipelineRuns(issueNumber, 10)
    : [];

  if (runs.length > 0) {
    const latest = runs[0];
    if (latest.status === 'running') {
      advisoryNotes.push(`Pipeline run ${latest.runId} is currently running (stage: ${latest.currentStage ?? 'unknown'})`);
    }
    if (latest.status === 'failed') {
      advisoryNotes.push(`Last pipeline run failed: ${latest.result ?? 'no details'}`);
    }
  }

  // Autonomy level from ledger (use 'interactive' as the agent name for IDE sessions)
  let autonomyLevel: number | null = null;
  const ledger = deps.store.getAutonomyLedger('interactive');
  if (ledger) {
    autonomyLevel = ledger.currentLevel;
    if (ledger.currentLevel <= 1) {
      advisoryNotes.push('Low autonomy level — consider requesting human review for significant changes.');
    }
  }

  if (issueNumber == null) {
    advisoryNotes.push('No issue linked to this session — work will be unattributed.');
  }

  return {
    issueNumber,
    autonomyLevel,
    pipelineRuns: runs.length,
    constraints,
    advisoryNotes,
  };
}

export function registerCheckTask(server: McpServer, deps: ServerDeps): void {
  server.tool(
    'check_task',
    'Check task status, constraints, and autonomy level for the current session or issue.',
    {
      sessionId: z.string().optional().describe('Session ID (defaults to active session)'),
      issueNumber: z.number().int().optional().describe('Override issue number'),
    },
    async ({ sessionId, issueNumber }) => {
      const result = handleCheckTask(deps, { sessionId, issueNumber });
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    },
  );
}
