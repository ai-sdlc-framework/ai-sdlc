import { describe, it, expect } from 'vitest';
import { createJiraIssueTracker, type HttpClient, type JiraConfig } from './index.js';

function createMockClient(responses: Map<string, { status: number; body: unknown }>): HttpClient {
  return async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    // Try exact method+url match, then url-contains match
    for (const [pattern, resp] of responses.entries()) {
      const [m, u] = pattern.split(' ', 2);
      if (m === method && url.includes(u)) {
        return {
          ok: resp.status >= 200 && resp.status < 300,
          status: resp.status,
          json: async () => resp.body,
        } as unknown as Response;
      }
    }
    return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
  };
}

const baseConfig: JiraConfig = {
  baseUrl: 'https://test.atlassian.net',
  projectKey: 'TEST',
};

const sampleIssue = {
  key: 'TEST-1',
  fields: {
    summary: 'Fix bug',
    description: {
      type: 'doc', version: 1,
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Bug description' }] }],
    },
    status: { name: 'To Do' },
    labels: ['bug'],
    assignee: { displayName: 'Alice' },
  },
};

describe('createJiraIssueTracker', () => {
  it('listIssues builds JQL and returns issues', async () => {
    const client = createMockClient(new Map([
      ['GET /rest/api/3/search', { status: 200, body: { issues: [sampleIssue] } }],
    ]));
    const tracker = createJiraIssueTracker(baseConfig, client);
    const issues = await tracker.listIssues({ status: 'To Do' });
    expect(issues).toHaveLength(1);
    expect(issues[0].id).toBe('TEST-1');
    expect(issues[0].title).toBe('Fix bug');
    expect(issues[0].description).toBe('Bug description');
    expect(issues[0].labels).toEqual(['bug']);
  });

  it('getIssue fetches single issue', async () => {
    const client = createMockClient(new Map([
      ['GET /rest/api/3/issue/TEST-1', { status: 200, body: sampleIssue }],
    ]));
    const tracker = createJiraIssueTracker(baseConfig, client);
    const issue = await tracker.getIssue('TEST-1');
    expect(issue.id).toBe('TEST-1');
    expect(issue.assignee).toBe('Alice');
    expect(issue.url).toBe('https://test.atlassian.net/browse/TEST-1');
  });

  it('createIssue sends ADF description', async () => {
    let sentBody: string | undefined;
    const client: HttpClient = async (url, init) => {
      if (init?.method === 'POST' && url.includes('/issue')) {
        sentBody = init.body as string;
        return { ok: true, status: 201, json: async () => ({ key: 'TEST-2' }) } as unknown as Response;
      }
      // getIssue follow-up
      return {
        ok: true, status: 200,
        json: async () => ({
          key: 'TEST-2',
          fields: { summary: 'New task', description: null, status: { name: 'To Do' }, labels: [], assignee: null },
        }),
      } as unknown as Response;
    };
    const tracker = createJiraIssueTracker(baseConfig, client);
    const issue = await tracker.createIssue({ title: 'New task', description: 'details' });
    expect(issue.id).toBe('TEST-2');
    const parsed = JSON.parse(sentBody!);
    expect(parsed.fields.description.type).toBe('doc');
  });

  it('updateIssue sends PUT with fields', async () => {
    let sentMethod: string | undefined;
    const client: HttpClient = async (url, init) => {
      if (init?.method === 'PUT') {
        sentMethod = init.method;
        return { ok: true, status: 204, json: async () => ({}) } as unknown as Response;
      }
      return {
        ok: true, status: 200,
        json: async () => ({ key: 'TEST-1', fields: { summary: 'Updated', description: null, status: { name: 'To Do' }, labels: [], assignee: null } }),
      } as unknown as Response;
    };
    const tracker = createJiraIssueTracker(baseConfig, client);
    const issue = await tracker.updateIssue('TEST-1', { title: 'Updated' });
    expect(sentMethod).toBe('PUT');
    expect(issue.title).toBe('Updated');
  });

  it('transitionIssue fetches available transitions and posts matching ID', async () => {
    let transitionPosted: string | undefined;
    const client: HttpClient = async (url, init) => {
      if (url.includes('/transitions') && !init?.method) {
        return {
          ok: true, status: 200,
          json: async () => ({ transitions: [{ id: '31', name: 'Done' }, { id: '21', name: 'In Progress' }] }),
        } as unknown as Response;
      }
      if (url.includes('/transitions') && init?.method === 'POST') {
        transitionPosted = init.body as string;
        return { ok: true, status: 204, json: async () => ({}) } as unknown as Response;
      }
      return {
        ok: true, status: 200,
        json: async () => ({ key: 'TEST-1', fields: { summary: 'Fix bug', description: null, status: { name: 'Done' }, labels: [], assignee: null } }),
      } as unknown as Response;
    };
    const tracker = createJiraIssueTracker(baseConfig, client);
    const issue = await tracker.transitionIssue('TEST-1', 'Done');
    expect(issue.status).toBe('Done');
    const parsed = JSON.parse(transitionPosted!);
    expect(parsed.transition.id).toBe('31');
  });

  it('transitionIssue throws for unavailable transition', async () => {
    const client: HttpClient = async () => ({
      ok: true, status: 200,
      json: async () => ({ transitions: [{ id: '31', name: 'Done' }] }),
    } as unknown as Response);
    const tracker = createJiraIssueTracker(baseConfig, client);
    await expect(tracker.transitionIssue('TEST-1', 'Nonexistent')).rejects.toThrow('not available');
  });

  it('addComment sends ADF body', async () => {
    let sentBody: string | undefined;
    const client: HttpClient = async (_url, init) => {
      if (init?.method === 'POST') sentBody = init.body as string;
      return { ok: true, status: 201, json: async () => ({}) } as unknown as Response;
    };
    const tracker = createJiraIssueTracker(baseConfig, client);
    await tracker.addComment('TEST-1', 'Hello world');
    const parsed = JSON.parse(sentBody!);
    expect(parsed.body.type).toBe('doc');
  });

  it('getComments extracts text from ADF', async () => {
    const client = createMockClient(new Map([
      ['GET /rest/api/3/issue/TEST-1/comment', {
        status: 200,
        body: {
          comments: [
            {
              body: {
                type: 'doc', version: 1,
                content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Comment text' }] }],
              },
            },
          ],
        },
      }],
    ]));
    const tracker = createJiraIssueTracker(baseConfig, client);
    const comments = await tracker.getComments('TEST-1');
    expect(comments).toHaveLength(1);
    expect(comments[0].body).toBe('Comment text');
  });

  it('listIssues with labels filter builds correct JQL', async () => {
    let requestedUrl = '';
    const client: HttpClient = async (url) => {
      requestedUrl = url;
      return { ok: true, status: 200, json: async () => ({ issues: [] }) } as unknown as Response;
    };
    const tracker = createJiraIssueTracker(baseConfig, client);
    await tracker.listIssues({ labels: ['bug', 'urgent'] });
    expect(decodeURIComponent(requestedUrl)).toContain('labels IN ("bug", "urgent")');
  });

  it('throws on API failure', async () => {
    const client = createMockClient(new Map([
      ['GET /rest/api/3/issue/TEST-999', { status: 404, body: { errorMessages: ['Not found'] } }],
    ]));
    const tracker = createJiraIssueTracker(baseConfig, client);
    await expect(tracker.getIssue('TEST-999')).rejects.toThrow('Jira getIssue failed: 404');
  });

  it('watchIssues returns empty stream', () => {
    const tracker = createJiraIssueTracker(baseConfig, async () => ({ ok: true } as unknown as Response));
    const stream = tracker.watchIssues({});
    expect(stream[Symbol.asyncIterator]).toBeDefined();
  });
});
