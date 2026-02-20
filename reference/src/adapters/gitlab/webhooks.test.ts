import { describe, it, expect } from 'vitest';
import {
  verifyGitLabToken,
  transformGitLabIssueEvent,
  transformGitLabMREvent,
  transformGitLabPipelineEvent,
  createGitLabWebhookProvider,
} from './webhooks.js';

describe('verifyGitLabToken', () => {
  it('accepts valid token', () => {
    expect(verifyGitLabToken('my-secret', { 'x-gitlab-token': 'my-secret' })).toBe(true);
  });

  it('rejects invalid token', () => {
    expect(verifyGitLabToken('my-secret', { 'x-gitlab-token': 'wrong' })).toBe(false);
  });

  it('rejects missing token', () => {
    expect(verifyGitLabToken('my-secret', {})).toBe(false);
  });
});

describe('transformGitLabIssueEvent', () => {
  const basePayload = {
    event_type: 'issue',
    object_attributes: {
      iid: 10,
      title: 'Bug',
      description: 'desc',
      state: 'opened',
      action: 'open',
      url: 'https://gitlab.com/issues/10',
      labels: [{ title: 'bug' }],
    },
    assignees: [{ username: 'dev1' }],
  };

  it('maps open action to created', () => {
    const event = transformGitLabIssueEvent(basePayload);
    expect(event!.type).toBe('created');
    expect(event!.issue.id).toBe('10');
    expect(event!.issue.labels).toEqual(['bug']);
  });

  it('maps update to updated', () => {
    const event = transformGitLabIssueEvent({
      ...basePayload,
      object_attributes: { ...basePayload.object_attributes, action: 'update' },
    });
    expect(event!.type).toBe('updated');
  });

  it('maps close to transitioned', () => {
    const event = transformGitLabIssueEvent({
      ...basePayload,
      object_attributes: { ...basePayload.object_attributes, action: 'close' },
    });
    expect(event!.type).toBe('transitioned');
  });

  it('returns null for non-issue event', () => {
    expect(transformGitLabIssueEvent({ event_type: 'note', object_attributes: {} })).toBeNull();
  });

  it('returns null for unknown action', () => {
    expect(
      transformGitLabIssueEvent({
        ...basePayload,
        object_attributes: { ...basePayload.object_attributes, action: 'label' },
      }),
    ).toBeNull();
  });
});

describe('transformGitLabMREvent', () => {
  const basePayload = {
    event_type: 'merge_request',
    object_attributes: {
      iid: 5,
      title: 'MR',
      description: 'd',
      source_branch: 'feat',
      target_branch: 'main',
      state: 'opened',
      action: 'open',
      url: 'https://gitlab.com/mr/5',
      author_id: 1,
    },
    user: { username: 'dev1' },
  };

  it('maps open to opened', () => {
    const event = transformGitLabMREvent(basePayload);
    expect(event!.type).toBe('opened');
    expect(event!.pullRequest.id).toBe('5');
  });

  it('maps merge to merged', () => {
    const event = transformGitLabMREvent({
      ...basePayload,
      object_attributes: { ...basePayload.object_attributes, action: 'merge', state: 'merged' },
    });
    expect(event!.type).toBe('merged');
  });

  it('maps close to closed', () => {
    const event = transformGitLabMREvent({
      ...basePayload,
      object_attributes: { ...basePayload.object_attributes, action: 'close', state: 'closed' },
    });
    expect(event!.type).toBe('closed');
  });

  it('returns null for non-MR event', () => {
    expect(transformGitLabMREvent({ event_type: 'note' })).toBeNull();
  });
});

describe('transformGitLabPipelineEvent', () => {
  it('maps success pipeline to completed', () => {
    const event = transformGitLabPipelineEvent({
      object_kind: 'pipeline',
      object_attributes: { id: 200, status: 'success', ref: 'main' },
    });
    expect(event!.type).toBe('completed');
    expect(event!.build.id).toBe('200');
  });

  it('maps failed pipeline to failed', () => {
    const event = transformGitLabPipelineEvent({
      object_kind: 'pipeline',
      object_attributes: { id: 201, status: 'failed', ref: 'main' },
    });
    expect(event!.type).toBe('failed');
  });

  it('returns null for running pipeline', () => {
    expect(
      transformGitLabPipelineEvent({
        object_kind: 'pipeline',
        object_attributes: { id: 202, status: 'running', ref: 'main' },
      }),
    ).toBeNull();
  });

  it('returns null for non-pipeline event', () => {
    expect(transformGitLabPipelineEvent({ object_kind: 'build' })).toBeNull();
  });
});

describe('createGitLabWebhookProvider', () => {
  it('routes Issue Hook events', () => {
    const received: unknown[] = [];
    const provider = createGitLabWebhookProvider(
      { secretToken: 'secret' },
      { issues: { push: (p) => received.push(p) } },
    );
    provider.onEvent({ 'x-gitlab-event': 'Issue Hook' }, { test: true });
    expect(received).toHaveLength(1);
  });

  it('routes Merge Request Hook events', () => {
    const received: unknown[] = [];
    const provider = createGitLabWebhookProvider(
      { secretToken: 'secret' },
      { mergeRequests: { push: (p) => received.push(p) } },
    );
    provider.onEvent({ 'x-gitlab-event': 'Merge Request Hook' }, { test: true });
    expect(received).toHaveLength(1);
  });

  it('routes Pipeline Hook events', () => {
    const received: unknown[] = [];
    const provider = createGitLabWebhookProvider(
      { secretToken: 'secret' },
      { pipelines: { push: (p) => received.push(p) } },
    );
    provider.onEvent({ 'x-gitlab-event': 'Pipeline Hook' }, { test: true });
    expect(received).toHaveLength(1);
  });
});
