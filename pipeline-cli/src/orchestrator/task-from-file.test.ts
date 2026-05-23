/**
 * AISDLC-373 — tests for the single-PR `--task-from-file` resolver.
 *
 * Covers the happy path (valid file, frontmatter override, slug fallback)
 * plus every rejection branch (missing file, directory, bad filename,
 * unreadable frontmatter).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { resolveTaskFromFile, TaskFromFileResolutionError } from './task-from-file.js';

describe('resolveTaskFromFile', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'aisdlc-373-tff-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  function writeTask(relativePath: string, body: string): { absolute: string; relative: string } {
    const absolute = join(tmp, relativePath);
    // Use path.dirname for cross-platform correctness — lastIndexOf('/') breaks
    // on Windows where the separator is '\\'. (Round-2 reviewer minor fix.)
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, body, 'utf8');
    return { absolute, relative: relativePath };
  }

  it('resolves a well-formed task file via absolute path', () => {
    const body = [
      '---',
      'id: AISDLC-373',
      "title: 'feat(orchestrator): collapse 2-PR pattern'",
      'status: To Do',
      '---',
      '',
      '## Problem',
      'lorem ipsum',
    ].join('\n');
    const { absolute } = writeTask('backlog/tasks/aisdlc-373 - feat-collapse.md', body);

    const result = resolveTaskFromFile(absolute);

    expect(result.id).toBe('AISDLC-373');
    expect(result.title).toBe('feat(orchestrator): collapse 2-PR pattern');
    expect(result.filePath).toBe(resolve(absolute));
  });

  it('resolves a file under .worktrees/<id>/backlog/tasks (operator-driven shape)', () => {
    const body = [
      '---',
      'id: AISDLC-400',
      'title: example title',
      '---',
      '',
      '## Problem',
      'x',
    ].join('\n');
    const { absolute } = writeTask(
      '.worktrees/aisdlc-400/backlog/tasks/aisdlc-400 - example.md',
      body,
    );

    const result = resolveTaskFromFile(absolute);
    expect(result.id).toBe('AISDLC-400');
    expect(result.title).toBe('example title');
  });

  it('resolves files under backlog/completed/ (single-PR flow may stage there)', () => {
    const body = ['---', 'id: AISDLC-401', 'title: t', '---', '', '## Problem', 'x'].join('\n');
    const { absolute } = writeTask('backlog/completed/aisdlc-401 - t.md', body);
    const result = resolveTaskFromFile(absolute);
    expect(result.id).toBe('AISDLC-401');
  });

  it('resolves via a relative path with workDir as the base', () => {
    const body = ['---', 'id: AISDLC-402', 'title: rel', '---', '', '## Problem', 'x'].join('\n');
    writeTask('backlog/tasks/aisdlc-402 - rel.md', body);

    const result = resolveTaskFromFile('backlog/tasks/aisdlc-402 - rel.md', tmp);
    expect(result.id).toBe('AISDLC-402');
    expect(result.title).toBe('rel');
  });

  it('upper-cases the frontmatter id even when it is lowercase', () => {
    const body = ['---', 'id: aisdlc-403', 'title: t', '---', '', '## Problem', 'x'].join('\n');
    const { absolute } = writeTask('backlog/tasks/aisdlc-403 - t.md', body);
    const result = resolveTaskFromFile(absolute);
    expect(result.id).toBe('AISDLC-403');
  });

  it('falls back to filename-derived id when frontmatter id is missing', () => {
    const body = ['---', 'title: no id field', '---', '', '## Problem', 'x'].join('\n');
    const { absolute } = writeTask('backlog/tasks/aisdlc-404 - some-slug.md', body);
    const result = resolveTaskFromFile(absolute);
    expect(result.id).toBe('AISDLC-404');
    expect(result.title).toBe('no id field');
  });

  it('falls back to humanized slug when frontmatter title is missing', () => {
    const body = ['---', 'id: AISDLC-405', '---', '', '## Problem', 'x'].join('\n');
    const { absolute } = writeTask('backlog/tasks/aisdlc-405 - feat-add-thing.md', body);
    const result = resolveTaskFromFile(absolute);
    expect(result.title).toBe('feat add thing');
  });

  it('accepts sub-task ids like aisdlc-NN.M', () => {
    const body = ['---', 'id: AISDLC-373.1', 'title: sub', '---', '', '## P', 'x'].join('\n');
    const { absolute } = writeTask('backlog/tasks/aisdlc-373.1 - sub.md', body);
    const result = resolveTaskFromFile(absolute);
    expect(result.id).toBe('AISDLC-373.1');
  });

  it('throws on empty input', () => {
    expect(() => resolveTaskFromFile('')).toThrow(TaskFromFileResolutionError);
    expect(() => resolveTaskFromFile('   ')).toThrow(TaskFromFileResolutionError);
  });

  it('throws when the file does not exist', () => {
    expect(() => resolveTaskFromFile(join(tmp, 'does-not-exist.md'))).toThrow(/does not exist/);
  });

  it('throws when the path is a directory', () => {
    const dir = join(tmp, 'aisdlc-406 - dir.md');
    mkdirSync(dir, { recursive: true });
    expect(() => resolveTaskFromFile(dir)).toThrow(/not a regular file/);
  });

  it('throws on a filename that does not match the convention', () => {
    const { absolute } = writeTask('backlog/tasks/random-name.md', '---\nid: X\n---\n');
    expect(() => resolveTaskFromFile(absolute)).toThrow(/does not match 'aisdlc-NN/);
  });

  it('throws on a file with no frontmatter (graceful)', () => {
    const { absolute } = writeTask('backlog/tasks/aisdlc-407 - bare.md', 'no frontmatter here');
    // No frontmatter → falls back to filename id + slug; that's OK.
    const result = resolveTaskFromFile(absolute);
    expect(result.id).toBe('AISDLC-407');
    expect(result.title).toBe('bare');
  });

  it('attributes a YAML parse error to "failed to load" (not "failed to read")', () => {
    // Round-2 reviewer minor fix: a YAML-parse failure used to be reported as
    // `failed to read task file ... YAML parse error: ...` — misleading because
    // the read succeeded; only the parse failed. The two failure modes now use
    // distinct verbs ("read" for filesystem errors, "load" for parse errors).
    const badYaml = ['---', 'id: AISDLC-408', 'title: [unclosed', '---', '', 'body'].join('\n');
    const { absolute } = writeTask('backlog/tasks/aisdlc-408 - bad-yaml.md', badYaml);
    expect(() => resolveTaskFromFile(absolute)).toThrow(/failed to load task file/);
  });
});
