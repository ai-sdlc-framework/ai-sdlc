/**
 * Notification router — dispatches pipeline events to configured messengers.
 *
 * Routes events like pipeline-start, gate-failure, agent-complete, pr-created
 * to one or more Messenger implementations with filtering and template rendering.
 */

import type { Messenger } from '@ai-sdlc/reference';

// ── Types ────────────────────────────────────────────────────────────

export type PipelineEventType =
  | 'pipeline-start'
  | 'pipeline-complete'
  | 'pipeline-failed'
  | 'gate-pass'
  | 'gate-failure'
  | 'agent-start'
  | 'agent-complete'
  | 'agent-failed'
  | 'pr-created'
  | 'approval-required'
  | 'promotion'
  | 'demotion'
  | 'cost-alert'
  | 'deploy-start'
  | 'deploy-complete'
  | 'deploy-failed'
  | 'rollout-progressing'
  | 'rollout-complete'
  | 'rollout-rollback';

export interface PipelineEvent {
  type: PipelineEventType;
  /** Context variables for template rendering. */
  data: Record<string, string | number | boolean>;
  /** Severity override. */
  severity?: 'info' | 'warning' | 'error';
  /** Timestamp. */
  timestamp?: string;
}

export interface NotificationRoute {
  /** Name of this route for identification. */
  name: string;
  /** Messenger to dispatch to. */
  messenger: Messenger;
  /** Channel to send to. */
  channel: string;
  /** Event types to route (empty = all events). */
  events?: PipelineEventType[];
  /** Minimum severity to route. */
  minSeverity?: 'info' | 'warning' | 'error';
  /** Whether to use threads for related events. */
  useThreads?: boolean;
}

export interface NotificationTemplate {
  title: string;
  body: string;
}

// ── Default Templates ────────────────────────────────────────────────

const DEFAULT_TEMPLATES: Record<PipelineEventType, NotificationTemplate> = {
  'pipeline-start': {
    title: 'Pipeline Started',
    body: 'Pipeline run {runId} started for issue #{issueNumber}',
  },
  'pipeline-complete': {
    title: 'Pipeline Completed',
    body: 'Pipeline run {runId} completed successfully. PR: {prUrl}',
  },
  'pipeline-failed': {
    title: 'Pipeline Failed',
    body: 'Pipeline run {runId} failed: {error}',
  },
  'gate-pass': {
    title: 'Gate Passed',
    body: 'Quality gate "{gateName}" passed for issue #{issueNumber}',
  },
  'gate-failure': {
    title: 'Gate Failed',
    body: 'Quality gate "{gateName}" failed: {details}',
  },
  'agent-start': {
    title: 'Agent Started',
    body: 'Agent {agentName} started working on issue #{issueNumber}',
  },
  'agent-complete': {
    title: 'Agent Completed',
    body: 'Agent {agentName} completed. Files changed: {filesChanged}',
  },
  'agent-failed': {
    title: 'Agent Failed',
    body: 'Agent {agentName} failed: {error}',
  },
  'pr-created': {
    title: 'PR Created',
    body: 'Pull request created: {prUrl}',
  },
  'approval-required': {
    title: 'Approval Required',
    body: 'Issue #{issueNumber} requires approval (tier: {tier})',
  },
  promotion: {
    title: 'Agent Promoted',
    body: 'Agent {agentName} promoted from level {fromLevel} to {toLevel}',
  },
  demotion: {
    title: 'Agent Demoted',
    body: 'Agent {agentName} demoted from level {fromLevel} to {toLevel}: {reason}',
  },
  'cost-alert': {
    title: 'Cost Alert',
    body: 'Budget utilization at {utilization}% ({spent}/{budget} USD)',
  },
  'deploy-start': {
    title: 'Deployment Started',
    body: 'Deploying {version} to {environment} via {target}',
  },
  'deploy-complete': {
    title: 'Deployment Complete',
    body: 'Version {version} deployed to {environment}. URL: {url}',
  },
  'deploy-failed': {
    title: 'Deployment Failed',
    body: 'Deployment of {version} to {environment} failed: {error}',
  },
  'rollout-progressing': {
    title: 'Rollout Progressing',
    body: 'Rollout at {weightPercent}% (step {step}). Error rate: {errorRate}%, P95: {latencyP95}ms',
  },
  'rollout-complete': {
    title: 'Rollout Complete',
    body: 'Rollout of {version} to {environment} completed at 100%',
  },
  'rollout-rollback': {
    title: 'Rollout Rolled Back',
    body: 'Rollout of {version} to {environment} rolled back: {reason}',
  },
};

// ── Router ───────────────────────────────────────────────────────────

export class NotificationRouter {
  private routes: NotificationRoute[] = [];
  private templates: Map<PipelineEventType, NotificationTemplate> = new Map();
  private activeThreads = new Map<string, string>(); // route+issue -> threadId

  constructor(customTemplates?: Partial<Record<PipelineEventType, NotificationTemplate>>) {
    // Initialize with default templates
    for (const [key, value] of Object.entries(DEFAULT_TEMPLATES)) {
      this.templates.set(key as PipelineEventType, value);
    }
    // Override with custom templates
    if (customTemplates) {
      for (const [key, value] of Object.entries(customTemplates)) {
        if (value) this.templates.set(key as PipelineEventType, value);
      }
    }
  }

  /**
   * Add a notification route.
   */
  addRoute(route: NotificationRoute): void {
    this.routes.push(route);
  }

  /**
   * Remove a route by name.
   */
  removeRoute(name: string): void {
    this.routes = this.routes.filter((r) => r.name !== name);
  }

  /**
   * Dispatch a pipeline event to all matching routes.
   */
  async dispatch(event: PipelineEvent): Promise<void> {
    const matchingRoutes = this.routes.filter((route) => this.matchesRoute(route, event));

    const promises = matchingRoutes.map((route) =>
      this.sendToRoute(route, event).catch((err) => {
        // Non-blocking: log but don't fail the pipeline
        console.error(`Notification route "${route.name}" failed:`, err);
      }),
    );

    await Promise.all(promises);
  }

  /**
   * Get the count of configured routes.
   */
  get routeCount(): number {
    return this.routes.length;
  }

  // ── Internal ─────────────────────────────────────────────────────

  private matchesRoute(route: NotificationRoute, event: PipelineEvent): boolean {
    // Check event type filter
    if (route.events && route.events.length > 0 && !route.events.includes(event.type)) {
      return false;
    }

    // Check minimum severity
    if (route.minSeverity) {
      const severityOrder = { info: 0, warning: 1, error: 2 };
      const eventSeverity = event.severity ?? this.defaultSeverity(event.type);
      if (severityOrder[eventSeverity] < severityOrder[route.minSeverity]) {
        return false;
      }
    }

    return true;
  }

  private async sendToRoute(route: NotificationRoute, event: PipelineEvent): Promise<void> {
    const template = this.templates.get(event.type) ?? {
      title: event.type,
      body: JSON.stringify(event.data),
    };
    const rendered = this.renderTemplate(template, event.data);
    const severity = event.severity ?? this.defaultSeverity(event.type);

    if (route.useThreads) {
      const threadKey = `${route.name}:${event.data.issueNumber ?? 'global'}`;
      const existingThread = this.activeThreads.get(threadKey);

      if (existingThread) {
        await route.messenger.postUpdate(existingThread, `**${rendered.title}**\n${rendered.body}`);
      } else {
        const thread = await route.messenger.createThread({
          channel: route.channel,
          title: rendered.title,
          message: rendered.body,
        });
        this.activeThreads.set(threadKey, thread.id);
      }
    } else {
      await route.messenger.sendNotification({
        channel: route.channel,
        message: `**${rendered.title}**\n${rendered.body}`,
        severity,
      });
    }
  }

  private renderTemplate(
    template: NotificationTemplate,
    data: Record<string, string | number | boolean>,
  ): { title: string; body: string } {
    let title = template.title;
    let body = template.body;

    for (const [key, value] of Object.entries(data)) {
      const placeholder = `{${key}}`;
      title = title.replaceAll(placeholder, String(value));
      body = body.replaceAll(placeholder, String(value));
    }

    return { title, body };
  }

  private defaultSeverity(type: PipelineEventType): 'info' | 'warning' | 'error' {
    switch (type) {
      case 'pipeline-failed':
      case 'agent-failed':
      case 'gate-failure':
      case 'deploy-failed':
        return 'error';
      case 'approval-required':
      case 'demotion':
      case 'cost-alert':
      case 'rollout-rollback':
        return 'warning';
      default:
        return 'info';
    }
  }
}
