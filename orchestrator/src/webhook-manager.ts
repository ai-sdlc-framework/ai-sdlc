/**
 * Webhook manager — creates and manages the webhook server,
 * registers providers based on config, and handles lifecycle.
 */

import {
  createWebhookServer,
  createWebhookBridge,
  createGitHubWebhookProvider,
  createGitLabWebhookProvider,
  createJiraWebhookProvider,
  createLinearWebhookProvider,
  transformIssueEvent,
  transformPREvent,
  transformBuildEvent,
  transformGitLabIssueEvent,
  transformGitLabMREvent,
  transformGitLabPipelineEvent,
  transformJiraIssueEvent,
  transformLinearIssueEvent,
  type WebhookServer,
  type WebhookBridge,
  type IssueEvent,
  type PREvent,
  type BuildEvent,
} from '@ai-sdlc/reference';

// ── Types ────────────────────────────────────────────────────────────

export interface WebhookManagerConfig {
  /** Port to listen on for webhooks. */
  port: number;
  /** Host to bind to (defaults to '0.0.0.0'). */
  host?: string;
  /** GitHub webhook secret. */
  githubSecret?: string;
  /** GitLab webhook secret token. */
  gitlabSecretToken?: string;
  /** Jira webhook secret. */
  jiraSecret?: string;
  /** Linear webhook signing secret. */
  linearSigningSecret?: string;
}

export interface WebhookBridges {
  issues: WebhookBridge<IssueEvent>;
  pullRequests: WebhookBridge<PREvent>;
  builds: WebhookBridge<BuildEvent>;
}

export interface WebhookManager {
  /** Start the webhook server. */
  start(): Promise<void>;
  /** Stop the webhook server. */
  stop(): Promise<void>;
  /** Get the configured bridges for event consumption. */
  readonly bridges: WebhookBridges;
  /** Get the underlying server. */
  readonly server: WebhookServer;
  /** Number of registered providers. */
  readonly providerCount: number;
}

// ── Implementation ───────────────────────────────────────────────────

export function createWebhookManager(config: WebhookManagerConfig): WebhookManager {
  const server = createWebhookServer({ port: config.port, host: config.host });

  // Create unified bridges
  const issueBridge = createWebhookBridge<IssueEvent>((payload) => {
    // Try each transformer in order
    return (
      transformIssueEvent(payload) ??
      transformGitLabIssueEvent(payload) ??
      transformJiraIssueEvent(payload) ??
      transformLinearIssueEvent(payload)
    );
  });

  const prBridge = createWebhookBridge<PREvent>((payload) => {
    return transformPREvent(payload) ?? transformGitLabMREvent(payload);
  });

  const buildBridge = createWebhookBridge<BuildEvent>((payload) => {
    return transformBuildEvent(payload) ?? transformGitLabPipelineEvent(payload);
  });

  const bridges: WebhookBridges = {
    issues: issueBridge,
    pullRequests: prBridge,
    builds: buildBridge,
  };

  // Register providers based on config
  if (config.githubSecret) {
    const provider = createGitHubWebhookProvider(
      { secret: config.githubSecret },
      { issues: issueBridge, pullRequests: prBridge, builds: buildBridge },
    );
    server.registerProvider(provider);
  }

  if (config.gitlabSecretToken) {
    const provider = createGitLabWebhookProvider(
      { secretToken: config.gitlabSecretToken },
      { issues: issueBridge, mergeRequests: prBridge, pipelines: buildBridge },
    );
    server.registerProvider(provider);
  }

  if (config.jiraSecret) {
    const provider = createJiraWebhookProvider(
      { secret: config.jiraSecret },
      { issues: issueBridge },
    );
    server.registerProvider(provider);
  }

  if (config.linearSigningSecret) {
    const provider = createLinearWebhookProvider(
      { signingSecret: config.linearSigningSecret },
      { issues: issueBridge },
    );
    server.registerProvider(provider);
  }

  return {
    async start() {
      await server.start();
    },
    async stop() {
      issueBridge.close();
      prBridge.close();
      buildBridge.close();
      await server.stop();
    },
    get bridges() {
      return bridges;
    },
    get server() {
      return server;
    },
    get providerCount() {
      return server.providerCount;
    },
  };
}
