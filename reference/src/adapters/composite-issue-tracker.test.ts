import { describe, it, expect } from 'vitest';
import { createCompositeIssueTracker } from './composite-issue-tracker.js';
import { createWebhookBridge } from './webhook-bridge.js';
import type {
  IssueTracker,
  IssueFilter,
  Issue,
  CreateIssueInput,
  UpdateIssueInput,
  IssueEvent,
  IssueComment,
  EventStream,
} from './interfaces.js';

/** Create a minimal mock IssueTracker with configurable behavior. */
function createMock(options: {
  prefix: string;
  issues?: Issue[];
  listError?: Error;
}): IssueTracker & { calls: Record<string, unknown[][]> } {
  const calls: Record<string, unknown[][]> = {};
  const track = (method: string, args: unknown[]) => {
    (calls[method] ??= []).push(args);
  };
  const issues = new Map<string, Issue>();
  for (const i of options.issues ?? []) issues.set(i.id, i);
  let nextId = issues.size + 1;

  return {
    calls,
    async listIssues(filter: IssueFilter): Promise<Issue[]> {
      track('listIssues', [filter]);
      if (options.listError) throw options.listError;
      let result = Array.from(issues.values());
      if (filter.status) result = result.filter((i) => i.status === filter.status);
      return result;
    },
    async getIssue(id: string): Promise<Issue> {
      track('getIssue', [id]);
      const issue = issues.get(id);
      if (!issue) throw new Error(`Not found: ${id}`);
      return issue;
    },
    async createIssue(input: CreateIssueInput): Promise<Issue> {
      track('createIssue', [input]);
      const id = `${options.prefix}-${nextId++}`;
      const issue: Issue = {
        id,
        title: input.title,
        description: input.description,
        status: 'open',
        labels: input.labels,
        assignee: input.assignee,
        url: `https://example.com/${id}`,
      };
      issues.set(id, issue);
      return issue;
    },
    async updateIssue(id: string, input: UpdateIssueInput): Promise<Issue> {
      track('updateIssue', [id, input]);
      const issue = issues.get(id);
      if (!issue) throw new Error(`Not found: ${id}`);
      if (input.title !== undefined) issue.title = input.title;
      return issue;
    },
    async transitionIssue(id: string, transition: string): Promise<Issue> {
      track('transitionIssue', [id, transition]);
      const issue = issues.get(id);
      if (!issue) throw new Error(`Not found: ${id}`);
      issue.status = transition;
      return issue;
    },
    async addComment(id: string, body: string): Promise<void> {
      track('addComment', [id, body]);
    },
    async getComments(id: string): Promise<IssueComment[]> {
      track('getComments', [id]);
      return [];
    },
    watchIssues(_filter: IssueFilter): EventStream<IssueEvent> {
      return {
        async *[Symbol.asyncIterator]() {
          // Stub: no events
        },
      };
    },
  };
}

function issue(id: string, title: string): Issue {
  return { id, title, status: 'open', url: `https://example.com/${id}` };
}

describe('createCompositeIssueTracker', () => {
  it('throws on empty backends list', () => {
    expect(() => createCompositeIssueTracker({ backends: [] })).toThrow('at least one backend');
  });

  // ── listIssues ─────────────────────────────────────────────────────

  it('listIssues fans out and merges results from 2 backends', async () => {
    const jira = createMock({ prefix: 'JIRA', issues: [issue('JIRA-1', 'Jira bug')] });
    const backlog = createMock({ prefix: 'TASK', issues: [issue('TASK-1', 'Backlog task')] });

    const composite = createCompositeIssueTracker({
      backends: [
        { prefix: 'JIRA', adapter: jira },
        { prefix: 'TASK', adapter: backlog },
      ],
    });

    const results = await composite.listIssues({});
    expect(results).toHaveLength(2);
    expect(results.map((i) => i.id).sort()).toEqual(['JIRA-1', 'TASK-1']);
  });

  it('listIssues returns partial results when one backend fails', async () => {
    const jira = createMock({
      prefix: 'JIRA',
      issues: [issue('JIRA-1', 'Jira bug')],
      listError: new Error('Jira down'),
    });
    const backlog = createMock({ prefix: 'TASK', issues: [issue('TASK-1', 'Backlog task')] });

    const composite = createCompositeIssueTracker({
      backends: [
        { prefix: 'JIRA', adapter: jira },
        { prefix: 'TASK', adapter: backlog },
      ],
    });

    const results = await composite.listIssues({});
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('TASK-1');
  });

  it('listIssues throws aggregated error when all backends fail', async () => {
    const jira = createMock({ prefix: 'JIRA', listError: new Error('Jira down') });
    const backlog = createMock({ prefix: 'TASK', listError: new Error('Backlog down') });

    const composite = createCompositeIssueTracker({
      backends: [
        { prefix: 'JIRA', adapter: jira },
        { prefix: 'TASK', adapter: backlog },
      ],
    });

    await expect(composite.listIssues({})).rejects.toThrow('All backends failed');
  });

  it('listIssues passes filter to all backends', async () => {
    const jira = createMock({ prefix: 'JIRA', issues: [issue('JIRA-1', 'Jira bug')] });
    const backlog = createMock({ prefix: 'TASK', issues: [issue('TASK-1', 'Backlog task')] });

    const composite = createCompositeIssueTracker({
      backends: [
        { prefix: 'JIRA', adapter: jira },
        { prefix: 'TASK', adapter: backlog },
      ],
    });

    const filter: IssueFilter = { status: 'open' };
    await composite.listIssues(filter);

    expect(jira.calls['listIssues']).toEqual([[filter]]);
    expect(backlog.calls['listIssues']).toEqual([[filter]]);
  });

  // ── getIssue routing ───────────────────────────────────────────────

  it('getIssue routes by prefix', async () => {
    const jira = createMock({ prefix: 'JIRA', issues: [issue('JIRA-1', 'Jira bug')] });
    const backlog = createMock({ prefix: 'TASK', issues: [issue('TASK-1', 'Backlog task')] });

    const composite = createCompositeIssueTracker({
      backends: [
        { prefix: 'JIRA', adapter: jira },
        { prefix: 'TASK', adapter: backlog },
      ],
    });

    const result = await composite.getIssue('JIRA-1');
    expect(result.title).toBe('Jira bug');

    const result2 = await composite.getIssue('TASK-1');
    expect(result2.title).toBe('Backlog task');
  });

  it('getIssue routes to fallback for unmatched prefix', async () => {
    const github = createMock({ prefix: 'GH', issues: [issue('123', 'GitHub issue')] });

    const composite = createCompositeIssueTracker({
      backends: [
        { prefix: 'JIRA', adapter: createMock({ prefix: 'JIRA' }) },
        { prefix: null, adapter: github },
      ],
    });

    const result = await composite.getIssue('123');
    expect(result.title).toBe('GitHub issue');
  });

  it('getIssue throws for unknown ID when no fallback', async () => {
    const composite = createCompositeIssueTracker({
      backends: [{ prefix: 'JIRA', adapter: createMock({ prefix: 'JIRA' }) }],
    });

    await expect(composite.getIssue('UNKNOWN-1')).rejects.toThrow(
      'No backend configured for issue "UNKNOWN-1"',
    );
  });

  // ── createIssue ────────────────────────────────────────────────────

  it('createIssue routes to primary backend', async () => {
    const jira = createMock({ prefix: 'JIRA' });
    const backlog = createMock({ prefix: 'TASK' });

    const composite = createCompositeIssueTracker({
      backends: [
        { prefix: 'JIRA', adapter: jira },
        { prefix: 'TASK', adapter: backlog },
      ],
      primaryIndex: 1,
    });

    const result = await composite.createIssue({ title: 'New task' });
    expect(result.id).toMatch(/^TASK-/);
    expect(jira.calls['createIssue']).toBeUndefined();
    expect(backlog.calls['createIssue']).toHaveLength(1);
  });

  // ── updateIssue ────────────────────────────────────────────────────

  it('updateIssue routes by prefix', async () => {
    const jira = createMock({ prefix: 'JIRA', issues: [issue('JIRA-1', 'Jira bug')] });
    const backlog = createMock({ prefix: 'TASK', issues: [issue('TASK-1', 'Backlog task')] });

    const composite = createCompositeIssueTracker({
      backends: [
        { prefix: 'JIRA', adapter: jira },
        { prefix: 'TASK', adapter: backlog },
      ],
    });

    await composite.updateIssue('TASK-1', { title: 'Updated' });
    expect(backlog.calls['updateIssue']).toEqual([['TASK-1', { title: 'Updated' }]]);
    expect(jira.calls['updateIssue']).toBeUndefined();
  });

  // ── transitionIssue ────────────────────────────────────────────────

  it('transitionIssue routes by prefix', async () => {
    const jira = createMock({ prefix: 'JIRA', issues: [issue('JIRA-1', 'Jira bug')] });

    const composite = createCompositeIssueTracker({
      backends: [{ prefix: 'JIRA', adapter: jira }],
    });

    await composite.transitionIssue('JIRA-1', 'in-progress');
    expect(jira.calls['transitionIssue']).toEqual([['JIRA-1', 'in-progress']]);
  });

  // ── addComment ─────────────────────────────────────────────────────

  it('addComment routes by prefix', async () => {
    const backlog = createMock({ prefix: 'TASK', issues: [issue('TASK-1', 'Task')] });

    const composite = createCompositeIssueTracker({
      backends: [{ prefix: 'TASK', adapter: backlog }],
    });

    await composite.addComment('TASK-1', 'Hello');
    expect(backlog.calls['addComment']).toEqual([['TASK-1', 'Hello']]);
  });

  // ── getComments ────────────────────────────────────────────────────

  it('getComments routes by prefix', async () => {
    const jira = createMock({ prefix: 'JIRA', issues: [issue('JIRA-1', 'Bug')] });

    const composite = createCompositeIssueTracker({
      backends: [{ prefix: 'JIRA', adapter: jira }],
    });

    await composite.getComments('JIRA-1');
    expect(jira.calls['getComments']).toEqual([['JIRA-1']]);
  });

  // ── watchIssues ────────────────────────────────────────────────────

  it('watchIssues merges events from multiple backends', async () => {
    const bridge1 = createWebhookBridge<IssueEvent>((p) => p as IssueEvent);
    const bridge2 = createWebhookBridge<IssueEvent>((p) => p as IssueEvent);

    const backend1: IssueTracker = {
      ...createMock({ prefix: 'A' }),
      watchIssues: () => bridge1.stream(),
    };
    const backend2: IssueTracker = {
      ...createMock({ prefix: 'B' }),
      watchIssues: () => bridge2.stream(),
    };

    const composite = createCompositeIssueTracker({
      backends: [
        { prefix: 'A', adapter: backend1 },
        { prefix: 'B', adapter: backend2 },
      ],
    });

    const stream = composite.watchIssues({});
    const iter = stream[Symbol.asyncIterator]();

    const event1: IssueEvent = {
      type: 'created',
      issue: issue('A-1', 'From A'),
      timestamp: '2024-01-01T00:00:00Z',
    };
    const event2: IssueEvent = {
      type: 'updated',
      issue: issue('B-1', 'From B'),
      timestamp: '2024-01-01T00:00:01Z',
    };

    bridge1.push(event1);
    bridge2.push(event2);

    const r1 = await iter.next();
    const r2 = await iter.next();

    expect(r1.done).toBe(false);
    expect(r2.done).toBe(false);

    const received = [r1.value, r2.value];
    expect(received).toContainEqual(event1);
    expect(received).toContainEqual(event2);

    // Cleanup
    bridge1.close();
    bridge2.close();
    await iter.return!();
  });

  it('watchIssues returns empty iterator when all children return stubs', async () => {
    const composite = createCompositeIssueTracker({
      backends: [{ prefix: 'JIRA', adapter: createMock({ prefix: 'JIRA' }) }],
    });

    const stream = composite.watchIssues({});
    const iter = stream[Symbol.asyncIterator]();

    // The stub generators complete immediately, so the merged stream should end
    const result = await iter.next();
    expect(result.done).toBe(true);
  });
});
