import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const REPO = resolve(import.meta.dirname, '../..');
const ROOTS = ['orchestrator/src', 'pipeline-cli/src', 'reference/src', 'mcp-server/src'];
// dependency-graph.ts is the engine; the RFC-0056 workflow engine is exempt.
const ALLOWED = [/deps\/dependency-graph\.ts$/, /workflow/i];
const PATTERN = /function\s+(topologicalSort|topoSort|toposort|kahn\w*)\b/i;

function walk(dir: string, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const e of entries) {
    if (e === 'node_modules' || e === 'dist') continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.ts') && !p.endsWith('.test.ts')) out.push(p);
  }
}

describe('single topological-sort implementation (AISDLC-1212)', () => {
  it('has no topological sort outside dependency-graph.ts and the workflow engine', () => {
    const files: string[] = [];
    for (const r of ROOTS) walk(join(REPO, r), files);
    const offenders = files
      .map((f) => relative(REPO, f))
      .filter((rel) => !ALLOWED.some((a) => a.test(rel)))
      .filter((rel) => PATTERN.test(readFileSync(join(REPO, rel), 'utf8')));
    expect(offenders).toEqual([]);
  });
});
