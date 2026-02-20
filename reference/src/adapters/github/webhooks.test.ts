import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  verifyGitHubSignature,
  transformIssueEvent,
  transformPREvent,
  transformBuildEvent,
  createGitHubWebhookProvider,
} from './webhooks.js';
import { createWebhookBridge } from '../webhook-bridge.js';
import type { IssueEvent, PREvent, BuildEvent } from '../interfaces.js';

// ── Signature Verification ───────────────────────────────────────────

describe('verifyGitHubSignature', () => {
  const secret = 'test-secret';
  const body = Buffer.from('{"hello":"world"}');

  function sign(content: Buffer, key: string): string {
    return 'sha256=' + createHmac('sha256', key).update(content).digest('hex');
  }

  it('accepts valid signature', () => {
    const headers = { 'x-hub-signature-256': sign(body, secret) };
    expect(verifyGitHubSignature(secret, headers, body)).toBe(true);
  });

  it('rejects invalid signature', () => {
    const headers = { 'x-hub-signature-256': 'sha256=bad' };
    expect(verifyGitHubSignature(secret, headers, body)).toBe(false);
  });

  it('rejects missing signature header', () => {
    expect(verifyGitHubSignature(secret, {}, body)).toBe(false);
  });

  it('rejects wrong secret', () => {
    const headers = { 'x-hub-signature-256': sign(body, 'wrong-secret') };
    expect(verifyGitHubSignature(secret, headers, body)).toBe(false);
  });
});

// ── Issue Event Transformer ──────────────────────────────────────────

describe('transformIssueEvent', () => {
  const baseIssue = {
    number: 42,
    title: 'Test Issue',
    body: 'Description',
    state: 'open',
    labels: [{ name: 'bug' }],
    assignee: { login: 'user1' },
    html_url: 'https://github.com/org/repo/issues/42',
  };

  it('maps issues.opened to created', () => {
    const event = transformIssueEvent({ action: 'opened', issue: baseIssue });
    expect(event).not.toBeNull();
    expect(event!.type).toBe('created');
    expect(event!.issue.id).toBe('42');
    expect(event!.issue.title).toBe('Test Issue');
    expect(event!.issue.labels).toEqual(['bug']);
    expect(event!.issue.assignee).toBe('user1');
  });

  it('maps issues.edited to updated', () => {
    const event = transformIssueEvent({ action: 'edited', issue: baseIssue });
    expect(event!.type).toBe('updated');
  });

  it('maps issues.closed to transitioned', () => {
    const event = transformIssueEvent({
      action: 'closed',
      issue: { ...baseIssue, state: 'closed' },
    });
    expect(event!.type).toBe('transitioned');
  });

  it('maps issues.reopened to transitioned', () => {
    const event = transformIssueEvent({ action: 'reopened', issue: baseIssue });
    expect(event!.type).toBe('transitioned');
  });

  it('returns null for unrecognized actions', () => {
    expect(transformIssueEvent({ action: 'labeled', issue: baseIssue })).toBeNull();
  });

  it('returns null for invalid payload', () => {
    expect(transformIssueEvent(null)).toBeNull();
    expect(transformIssueEvent({})).toBeNull();
    expect(transformIssueEvent({ action: 'opened' })).toBeNull();
  });

  it('handles missing optional fields', () => {
    const event = transformIssueEvent({
      action: 'opened',
      issue: { ...baseIssue, body: null, assignee: null, labels: [] },
    });
    expect(event!.issue.description).toBeUndefined();
    expect(event!.issue.assignee).toBeUndefined();
    expect(event!.issue.labels).toEqual([]);
  });
});

// ── PR Event Transformer ─────────────────────────────────────────────

describe('transformPREvent', () => {
  const basePR = {
    number: 99,
    title: 'Fix Bug',
    body: 'PR desc',
    head: { ref: 'feature/fix' },
    base: { ref: 'main' },
    state: 'open',
    merged: false,
    user: { login: 'author1' },
    html_url: 'https://github.com/org/repo/pull/99',
  };

  it('maps pull_request.opened to opened', () => {
    const event = transformPREvent({ action: 'opened', pull_request: basePR });
    expect(event!.type).toBe('opened');
    expect(event!.pullRequest.id).toBe('99');
    expect(event!.pullRequest.sourceBranch).toBe('feature/fix');
    expect(event!.pullRequest.targetBranch).toBe('main');
    expect(event!.pullRequest.author).toBe('author1');
  });

  it('maps pull_request.synchronize to updated', () => {
    const event = transformPREvent({ action: 'synchronize', pull_request: basePR });
    expect(event!.type).toBe('updated');
  });

  it('maps pull_request.closed (merged) to merged', () => {
    const event = transformPREvent({
      action: 'closed',
      pull_request: { ...basePR, merged: true, state: 'closed' },
    });
    expect(event!.type).toBe('merged');
    expect(event!.pullRequest.status).toBe('merged');
  });

  it('maps pull_request.closed (not merged) to closed', () => {
    const event = transformPREvent({
      action: 'closed',
      pull_request: { ...basePR, merged: false, state: 'closed' },
    });
    expect(event!.type).toBe('closed');
    expect(event!.pullRequest.status).toBe('closed');
  });

  it('returns null for unrecognized actions', () => {
    expect(transformPREvent({ action: 'labeled', pull_request: basePR })).toBeNull();
  });

  it('returns null for invalid payload', () => {
    expect(transformPREvent(null)).toBeNull();
    expect(transformPREvent({})).toBeNull();
  });
});

// ── Build Event Transformer ──────────────────────────────────────────

describe('transformBuildEvent', () => {
  it('maps workflow_run.completed (success) to completed', () => {
    const event = transformBuildEvent({
      action: 'completed',
      workflow_run: {
        id: 1001,
        conclusion: 'success',
        html_url: 'https://example.com',
        status: 'completed',
      },
    });
    expect(event!.type).toBe('completed');
    expect(event!.build.id).toBe('1001');
  });

  it('maps workflow_run.completed (failure) to failed', () => {
    const event = transformBuildEvent({
      action: 'completed',
      workflow_run: {
        id: 1002,
        conclusion: 'failure',
        html_url: 'https://example.com',
        status: 'completed',
      },
    });
    expect(event!.type).toBe('failed');
  });

  it('maps check_run.completed to completed', () => {
    const event = transformBuildEvent({
      action: 'completed',
      check_run: {
        id: 2001,
        conclusion: 'success',
        html_url: 'https://example.com',
        status: 'completed',
      },
    });
    expect(event!.type).toBe('completed');
    expect(event!.build.id).toBe('2001');
  });

  it('returns null for non-completed workflow_run', () => {
    expect(
      transformBuildEvent({
        action: 'requested',
        workflow_run: { id: 1003, conclusion: null, html_url: '', status: 'queued' },
      }),
    ).toBeNull();
  });

  it('returns null for invalid payload', () => {
    expect(transformBuildEvent(null)).toBeNull();
    expect(transformBuildEvent({})).toBeNull();
  });
});

// ── Webhook Provider ─────────────────────────────────────────────────

describe('createGitHubWebhookProvider', () => {
  it('routes issue events to issues bridge', () => {
    const received: unknown[] = [];
    const bridge = createWebhookBridge<IssueEvent>((p) => {
      received.push(p);
      return transformIssueEvent(p);
    });

    const provider = createGitHubWebhookProvider({ secret: 'test' }, { issues: bridge });

    const payload = {
      action: 'opened',
      issue: { number: 1, title: 'T', body: '', state: 'open', labels: [], html_url: '' },
    };
    provider.onEvent({ 'x-github-event': 'issues' }, payload);

    expect(received).toHaveLength(1);
    bridge.close();
  });

  it('routes PR events to pullRequests bridge', () => {
    const received: unknown[] = [];
    const bridge = createWebhookBridge<PREvent>((p) => {
      received.push(p);
      return transformPREvent(p);
    });

    const provider = createGitHubWebhookProvider({ secret: 'test' }, { pullRequests: bridge });

    const payload = {
      action: 'opened',
      pull_request: {
        number: 1,
        title: 'PR',
        body: '',
        head: { ref: 'b' },
        base: { ref: 'main' },
        state: 'open',
        merged: false,
        user: { login: 'u' },
        html_url: '',
      },
    };
    provider.onEvent({ 'x-github-event': 'pull_request' }, payload);

    expect(received).toHaveLength(1);
    bridge.close();
  });

  it('routes build events to builds bridge', () => {
    const received: unknown[] = [];
    const bridge = createWebhookBridge<BuildEvent>((p) => {
      received.push(p);
      return transformBuildEvent(p);
    });

    const provider = createGitHubWebhookProvider({ secret: 'test' }, { builds: bridge });

    provider.onEvent(
      { 'x-github-event': 'workflow_run' },
      {
        action: 'completed',
        workflow_run: { id: 1, conclusion: 'success', html_url: '', status: 'completed' },
      },
    );

    expect(received).toHaveLength(1);
    bridge.close();
  });

  it('ignores events when bridge not configured', () => {
    const provider = createGitHubWebhookProvider({ secret: 'test' }, {});
    // Should not throw
    provider.onEvent({ 'x-github-event': 'issues' }, { action: 'opened' });
    provider.onEvent({ 'x-github-event': 'pull_request' }, { action: 'opened' });
    provider.onEvent({ 'x-github-event': 'workflow_run' }, { action: 'completed' });
  });
});
