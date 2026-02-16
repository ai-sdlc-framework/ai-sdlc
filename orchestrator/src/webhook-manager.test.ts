import { describe, it, expect, afterEach } from 'vitest';
import { createWebhookManager, type WebhookManager } from './webhook-manager.js';

let manager: WebhookManager | null = null;

afterEach(async () => {
  if (manager) {
    await manager.stop();
    manager = null;
  }
});

describe('WebhookManager', () => {
  it('creates with no providers when no secrets configured', () => {
    manager = createWebhookManager({ port: 0 });
    expect(manager.providerCount).toBe(0);
  });

  it('registers GitHub provider when secret is set', () => {
    manager = createWebhookManager({ port: 0, githubSecret: 'gh-secret' });
    expect(manager.providerCount).toBe(1);
  });

  it('registers GitLab provider when token is set', () => {
    manager = createWebhookManager({ port: 0, gitlabSecretToken: 'gl-token' });
    expect(manager.providerCount).toBe(1);
  });

  it('registers Jira provider when secret is set', () => {
    manager = createWebhookManager({ port: 0, jiraSecret: 'jira-secret' });
    expect(manager.providerCount).toBe(1);
  });

  it('registers Linear provider when secret is set', () => {
    manager = createWebhookManager({ port: 0, linearSigningSecret: 'linear-secret' });
    expect(manager.providerCount).toBe(1);
  });

  it('registers multiple providers', () => {
    manager = createWebhookManager({
      port: 0,
      githubSecret: 'gh',
      gitlabSecretToken: 'gl',
      jiraSecret: 'jira',
      linearSigningSecret: 'linear',
    });
    expect(manager.providerCount).toBe(4);
  });

  it('starts and stops cleanly', async () => {
    manager = createWebhookManager({ port: 0, githubSecret: 'test' });
    await manager.start();
    expect(manager.server.port).toBeGreaterThan(0);
    await manager.stop();
    manager = null;
  });

  it('exposes bridges for event consumption', () => {
    manager = createWebhookManager({ port: 0 });
    expect(manager.bridges.issues).toBeDefined();
    expect(manager.bridges.pullRequests).toBeDefined();
    expect(manager.bridges.builds).toBeDefined();
  });

  it('bridges have stream() and push() methods', () => {
    manager = createWebhookManager({ port: 0 });
    expect(typeof manager.bridges.issues.stream).toBe('function');
    expect(typeof manager.bridges.issues.push).toBe('function');
  });

  it('health endpoint works when started', async () => {
    manager = createWebhookManager({ port: 0, githubSecret: 'test' });
    await manager.start();
    const res = await fetch(`http://127.0.0.1:${manager.server.port}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { providers: number };
    expect(body.providers).toBe(1);
  });
});
