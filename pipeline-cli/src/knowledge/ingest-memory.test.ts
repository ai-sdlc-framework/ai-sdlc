import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyDream } from '../memory-dream/apply.js';
import { metaPathFor } from '../memory-dream/run.js';
import { readMemoryFolder, serializeNote } from '../memory-dream/notes.js';
import { parseEntryFile } from './entry.js';
import { ingestMemoryForProject, memoryEntryId, reingestAfterSwap } from './ingest-memory.js';
import { readLedger } from './retrieval/ledger.js';
import { queryIndex, rebuildIndex, recordHarnessRecall } from './retrieval/service.js';
import { checkKnowledgeScope } from './scope-check.js';
import { findProtectedCitations, validateKnowledge } from './store.js';

let dir: string;
let mem: string;
const protectedMem = (): string => join(dir, '.ai-sdlc/knowledge-protected/memory');

function note(file: string, type: string, body = 'banana smoothie preference'): void {
  writeFileSync(
    join(mem, file),
    serializeNote({ name: file.replace('.md', ''), description: `about ${file}`, type, body }),
  );
}

function entry(file: string): Record<string, unknown> {
  const p = parseEntryFile(
    readFileSync(join(protectedMem(), `${memoryEntryId(file)}.md`), 'utf-8'),
  );
  if (!('fields' in p)) throw new Error('unparseable');
  return p.fields;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ingest-memory-'));
  mem = join(dir, '.claude/memory');
  mkdirSync(mem, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: dir });
  writeFileSync(join(dir, '.gitignore'), '.ai-sdlc/knowledge-protected/\n.claude/memory/\n');
  note('user_role.md', 'user');
  note('feedback_rule.md', 'feedback');
  note('project_x.md', 'project');
  note('reference_y.md', 'reference');
  writeFileSync(join(mem, 'MEMORY.md'), '- [a](user_role.md) — a\n');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('ingestMemoryForProject', () => {
  it('turns every note into a protected memory entry cited to the note file', () => {
    const r = ingestMemoryForProject(dir, mem, '2026-10-29');
    expect(r.created).toBe(4);
    for (const f of ['user_role.md', 'feedback_rule.md', 'project_x.md', 'reference_y.md']) {
      const e = entry(f);
      expect(e.trunk).toBe('memory');
      expect(e.scope).toBe('protected');
      expect(e.source).toBe(`.claude/memory/${f}`);
    }
    expect(validateKnowledge(dir).errors).toEqual([]);
    expect(ingestMemoryForProject(dir, mem, '2026-10-29').unchanged).toBe(4);
  });

  it.each([
    ['user_role.md', 'specialist', 'operator'],
    ['feedback_rule.md', 'specialist', 'operator'],
    ['project_x.md', 'inferred', undefined],
    ['reference_y.md', 'inferred', undefined],
  ])('maps %s to %s', (file, authority, proof) => {
    ingestMemoryForProject(dir, mem, '2026-10-29');
    const e = entry(file);
    expect(e.authority).toBe(authority);
    expect(e.proof).toBe(proof);
  });

  it('updates a changed note with supersedes and skips invalid notes', () => {
    ingestMemoryForProject(dir, mem, '2026-10-29');
    note('user_role.md', 'user', 'changed body');
    writeFileSync(join(mem, 'broken.md'), 'no frontmatter');
    const r = ingestMemoryForProject(dir, mem, '2026-10-30');
    expect(r.updated).toBe(1);
    expect(r.skipped).toBe(1);
    expect(String(entry('user_role.md').supersedes)).toContain('memory-user-role@');
  });

  it('re-ingests under the dream lock after a swap and supersedes removed notes', () => {
    ingestMemoryForProject(dir, mem, '2026-10-29');
    const out = join(dir, '.claude/memory.dream-out');
    mkdirSync(out);
    for (const f of ['user_role.md', 'feedback_rule.md', 'reference_y.md']) {
      writeFileSync(join(out, f), readFileSync(join(mem, f)));
    }
    writeFileSync(join(out, 'MEMORY.md'), '');
    const snapshot = Object.fromEntries(readMemoryFolder(mem).notes.map((n) => [n.file, n.hash]));
    writeFileSync(metaPathFor(out), JSON.stringify({ inputDir: mem, snapshot }));
    let lockSeen = false;
    applyDream({
      outputDir: out,
      afterSwap: (live) => {
        lockSeen = existsSync(`${live}.dream.lock`);
        reingestAfterSwap(dir)(live);
      },
    });
    expect(lockSeen).toBe(true);
    expect(entry('project_x.md').status).toBe('superseded');
    expect(entry('user_role.md').status).toBeUndefined();
  });

  it('does not re-ingest when the memory trunk was never created', () => {
    reingestAfterSwap(dir)(mem);
    expect(existsSync(protectedMem())).toBe(false);
  });
});

describe('ledger and scope', () => {
  it('marks harness-recalled notes loaded so the engine does not inject them again', async () => {
    ingestMemoryForProject(dir, mem, '2026-10-29');
    await rebuildIndex(dir);
    expect(recordHarnessRecall(dir, 's1', mem, ['user_role.md'])).toBe(1);
    expect(recordHarnessRecall(dir, 's1', mem, ['user_role.md'])).toBe(0);
    expect(readLedger(dir, 's1').some((r) => r.moment === 'harness-recall')).toBe(true);
    const hits = await queryIndex(dir, { text: 'banana smoothie', sessionId: 's1' });
    const ids = hits.map((h) => h.id);
    expect(ids).not.toContain('memory-user-role');
    expect(ids).toContain('memory-project-x');
  });

  it('excludes superseded entries from the index', async () => {
    ingestMemoryForProject(dir, mem, '2026-10-29');
    rmSync(join(mem, 'project_x.md'));
    ingestMemoryForProject(dir, mem, '2026-10-30');
    await rebuildIndex(dir);
    const ids = (await queryIndex(dir, { text: 'banana smoothie' })).map((h) => h.id);
    expect(ids).not.toContain('memory-project-x');
    expect(ids).toContain('memory-user-role');
  });

  it('keeps memory out of the tracked root and flags citations in a PR body', () => {
    ingestMemoryForProject(dir, mem, '2026-10-29');
    expect(checkKnowledgeScope(dir)).toEqual([]);
    expect(existsSync(join(dir, '.ai-sdlc/knowledge/memory'))).toBe(false);
    expect(findProtectedCitations(dir, 'see memory-user-role for details')).toEqual([
      'memory-user-role',
    ]);
    expect(findProtectedCitations(dir, 'nothing here')).toEqual([]);
  });
});
