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
