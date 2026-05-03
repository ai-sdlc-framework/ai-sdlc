/**
 * Dependency-graph tests.
 *
 * Covers AISDLC-117 acceptance criterion #8:
 *   - empty graph
 *   - single chain (A → B → C)
 *   - diamond fan-out (A,B → C; A,B → D)
 *   - cycle detection
 *   - dangling refs
 *   - missing-dep refusal (preflight)
 *
 * Plus mermaid + DOT emission and edge cases (case-insensitive lookup,
 * malformed files, duplicate IDs across tasks/+completed/).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  blockers,
  buildDependencyGraph,
  frontier,
  impact,
  parseTaskFrontmatter,
  preflight,
  renderGraph,
  validate,
} from './dependency-graph.js';
import { cleanupTmpProject, makeTmpProject, writeTaskFile } from '../__test-helpers/make-task.js';

let tmp: string;

beforeEach(() => {
  tmp = makeTmpProject();
});

afterEach(() => {
  cleanupTmpProject(tmp);
});

describe('buildDependencyGraph', () => {
  it('empty graph — no task files', () => {
    const g = buildDependencyGraph({ workDir: tmp });
    expect(g.nodes.size).toBe(0);
    expect(g.openIds).toEqual([]);
    expect(g.completedIds).toEqual([]);
  });

  it('returns empty graph when workDir has no backlog/ at all', () => {
    const empty = makeTmpProject();
    rmSync(join(empty, 'backlog'), { recursive: true, force: true });
    const g = buildDependencyGraph({ workDir: empty });
    expect(g.nodes.size).toBe(0);
    cleanupTmpProject(empty);
  });

  it('builds nodes from tasks/ + completed/, normalising keys to lowercase', () => {
    writeTaskFile(tmp, { id: 'AISDLC-1', title: 'open', status: 'To Do' });
    writeTaskFile(tmp, { id: 'AISDLC-2', title: 'done', completed: true });
    const g = buildDependencyGraph({ workDir: tmp });
    expect(g.nodes.size).toBe(2);
    expect(g.openIds).toEqual(['aisdlc-1']);
    expect(g.completedIds).toEqual(['aisdlc-2']);
    expect(g.nodes.get('aisdlc-1')?.status).toBe('open');
    expect(g.nodes.get('aisdlc-2')?.status).toBe('completed');
  });

  it('parses dependencies frontmatter', () => {
    writeTaskFile(tmp, {
      id: 'AISDLC-1',
      title: 'depender',
      status: 'To Do',
      dependencies: ['AISDLC-2', 'AISDLC-3'],
    });
    const g = buildDependencyGraph({ workDir: tmp });
    expect(g.nodes.get('aisdlc-1')?.dependencies).toEqual(['AISDLC-2', 'AISDLC-3']);
  });

  it('skips non-md files', () => {
    writeTaskFile(tmp, { id: 'AISDLC-1', title: 'a' });
    writeFileSync(join(tmp, 'backlog', 'tasks', 'README.txt'), 'ignore me\n', 'utf8');
    const g = buildDependencyGraph({ workDir: tmp });
    expect(g.nodes.size).toBe(1);
  });

  it('warns on malformed task files but does not throw', () => {
    writeTaskFile(tmp, { id: 'AISDLC-1', title: 'good' });
    const bad = join(tmp, 'backlog', 'tasks', 'aisdlc-bad - x.md');
    // Make readFile throw by writing a directory at that path.
    mkdirSync(bad);
    const warnings: string[] = [];
    const g = buildDependencyGraph({ workDir: tmp }, (m) => warnings.push(m));
    expect(g.nodes.size).toBe(1);
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toMatch(/failed to parse/);
  });

  it('skips files without YAML frontmatter and files without an id', () => {
    writeTaskFile(tmp, { id: 'AISDLC-1', title: 'good' });
    writeFileSync(
      join(tmp, 'backlog', 'tasks', 'aisdlc-noid - x.md'),
      `---\ntitle: nope\n---\n\nbody\n`,
      'utf8',
    );
    writeFileSync(
      join(tmp, 'backlog', 'tasks', 'aisdlc-nomatter - x.md'),
      `no frontmatter at all\n`,
      'utf8',
    );
    const g = buildDependencyGraph({ workDir: tmp });
    expect(g.nodes.size).toBe(1);
  });

  it('completed/ wins when an ID appears in BOTH directories (data bug case)', () => {
    writeTaskFile(tmp, { id: 'AISDLC-1', title: 'open dup', status: 'To Do' });
    writeTaskFile(tmp, { id: 'AISDLC-1', title: 'done dup', completed: true });
    const g = buildDependencyGraph({ workDir: tmp });
    expect(g.nodes.get('aisdlc-1')?.status).toBe('completed');
  });
});

describe('parseTaskFrontmatter', () => {
  it('returns null for files without frontmatter', () => {
    const path = join(tmp, 'backlog', 'tasks', 'noheader - x.md');
    writeFileSync(path, 'body only\n', 'utf8');
    expect(parseTaskFrontmatter(path, 'open')).toBeNull();
  });

  it('returns null when id is missing', () => {
    const path = join(tmp, 'backlog', 'tasks', 'noid - x.md');
    writeFileSync(path, `---\ntitle: anon\n---\n\nbody\n`, 'utf8');
    expect(parseTaskFrontmatter(path, 'open')).toBeNull();
  });
});

describe('frontier', () => {
  it('returns ALL open tasks when no dependencies', () => {
    writeTaskFile(tmp, { id: 'AISDLC-1', title: 'a' });
    writeTaskFile(tmp, { id: 'AISDLC-2', title: 'b' });
    const g = buildDependencyGraph({ workDir: tmp });
    const f = frontier(g);
    expect(f.map((e) => e.id)).toEqual(['AISDLC-1', 'AISDLC-2']);
  });

  it('single chain — only the head with all deps Done is on the frontier', () => {
    // C → B → A, with A done. Frontier should be {B}.
    writeTaskFile(tmp, { id: 'AISDLC-A', title: 'a', completed: true });
    writeTaskFile(tmp, { id: 'AISDLC-B', title: 'b', dependencies: ['AISDLC-A'] });
    writeTaskFile(tmp, { id: 'AISDLC-C', title: 'c', dependencies: ['AISDLC-B'] });
    const g = buildDependencyGraph({ workDir: tmp });
    const f = frontier(g);
    expect(f.map((e) => e.id)).toEqual(['AISDLC-B']);
  });

  it('diamond fan-out — fan-out node ready iff both branches Done', () => {
    // D depends on B+C; B,C depend on A. A done. B,C open ⇒ D not ready.
    writeTaskFile(tmp, { id: 'AISDLC-A', title: 'a', completed: true });
    writeTaskFile(tmp, { id: 'AISDLC-B', title: 'b', dependencies: ['AISDLC-A'] });
    writeTaskFile(tmp, { id: 'AISDLC-C', title: 'c', dependencies: ['AISDLC-A'] });
    writeTaskFile(tmp, {
      id: 'AISDLC-D',
      title: 'd',
      dependencies: ['AISDLC-B', 'AISDLC-C'],
    });
    let g = buildDependencyGraph({ workDir: tmp });
    let f = frontier(g);
    expect(f.map((e) => e.id).sort()).toEqual(['AISDLC-B', 'AISDLC-C']);

    // Now mark B+C done. D should be on the frontier.
    rmSync(join(tmp, 'backlog'), { recursive: true });
    mkdirSync(join(tmp, 'backlog', 'tasks'), { recursive: true });
    mkdirSync(join(tmp, 'backlog', 'completed'), { recursive: true });
    writeTaskFile(tmp, { id: 'AISDLC-A', title: 'a', completed: true });
    writeTaskFile(tmp, {
      id: 'AISDLC-B',
      title: 'b',
      dependencies: ['AISDLC-A'],
      completed: true,
    });
    writeTaskFile(tmp, {
      id: 'AISDLC-C',
      title: 'c',
      dependencies: ['AISDLC-A'],
      completed: true,
    });
    writeTaskFile(tmp, {
      id: 'AISDLC-D',
      title: 'd',
      dependencies: ['AISDLC-B', 'AISDLC-C'],
    });
    g = buildDependencyGraph({ workDir: tmp });
    f = frontier(g);
    expect(f.map((e) => e.id)).toEqual(['AISDLC-D']);
  });

  it('dangling deps block the frontier (safe default)', () => {
    writeTaskFile(tmp, {
      id: 'AISDLC-1',
      title: 'a',
      dependencies: ['AISDLC-DOES-NOT-EXIST'],
    });
    const g = buildDependencyGraph({ workDir: tmp });
    expect(frontier(g)).toEqual([]);
  });

  it('case-insensitive dependency match', () => {
    writeTaskFile(tmp, { id: 'AISDLC-1', title: 'd', completed: true });
    writeTaskFile(tmp, { id: 'AISDLC-2', title: 'a', dependencies: ['aisdlc-1'] });
    const g = buildDependencyGraph({ workDir: tmp });
    expect(frontier(g).map((e) => e.id)).toEqual(['AISDLC-2']);
  });
});

describe('blockers / impact', () => {
  it('blockers walks the transitive forward closure (open only)', () => {
    // C → B → A; A done. Blockers(C) = [B].
    writeTaskFile(tmp, { id: 'AISDLC-A', title: 'a', completed: true });
    writeTaskFile(tmp, { id: 'AISDLC-B', title: 'b', dependencies: ['AISDLC-A'] });
    writeTaskFile(tmp, { id: 'AISDLC-C', title: 'c', dependencies: ['AISDLC-B'] });
    const g = buildDependencyGraph({ workDir: tmp });
    expect(blockers(g, 'AISDLC-C').map((b) => b.id)).toEqual(['AISDLC-B']);
  });

  it('blockers handles diamond fan-in without duplicating nodes', () => {
    writeTaskFile(tmp, { id: 'AISDLC-A', title: 'a' });
    writeTaskFile(tmp, { id: 'AISDLC-B', title: 'b', dependencies: ['AISDLC-A'] });
    writeTaskFile(tmp, { id: 'AISDLC-C', title: 'c', dependencies: ['AISDLC-A'] });
    writeTaskFile(tmp, {
      id: 'AISDLC-D',
      title: 'd',
      dependencies: ['AISDLC-B', 'AISDLC-C'],
    });
    const g = buildDependencyGraph({ workDir: tmp });
    expect(blockers(g, 'AISDLC-D').map((b) => b.id)).toEqual(['AISDLC-A', 'AISDLC-B', 'AISDLC-C']);
  });

  it('blockers returns empty list for unknown task ID', () => {
    expect(blockers(buildDependencyGraph({ workDir: tmp }), 'AISDLC-NOPE')).toEqual([]);
  });

  it('impact walks reverse closure', () => {
    // C → B → A. impact(A) = [B, C]
    writeTaskFile(tmp, { id: 'AISDLC-A', title: 'a' });
    writeTaskFile(tmp, { id: 'AISDLC-B', title: 'b', dependencies: ['AISDLC-A'] });
    writeTaskFile(tmp, { id: 'AISDLC-C', title: 'c', dependencies: ['AISDLC-B'] });
    const g = buildDependencyGraph({ workDir: tmp });
    expect(impact(g, 'AISDLC-A').map((b) => b.id)).toEqual(['AISDLC-B', 'AISDLC-C']);
  });

  it('impact returns empty list when nothing depends on the target', () => {
    writeTaskFile(tmp, { id: 'AISDLC-A', title: 'a' });
    const g = buildDependencyGraph({ workDir: tmp });
    expect(impact(g, 'AISDLC-A')).toEqual([]);
  });

  it('impact returns empty list for unknown task ID', () => {
    expect(impact(buildDependencyGraph({ workDir: tmp }), 'AISDLC-NOPE')).toEqual([]);
  });
});

describe('validate', () => {
  it('clean graph reports ok=true', () => {
    writeTaskFile(tmp, { id: 'AISDLC-A', title: 'a' });
    writeTaskFile(tmp, { id: 'AISDLC-B', title: 'b', dependencies: ['AISDLC-A'] });
    const r = validate(buildDependencyGraph({ workDir: tmp }));
    expect(r.ok).toBe(true);
    expect(r.cycles).toEqual([]);
    expect(r.dangling).toEqual([]);
  });

  it('detects a 2-node cycle', () => {
    writeTaskFile(tmp, { id: 'AISDLC-A', title: 'a', dependencies: ['AISDLC-B'] });
    writeTaskFile(tmp, { id: 'AISDLC-B', title: 'b', dependencies: ['AISDLC-A'] });
    const r = validate(buildDependencyGraph({ workDir: tmp }));
    expect(r.ok).toBe(false);
    expect(r.cycles.length).toBe(1);
    // canonicalised — closing edge present
    expect(r.cycles[0][0]).toEqual(r.cycles[0][r.cycles[0].length - 1]);
  });

  it('detects a 3-node cycle', () => {
    writeTaskFile(tmp, { id: 'AISDLC-A', title: 'a', dependencies: ['AISDLC-B'] });
    writeTaskFile(tmp, { id: 'AISDLC-B', title: 'b', dependencies: ['AISDLC-C'] });
    writeTaskFile(tmp, { id: 'AISDLC-C', title: 'c', dependencies: ['AISDLC-A'] });
    const r = validate(buildDependencyGraph({ workDir: tmp }));
    expect(r.cycles.length).toBe(1);
    expect(r.cycles[0].length).toBe(4); // 3 nodes + closing repeat
  });

  it('flags dangling references', () => {
    writeTaskFile(tmp, {
      id: 'AISDLC-A',
      title: 'a',
      dependencies: ['AISDLC-MISSING'],
    });
    const r = validate(buildDependencyGraph({ workDir: tmp }));
    expect(r.dangling).toEqual([{ source: 'AISDLC-A', missing: 'AISDLC-MISSING' }]);
    expect(r.ok).toBe(false);
  });

  it('reports cycles AND dangling refs together', () => {
    writeTaskFile(tmp, {
      id: 'AISDLC-A',
      title: 'a',
      dependencies: ['AISDLC-B', 'AISDLC-MISSING'],
    });
    writeTaskFile(tmp, { id: 'AISDLC-B', title: 'b', dependencies: ['AISDLC-A'] });
    const r = validate(buildDependencyGraph({ workDir: tmp }));
    expect(r.cycles.length).toBe(1);
    expect(r.dangling).toEqual([{ source: 'AISDLC-A', missing: 'AISDLC-MISSING' }]);
  });

  it('does not double-report the same cycle from different starting points', () => {
    // 3-cycle should be reported exactly once even though DFS may enter from
    // any of the 3 nodes.
    writeTaskFile(tmp, { id: 'AISDLC-A', title: 'a', dependencies: ['AISDLC-B'] });
    writeTaskFile(tmp, { id: 'AISDLC-B', title: 'b', dependencies: ['AISDLC-C'] });
    writeTaskFile(tmp, { id: 'AISDLC-C', title: 'c', dependencies: ['AISDLC-A'] });
    const r = validate(buildDependencyGraph({ workDir: tmp }));
    expect(r.cycles.length).toBe(1);
  });

  it('handles a self-loop (1-node cycle)', () => {
    writeTaskFile(tmp, { id: 'AISDLC-A', title: 'a', dependencies: ['AISDLC-A'] });
    const r = validate(buildDependencyGraph({ workDir: tmp }));
    expect(r.cycles.length).toBe(1);
    expect(r.cycles[0]).toEqual(['AISDLC-A', 'AISDLC-A']);
  });
});

describe('preflight', () => {
  it('refuses unknown task', () => {
    const g = buildDependencyGraph({ workDir: tmp });
    const p = preflight(g, 'AISDLC-NOPE');
    expect(p.ok).toBe(false);
    expect(p.reason).toMatch(/unknown task/);
  });

  it('refuses already-completed task', () => {
    writeTaskFile(tmp, { id: 'AISDLC-1', title: 'shipped', completed: true });
    const g = buildDependencyGraph({ workDir: tmp });
    const p = preflight(g, 'AISDLC-1');
    expect(p.ok).toBe(false);
    expect(p.reason).toMatch(/already shipped/);
  });

  it('refuses task with open transitive dependencies (missing-dep refusal)', () => {
    writeTaskFile(tmp, { id: 'AISDLC-A', title: 'a' });
    writeTaskFile(tmp, { id: 'AISDLC-B', title: 'b', dependencies: ['AISDLC-A'] });
    const g = buildDependencyGraph({ workDir: tmp });
    const p = preflight(g, 'AISDLC-B');
    expect(p.ok).toBe(false);
    expect(p.reason).toMatch(/dependency/);
    expect(p.blockers.map((b) => b.id)).toEqual(['AISDLC-A']);
  });

  it('refuses task with dangling dependency refs', () => {
    writeTaskFile(tmp, {
      id: 'AISDLC-A',
      title: 'a',
      dependencies: ['AISDLC-MISSING'],
    });
    const g = buildDependencyGraph({ workDir: tmp });
    const p = preflight(g, 'AISDLC-A');
    expect(p.ok).toBe(false);
    expect(p.reason).toMatch(/dangling/);
    expect(p.dangling.length).toBe(1);
  });

  it('approves task whose dependencies are all completed', () => {
    writeTaskFile(tmp, { id: 'AISDLC-A', title: 'a', completed: true });
    writeTaskFile(tmp, { id: 'AISDLC-B', title: 'b', dependencies: ['AISDLC-A'] });
    const g = buildDependencyGraph({ workDir: tmp });
    const p = preflight(g, 'AISDLC-B');
    expect(p.ok).toBe(true);
    expect(p.reason).toBe('');
    expect(p.blockers).toEqual([]);
  });

  it('approves task with no dependencies', () => {
    writeTaskFile(tmp, { id: 'AISDLC-A', title: 'a' });
    const g = buildDependencyGraph({ workDir: tmp });
    expect(preflight(g, 'AISDLC-A').ok).toBe(true);
  });
});

describe('renderGraph', () => {
  it('emits mermaid with one node per task and one edge per dependency', () => {
    writeTaskFile(tmp, { id: 'AISDLC-A', title: 'a', completed: true });
    writeTaskFile(tmp, { id: 'AISDLC-B', title: 'b', dependencies: ['AISDLC-A'] });
    const out = renderGraph(buildDependencyGraph({ workDir: tmp }), 'mermaid');
    expect(out).toContain('flowchart TD');
    expect(out).toContain('AISDLC_A');
    expect(out).toContain('AISDLC_B');
    expect(out).toContain('AISDLC_B --> AISDLC_A');
    expect(out).toContain(':::done'); // completed style applied
    expect(out).toContain(':::open'); // open style applied
  });

  it('emits DOT format', () => {
    writeTaskFile(tmp, { id: 'AISDLC-A', title: 'a' });
    writeTaskFile(tmp, { id: 'AISDLC-B', title: 'b', dependencies: ['AISDLC-A'] });
    const out = renderGraph(buildDependencyGraph({ workDir: tmp }), 'dot');
    expect(out).toContain('digraph deps');
    expect(out).toContain('"AISDLC-A"');
    expect(out).toContain('"AISDLC-B" -> "AISDLC-A"');
  });

  it('mermaid renders task with no title (just ID label)', () => {
    const path = join(tmp, 'backlog', 'tasks', 'aisdlc-x - notitle.md');
    writeFileSync(
      path,
      `---\nid: AISDLC-X\nstatus: To Do\n---\n\n## Acceptance Criteria\n- [ ] #1 a\n`,
      'utf8',
    );
    const out = renderGraph(buildDependencyGraph({ workDir: tmp }), 'mermaid');
    expect(out).toContain('AISDLC_X["AISDLC-X"]');
  });

  it('handles characters that need escaping in titles + dot fallback for dangling deps', () => {
    writeTaskFile(tmp, {
      id: 'AISDLC-A',
      title: 'a "quoted" title',
      dependencies: ['AISDLC-MISSING'],
    });
    const mermaid = renderGraph(buildDependencyGraph({ workDir: tmp }), 'mermaid');
    expect(mermaid).toContain("a 'quoted' title");
    expect(mermaid).toContain('AISDLC_A --> AISDLC_MISSING');

    const dot = renderGraph(buildDependencyGraph({ workDir: tmp }), 'dot');
    expect(dot).toContain('a \\"quoted\\" title');
    expect(dot).toContain('"AISDLC-A" -> "AISDLC-MISSING"');
  });
});

// ── AISDLC-153: status field consulted alongside file location ──────────
//
// Bug fixed here: frontier was treating any file in `backlog/tasks/` as open,
// even when its frontmatter `status: Done` said otherwise. Stale entries (PRs
// merged with the `mark complete` chore but without the file move) poisoned
// the dispatch picture. The fix reclassifies stale entries as completed for
// dispatch + emits a one-line stderr warning so the operator can `git mv`.
describe('frontier — status field is consulted (AISDLC-153)', () => {
  it('file in completed/ → completed (no warning)', () => {
    writeTaskFile(tmp, { id: 'AISDLC-1', title: 'done', completed: true });
    writeTaskFile(tmp, { id: 'AISDLC-2', title: 'next', dependencies: ['AISDLC-1'] });
    const warnings: string[] = [];
    const g = buildDependencyGraph({ workDir: tmp }, (m) => warnings.push(m));
    const f = frontier(g);
    expect(f.map((e) => e.id)).toEqual(['AISDLC-2']);
    expect(g.nodes.get('aisdlc-1')?.status).toBe('completed');
    expect(g.nodes.get('aisdlc-1')?.fileLocation).toBe('completed');
    expect(warnings.filter((w) => w.includes('AISDLC-1'))).toEqual([]);
  });

  it('file in tasks/ + status: Done → completed + warning (stale entry)', () => {
    writeTaskFile(tmp, { id: 'AISDLC-1', title: 'stale', status: 'Done' });
    writeTaskFile(tmp, { id: 'AISDLC-2', title: 'next', dependencies: ['AISDLC-1'] });
    const warnings: string[] = [];
    const g = buildDependencyGraph({ workDir: tmp }, (m) => warnings.push(m));

    const node = g.nodes.get('aisdlc-1');
    expect(node?.status).toBe('completed');
    expect(node?.fileLocation).toBe('open');
    expect(node?.frontmatterStatus).toBe('Done');
    expect(g.completedIds).toContain('aisdlc-1');
    expect(g.openIds).not.toContain('aisdlc-1');

    // AISDLC-1 should NOT show up on the frontier — it's reclassified as done.
    // AISDLC-2 SHOULD now show up because its only blocker is satisfied.
    const f = frontier(g);
    expect(f.map((e) => e.id)).toEqual(['AISDLC-2']);

    // And the operator should see a single, actionable stale-task warning.
    const stale = warnings.filter((w) => w.includes('AISDLC-1'));
    expect(stale.length).toBe(1);
    expect(stale[0]).toMatch(/stale task/);
    expect(stale[0]).toMatch(/Done/);
    expect(stale[0]).toMatch(/git mv/);
    expect(stale[0]).toMatch(/backlog\/completed\//);
  });

  it("file in tasks/ + status: 'To Do' → open (frontier candidate)", () => {
    writeTaskFile(tmp, { id: 'AISDLC-1', title: 'todo', status: 'To Do' });
    const warnings: string[] = [];
    const g = buildDependencyGraph({ workDir: tmp }, (m) => warnings.push(m));
    const node = g.nodes.get('aisdlc-1');
    expect(node?.status).toBe('open');
    expect(node?.frontmatterStatus).toBe('To Do');
    expect(frontier(g).map((e) => e.id)).toEqual(['AISDLC-1']);
    expect(warnings).toEqual([]);
  });

  it("file in tasks/ + status: 'In Progress' → open (still actively-claimed)", () => {
    writeTaskFile(tmp, { id: 'AISDLC-1', title: 'wip', status: 'In Progress' });
    const warnings: string[] = [];
    const g = buildDependencyGraph({ workDir: tmp }, (m) => warnings.push(m));
    const node = g.nodes.get('aisdlc-1');
    expect(node?.status).toBe('open');
    expect(node?.frontmatterStatus).toBe('In Progress');
    expect(frontier(g).map((e) => e.id)).toEqual(['AISDLC-1']);
    expect(warnings).toEqual([]);
  });

  it('stale-Done synonyms (case-insensitive) also reclassify', () => {
    // Operators occasionally type 'done' / 'DONE' / 'Completed' / 'Shipped'
    // by hand. We accept the obvious synonyms so the dispatch picture stays
    // honest without forcing them to learn one canonical spelling.
    writeTaskFile(tmp, { id: 'AISDLC-1', title: 'lower', status: 'done' });
    writeTaskFile(tmp, { id: 'AISDLC-2', title: 'upper', status: 'DONE' });
    writeTaskFile(tmp, { id: 'AISDLC-3', title: 'completed', status: 'Completed' });
    writeTaskFile(tmp, { id: 'AISDLC-4', title: 'shipped', status: 'Shipped' });
    const warnings: string[] = [];
    const g = buildDependencyGraph({ workDir: tmp }, (m) => warnings.push(m));
    expect(g.nodes.get('aisdlc-1')?.status).toBe('completed');
    expect(g.nodes.get('aisdlc-2')?.status).toBe('completed');
    expect(g.nodes.get('aisdlc-3')?.status).toBe('completed');
    expect(g.nodes.get('aisdlc-4')?.status).toBe('completed');
    expect(warnings.length).toBe(4);
    expect(frontier(g)).toEqual([]); // none of them is open
  });

  it('blockers/preflight respect the reclassified status', () => {
    // A is stale-Done in tasks/, B depends on A. B should be dispatch-ready.
    writeTaskFile(tmp, { id: 'AISDLC-A', title: 'stale-done', status: 'Done' });
    writeTaskFile(tmp, {
      id: 'AISDLC-B',
      title: 'next',
      status: 'To Do',
      dependencies: ['AISDLC-A'],
    });
    const g = buildDependencyGraph({ workDir: tmp });
    expect(blockers(g, 'AISDLC-B')).toEqual([]);
    const p = preflight(g, 'AISDLC-B');
    expect(p.ok).toBe(true);
    expect(p.blockers).toEqual([]);
  });

  it('preflight refuses a stale-Done target as already shipped', () => {
    writeTaskFile(tmp, { id: 'AISDLC-1', title: 'stale', status: 'Done' });
    const g = buildDependencyGraph({ workDir: tmp });
    const p = preflight(g, 'AISDLC-1');
    expect(p.ok).toBe(false);
    expect(p.reason).toMatch(/already shipped/);
  });

  it('completed/ entry wins over a stale tasks/ entry with the same ID', () => {
    // Pathological: both files exist (rare data bug). The completed/ copy is
    // canonical; we must not double-warn or double-count.
    writeTaskFile(tmp, { id: 'AISDLC-1', title: 'stale-open', status: 'Done' });
    writeTaskFile(tmp, { id: 'AISDLC-1', title: 'real-done', completed: true });
    const warnings: string[] = [];
    const g = buildDependencyGraph({ workDir: tmp }, (m) => warnings.push(m));
    expect(g.nodes.get('aisdlc-1')?.status).toBe('completed');
    expect(g.nodes.get('aisdlc-1')?.fileLocation).toBe('completed');
    // completedIds may not contain 'aisdlc-1' twice
    expect(g.completedIds.filter((id) => id === 'aisdlc-1').length).toBe(1);
    // Stale warning still surfaces — the file IS in tasks/ and should move.
    expect(warnings.filter((w) => w.includes('AISDLC-1')).length).toBe(1);
  });
});
