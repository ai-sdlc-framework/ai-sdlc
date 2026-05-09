import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  registerTaskCreate,
  slugify,
  findExistingTaskFile,
  validateReferences,
  buildTaskContent,
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

describe('findExistingTaskFile (AISDLC-234)', () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'aisdlc-234-find-'));
    mkdirSync(join(projectDir, 'backlog', 'tasks'), { recursive: true });
    mkdirSync(join(projectDir, 'backlog', 'completed'), { recursive: true });
  });

  afterEach(() => rmSync(projectDir, { recursive: true, force: true }));

  it('returns undefined for unknown IDs', () => {
    expect(findExistingTaskFile(projectDir, 'AISDLC-9999')).toBeUndefined();
  });

  it('finds a file in tasks/', () => {
    const p = join(projectDir, 'backlog', 'tasks', 'aisdlc-42 - example.md');
    writeFileSync(p, 'x', 'utf-8');
    expect(findExistingTaskFile(projectDir, 'AISDLC-42')).toBe(p);
  });

  it('finds a file in completed/', () => {
    const p = join(projectDir, 'backlog', 'completed', 'aisdlc-42 - done.md');
    writeFileSync(p, 'x', 'utf-8');
    expect(findExistingTaskFile(projectDir, 'aisdlc-42')).toBe(p);
  });

  it('is case-insensitive', () => {
    const p = join(projectDir, 'backlog', 'tasks', 'aisdlc-10 - x.md');
    writeFileSync(p, 'x', 'utf-8');
    expect(findExistingTaskFile(projectDir, 'AISDLC-10')).toBe(p);
  });
});

describe('validateReferences (AISDLC-234)', () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'aisdlc-234-refs-'));
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

// ── helpers ──────────────────────────────────────────────────────────────

import { readdirSync } from 'node:fs';
function require_readdirSync(dir: string): string[] {
  return readdirSync(dir);
}
