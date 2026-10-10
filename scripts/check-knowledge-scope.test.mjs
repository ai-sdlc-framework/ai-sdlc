/**
 * AISDLC-773: hermetic tests for `scripts/check-knowledge-scope.sh` and
 * `scripts/check-pr-body-protected.sh`, plus the .gitignore entry (AC7).
 *
 * Run with: node --test scripts/check-knowledge-scope.test.mjs
 */
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCOPE = join(HERE, 'check-knowledge-scope.sh');
const BODY = join(HERE, 'check-pr-body-protected.sh');

let root;
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

function repo(files) {
  root = mkdtempSync(join(tmpdir(), 'ai-sdlc-knowledge-'));
  execFileSync('git', ['init', '-q'], { cwd: root });
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
}

const entry = (id, scope) => `---\nid: ${id}\nscope: ${scope}\n---\nbody\n`;
const run = (script, args, input) =>
  spawnSync('bash', [script, ...args], { cwd: root, encoding: 'utf-8', input });

describe('check-knowledge-scope.sh', () => {
  it('passes with only internal/universal entries in the tracked root', () => {
    repo({
      '.gitignore': '.ai-sdlc/knowledge-protected/\n',
      '.ai-sdlc/knowledge/systems/a.md': entry('k-a', 'internal'),
      '.ai-sdlc/knowledge/process/b.md': entry('k-b', 'universal'),
    });
    assert.equal(run(SCOPE, []).status, 0);
  });

  it('passes when the tracked root does not exist', () => {
    repo({ 'x.txt': 'x', '.gitignore': '.ai-sdlc/knowledge-protected/\n' });
    assert.equal(run(SCOPE, []).status, 0);
  });

  it('fails when a protected entry sits in the tracked root', () => {
    repo({ '.ai-sdlc/knowledge/customers/c.md': entry('k-c', 'protected') });
    const r = run(SCOPE, []);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /customers\/c\.md/);
  });

  it('fails when files under the protected root are tracked by git', () => {
    repo({
      '.gitignore': '.ai-sdlc/knowledge-protected/\n',
      '.ai-sdlc/knowledge-protected/customers/c.md': entry('k-c', 'protected'),
    });
    execFileSync('git', ['add', '-f', '.'], { cwd: root });
    assert.equal(run(SCOPE, []).status, 1);
  });

  it('passes for an ignored, untracked protected root', () => {
    repo({
      '.gitignore': '.ai-sdlc/knowledge-protected/\n',
      '.ai-sdlc/knowledge-protected/customers/c.md': entry('k-c', 'protected'),
      '.ai-sdlc/knowledge/a.md': entry('a', 'internal'),
    });
    assert.equal(run(SCOPE, []).status, 0);
  });

  it('fails on a flow-mapping (JSON) frontmatter protected entry', () => {
    repo({
      '.ai-sdlc/knowledge/customers/c.md': '---\n{"id": "k-c", "scope": "protected"}\n---\nbody\n',
    });
    assert.equal(run(SCOPE, []).status, 1);
  });

  it('fails on CRLF, trailing-comment, quoted-key and BOM forms', () => {
    const forms = [
      '---\r\nid: k\r\nscope: protected\r\n---\r\nbody\r\n',
      '---\nid: k\nscope: protected # client\n---\nbody\n',
      '---\nid: k\n"scope": protected\n---\nbody\n',
      '\uFEFF---\nid: k\nscope: protected\n---\nbody\n',
      '---\nid: k\nscope: >\n  protected\n---\nbody\n',
    ];
    for (const f of forms) {
      repo({ '.ai-sdlc/knowledge/customers/c.md': f });
      assert.equal(run(SCOPE, []).status, 1, JSON.stringify(f));
    }
  });

  it('checks roots configured in .ai-sdlc/context.yaml', () => {
    repo({
      '.ai-sdlc/context.yaml': 'knowledge:\n  trackedRoot: kb\n  protectedRoot: kb-private\n',
      'kb/customers/c.md': entry('k-c', 'protected'),
    });
    assert.equal(run(SCOPE, []).status, 1);
  });

  it('fails when the configured protected root is not git-ignored', () => {
    repo({
      '.ai-sdlc/context.yaml': 'knowledge:\n  protectedRoot: kb-private\n',
      '.gitignore': '.ai-sdlc/knowledge-protected/\n',
    });
    const r = run(SCOPE, []);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /not git-ignored/);
  });
});

describe('check-knowledge-scope.sh over the pushed range (AISDLC-773)', () => {
  const git = (...args) =>
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
      cwd: root,
      encoding: 'utf-8',
    }).trim();
  const commit = (msg) => {
    git('add', '-A', '-f');
    git('commit', '-q', '-m', msg);
    return git('rev-parse', 'HEAD');
  };
  const push = (local, remote) => `refs/heads/b ${local} refs/heads/b ${remote}\n`;
  const NULL = '0'.repeat(40);

  it('catches a protected entry added in one commit and removed in a later one', () => {
    repo({ '.gitignore': '.ai-sdlc/knowledge-protected/\n', 'x.txt': 'x' });
    const base = commit('base');
    mkdirSync(join(root, '.ai-sdlc/knowledge/customers'), { recursive: true });
    writeFileSync(join(root, '.ai-sdlc/knowledge/customers/c.md'), entry('k-c', 'protected'));
    commit('add');
    rmSync(join(root, '.ai-sdlc/knowledge/customers/c.md'));
    const head = commit('remove');
    assert.equal(run(SCOPE, []).status, 0, 'HEAD alone looks clean');
    const r = run(SCOPE, ['--push-stdin'], push(head, base));
    assert.equal(r.status, 1);
    assert.match(r.stderr, /customers\/c\.md.*pushed commit/);
  });

  it('catches a file committed under the protected root and later removed', () => {
    repo({ '.gitignore': '.ai-sdlc/knowledge-protected/\n', 'x.txt': 'x' });
    const base = commit('base');
    mkdirSync(join(root, '.ai-sdlc/knowledge-protected'), { recursive: true });
    writeFileSync(join(root, '.ai-sdlc/knowledge-protected/p.md'), entry('k-p', 'protected'));
    commit('add');
    git('rm', '-q', '-f', '.ai-sdlc/knowledge-protected/p.md');
    const head = commit('remove');
    const r = run(SCOPE, ['--push-stdin'], push(head, base));
    assert.equal(r.status, 1);
    assert.match(r.stderr, /protected root is in pushed commit/);
  });

  it('passes a clean range and ignores commits already on the remote', () => {
    repo({ '.gitignore': '.ai-sdlc/knowledge-protected/\n' });
    mkdirSync(join(root, '.ai-sdlc/knowledge'), { recursive: true });
    writeFileSync(join(root, '.ai-sdlc/knowledge/old.md'), entry('k-o', 'protected'));
    const old = commit('old leak already pushed');
    rmSync(join(root, '.ai-sdlc/knowledge/old.md'));
    writeFileSync(join(root, '.ai-sdlc/knowledge/a.md'), entry('k-a', 'internal'));
    const head = commit('clean');
    assert.equal(run(SCOPE, ['--push-stdin'], push(head, old)).status, 0);
  });

  it('scans a new branch back to the merge-base and skips deleted refs', () => {
    repo({ '.gitignore': '.ai-sdlc/knowledge-protected/\n', 'x.txt': 'x' });
    git('branch', '-M', 'main');
    const base = commit('base');
    git('update-ref', 'refs/remotes/origin/main', base);
    mkdirSync(join(root, '.ai-sdlc/knowledge'), { recursive: true });
    writeFileSync(join(root, '.ai-sdlc/knowledge/c.md'), entry('k-c', 'protected'));
    commit('add');
    rmSync(join(root, '.ai-sdlc/knowledge/c.md'));
    const head = commit('remove');
    assert.equal(run(SCOPE, ['--push-stdin'], push(head, NULL)).status, 1);
    assert.equal(run(SCOPE, ['--push-stdin'], push(NULL, head)).status, 0);
  });
});

describe('check-knowledge-scope.sh protected root outside the repo', () => {
  it('does not treat a protected root outside the repository as a violation', () => {
    repo({
      '.ai-sdlc/context.yaml': 'knowledge:\n  protectedRoot: ../kb-private\n',
      '.ai-sdlc/knowledge/a.md': entry('k-a', 'internal'),
    });
    assert.equal(run(SCOPE, []).status, 0);
  });
});

describe('check-pr-body-protected.sh', () => {
  const files = {
    '.ai-sdlc/knowledge-protected/customers/c.md': entry('acme-pricing', 'protected'),
  };

  it('fails when the body cites a protected entry id', () => {
    repo(files);
    const r = run(BODY, ['-'], 'Derived from acme-pricing.\n');
    assert.equal(r.status, 1);
    assert.match(r.stderr, /acme-pricing/);
  });

  it('fails when the body cites the protected root path', () => {
    repo(files);
    assert.equal(run(BODY, ['-'], 'See .ai-sdlc/knowledge-protected/x.md\n').status, 1);
  });

  it('passes for a body that does not cite protected entries', () => {
    repo(files);
    assert.equal(run(BODY, ['-'], 'Adds a validator. See acme-pricing-unrelated? no.\n').status, 0);
  });

  it('errors on missing arguments', () => {
    repo(files);
    assert.equal(run(BODY, []).status, 2);
  });
});

describe('.gitignore (AC7)', () => {
  it('ignores the protected knowledge root', () => {
    const gi = readFileSync(join(HERE, '..', '.gitignore'), 'utf-8').split('\n');
    assert.ok(gi.includes('.ai-sdlc/knowledge-protected/'));
  });
});
