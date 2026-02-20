import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { CostTracker } from '@ai-sdlc/orchestrator';
import type { ServerDeps } from '../types.js';

export interface TrackUsageResult {
  entryCostUsd: number;
  cumulativeCostUsd: number;
  cumulativeInputTokens: number;
  cumulativeOutputTokens: number;
}

export function handleTrackUsage(
  deps: ServerDeps,
  input: { sessionId?: string; model: string; inputTokens: number; outputTokens: number },
): TrackUsageResult {
  const session = input.sessionId ? deps.sessions.get(input.sessionId) : deps.sessions.getActive();

  const costUsd = CostTracker.computeCost(input.inputTokens, input.outputTokens, input.model);

  // Record in the cost ledger
  deps.costTracker.recordCost({
    runId: session?.sessionId ?? 'unattributed',
    agentName: session?.developer ?? 'unknown',
    pipelineType: 'interactive',
    model: input.model,
    inputTokens: input.inputTokens,
    outputTokens: input.outputTokens,
    issueNumber: session?.linkedIssue ?? undefined,
  });

  // Accumulate in the session
  if (session) {
    deps.sessions.addUsage(session.sessionId, {
      model: input.model,
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      costUsd,
    });
  }

  return {
    entryCostUsd: costUsd,
    cumulativeCostUsd: session?.accumulatedCost.totalCostUsd ?? costUsd,
    cumulativeInputTokens: session?.accumulatedCost.totalInputTokens ?? input.inputTokens,
    cumulativeOutputTokens: session?.accumulatedCost.totalOutputTokens ?? input.outputTokens,
  };
}

export function registerTrackUsage(server: McpServer, deps: ServerDeps): void {
  server.tool(
    'track_usage',
    'Record token usage for cost tracking and budget monitoring.',
    {
      sessionId: z.string().optional().describe('Session ID (defaults to active session)'),
      model: z.string().describe('Model name (e.g. claude-opus-4-6)'),
      inputTokens: z.number().int().min(0).describe('Number of input tokens'),
      outputTokens: z.number().int().min(0).describe('Number of output tokens'),
    },
    async ({ sessionId, model, inputTokens, outputTokens }) => {
      const result = handleTrackUsage(deps, { sessionId, model, inputTokens, outputTokens });
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    },
  );
}
