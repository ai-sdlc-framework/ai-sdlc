import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createBacklogMdIssueTracker, type BacklogMdConfig, type BacklogFs } from './index.js';

const TASK_CONTENT = `---
id: PROJ-1
title: Fix the login bug
status: In Progress
assignee:
  - alice
labels:
  - bug
  - auth
created_date: '2026-03-01 10:00'
dependencies: []
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The login form throws an error when submitting empty fields.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Fix validation
<!-- AC:END -->
`;

const TASK2_CONTENT = `---
id: PROJ-2
title: Add dashboard
status: To Do
assignee: []
labels:
  - feature
created_date: '2026-03-02 14:00'
dependencies: []
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Build the main dashboard page.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
<!-- AC:END -->
`;

const CONFIG_CONTENT = `project_name: test-project
default_status: "To Do"
statuses: ["To Do", "In Progress", "Done"]
labels: []
task_prefix: "PROJ"
`;

const config: BacklogMdConfig = {
  backlogDir: '/mock/backlog',
};

function createMockFs(
  files: Record<string, string> = {},
  dirs: Record<string, string[]> = {},
): BacklogFs & {
  readdir: ReturnType<typeof vi.fn>;
  readFile: ReturnType<typeof vi.fn>;
  writeFile: ReturnType<typeof vi.fn>;
  exists: ReturnType<typeof vi.fn>;
} {
  const mockFs = {
    readdir: vi.fn((dirPath: string) => {
      if (dirs[dirPath]) return Promise.resolve(dirs[dirPath]);
      return Promise.reject(new Error(`Directory not found: ${dirPath}`));
    }),
    readFile: vi.fn((filePath: string) => {
      if (files[filePath] !== undefined) return Promise.resolve(files[filePath]);
      return Promise.reject(new Error(`File not found: ${filePath}`));
    }),
    writeFile: vi.fn(() => Promise.resolve()),
    exists: vi.fn((filePath: string) => {
      return Promise.resolve(files[filePath] !== undefined || dirs[filePath] !== undefined);
    }),
  };
  return mockFs;
}

describe('createBacklogMdIssueTracker', () => {
  let mockFs: ReturnType<typeof createMockFs>;
  let tracker: ReturnType<typeof createBacklogMdIssueTracker>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockFs = createMockFs(
      {
        '/mock/backlog/config.yml': CONFIG_CONTENT,
        '/mock/backlog/tasks/proj-1 - Fix-the-login-bug.md': TASK_CONTENT,
        '/mock/backlog/tasks/proj-2 - Add-dashboard.md': TASK2_CONTENT,
      },
      {
        '/mock/backlog': ['config.yml', 'tasks'],
        '/mock/backlog/tasks': ['proj-1 - Fix-the-login-bug.md', 'proj-2 - Add-dashboard.md'],
      },
    );
    tracker = createBacklogMdIssueTracker(config, mockFs);
  });

  it('listIssues returns mapped issues', async () => {
    const issues = await tracker.listIssues({});
    expect(issues).toHaveLength(2);
    expect(issues[0]).toEqual({
      id: 'PROJ-1',
      title: 'Fix the login bug',
      description:
        'The login form throws an error when submitting empty fields.\n\n## Acceptance Criteria\n- [ ] #1 Fix validation',
      status: 'In Progress',
      labels: ['bug', 'auth'],
      assignee: 'alice',
      url: 'file:///mock/backlog/tasks/proj-1 - Fix-the-login-bug.md',
    });
  });

  it('listIssues filters by status', async () => {
    const issues = await tracker.listIssues({ status: 'To Do' });
    expect(issues).toHaveLength(1);
    expect(issues[0].id).toBe('PROJ-2');
  });

  it('listIssues filters by labels', async () => {
    const issues = await tracker.listIssues({ labels: ['bug'] });
    expect(issues).toHaveLength(1);
    expect(issues[0].id).toBe('PROJ-1');
  });

  it('listIssues filters by assignee', async () => {
    const issues = await tracker.listIssues({ assignee: 'alice' });
    expect(issues).toHaveLength(1);
    expect(issues[0].id).toBe('PROJ-1');
  });

  it('listIssues returns [] for missing directory', async () => {
    mockFs.exists.mockResolvedValue(false);
    const issues = await tracker.listIssues({});
    expect(issues).toEqual([]);
  });

  it('getIssue returns mapped issue', async () => {
    const issue = await tracker.getIssue('PROJ-1');
    expect(issue.id).toBe('PROJ-1');
    expect(issue.title).toBe('Fix the login bug');
    expect(issue.status).toBe('In Progress');
    expect(issue.assignee).toBe('alice');
  });

  it('getIssue throws for unknown ID', async () => {
    await expect(tracker.getIssue('PROJ-999')).rejects.toThrow('not found');
  });

  it('createIssue generates correct filename and frontmatter', async () => {
    const issue = await tracker.createIssue({
      title: 'New Feature',
      description: 'Build something new',
      labels: ['feature'],
      assignee: 'bob',
    });

    expect(issue.id).toBe('PROJ-3');
    expect(issue.title).toBe('New Feature');
    expect(issue.description).toBe('Build something new');
    expect(issue.labels).toEqual(['feature']);
    expect(issue.assignee).toBe('bob');

    expect(mockFs.writeFile).toHaveBeenCalledTimes(1);
    const [filePath, content] = mockFs.writeFile.mock.calls[0];
    expect(filePath).toContain('proj-3');
    expect(filePath).toContain('New-Feature');
    expect(content).toContain('id: PROJ-3');
    expect(content).toContain('title: New Feature');
    expect(content).toContain('Build something new');
  });

  it('createIssue auto-increments task number', async () => {
    const issue = await tracker.createIssue({ title: 'Third Task' });
    expect(issue.id).toBe('PROJ-3');
  });

  it('createIssue throws for missing backlog directory', async () => {
    mockFs.exists.mockResolvedValue(false);
    await expect(tracker.createIssue({ title: 'Fail' })).rejects.toThrow(
      'Backlog directory not found',
    );
  });

  it('updateIssue updates frontmatter fields', async () => {
    const issue = await tracker.updateIssue('PROJ-1', {
      title: 'Updated Title',
      labels: ['critical'],
    });
    expect(issue.title).toBe('Updated Title');
    expect(issue.labels).toEqual(['critical']);

    const [, content] = mockFs.writeFile.mock.calls[0];
    expect(content).toContain('title: Updated Title');
  });

  it('updateIssue updates description section', async () => {
    await tracker.updateIssue('PROJ-1', {
      description: 'New description content',
    });

    const [, content] = mockFs.writeFile.mock.calls[0];
    expect(content).toContain('New description content');
    expect(content).toContain('<!-- SECTION:DESCRIPTION:BEGIN -->');
    expect(content).toContain('<!-- SECTION:DESCRIPTION:END -->');
  });

  it('transitionIssue updates status', async () => {
    const issue = await tracker.transitionIssue('PROJ-1', 'Done');
    expect(issue.status).toBe('Done');

    const [, content] = mockFs.writeFile.mock.calls[0];
    expect(content).toContain('status: Done');
  });

  it('transitionIssue throws for invalid status', async () => {
    await expect(tracker.transitionIssue('PROJ-1', 'InvalidStatus')).rejects.toThrow(
      'Invalid status',
    );
  });

  it('addComment appends to Implementation Notes section', async () => {
    await tracker.addComment('PROJ-1', 'This is a comment');

    expect(mockFs.writeFile).toHaveBeenCalledTimes(1);
    const [, content] = mockFs.writeFile.mock.calls[0];
    expect(content).toContain('## Implementation Notes');
    expect(content).toContain('### Note (');
    expect(content).toContain('This is a comment');
  });

  it('addComment appends to existing Implementation Notes section', async () => {
    const taskWithNotes =
      TASK_CONTENT + '\n## Implementation Notes\n\n### Note (2026-03-01 12:00)\n\nExisting note\n';
    mockFs.readFile.mockImplementation((path: string) => {
      if (path.includes('proj-1')) return Promise.resolve(taskWithNotes);
      return Promise.reject(new Error('not found'));
    });

    await tracker.addComment('PROJ-1', 'New comment');

    const [, content] = mockFs.writeFile.mock.calls[0];
    expect(content).toContain('Existing note');
    expect(content).toContain('New comment');
  });

  it('getComments parses note subsections', async () => {
    const taskWithNotes =
      TASK_CONTENT +
      '\n## Implementation Notes\n\n### Note (2026-03-01 12:00)\n\nFirst note\n\n### Note (2026-03-02 14:00)\n\nSecond note\n';
    mockFs.readFile.mockImplementation((path: string) => {
      if (path.includes('proj-1')) return Promise.resolve(taskWithNotes);
      return Promise.reject(new Error('not found'));
    });

    const comments = await tracker.getComments('PROJ-1');
    expect(comments).toHaveLength(2);
    expect(comments[0].body).toBe('First note');
    expect(comments[1].body).toBe('Second note');
  });

  it('getComments returns empty for task without notes', async () => {
    const comments = await tracker.getComments('PROJ-1');
    expect(comments).toEqual([]);
  });

  it('watchIssues returns empty async iterator', async () => {
    const stream = tracker.watchIssues({});
    const items: unknown[] = [];
    for await (const item of stream) {
      items.push(item);
    }
    expect(items).toHaveLength(0);
  });

  it('missing backlog directory gives graceful error on mutations', async () => {
    mockFs.exists.mockResolvedValue(false);
    await expect(tracker.getIssue('PROJ-1')).rejects.toThrow('tasks directory not found');
    await expect(tracker.updateIssue('PROJ-1', { title: 'X' })).rejects.toThrow(
      'tasks directory not found',
    );
    await expect(tracker.transitionIssue('PROJ-1', 'Done')).rejects.toThrow(
      'tasks directory not found',
    );
    await expect(tracker.addComment('PROJ-1', 'X')).rejects.toThrow('tasks directory not found');
    await expect(tracker.getComments('PROJ-1')).rejects.toThrow('tasks directory not found');
  });

  it('uses taskPrefix override from config', async () => {
    const customTracker = createBacklogMdIssueTracker(
      { backlogDir: '/mock/backlog', taskPrefix: 'CUSTOM' },
      mockFs,
    );
    // Override readdir to return files with CUSTOM prefix
    mockFs.readdir.mockImplementation((dirPath: string) => {
      if (dirPath === '/mock/backlog/tasks') return Promise.resolve([]);
      if (dirPath === '/mock/backlog') return Promise.resolve(['config.yml', 'tasks']);
      return Promise.reject(new Error('not found'));
    });
    mockFs.exists.mockResolvedValue(true);

    const issue = await customTracker.createIssue({ title: 'Custom Prefix Task' });
    expect(issue.id).toBe('CUSTOM-1');
  });
});
