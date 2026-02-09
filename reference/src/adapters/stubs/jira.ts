/**
 * Stub Jira adapter for testing.
 * Implements IssueTracker interface in-memory.
 */

import type {
  IssueTracker,
  IssueFilter,
  Issue,
  CreateIssueInput,
  UpdateIssueInput,
  IssueEvent,
  EventStream,
} from '../interfaces.js';

export interface StubJiraAdapter extends IssueTracker {
  getIssueCount(): number;
  getStoredIssue(id: string): Issue | undefined;
}

export function createStubJira(): StubJiraAdapter {
  const issues = new Map<string, Issue>();
  const comments = new Map<string, string[]>();
  let nextId = 1;

  return {
    async listIssues(filter: IssueFilter): Promise<Issue[]> {
      let result = Array.from(issues.values());
      if (filter.status) result = result.filter((i) => i.status === filter.status);
      if (filter.labels?.length)
        result = result.filter((i) => filter.labels!.some((l) => i.labels?.includes(l)));
      if (filter.assignee) result = result.filter((i) => i.assignee === filter.assignee);
      if (filter.project) result = result.filter((i) => i.url.includes(filter.project!));
      return result;
    },

    async getIssue(id: string): Promise<Issue> {
      const issue = issues.get(id);
      if (!issue) throw new Error(`Issue "${id}" not found`);
      return issue;
    },

    async createIssue(input: CreateIssueInput): Promise<Issue> {
      const id = `JIRA-${nextId++}`;
      const issue: Issue = {
        id,
        title: input.title,
        description: input.description,
        status: 'open',
        labels: input.labels,
        assignee: input.assignee,
        url: `https://jira.example.com/browse/${id}`,
      };
      issues.set(id, issue);
      return issue;
    },

    async updateIssue(id: string, input: UpdateIssueInput): Promise<Issue> {
      const issue = issues.get(id);
      if (!issue) throw new Error(`Issue "${id}" not found`);
      if (input.title !== undefined) issue.title = input.title;
      if (input.description !== undefined) issue.description = input.description;
      if (input.labels !== undefined) issue.labels = input.labels;
      if (input.assignee !== undefined) issue.assignee = input.assignee;
      return issue;
    },

    async transitionIssue(id: string, transition: string): Promise<Issue> {
      const issue = issues.get(id);
      if (!issue) throw new Error(`Issue "${id}" not found`);
      issue.status = transition;
      return issue;
    },

    async addComment(id: string, body: string): Promise<void> {
      if (!issues.has(id)) throw new Error(`Issue "${id}" not found`);
      const existing = comments.get(id) ?? [];
      existing.push(body);
      comments.set(id, existing);
    },

    async getComments(id: string): Promise<Array<{ body: string }>> {
      return (comments.get(id) ?? []).map((body) => ({ body }));
    },

    watchIssues(_filter: IssueFilter): EventStream<IssueEvent> {
      return {
        async *[Symbol.asyncIterator]() {
          // Stub: no events
        },
      };
    },

    getIssueCount(): number {
      return issues.size;
    },

    getStoredIssue(id: string): Issue | undefined {
      return issues.get(id);
    },
  };
}
