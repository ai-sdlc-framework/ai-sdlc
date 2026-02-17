/**
 * In-memory session state manager.
 * Sessions are ephemeral — one per MCP server / IDE window.
 */

import { randomUUID } from 'node:crypto';

export type IssueLinkMethod = 'branch' | 'explicit' | 'git-context' | 'unattributed';

export interface UsageEntry {
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface AccumulatedCost {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
  byModel: Record<string, { inputTokens: number; outputTokens: number; costUsd: number }>;
}

export interface SessionState {
  sessionId: string;
  startedAt: string;
  developer: string;
  tool: string;
  repoPath: string;
  project: string;
  linkedIssue: number | null;
  linkMethod: IssueLinkMethod | null;
  accumulatedCost: AccumulatedCost;
  active: boolean;
}

export interface CreateSessionOpts {
  developer: string;
  tool: string;
  repoPath?: string;
  project?: string;
}

function emptyAccumulatedCost(): AccumulatedCost {
  return { totalInputTokens: 0, totalOutputTokens: 0, totalCostUsd: 0, byModel: {} };
}

export class SessionManager {
  private sessions = new Map<string, SessionState>();

  create(opts: CreateSessionOpts): SessionState {
    const sessionId = randomUUID();
    const session: SessionState = {
      sessionId,
      startedAt: new Date().toISOString(),
      developer: opts.developer,
      tool: opts.tool,
      repoPath: opts.repoPath ?? process.cwd(),
      project: opts.project ?? process.env['AI_SDLC_PROJECT'] ?? '',
      linkedIssue: null,
      linkMethod: null,
      accumulatedCost: emptyAccumulatedCost(),
      active: true,
    };
    this.sessions.set(sessionId, session);
    return session;
  }

  get(sessionId: string): SessionState | undefined {
    return this.sessions.get(sessionId);
  }

  getActive(): SessionState | undefined {
    for (const s of this.sessions.values()) {
      if (s.active) return s;
    }
    return undefined;
  }

  addUsage(sessionId: string, entry: UsageEntry): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    const cost = session.accumulatedCost;
    cost.totalInputTokens += entry.inputTokens;
    cost.totalOutputTokens += entry.outputTokens;
    cost.totalCostUsd += entry.costUsd;

    const model = cost.byModel[entry.model] ?? { inputTokens: 0, outputTokens: 0, costUsd: 0 };
    model.inputTokens += entry.inputTokens;
    model.outputTokens += entry.outputTokens;
    model.costUsd += entry.costUsd;
    cost.byModel[entry.model] = model;
  }

  linkIssue(sessionId: string, issueNumber: number | null, method: IssueLinkMethod): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.linkedIssue = issueNumber;
    session.linkMethod = method;
  }

  end(sessionId: string): SessionState | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;
    session.active = false;
    return session;
  }
}
