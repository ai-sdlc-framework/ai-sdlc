/**
 * Jira adapter — implements IssueTracker via Jira Cloud REST API v3.
 * Uses Basic Auth (email:token) and injected HttpClient for testability.
 * <!-- Source: PRD Section 9 -->
 */

import { resolveSecret } from '../resolve-secret.js';
import type {
  IssueTracker,
  Issue,
  IssueFilter,
  IssueComment,
  CreateIssueInput,
  UpdateIssueInput,
  EventStream,
  IssueEvent,
} from '../interfaces.js';

// ── Types ────────────────────────────────────────────────────────────

export type HttpClient = (url: string, init?: RequestInit) => Promise<Response>;

export interface JiraConfig {
  /** Jira Cloud base URL (e.g. 'https://yoursite.atlassian.net'). */
  baseUrl: string;
  /** Jira project key (e.g. 'PROJ'). */
  projectKey: string;
  /** Email for Basic Auth. */
  email?: string;
  /** API token secret reference for Basic Auth. */
  apiToken?: { secretRef: string };
}

// ── Internal Helpers ─────────────────────────────────────────────────

function createDefaultClient(config: JiraConfig): HttpClient {
  const email = config.email ?? '';
  const token = config.apiToken ? resolveSecret(config.apiToken.secretRef) : '';
  const auth = Buffer.from(`${email}:${token}`).toString('base64');

  return async (url: string, init?: RequestInit) => {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Basic ${auth}`,
      ...(init?.headers as Record<string, string>),
    };
    return fetch(url, { ...init, headers });
  };
}

function apiUrl(config: JiraConfig, path: string): string {
  return `${config.baseUrl}/rest/api/3${path}`;
}

/** Wrap plain text in Atlassian Document Format (ADF). */
function toADF(text: string): Record<string, unknown> {
  return {
    type: 'doc',
    version: 1,
    content: [
      {
        type: 'paragraph',
        content: [{ type: 'text', text }],
      },
    ],
  };
}

/** Extract plain text from ADF document. */
function fromADF(adf: unknown): string {
  if (!adf || typeof adf !== 'object') return '';
  const doc = adf as Record<string, unknown>;
  if (doc.type !== 'doc' || !Array.isArray(doc.content)) return '';
  const parts: string[] = [];
  for (const block of doc.content) {
    if (block.type === 'paragraph' && Array.isArray(block.content)) {
      for (const inline of block.content) {
        if (inline.type === 'text' && typeof inline.text === 'string') {
          parts.push(inline.text);
        }
      }
    }
  }
  return parts.join('\n');
}

/** Build JQL from IssueFilter. */
function buildJQL(config: JiraConfig, filter: IssueFilter): string {
  const conditions: string[] = [`project = "${config.projectKey}"`];
  if (filter.status) conditions.push(`status = "${filter.status}"`);
  if (filter.labels?.length) {
    conditions.push(`labels IN (${filter.labels.map((l) => `"${l}"`).join(', ')})`);
  }
  if (filter.assignee) conditions.push(`assignee = "${filter.assignee}"`);
  return conditions.join(' AND ');
}

function mapJiraIssue(data: Record<string, unknown>, baseUrl: string): Issue {
  const fields = data.fields as Record<string, unknown>;
  return {
    id: data.key as string,
    title: (fields.summary as string) ?? '',
    description: fromADF(fields.description),
    status: ((fields.status as Record<string, string>)?.name) ?? 'unknown',
    labels: (fields.labels as string[]) ?? [],
    assignee: (fields.assignee as Record<string, string>)?.displayName,
    url: `${baseUrl}/browse/${data.key}`,
  };
}

function createStubEventStream<T>(): EventStream<T> {
  return {
    async *[Symbol.asyncIterator]() {
      // Stub — real implementation uses webhooks
    },
  };
}

// ── IssueTracker ─────────────────────────────────────────────────────

export function createJiraIssueTracker(
  config: JiraConfig,
  injectedClient?: HttpClient,
): IssueTracker {
  const client = injectedClient ?? createDefaultClient(config);

  return {
    async listIssues(filter: IssueFilter): Promise<Issue[]> {
      const jql = buildJQL(config, filter);
      const res = await client(apiUrl(config, `/search?jql=${encodeURIComponent(jql)}&maxResults=100`));
      if (!res.ok) throw new Error(`Jira listIssues failed: ${res.status}`);
      const data = await res.json();
      return (data.issues ?? []).map((i: Record<string, unknown>) => mapJiraIssue(i, config.baseUrl));
    },

    async getIssue(id: string): Promise<Issue> {
      const res = await client(apiUrl(config, `/issue/${id}`));
      if (!res.ok) throw new Error(`Jira getIssue failed: ${res.status}`);
      const data = await res.json();
      return mapJiraIssue(data, config.baseUrl);
    },

    async createIssue(input: CreateIssueInput): Promise<Issue> {
      const body: Record<string, unknown> = {
        fields: {
          project: { key: config.projectKey },
          summary: input.title,
          issuetype: { name: 'Task' },
          ...(input.description ? { description: toADF(input.description) } : {}),
          ...(input.labels?.length ? { labels: input.labels } : {}),
        },
      };
      const res = await client(apiUrl(config, '/issue'), {
        method: 'POST',
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`Jira createIssue failed: ${res.status}`);
      const data = await res.json();
      // Fetch the full issue to return complete data
      return this.getIssue(data.key);
    },

    async updateIssue(id: string, input: UpdateIssueInput): Promise<Issue> {
      const fields: Record<string, unknown> = {};
      if (input.title) fields.summary = input.title;
      if (input.description) fields.description = toADF(input.description);
      if (input.labels) fields.labels = input.labels;

      const res = await client(apiUrl(config, `/issue/${id}`), {
        method: 'PUT',
        body: JSON.stringify({ fields }),
      });
      if (!res.ok) throw new Error(`Jira updateIssue failed: ${res.status}`);
      return this.getIssue(id);
    },

    async transitionIssue(id: string, transition: string): Promise<Issue> {
      // Step 1: Get available transitions
      const transRes = await client(apiUrl(config, `/issue/${id}/transitions`));
      if (!transRes.ok) throw new Error(`Jira getTransitions failed: ${transRes.status}`);
      const transData = await transRes.json();
      const transitions = transData.transitions as Array<{ id: string; name: string }>;
      const target = transitions.find(
        (t) => t.name.toLowerCase() === transition.toLowerCase(),
      );
      if (!target) {
        throw new Error(`Transition "${transition}" not available for issue ${id}`);
      }

      // Step 2: Execute transition
      const res = await client(apiUrl(config, `/issue/${id}/transitions`), {
        method: 'POST',
        body: JSON.stringify({ transition: { id: target.id } }),
      });
      if (!res.ok) throw new Error(`Jira transitionIssue failed: ${res.status}`);
      return this.getIssue(id);
    },

    async addComment(id: string, body: string): Promise<void> {
      const res = await client(apiUrl(config, `/issue/${id}/comment`), {
        method: 'POST',
        body: JSON.stringify({ body: toADF(body) }),
      });
      if (!res.ok) throw new Error(`Jira addComment failed: ${res.status}`);
    },

    async getComments(id: string): Promise<IssueComment[]> {
      const res = await client(apiUrl(config, `/issue/${id}/comment`));
      if (!res.ok) throw new Error(`Jira getComments failed: ${res.status}`);
      const data = await res.json();
      return (data.comments ?? []).map((c: Record<string, unknown>) => ({
        body: fromADF(c.body),
      }));
    },

    watchIssues(_filter: IssueFilter): EventStream<IssueEvent> {
      return createStubEventStream();
    },
  };
}
