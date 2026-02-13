/**
 * Custom adapter implementation example.
 *
 * Demonstrates implementing the IssueTracker interface from scratch,
 * registering it, and using the webhook bridge.
 *
 * Run: npx tsx docs/examples/adapter-implementation.ts
 */

import type { IssueTracker, Issue, IssueFilter, EventStream } from '@ai-sdlc/reference';
import {
  createAdapterRegistry,
  createWebhookBridge,
  createInProcessEventBus,
  AdapterBindingBuilder,
  validateResource,
} from '@ai-sdlc/reference';

// ── 1. Implement the IssueTracker interface ───────────────────────────

interface InMemoryConfig {
  projectKey: string;
}

function createInMemoryIssueTracker(config: InMemoryConfig): IssueTracker {
  const issues = new Map<string, Issue>();
  let counter = 0;

  return {
    async listIssues(filter: IssueFilter): Promise<Issue[]> {
      return Array.from(issues.values()).filter((issue) => {
        if (filter.status && issue.status !== filter.status) return false;
        if (filter.assignee && issue.assignee !== filter.assignee) return false;
        if (filter.labels?.length) {
          const issueLabels = issue.labels ?? [];
          if (!filter.labels.some((l) => issueLabels.includes(l))) return false;
        }
        return true;
      });
    },

    async getIssue(id: string): Promise<Issue> {
      const issue = issues.get(id);
      if (!issue) throw new Error(`Issue ${id} not found`);
      return issue;
    },

    async createIssue(input): Promise<Issue> {
      const id = `${config.projectKey}-${++counter}`;
      const issue: Issue = {
        id,
        title: input.title,
        description: input.description,
        status: 'open',
        labels: input.labels,
        assignee: input.assignee,
        url: `https://example.com/issues/${id}`,
      };
      issues.set(id, issue);
      return issue;
    },

    async updateIssue(id: string, input): Promise<Issue> {
      const issue = issues.get(id);
      if (!issue) throw new Error(`Issue ${id} not found`);
      const updated: Issue = {
        ...issue,
        ...(input.title && { title: input.title }),
        ...(input.description && { description: input.description }),
        ...(input.labels && { labels: input.labels }),
        ...(input.assignee && { assignee: input.assignee }),
      };
      issues.set(id, updated);
      return updated;
    },

    async transitionIssue(id: string, transition: string): Promise<Issue> {
      const issue = issues.get(id);
      if (!issue) throw new Error(`Issue ${id} not found`);
      const updated = { ...issue, status: transition };
      issues.set(id, updated);
      return updated;
    },

    async addComment(_id: string, _body: string): Promise<void> {
      // No-op for in-memory adapter
    },

    async getComments(_id: string) {
      return [];
    },

    watchIssues(_filter: IssueFilter): EventStream<any> {
      throw new Error('Watch not supported in in-memory adapter');
    },
  };
}

// ── 2. Register the adapter ───────────────────────────────────────────

const registry = createAdapterRegistry();

registry.register(
  {
    name: 'in-memory',
    interface: 'IssueTracker',
    type: 'in-memory',
    version: '1.0.0',
    stability: 'experimental',
    description: 'In-memory issue tracker for testing and examples',
  },
  (config) => createInMemoryIssueTracker(config as InMemoryConfig),
);

// List registered adapters
console.log(
  'Registered adapters:',
  registry.list().map((a) => `${a.interface}/${a.name}`),
);

// ── 3. Instantiate and use ────────────────────────────────────────────

const factory = registry.get('IssueTracker', 'in-memory')!;
const tracker = factory({ projectKey: 'TEST' }) as IssueTracker;

const created = await tracker.createIssue({
  title: 'Add user authentication',
  description: 'Implement JWT-based auth with login/logout endpoints',
  labels: ['feature', 'ai-eligible'],
});
console.log('Created:', created.id, '-', created.title);

await tracker.transitionIssue(created.id, 'in-progress');
const updated = await tracker.getIssue(created.id);
console.log('Status:', updated.status);

const openIssues = await tracker.listIssues({ status: 'in-progress' });
console.log('In-progress issues:', openIssues.length);

// ── 4. Webhook bridge ─────────────────────────────────────────────────

const bridge = createWebhookBridge();

bridge.transform('custom:issue_updated', (payload: any) => ({
  type: 'updated',
  issue: payload.issue,
  timestamp: new Date().toISOString(),
}));

bridge.on('custom:issue_updated', (event) => {
  console.log('Webhook event received:', (event as any).type);
});

bridge.emit('custom:issue_updated', { issue: updated });

// ── 5. In-process EventBus ────────────────────────────────────────────

const bus = createInProcessEventBus();

const unsub = bus.subscribe('issue.created', (payload) => {
  console.log('EventBus — issue.created:', (payload as any).id);
});

await bus.publish('issue.created', { id: created.id, title: created.title });
unsub();

// ── 6. AdapterBinding resource ────────────────────────────────────────

const binding = new AdapterBindingBuilder('in-memory-tracker', 'IssueTracker', 'in-memory', '1.0.0')
  .label('adapter', 'in-memory')
  .config({ projectKey: 'TEST' })
  .build();

const result = validateResource(binding);
console.log('AdapterBinding valid:', result.valid);
