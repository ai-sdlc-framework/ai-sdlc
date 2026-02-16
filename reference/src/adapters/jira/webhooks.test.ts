import { describe, it, expect } from 'vitest';
import {
  verifyJiraWebhook,
  transformJiraIssueEvent,
  createJiraWebhookProvider,
} from './webhooks.js';

describe('verifyJiraWebhook', () => {
  it('accepts valid query parameter secret', () => {
    expect(verifyJiraWebhook('my-secret', {}, Buffer.alloc(0), 'my-secret')).toBe(true);
  });

  it('rejects invalid query parameter secret', () => {
    expect(verifyJiraWebhook('my-secret', {}, Buffer.alloc(0), 'wrong')).toBe(false);
  });

  it('falls back to header verification', () => {
    expect(verifyJiraWebhook('my-secret', { 'x-jira-webhook-secret': 'my-secret' }, Buffer.alloc(0))).toBe(true);
  });

  it('rejects when no secret provided', () => {
    expect(verifyJiraWebhook('my-secret', {}, Buffer.alloc(0))).toBe(false);
  });
});

describe('transformJiraIssueEvent', () => {
  const basePayload = {
    webhookEvent: 'jira:issue_created',
    issue: {
      key: 'PROJ-1',
      fields: {
        summary: 'Test Issue',
        description: 'Some description',
        status: { name: 'To Do' },
        labels: [{ name: 'bug' }],
        assignee: { displayName: 'Alice' },
      },
      self: 'https://jira.example.com/rest/api/3/issue/PROJ-1',
    },
  };

  it('maps jira:issue_created to created', () => {
    const event = transformJiraIssueEvent(basePayload);
    expect(event!.type).toBe('created');
    expect(event!.issue.id).toBe('PROJ-1');
    expect(event!.issue.title).toBe('Test Issue');
    expect(event!.issue.labels).toEqual(['bug']);
  });

  it('maps jira:issue_updated to updated', () => {
    const event = transformJiraIssueEvent({
      ...basePayload,
      webhookEvent: 'jira:issue_updated',
    });
    expect(event!.type).toBe('updated');
  });

  it('returns null for unknown event types', () => {
    expect(transformJiraIssueEvent({
      ...basePayload,
      webhookEvent: 'jira:issue_deleted',
    })).toBeNull();
  });

  it('returns null for missing issue', () => {
    expect(transformJiraIssueEvent({ webhookEvent: 'jira:issue_created' })).toBeNull();
  });

  it('returns null for invalid payload', () => {
    expect(transformJiraIssueEvent(null)).toBeNull();
    expect(transformJiraIssueEvent({})).toBeNull();
  });

  it('handles string labels', () => {
    const event = transformJiraIssueEvent({
      ...basePayload,
      issue: {
        ...basePayload.issue,
        fields: { ...basePayload.issue.fields, labels: ['bug', 'urgent'] },
      },
    });
    expect(event!.issue.labels).toEqual(['bug', 'urgent']);
  });
});

describe('createJiraWebhookProvider', () => {
  it('routes events to issues bridge', () => {
    const received: unknown[] = [];
    const provider = createJiraWebhookProvider(
      { secret: 'test' },
      { issues: { push: (p) => received.push(p) } },
    );
    provider.onEvent({}, { webhookEvent: 'jira:issue_created' });
    expect(received).toHaveLength(1);
  });
});
