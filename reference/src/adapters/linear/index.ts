/**
 * Linear adapter — implements the IssueTracker interface.
 * Uses the @linear/sdk for API access.
 */

import { LinearClient } from '@linear/sdk';
import { resolveSecret } from '../resolve-secret.js';
import type {
  IssueTracker,
  Issue,
  IssueFilter,
  CreateIssueInput,
  UpdateIssueInput,
  EventStream,
  IssueEvent,
} from '../interfaces.js';

export type LinearConfig = {
  teamId: string;
  apiKey?: { secretRef: string };
  defaultLabels?: string[];
};

// ── Internal types ────────────────────────────────────────────────────

/** Minimal client interface for dependency injection and testing. */
export interface LinearClientLike {
  issues(params: { filter: unknown }): Promise<{ nodes: unknown[] }>;
  issue(id: string): Promise<unknown>;
  createIssue(input: Record<string, unknown>): Promise<{ issue: Promise<unknown> | unknown }>;
  updateIssue(id: string, input: Record<string, unknown>): Promise<unknown>;
  issueLabels(): Promise<{ nodes: { id: string; name: string }[] }>;
  team(id: string): Promise<{ states(): Promise<{ nodes: { id: string; name: string }[] }> }>;
}

interface LinearIssueNode {
  id: string;
  title: string;
  description?: string;
  state: Promise<{ name: string }> | { name: string };
  labels: () => Promise<{ nodes: { name: string }[] }>;
  assignee?: Promise<{ name: string } | null> | { name: string } | null;
  url: string;
}

// ── Internal helpers ──────────────────────────────────────────────────

async function mapLinearIssue(node: LinearIssueNode): Promise<Issue> {
  const state = await Promise.resolve(node.state);
  const labelsResult = await node.labels();
  const assignee = await Promise.resolve(node.assignee);

  return {
    id: node.id,
    title: node.title,
    description: node.description,
    status: state.name,
    labels: labelsResult.nodes.map((l: { name: string }) => l.name),
    assignee:
      assignee && typeof assignee === 'object' && 'name' in assignee ? assignee.name : undefined,
    url: node.url,
  };
}

function createStubEventStream<T>(): EventStream<T> {
  return {
    async *[Symbol.asyncIterator]() {
      // Stub — real implementation requires webhooks
    },
  };
}

// ── IssueTracker ──────────────────────────────────────────────────────

export function createLinearIssueTracker(
  config: LinearConfig,
  injectedClient?: LinearClientLike,
): IssueTracker {
  let client: LinearClientLike;

  if (injectedClient) {
    client = injectedClient;
  } else {
    const apiKey = config.apiKey ? resolveSecret(config.apiKey.secretRef) : undefined;
    if (!apiKey) {
      throw new Error('Linear API key is required');
    }
    client = new LinearClient({ apiKey }) as unknown as LinearClientLike;
  }

  return {
    async listIssues(filter: IssueFilter): Promise<Issue[]> {
      const filterObj: Record<string, unknown> = {
        team: { id: { eq: config.teamId } },
      };
      if (filter.labels?.length) {
        filterObj.labels = { name: { in: filter.labels } };
      }
      if (filter.assignee) {
        filterObj.assignee = { name: { eq: filter.assignee } };
      }

      const result = await client.issues({ filter: filterObj });
      const issues: Issue[] = [];
      for (const node of result.nodes) {
        issues.push(await mapLinearIssue(node as unknown as LinearIssueNode));
      }
      return issues;
    },

    async getIssue(id: string): Promise<Issue> {
      const issue = await client.issue(id);
      return mapLinearIssue(issue as unknown as LinearIssueNode);
    },

    async createIssue(input: CreateIssueInput): Promise<Issue> {
      const labelIds: string[] = [];
      if (input.labels?.length) {
        const allLabels = await client.issueLabels();
        for (const name of input.labels) {
          const found = allLabels.nodes.find((l) => l.name === name);
          if (found) labelIds.push(found.id);
        }
      }

      const result = await client.createIssue({
        teamId: config.teamId,
        title: input.title,
        description: input.description,
        labelIds: labelIds.length > 0 ? labelIds : undefined,
      });

      const issue = await Promise.resolve(result.issue);
      if (!issue) throw new Error('Failed to create Linear issue');
      return mapLinearIssue(issue as unknown as LinearIssueNode);
    },

    async updateIssue(id: string, input: UpdateIssueInput): Promise<Issue> {
      const updates: Record<string, unknown> = {};
      if (input.title) updates.title = input.title;
      if (input.description) updates.description = input.description;

      await client.updateIssue(id, updates);
      const issue = await client.issue(id);
      return mapLinearIssue(issue as unknown as LinearIssueNode);
    },

    async transitionIssue(id: string, transition: string): Promise<Issue> {
      const team = await client.team(config.teamId);
      const states = await team.states();
      const targetState = states.nodes.find(
        (s) => s.name.toLowerCase() === transition.toLowerCase(),
      );

      if (!targetState) {
        throw new Error(`State "${transition}" not found for team ${config.teamId}`);
      }

      await client.updateIssue(id, { stateId: targetState.id });
      const issue = await client.issue(id);
      return mapLinearIssue(issue as unknown as LinearIssueNode);
    },

    async addComment(_id: string, _body: string): Promise<void> {
      // Stub — Linear comment API not yet integrated
    },

    async getComments(_id: string): Promise<Array<{ body: string }>> {
      return [];
    },

    watchIssues(_filter: IssueFilter): EventStream<IssueEvent> {
      return createStubEventStream();
    },
  };
}
