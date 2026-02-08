import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createLinearIssueTracker, type LinearConfig, type LinearClientLike } from './index.js';

vi.mock('../resolve-secret.js', () => ({
  resolveSecret: vi.fn(() => 'lin_mock_api_key'),
}));

const config: LinearConfig = {
  teamId: 'team-123',
  apiKey: { secretRef: 'linear-api-key' },
};

function makeIssueNode(overrides: Record<string, unknown> = {}) {
  return {
    id: 'issue-1',
    title: 'Test Issue',
    description: 'A test issue',
    state: Promise.resolve({ name: 'In Progress' }),
    labels: () => Promise.resolve({ nodes: [{ name: 'bug' }] }),
    assignee: Promise.resolve({ name: 'alice' }),
    url: 'https://linear.app/team/issue-1',
    ...overrides,
  };
}

function createMockClient(): LinearClientLike & {
  issues: ReturnType<typeof vi.fn>;
  issue: ReturnType<typeof vi.fn>;
  createIssue: ReturnType<typeof vi.fn>;
  updateIssue: ReturnType<typeof vi.fn>;
  issueLabels: ReturnType<typeof vi.fn>;
  team: ReturnType<typeof vi.fn>;
} {
  return {
    issues: vi.fn(),
    issue: vi.fn(),
    createIssue: vi.fn(),
    updateIssue: vi.fn(),
    issueLabels: vi.fn(),
    team: vi.fn(),
  };
}

describe('createLinearIssueTracker', () => {
  let mockClient: ReturnType<typeof createMockClient>;
  let tracker: ReturnType<typeof createLinearIssueTracker>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockClient = createMockClient();
    tracker = createLinearIssueTracker(config, mockClient);
  });

  it('listIssues returns mapped issues', async () => {
    mockClient.issues.mockResolvedValue({
      nodes: [makeIssueNode()],
    });

    const issues = await tracker.listIssues({});
    expect(issues).toHaveLength(1);
    expect(issues[0]).toEqual({
      id: 'issue-1',
      title: 'Test Issue',
      description: 'A test issue',
      status: 'In Progress',
      labels: ['bug'],
      assignee: 'alice',
      url: 'https://linear.app/team/issue-1',
    });
  });

  it('listIssues passes filter params', async () => {
    mockClient.issues.mockResolvedValue({ nodes: [] });

    await tracker.listIssues({ labels: ['bug'], assignee: 'bob' });
    expect(mockClient.issues).toHaveBeenCalledWith(
      expect.objectContaining({
        filter: expect.objectContaining({
          labels: { name: { in: ['bug'] } },
          assignee: { name: { eq: 'bob' } },
        }),
      }),
    );
  });

  it('getIssue returns mapped issue', async () => {
    mockClient.issue.mockResolvedValue(makeIssueNode());

    const issue = await tracker.getIssue('issue-1');
    expect(issue.id).toBe('issue-1');
    expect(issue.status).toBe('In Progress');
  });

  it('createIssue sends correct params', async () => {
    mockClient.issueLabels.mockResolvedValue({ nodes: [{ id: 'label-1', name: 'bug' }] });
    mockClient.createIssue.mockResolvedValue({
      issue: Promise.resolve(makeIssueNode()),
    });

    const issue = await tracker.createIssue({
      title: 'New Bug',
      description: 'Something broke',
      labels: ['bug'],
    });

    expect(issue.id).toBe('issue-1');
    expect(mockClient.createIssue).toHaveBeenCalledWith(
      expect.objectContaining({
        teamId: 'team-123',
        title: 'New Bug',
        description: 'Something broke',
        labelIds: ['label-1'],
      }),
    );
  });

  it('createIssue throws when issue creation returns null', async () => {
    mockClient.createIssue.mockResolvedValue({
      issue: Promise.resolve(null),
    });

    await expect(tracker.createIssue({ title: 'Fail' })).rejects.toThrow('Failed to create');
  });

  it('updateIssue updates and returns mapped issue', async () => {
    mockClient.updateIssue.mockResolvedValue({});
    mockClient.issue.mockResolvedValue(makeIssueNode({ title: 'Updated Title' }));

    const issue = await tracker.updateIssue('issue-1', { title: 'Updated Title' });
    expect(issue.title).toBe('Updated Title');
    expect(mockClient.updateIssue).toHaveBeenCalledWith('issue-1', { title: 'Updated Title' });
  });

  it('transitionIssue resolves state by name', async () => {
    mockClient.team.mockResolvedValue({
      states: () =>
        Promise.resolve({
          nodes: [
            { id: 'state-1', name: 'Done' },
            { id: 'state-2', name: 'In Progress' },
          ],
        }),
    });
    mockClient.updateIssue.mockResolvedValue({});
    mockClient.issue.mockResolvedValue(makeIssueNode({ state: Promise.resolve({ name: 'Done' }) }));

    const issue = await tracker.transitionIssue('issue-1', 'Done');
    expect(issue.status).toBe('Done');
    expect(mockClient.updateIssue).toHaveBeenCalledWith('issue-1', { stateId: 'state-1' });
  });

  it('transitionIssue throws for unknown state', async () => {
    mockClient.team.mockResolvedValue({
      states: () => Promise.resolve({ nodes: [] }),
    });

    await expect(tracker.transitionIssue('issue-1', 'Unknown')).rejects.toThrow('not found');
  });

  it('watchIssues returns empty async iterator', async () => {
    const stream = tracker.watchIssues({});
    const items: unknown[] = [];
    for await (const item of stream) {
      items.push(item);
    }
    expect(items).toHaveLength(0);
  });

  it('handles issues with null assignee', async () => {
    mockClient.issue.mockResolvedValue(makeIssueNode({ assignee: Promise.resolve(null) }));

    const issue = await tracker.getIssue('issue-1');
    expect(issue.assignee).toBeUndefined();
  });
});
