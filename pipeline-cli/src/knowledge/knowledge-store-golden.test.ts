/**
 * Golden bytes (AISDLC-1418): routing entry writes through `KnowledgeStore` must not change a
 * single byte on disk. The snapshots below were recorded with the pre-store writers.
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { serializeNote } from '../memory-dream/notes.js';
import { loadKnowledgeConfig } from './config.js';
import { captureFact } from './data-room.js';
import { hashValue } from './entry.js';
import { supersedeEntry } from './human.js';
import { ingestMemoryTrunk } from './ingest-memory.js';
import { ingestSource } from './ingest-sources.js';
import { DEFAULT_ONTOLOGY } from './ontology.js';
import { promoteEntry } from './promote.js';
import { removeFixtureDir } from '../__test-helpers/remove-fixture-dir.js';

const HUMAN = { by: 'human', principal: 'human:op@example.com' } as const;

let root: string;
afterEach(() => removeFixtureDir(root));

function seed(tracked: string, id: string): void {
  const value = `value of ${id}`;
  const fields = {
    id,
    trunk: 'systems',
    type: 'fact',
    value,
    confidence: 0.5,
    authority: 'inferred',
    scope: 'internal',
    source: 'src/x.ts',
    observed: '2026-10-09',
    decay: 'durable',
    relations: [],
    contentHash: hashValue(value),
  };
  const p = join(tracked, 'systems', `${id}.md`);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, `---\n${JSON.stringify(fields)}\n---\nbody\n`);
}

describe('entry bytes on disk (golden)', () => {
  it('promoted, superseded, ingested and captured entries are byte-identical', () => {
    root = mkdtempSync(join(tmpdir(), 'ks-golden-'));
    const tracked = join(root, '.ai-sdlc/knowledge');
    const prot = join(root, '.ai-sdlc/knowledge-protected');
    seed(tracked, 'a');
    seed(tracked, 'b');
    const read = (p: string): string => readFileSync(p, 'utf-8');

    const ctx = { projectDir: root, ontology: DEFAULT_ONTOLOGY, config: loadKnowledgeConfig(root) };
    expect(
      promoteEntry({ backend: 'files' }, tracked, 'a', { to: 'canonical', ...HUMAN }, ctx).ok,
    ).toBe(true);
    expect(read(join(tracked, 'systems/a.md'))).toMatchInlineSnapshot(`
      "---
      id: a
      trunk: systems
      type: fact
      value: value of a
      confidence: 0.5
      authority: canonical
      scope: internal
      source: src/x.ts
      observed: '2026-10-09'
      decay: durable
      relations: []
      contentHash: f8aa46f438ac8f39780e03ec8244ccdc6ce8e6221832a6ed34383ce104496356
      ---
      body
      "
    `);

    expect(supersedeEntry({ backend: 'files' }, tracked, 'a', 'b', HUMAN).ok).toBe(true);
    expect(read(join(tracked, 'systems/b.md'))).toMatchInlineSnapshot(`
      "---
      id: b
      trunk: systems
      type: fact
      value: value of b
      confidence: 0.5
      authority: inferred
      scope: internal
      source: src/x.ts
      observed: '2026-10-09'
      decay: durable
      relations:
        - type: supersedes
          target: a
      contentHash: 5741ee6a70b06dc36f44ea5995db9b289bb54e1eab3b0930bceb5247544a248c
      supersedes: a
      ---
      body
      "
    `);

    const task = join(root, 'backlog/tasks/T-1 - t.md');
    mkdirSync(dirname(task), { recursive: true });
    writeFileSync(task, '---\nid: T-1\ntitle: Do thing\nstatus: To Do\n---\n\nbody\n');
    const opts = {
      backend: 'files',
      projectDir: root,
      trackedRootAbs: tracked,
      ontology: DEFAULT_ONTOLOGY,
      observed: '2026-10-09',
      actor: HUMAN,
    };
    expect(ingestSource('tasks', opts)).toEqual({ created: 1, updated: 0, unchanged: 0 });
    expect(read(join(tracked, 'process/task-t-1.md'))).toMatchInlineSnapshot(`
      "---
      id: task-t-1
      trunk: process
      type: fact
      value: 'T-1: Do thing [To Do]'
      confidence: 0.8
      authority: specialist
      scope: internal
      source: backlog/tasks/T-1 - t.md
      observed: '2026-10-09'
      decay: seasonal
      relations: []
      contentHash: 1351d1d79eba8f162cbf9748d72fb276ed20146592f66eba9aa66d62f1a4757a
      proof: T-1
      ---

      "
    `);
    writeFileSync(task, '---\nid: T-1\ntitle: Do another thing\nstatus: Done\n---\n\nbody\n');
    expect(ingestSource('tasks', opts)).toEqual({ created: 0, updated: 1, unchanged: 0 });
    expect(read(join(tracked, 'process/task-t-1.md'))).toMatchInlineSnapshot(`
      "---
      id: task-t-1
      trunk: process
      type: fact
      value: 'T-1: Do another thing [Done]'
      confidence: 0.8
      authority: specialist
      scope: internal
      source: backlog/tasks/T-1 - t.md
      observed: '2026-10-09'
      decay: seasonal
      relations: []
      contentHash: ea22ff54b8cc195d2d1a4e248b1367dcc4a460cca6eb4eff84ec1ca97a24b1d3
      proof: T-1
      supersedes: task-t-1@1351d1d79eba8f162cbf9748d72fb276ed20146592f66eba9aa66d62f1a4757a
      ---

      "
    `);

    const mem = join(root, 'memory');
    mkdirSync(mem, { recursive: true });
    const note = (file: string, type: string): void =>
      writeFileSync(
        join(mem, file),
        serializeNote({ name: file.replace('.md', ''), description: `about ${file}`, type, body }),
      );
    const body = 'banana smoothie preference';
    note('user_role.md', 'user');
    note('project_x.md', 'project');
    const memOpts = {
      backend: 'files',
      projectDir: root,
      memoryDir: mem,
      protectedRootAbs: prot,
      ontology: DEFAULT_ONTOLOGY,
      observed: '2026-10-09',
      actor: HUMAN,
    };
    expect(ingestMemoryTrunk(memOpts).created).toBe(2);
    expect(read(join(prot, 'memory/memory-user-role.md'))).toMatchInlineSnapshot(`
      "---
      id: memory-user-role
      trunk: memory
      type: fact
      value: 'user_role: about user_role.md banana smoothie preference'
      confidence: 0.8
      authority: specialist
      scope: protected
      source: memory/user_role.md
      observed: '2026-10-09'
      decay: durable
      relations: []
      contentHash: 3c3892e8f8f23c34a578efdc04408917a3312b8e95e8bef8539c129cd5d817eb
      proof: operator
      ---

      banana smoothie preference
      "
    `);
    writeFileSync(join(mem, 'project_x.md'), '');
    expect(ingestMemoryTrunk(memOpts)).toMatchObject({ superseded: 1 });
    expect(read(join(prot, 'memory/memory-project-x.md'))).toMatchInlineSnapshot(`
      "---
      id: memory-project-x
      trunk: memory
      type: fact
      value: 'project_x: about project_x.md banana smoothie preference'
      confidence: 0.6
      authority: inferred
      scope: protected
      source: memory/project_x.md
      observed: '2026-10-09'
      decay: seasonal
      relations: []
      contentHash: a6c3896479f674fcb4036b15f207cb949cafc8b5e979f13b308b427205ed5506
      status: superseded
      ---

      banana smoothie preference
      "
    `);

    const captured = captureFact({ backend: 'files' }, prot, {
      id: 'fact-1',
      value: 'Revenue grew',
      sourceDoc: 'plan.md',
      observed: '2026-10-09',
    });
    expect(captured).toBe(join(prot, 'memory', 'fact-1.md'));
    expect(read(captured)).toMatchInlineSnapshot(`
      "---
      id: fact-1
      trunk: memory
      type: fact
      value: Revenue grew
      confidence: 0.7
      authority: inferred
      scope: protected
      source: data-room:plan.md
      observed: '2026-10-09'
      decay: durable
      relations: []
      contentHash: edee2834c66b741d499fa411b4e42e1d6664dda6edf95ae4487f44db63d74f37
      writtenBy: agent
      reverify: Re-check against plan.md in the data room
      ---
      Source: plan.md
      "
    `);
  });
});
