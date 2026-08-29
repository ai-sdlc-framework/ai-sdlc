import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  registerTaskCreate,
  slugify,
  validateReferences,
  buildTaskContent,
  buildCollisionMessage,
} from './task-create.js';

type Handler = (
  args: Record<string, unknown>,
) => Promise<{ content: { type: string; text: string }[]; isError?: boolean }>;

/**
 * Tests for AISDLC-234: Pattern C-aware `task_create` MCP tool.
 *
 * AC coverage:
 *   #1 — tool is registered and callable
 *   #2 — Pattern C routing (via pickProjectRoot/deps.projectDir injection)
 *   #3 — input schema (id, title, description, status, priority, labels, dependencies, references)
 *   #4 — returned response includes resolved file path
 *   #5 — frontmatter validation / reference check
 *   #6 — hermetic tests: routes to worktree / routes to parent / refuses without signal
 *   #7 — CLAUDE.md update (docs, not tested here)
 *   #8 — tool list documentation (index.ts, tested in index.test.ts)
 */
describe('task_create MCP tool (AISDLC-234)', () => {
  let projectDir: string;
  let handler: Handler;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'aisdlc-234-task-create-'));
    initGitRepoForFixture(projectDir);
    mkdirSync(join(projectDir, 'backlog', 'tasks'), { recursive: true });
    mkdirSync(join(projectDir, 'backlog', 'completed'), { recursive: true });

    const server = {
      tool: vi.fn((_name, _desc, _schema, registered) => {
        handler = registered as Handler;
      }),
    } as unknown as McpServer;
    registerTaskCreate(server, { projectDir });
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  // AC #1, #3, #4: tool is registered, accepts required schema fields, response has path
  it('creates a task file with correct frontmatter (AC #1, #3, #4)', async () => {
    const result = await handler({
      id: 'AISDLC-234',
      title: 'Pattern-C-aware task_create tool',
      status: 'To Do',
    });

    expect(result.isError).toBeUndefined();
    const text = result.content[0].text;
    // AC #4: response includes the resolved file path
    expect(text).toContain('Path:');
    expect(text).toContain('aisdlc-234');
    expect(text).toContain('AISDLC-234');

    // Verify the file was actually written
    const tasksDir = join(projectDir, 'backlog', 'tasks');
    const files = require_readdirSync(tasksDir);
    const created = files.find((f: string) => f.startsWith('aisdlc-234'));
    expect(created).toBeDefined();

    const content = readFileSync(join(tasksDir, created!), 'utf-8');
    expect(content).toContain('id: AISDLC-234');
    // The title has no special chars needing YAML quoting (hyphens/underscores are safe)
    expect(content).toContain('title: Pattern-C-aware task_create tool');
    expect(content).toContain('status: To Do');
    expect(content).toContain('created_date:');
    expect(content).toContain('updated_date:');
  });

  // AC #3: all optional schema fields are accepted
  it('accepts all optional schema fields (AC #3)', async () => {
    const result = await handler({
      id: 'AISDLC-300',
      title: 'Full schema test',
      description: '## Description\n\nFull schema.',
      status: 'In Progress',
      priority: 'high',
      labels: ['feature', 'mcp'],
      dependencies: ['AISDLC-100'],
      references: [], // empty to avoid filesystem check failures
    });

    expect(result.isError).toBeUndefined();
    const tasksDir = join(projectDir, 'backlog', 'tasks');
    const files = require_readdirSync(tasksDir);
    const created = files.find((f: string) => f.startsWith('aisdlc-300'));
    expect(created).toBeDefined();

    const content = readFileSync(join(tasksDir, created!), 'utf-8');
    expect(content).toContain('status: In Progress');
    expect(content).toContain('priority: high');
    expect(content).toContain('labels:');
    expect(content).toContain('  - feature');
    expect(content).toContain('  - mcp');
    expect(content).toContain('dependencies:');
    expect(content).toContain('  - AISDLC-100');
    expect(content).toContain('## Description');
    expect(content).toContain('Full schema.');
  });

  // AC #4: response content explicitly includes the path
  it('response includes resolved file path (AC #4)', async () => {
    const result = await handler({ id: 'AISDLC-400', title: 'Path in response' });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain(`Path: ${join(projectDir, 'backlog', 'tasks')}`);
  });

  // AC #5: validates references, refuses with clear error on bad refs
  it('refuses with clear error when references are invalid (AC #5)', async () => {
    const result = await handler({
      id: 'AISDLC-500',
      title: 'Bad refs',
      references: ['does/not/exist.md'],
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('References validation failed');
    expect(result.content[0].text).toContain('does/not/exist.md');
  });

  // AC #5: valid file references pass
  it('accepts references that resolve to real files (AC #5)', async () => {
    // Create a real file to reference
    const refFile = join(projectDir, 'some-doc.md');
    writeFileSync(refFile, '# doc', 'utf-8');

    const result = await handler({
      id: 'AISDLC-501',
      title: 'Good refs',
      references: ['some-doc.md'],
    });

    expect(result.isError).toBeUndefined();
    const tasksDir = join(projectDir, 'backlog', 'tasks');
    const files = require_readdirSync(tasksDir);
    const created = files.find((f: string) => f.startsWith('aisdlc-501'));
    expect(created).toBeDefined();
    const content = readFileSync(join(tasksDir, created!), 'utf-8');
    expect(content).toContain('references:');
    expect(content).toContain('  - some-doc.md');
  });

  // AC #5: HTTP URL references skip filesystem check
  it('accepts http/https URL references without filesystem checks (AC #5)', async () => {
    const result = await handler({
      id: 'AISDLC-502',
      title: 'URL refs',
      references: ['https://example.com/doc'],
    });

    expect(result.isError).toBeUndefined();
  });

  // Idempotency guard: refuse to overwrite existing task in tasks/
  it('refuses if task already exists in tasks/ (idempotency guard)', async () => {
    writeFileSync(
      join(projectDir, 'backlog', 'tasks', 'aisdlc-600 - existing.md'),
      '---\nid: AISDLC-600\nstatus: To Do\n---\n',
      'utf-8',
    );

    const result = await handler({ id: 'AISDLC-600', title: 'Will conflict' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('already exists');
    expect(result.content[0].text).toContain('AISDLC-600');
  });

  // Idempotency guard: refuse to overwrite existing task in completed/
  it('refuses if task already exists in completed/ (idempotency guard)', async () => {
    writeFileSync(
      join(projectDir, 'backlog', 'completed', 'aisdlc-601 - done.md'),
      '---\nid: AISDLC-601\nstatus: Done\n---\n',
      'utf-8',
    );

    const result = await handler({ id: 'AISDLC-601', title: 'Already done' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('already exists');
  });

  // Default status is 'To Do'
  it('defaults status to "To Do" when not provided', async () => {
    const result = await handler({ id: 'AISDLC-700', title: 'Default status' });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('Status: To Do');
    const tasksDir = join(projectDir, 'backlog', 'tasks');
    const files = require_readdirSync(tasksDir);
    const created = files.find((f: string) => f.startsWith('aisdlc-700'));
    const content = readFileSync(join(tasksDir, created!), 'utf-8');
    expect(content).toContain('status: To Do');
  });

  // Creates backlog/tasks/ if it does not exist yet
  it('creates backlog/tasks/ if it does not exist', async () => {
    rmSync(join(projectDir, 'backlog', 'tasks'), { recursive: true, force: true });
    const result = await handler({ id: 'AISDLC-800', title: 'Auto-create dir' });
    expect(result.isError).toBeUndefined();
    expect(existsSync(join(projectDir, 'backlog', 'tasks'))).toBe(true);
  });

  // Major 1 (security): ID shape validation — path traversal prevention
  it('rejects id with path traversal attempt (Major 1 security)', async () => {
    const result = await handler({ id: '../../tmp/pwn', title: 'Traversal' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Invalid task ID format');
  });

  it('rejects id with non-ASCII characters (Major 1 security)', async () => {
    const result = await handler({ id: 'AISDLC-Á', title: 'Unicode' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Invalid task ID format');
  });

  it('rejects id with leading slash (Major 1 security)', async () => {
    const result = await handler({ id: '/etc/passwd', title: 'Traversal' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Invalid task ID format');
  });

  it('accepts valid id with sub-task suffix (Major 1 security)', async () => {
    const result = await handler({ id: 'AISDLC-234.1', title: 'Sub-task' });
    expect(result.isError).toBeUndefined();
  });
});

/**
 * AC #6 — Hermetic Pattern C routing tests.
 *
 * These test the routing via pickProjectRoot (which calls resolveProjectRoot
 * internally). We simulate the three Pattern C scenarios:
 *   (a) routes to worktree when sentinel exists
 *   (b) routes to parent when no .worktrees/ exists (non-Pattern-C project)
 *   (c) refuses when Pattern C parent has no sentinel and no env override
 */
describe('task_create — Pattern C routing (AC #6)', () => {
  let scratch: string;

  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), 'aisdlc-234-pattern-c-'));
    initGitRepoForFixture(scratch);
  });

  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  // AC #6(b): non-Pattern-C project — routes to the injected projectDir directly
  it('(b) routes to parent/plain project when no .worktrees/ exists (AC #6)', async () => {
    const plainProject = join(scratch, 'plain-project');
    mkdirSync(join(plainProject, 'backlog', 'tasks'), { recursive: true });

    let handler!: Handler;
    const server = {
      tool: vi.fn((_name, _desc, _schema, registered) => {
        handler = registered as Handler;
      }),
    } as unknown as McpServer;
    registerTaskCreate(server, { projectDir: plainProject });

    const result = await handler({ id: 'AISDLC-234', title: 'Plain project task' });
    expect(result.isError).toBeUndefined();
    // File should land in the plain project's tasks dir
    expect(result.content[0].text).toContain(join(plainProject, 'backlog', 'tasks'));
  });

  // AC #6(a): Pattern C — routes to worktree when sentinel (.active-task) exists.
  // This test exercises the REAL Pattern C routing path through pickProjectRoot →
  // resolveProjectRoot → applyPatternCIfNeeded → sentinel scan. We inject the
  // PARENT (which has .worktrees/<id>/ subdir + .active-task sentinel inside) as
  // projectDir. pickProjectRoot sees the parent has backlog/ → passes directly to
  // the tool, but the tool routes through pickProjectRoot which uses injected
  // projectDir. The actual Pattern C sentinel scanning is tested via env var path.
  // We use vi.stubEnv to inject AI_SDLC_ACTIVE_TASK_ID so resolveProjectRoot
  // routes correctly without relying on cwd-walk (hermetic).
  it('(a) routes to worktree when Pattern C parent has a .active-task sentinel (AC #6)', async () => {
    const parentRoot = join(scratch, 'parent-repo');
    const worktreeId = 'aisdlc-777';
    const worktreeRoot = join(parentRoot, '.worktrees', worktreeId);
    // Set up the parent with backlog/ AND the worktree subdir with backlog/tasks/
    mkdirSync(join(parentRoot, 'backlog', 'tasks'), { recursive: true });
    mkdirSync(join(worktreeRoot, 'backlog', 'tasks'), { recursive: true });
    // Write the .active-task sentinel inside the worktree
    writeFileSync(join(worktreeRoot, '.active-task'), 'AISDLC-777', 'utf-8');

    // Stub AI_SDLC_ACTIVE_TASK_ID so resolveProjectRoot routes via env var (hermetic)
    vi.stubEnv('AI_SDLC_ACTIVE_TASK_ID', 'AISDLC-777');
    // Point AI_SDLC_PROJECT_ROOT at the parent so resolveProjectRoot finds it
    vi.stubEnv('AI_SDLC_PROJECT_ROOT', parentRoot);

    let handler!: Handler;
    const server = {
      tool: vi.fn((_name, _desc, _schema, registered) => {
        handler = registered as Handler;
      }),
    } as unknown as McpServer;
    // Inject a deps.projectDir that has NO backlog/ so pickProjectRoot falls through
    // to resolveProjectRoot, which picks up AI_SDLC_PROJECT_ROOT → Pattern C routing.
    const noBacklogDir = join(scratch, 'no-backlog-for-6a');
    mkdirSync(noBacklogDir, { recursive: true });
    registerTaskCreate(server, { projectDir: noBacklogDir });

    const result = await handler({ id: 'AISDLC-777', title: 'Worktree routed task' });
    expect(result.isError).toBeUndefined();
    // File must land inside the WORKTREE's tasks dir, not the parent's
    expect(result.content[0].text).toContain(join(worktreeRoot, 'backlog', 'tasks'));
    expect(result.content[0].text).not.toContain(join(parentRoot, 'backlog', 'tasks'));

    vi.unstubAllEnvs();
  });

  // AC #6(c): Pattern C parent with no sentinel — resolveProjectRoot throws the
  // canonical PATTERN_C_ERROR_MESSAGE and the tool returns isError: true.
  // We set up a Pattern C parent (with .worktrees/<id>/ subdir but NO .active-task
  // inside it), point AI_SDLC_PROJECT_ROOT at it via vi.stubEnv, clear
  // AI_SDLC_ACTIVE_TASK_ID, inject a deps.projectDir with no backlog/ so
  // pickProjectRoot falls through to resolveProjectRoot, and assert the error.
  it('(c) refuses with clear error when Pattern C parent has no sentinel (AC #6)', async () => {
    const parentRoot = join(scratch, 'pattern-c-no-sentinel');
    mkdirSync(join(parentRoot, 'backlog', 'tasks'), { recursive: true });
    // Create a worktree subdir — enough to trigger Pattern C detection — but NO sentinel
    mkdirSync(join(parentRoot, '.worktrees', 'aisdlc-999'), { recursive: true });
    // Explicitly do NOT write a .active-task sentinel

    // Hermetically control env: point resolver at the Pattern C parent, ensure no task ID
    vi.stubEnv('AI_SDLC_PROJECT_ROOT', parentRoot);
    vi.stubEnv('AI_SDLC_ACTIVE_TASK_ID', '');

    const noBacklogDir = join(scratch, 'no-backlog-for-6c');
    mkdirSync(noBacklogDir, { recursive: true });

    let handler!: Handler;
    const server = {
      tool: vi.fn((_name, _desc, _schema, registered) => {
        handler = registered as Handler;
      }),
    } as unknown as McpServer;
    // Inject a projectDir with no backlog/ so pickProjectRoot falls through to resolveProjectRoot
    registerTaskCreate(server, { projectDir: noBacklogDir });

    const result = await handler({ id: 'AISDLC-999', title: 'Should be refused' });
    expect(result.isError).toBe(true);
    // The error message must contain the canonical Pattern C error string
    expect(result.content[0].text).toContain('Pattern C');

    vi.unstubAllEnvs();
  });
});

describe('slugify (AISDLC-234)', () => {
  it('converts spaces to hyphens', () => {
    expect(slugify('Hello World')).toBe('Hello-World');
  });

  it('strips special characters', () => {
    expect(slugify('RFC-0011: Definition of Ready!')).toBe('RFC-0011-Definition-of-Ready');
  });

  it('collapses repeated hyphens', () => {
    expect(slugify('A  B   C')).toBe('A-B-C');
  });

  it('strips leading and trailing hyphens', () => {
    expect(slugify('  hello  ')).toBe('hello');
  });

  it('caps at 60 characters', () => {
    const long = 'a'.repeat(80);
    expect(slugify(long).length).toBeLessThanOrEqual(60);
  });

  it('handles empty string', () => {
    expect(slugify('')).toBe('');
  });
});

describe('validateReferences (AISDLC-234)', () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'aisdlc-234-refs-'));
    initGitRepoForFixture(projectDir);
  });

  afterEach(() => rmSync(projectDir, { recursive: true, force: true }));

  it('returns empty for no references', () => {
    expect(validateReferences([], projectDir)).toEqual([]);
  });

  it('accepts http/https URLs without checking filesystem', () => {
    expect(
      validateReferences(['https://example.com/doc', 'http://localhost:3000/'], projectDir),
    ).toEqual([]);
  });

  it('returns error for non-existent file reference', () => {
    const errors = validateReferences(['missing.md'], projectDir);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('missing.md');
    expect(errors[0]).toContain('file not found');
  });

  it('accepts a file reference that exists', () => {
    writeFileSync(join(projectDir, 'exists.md'), '# doc', 'utf-8');
    expect(validateReferences(['exists.md'], projectDir)).toEqual([]);
  });

  it('returns multiple errors for multiple bad refs', () => {
    const errors = validateReferences(['a.md', 'b.md'], projectDir);
    expect(errors).toHaveLength(2);
  });
});

describe('buildTaskContent (AISDLC-234)', () => {
  it('produces valid frontmatter with required fields', () => {
    const content = buildTaskContent({ id: 'AISDLC-1', title: 'Test', status: 'To Do' });
    expect(content).toContain('---');
    expect(content).toContain('id: AISDLC-1');
    expect(content).toContain('title: Test');
    expect(content).toContain('status: To Do');
    expect(content).toContain('created_date:');
    expect(content).toContain('updated_date:');
    expect(content).toContain('assignee: []');
    expect(content).toContain('labels: []');
    expect(content).toContain('dependencies: []');
    expect(content).toContain('references: []');
  });

  it('includes priority when provided', () => {
    const content = buildTaskContent({
      id: 'AISDLC-2',
      title: 'Test',
      status: 'To Do',
      priority: 'high',
    });
    expect(content).toContain('priority: high');
  });

  it('includes labels as YAML sequence', () => {
    const content = buildTaskContent({
      id: 'AISDLC-3',
      title: 'Test',
      status: 'To Do',
      labels: ['feature', 'mcp'],
    });
    expect(content).toContain('labels:');
    expect(content).toContain('  - feature');
    expect(content).toContain('  - mcp');
  });

  it('includes dependencies as YAML sequence', () => {
    const content = buildTaskContent({
      id: 'AISDLC-4',
      title: 'Test',
      status: 'To Do',
      dependencies: ['AISDLC-100', 'AISDLC-200'],
    });
    expect(content).toContain('dependencies:');
    expect(content).toContain('  - AISDLC-100');
    expect(content).toContain('  - AISDLC-200');
  });

  it('includes references as YAML sequence', () => {
    const content = buildTaskContent({
      id: 'AISDLC-5',
      title: 'Test',
      status: 'To Do',
      references: ['docs/foo.md'],
    });
    expect(content).toContain('references:');
    expect(content).toContain('  - docs/foo.md');
  });

  it('appends description after frontmatter', () => {
    const content = buildTaskContent({
      id: 'AISDLC-6',
      title: 'Test',
      status: 'To Do',
      description: '## Description\n\nBody.',
    });
    // description body appears after the closing frontmatter delimiter
    expect(content.indexOf('## Description')).toBeGreaterThan(content.indexOf('---\n\n'));
    expect(content).toContain('Body.');
  });

  it('quotes title with special characters', () => {
    const content = buildTaskContent({
      id: 'AISDLC-7',
      title: "RFC-0011: Foo's bar",
      status: 'To Do',
    });
    // Title contains ':' so it must be quoted
    expect(content).toMatch(/title: '/);
  });
});

/**
 * AISDLC-559 — cross-source collision refusal.
 *
 * `task_create` must refuse an ID collision found in ANY of the 3 scanner
 * sources (git refs across every branch, sibling worktree filesystems, the
 * current worktree) — not just an exact filename match in the current
 * project dir. Fixtures are throwaway git repos / directory trees built
 * under a `mkdtemp`'d scratch dir, never a shared /tmp path.
 */
describe('task_create — cross-source collision refusal (AISDLC-559)', () => {
  let scratch: string;

  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), 'aisdlc-559-task-create-'));
    initGitRepoForFixture(scratch);
  });

  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  function git(cwd: string, args: string[]): string {
    return execFileSync('git', args, { cwd, encoding: 'utf-8' });
  }

  function initRepo(dir: string): void {
    mkdirSync(dir, { recursive: true });
    git(dir, ['init', '-q', '-b', 'main']);
    git(dir, ['config', 'user.email', 'aisdlc-559-task-create-test@example.invalid']);
    git(dir, ['config', 'user.name', 'AISDLC-559 task_create Test']);
  }

  it('refuses when the ID is claimed only on an unmerged branch', async () => {
    const repo = join(scratch, 'repo');
    initRepo(repo);
    writeFileSync(join(repo, 'README.md'), '# repo', 'utf-8');
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-q', '-m', 'chore: init']);

    git(repo, ['checkout', '-q', '-b', 'feature/x']);
    mkdirSync(join(repo, 'backlog', 'tasks'), { recursive: true });
    writeFileSync(join(repo, 'backlog', 'tasks', 'aisdlc-650 - foo.md'), 'x', 'utf-8');
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-q', '-m', 'feat: add AISDLC-650']);
    git(repo, ['checkout', '-q', 'main']);
    // On main, backlog/tasks/ doesn't exist in the working tree (only on the
    // unmerged branch) — recreate the empty dir so pickProjectRoot's
    // hasBacklogDir() check accepts the injected projectDir directly instead
    // of falling through to cwd-walk discovery.
    mkdirSync(join(repo, 'backlog', 'tasks'), { recursive: true });

    let handler!: Handler;
    const server = {
      tool: vi.fn((_name, _desc, _schema, registered) => {
        handler = registered as Handler;
      }),
    } as unknown as McpServer;
    registerTaskCreate(server, { projectDir: repo });

    const result = await handler({
      id: 'AISDLC-650',
      title: 'Should collide with unmerged branch',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('AISDLC-650');
    expect(result.content[0].text).toContain('git-refs');

    // The refusal must not have written the file (no false claim on refusal).
    expect(
      existsSync(
        join(repo, 'backlog', 'tasks', 'aisdlc-650 - should-collide-with-unmerged-branch.md'),
      ),
    ).toBe(false);
  });

  it('refuses when the ID is claimed only as an uncommitted file in a sibling worktree', async () => {
    const parent = join(scratch, 'parent-repo');
    const wtA = join(parent, '.worktrees', 'aisdlc-a');
    const wtB = join(parent, '.worktrees', 'aisdlc-b');
    mkdirSync(join(wtA, 'backlog', 'tasks'), { recursive: true });
    mkdirSync(join(wtB, 'backlog', 'tasks'), { recursive: true });
    writeFileSync(
      join(wtB, 'backlog', 'tasks', 'aisdlc-960 - sibling-uncommitted.md'),
      'x',
      'utf-8',
    );

    let handler!: Handler;
    const server = {
      tool: vi.fn((_name, _desc, _schema, registered) => {
        handler = registered as Handler;
      }),
    } as unknown as McpServer;
    registerTaskCreate(server, { projectDir: wtA });

    const result = await handler({
      id: 'AISDLC-960',
      title: 'Should collide with sibling worktree',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('sibling-worktrees');
    expect(result.content[0].text).toContain('aisdlc-b');
  });

  it('succeeds and writes the file when no source claims the ID', async () => {
    const repo = join(scratch, 'repo-clean');
    initRepo(repo);
    mkdirSync(join(repo, 'backlog', 'tasks'), { recursive: true });

    let handler!: Handler;
    const server = {
      tool: vi.fn((_name, _desc, _schema, registered) => {
        handler = registered as Handler;
      }),
    } as unknown as McpServer;
    registerTaskCreate(server, { projectDir: repo });

    const result = await handler({ id: 'AISDLC-970', title: 'No collision' });
    expect(result.isError).toBeUndefined();
    const created = readdirSync(join(repo, 'backlog', 'tasks')).find((f) =>
      f.startsWith('aisdlc-970'),
    );
    expect(created).toBeDefined();
  });
});

describe('buildCollisionMessage (AISDLC-559)', () => {
  it('names the source and detail for each claim', () => {
    const msg = buildCollisionMessage('AISDLC-650', [
      { source: 'git-refs', detail: 'backlog/tasks/aisdlc-650 - foo.md' },
      { source: 'sibling-worktrees', detail: '/parent/.worktrees/aisdlc-b/backlog/tasks/x.md' },
    ]);
    expect(msg).toContain('AISDLC-650');
    expect(msg).toContain('[git-refs]');
    expect(msg).toContain('[sibling-worktrees]');
    expect(msg).toContain('next_task_id');
  });
});

// ── helpers ──────────────────────────────────────────────────────────────

import { readdirSync } from 'node:fs';

// AISDLC-559 review (CRITICAL): the allocator now fails CLOSED when the
// git-refs source cannot scan. These fixtures previously used bare mkdtemp
// dirs with no .git, so git-refs was genuinely unscanned in EVERY test while
// they all asserted success — the tool's core guarantee was never exercised.
// Make the fixtures real repos so the scan actually runs.
function initGitRepoForFixture(dir: string): void {
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'aisdlc-559-fixture@example.invalid'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'AISDLC-559 Fixture'], { cwd: dir });
}

function require_readdirSync(dir: string): string[] {
  return readdirSync(dir);
}

describe('task_create — round-2 review fixes (AISDLC-559)', () => {
  let projectDir: string;
  let handler: Handler;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'aisdlc-559-r2-create-'));
    initGitRepoForFixture(projectDir);
    mkdirSync(join(projectDir, 'backlog', 'tasks'), { recursive: true });
    const server = {
      tool: vi.fn((_n, _d, _s, registered) => {
        handler = registered as Handler;
      }),
    } as unknown as McpServer;
    registerTaskCreate(server, { projectDir });
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  // CRITICAL: collapsing the collision check to the MAJOR number refused every
  // legitimate new sub-ID, breaking the RFC-walkthrough phase-task pattern.
  it('allows a NEW sub-ID even when the major and a sibling sub-ID exist', async () => {
    writeFileSync(join(projectDir, 'backlog', 'tasks', 'aisdlc-100 - epic.md'), 'x', 'utf-8');
    writeFileSync(join(projectDir, 'backlog', 'tasks', 'aisdlc-100.5 - phase.md'), 'x', 'utf-8');

    const result = await handler({ id: 'AISDLC-100.6', title: 'Phase six' });
    expect(result.isError).toBeUndefined();
    expect(existsSync(join(projectDir, 'backlog', 'tasks', 'aisdlc-100.6 - Phase-six.md'))).toBe(
      true,
    );
  });

  it('still refuses the EXACT id when it is already claimed', async () => {
    writeFileSync(join(projectDir, 'backlog', 'tasks', 'aisdlc-100.5 - phase.md'), 'x', 'utf-8');
    const result = await handler({ id: 'AISDLC-100.5', title: 'Dupe' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('already exists');
  });

  // CRITICAL: treating an unscanned git-refs as "no collisions" is how a
  // duplicate gets written for an id claimed on an unmerged/remote branch.
  it('refuses to create when the git-refs source could not be scanned', async () => {
    const noGit = mkdtempSync(join(tmpdir(), 'aisdlc-559-nogit-'));
    mkdirSync(join(noGit, 'backlog', 'tasks'), { recursive: true });
    // Broken gitdir = refs exist but are unreadable. A plain directory would be
    // vacuously complete and must NOT be refused.
    writeFileSync(join(noGit, '.git'), 'gitdir: /nonexistent/aisdlc-559\n', 'utf-8');
    let h: Handler;
    const server = {
      tool: vi.fn((_n, _d, _s, registered) => {
        h = registered as Handler;
      }),
    } as unknown as McpServer;
    registerTaskCreate(server, { projectDir: noGit });

    const result = await h!({ id: 'AISDLC-900', title: 'No git here' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('cannot verify it is unclaimed');
    expect(result.content[0].text).toContain('git-refs');
    expect(existsSync(join(noGit, 'backlog', 'tasks', 'aisdlc-900 - No-git-here.md'))).toBe(false);
    rmSync(noGit, { recursive: true, force: true });
  });
});
