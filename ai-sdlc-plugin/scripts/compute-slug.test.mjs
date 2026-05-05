// Run with: node --test ai-sdlc-plugin/scripts/compute-slug.test.mjs
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('./compute-slug.mjs', import.meta.url));

function run(content) {
  const dir = mkdtempSync(join(tmpdir(), 'compute-slug-test-'));
  const file = join(dir, 'task.md');
  writeFileSync(file, content, 'utf8');
  try {
    const result = spawnSync('node', [SCRIPT, file], { encoding: 'utf8' });
    return {
      stdout: result.stdout.trim(),
      stderr: result.stderr.trim(),
      code: result.status,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('compute-slug.mjs', () => {
  it('handles plain inline title', () => {
    const r = run(`---\nid: AISDLC-1\ntitle: Plain Title Here\n---\nbody`);
    assert.equal(r.code, 0);
    assert.equal(r.stdout, 'plain-title-here');
  });

  it('handles single-quoted inline title', () => {
    const r = run(`---\nid: AISDLC-1\ntitle: 'Quoted: title with colon'\n---\nbody`);
    assert.equal(r.code, 0);
    assert.equal(r.stdout, 'quoted-title-with-colon');
  });

  it('handles double-quoted inline title', () => {
    const r = run(`---\nid: AISDLC-1\ntitle: "Double quoted"\n---\nbody`);
    assert.equal(r.code, 0);
    assert.equal(r.stdout, 'double-quoted');
  });

  it('handles folded block scalar (>-) — the AISDLC-180 reproducer', () => {
    const r = run(
      `---\nid: AISDLC-180\ntitle: >-\n  Pipeline: branch slug computation produces empty/garbled slug for YAML\n  block-scalar titles\nstatus: To Do\n---\nbody`,
    );
    assert.equal(r.code, 0);
    // The slug truncates at 50 chars then re-strips trailing dashes
    assert.match(r.stdout, /^pipeline-branch-slug-computation/);
    assert.ok(!r.stdout.endsWith('-'), 'slug must not end with dash');
    assert.ok(r.stdout.length <= 50, `slug must be ≤50 chars, got ${r.stdout.length}`);
  });

  it('handles literal block scalar (|-)', () => {
    const r = run(
      `---\nid: AISDLC-1\ntitle: |-\n  Phase 1: Skeleton — cli-tui binary, Ink scaffold\nstatus: To Do\n---\nbody`,
    );
    assert.equal(r.code, 0);
    assert.equal(r.stdout, 'phase-1-skeleton-cli-tui-binary-ink-scaffold');
  });

  it('handles em-dashes and unicode (AISDLC-178.1 case)', () => {
    const r = run(
      `---\nid: AISDLC-178.1\ntitle: >-\n  Phase 1: Skeleton — cli-tui binary, Ink scaffold, Overview Mode placeholder\n  panes\n---\nbody`,
    );
    assert.equal(r.code, 0);
    assert.match(r.stdout, /^phase-1-skeleton-cli-tui-binary-ink-scaffold/);
    assert.ok(!r.stdout.endsWith('-'));
  });

  it('fails loud if title produces empty slug (AC #2)', () => {
    const r = run(`---\nid: AISDLC-1\ntitle: '!@#$%^&*()'\n---\nbody`);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /produces empty slug/);
  });

  it('fails loud if no title key', () => {
    const r = run(`---\nid: AISDLC-1\nstatus: To Do\n---\nbody`);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /no 'title:' key/);
  });

  it('fails loud if no frontmatter', () => {
    const r = run(`# Just a markdown body, no frontmatter`);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /no YAML frontmatter/);
  });

  it('fails loud if file unreadable', () => {
    const result = spawnSync('node', [SCRIPT, '/nonexistent/path/task.md'], { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /cannot read/);
  });

  it('caps slug at 50 chars and strips trailing dash', () => {
    const longTitle = 'a'.repeat(30) + ' ' + 'b'.repeat(30);
    const r = run(`---\nid: AISDLC-1\ntitle: ${longTitle}\n---\nbody`);
    assert.equal(r.code, 0);
    assert.ok(r.stdout.length <= 50);
    assert.ok(!r.stdout.endsWith('-'));
  });
});
