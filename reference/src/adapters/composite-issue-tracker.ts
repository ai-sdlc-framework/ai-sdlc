/**
 * Composite IssueTracker adapter.
 * Wraps N child IssueTracker instances behind a single IssueTracker interface,
 * routing by ID prefix.
 */

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
import { createWebhookBridge } from './webhook-bridge.js';

export interface BackendRoute {
  /** Prefix to match against issue IDs (e.g., "AISDLC", "JIRA"). Null = fallback. */
  prefix: string | null;
  adapter: IssueTracker;
}

export interface CompositeIssueTrackerConfig {
  backends: BackendRoute[];
  /** Index into backends array for createIssue routing. Defaults to 0. */
  primaryIndex?: number;
}

/**
 * Route an ID to a backend by prefix match.
 * Checks `id.toUpperCase().startsWith(prefix.toUpperCase() + '-')`.
 * Falls back to the backend with `prefix: null`, or throws if none.
 */
function routeById(id: string, backends: BackendRoute[]): IssueTracker {
  const upper = id.toUpperCase();
  for (const b of backends) {
    if (b.prefix !== null && upper.startsWith(b.prefix.toUpperCase() + '-')) {
      return b.adapter;
    }
  }
  // Fallback: first backend with prefix === null
  const fallback = backends.find((b) => b.prefix === null);
  if (fallback) return fallback.adapter;
  throw new Error(`No backend configured for issue "${id}"`);
}

/**
 * Merge multiple EventStreams into one via WebhookBridge.
 */
function mergeEventStreams(streams: EventStream<IssueEvent>[]): EventStream<IssueEvent> {
  const bridge = createWebhookBridge<IssueEvent>((payload) => payload as IssueEvent);

  let activeCount = streams.length;

  for (const stream of streams) {
    // Spawn async drain task per child stream
    (async () => {
      try {
        for await (const event of stream) {
          bridge.push(event);
        }
      } catch {
        // Ignore errors from individual streams
      } finally {
        activeCount--;
        if (activeCount === 0) {
          bridge.close();
        }
      }
    })();
  }

  // If no streams, close immediately
  if (streams.length === 0) {
    bridge.close();
  }

  return bridge.stream();
}

export function createCompositeIssueTracker(config: CompositeIssueTrackerConfig): IssueTracker {
  const { backends, primaryIndex = 0 } = config;

  if (backends.length === 0) {
    throw new Error('CompositeIssueTracker requires at least one backend');
  }

  return {
    async listIssues(filter: IssueFilter): Promise<Issue[]> {
      const results = await Promise.allSettled(backends.map((b) => b.adapter.listIssues(filter)));

      const issues: Issue[] = [];
      const errors: Error[] = [];

      for (const result of results) {
        if (result.status === 'fulfilled') {
          issues.push(...result.value);
        } else {
          errors.push(
            result.reason instanceof Error ? result.reason : new Error(String(result.reason)),
          );
        }
      }

      if (issues.length === 0 && errors.length > 0) {
        throw new AggregateError(errors, 'All backends failed in listIssues');
      }

      return issues;
    },

    async getIssue(id: string): Promise<Issue> {
      return routeById(id, backends).getIssue(id);
    },

    async createIssue(input: CreateIssueInput): Promise<Issue> {
      return backends[primaryIndex].adapter.createIssue(input);
    },

    async updateIssue(id: string, input: UpdateIssueInput): Promise<Issue> {
      return routeById(id, backends).updateIssue(id, input);
    },

    async transitionIssue(id: string, transition: string): Promise<Issue> {
      return routeById(id, backends).transitionIssue(id, transition);
    },

    async addComment(id: string, body: string): Promise<void> {
      return routeById(id, backends).addComment(id, body);
    },

    async getComments(id: string): Promise<IssueComment[]> {
      return routeById(id, backends).getComments(id);
    },

    watchIssues(filter: IssueFilter): EventStream<IssueEvent> {
      const streams = backends.map((b) => b.adapter.watchIssues(filter));
      return mergeEventStreams(streams);
    },
  };
}
