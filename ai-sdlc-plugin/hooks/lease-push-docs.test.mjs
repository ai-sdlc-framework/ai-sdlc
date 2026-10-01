/**
 * Keeps the push spellings that command / agent / skill bodies prescribe in
 * sync with what the leaseOnOwnBranch guard actually accepts. The push lines
 * are parsed OUT of those files, the branch placeholder is substituted
 * literally, and the real hook is run in a real-git worktree fixture bound to
 * a task. Reintroducing a denied spelling in any of the files fails here.
 *
 * Run with: node --test ai-sdlc-plugin/hooks/lease-push-docs.test.mjs
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  existsSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pluginRoot = join(__dirname, '..');
const hookScript = join(__dirname, 'enforce-blocked-actions.js');

const BRANCH = 'ai-sdlc/aisdlc-1-demo';
const POLICY = `apiVersion: ai-sdlc.io/v1alpha1
kind: AgentRole
spec:
  role: coding-agent
  governance:
    allowForcePush: leaseOnOwnBranch
  constraints:
    blockedActions:
      - 'git push --force*'
      - 'git push -f*'
`;

function bodies() {
  const out = [];
  for (const dir of ['commands', 'agents']) {
    for (const f of readdirSync(join(pluginRoot, dir))) {
      if (f.endsWith('.md')) out.push(join(pluginRoot, dir, f));
    }
  }
  for (const d of readdirSync(join(pluginRoot, 'skills'))) {
    const p = join(pluginRoot, 'skills', d, 'SKILL.md');
    if (existsSync(p)) out.push(p);
  }
  // Tracked repo-local copies under .claude/ (skills, commands) must not drift either.
  const repoRoot = join(pluginRoot, '..');
  let tracked = [];
  try {
    tracked = execFileSync('git', ['ls-files', '.claude'], { cwd: repoRoot, encoding: 'utf-8' })
      .split('\n')
      .filter((f) => f.endsWith('.md'));
  } catch {
    tracked = [];
  }
  for (const f of tracked) out.push(join(repoRoot, f));
  return out;
}

/** Every `git push ... force-with-lease ...` occurrence in a body (inline or fenced). */
function pushLines(file) {
  const text = readFileSync(file, 'utf-8');
  return [...text.matchAll(/git push [^`"\n]*force-with-lease[^`"\n]*/g)].map((m) => m[0].trim());
}

const substitute = (line) => line.replace(/<[^>]*branch[^>]*>/g, BRANCH);

let base;
let env;
let repo;
let wt;

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, env, encoding: 'utf-8' }).trim();
}

function verdict(command) {
  try {
    const out = execFileSync('node', [hookScript], {
      input: JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd: wt }),
      cwd: wt,
      env: { ...env, CLAUDE_PROJECT_DIR: repo },
      encoding: 'utf-8',
      timeout: 10000,
    }).trim();
    return out ? JSON.parse(out).hookSpecificOutput?.permissionDecision : 'allow';
  } catch (err) {
    return JSON.parse(err.stdout || '{}').hookSpecificOutput?.permissionDecision ?? 'error';
  }
}

before(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'lease-docs-')));
  writeFileSync(join(base, 'cfg'), '');
  env = {
    PATH: process.env.PATH,
    HOME: base,
    GIT_CONFIG_GLOBAL: join(base, 'cfg'),
    GIT_CONFIG_NOSYSTEM: '1',
  };
  repo = join(base, 'repo');
  mkdirSync(join(repo, '.ai-sdlc'), { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, '.ai-sdlc', 'agent-role.yaml'), POLICY);
  git(repo, 'add', '-A');
  git(repo, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '-m', 'i');
  git(base, 'init', '-q', '--bare', join(base, 'o.git'));
  git(repo, 'remote', 'add', 'origin', join(base, 'o.git'));
  wt = join(repo, '.worktrees', 'aisdlc-1');
  git(repo, 'worktree', 'add', '-q', '-b', BRANCH, wt);
  writeFileSync(join(wt, '.active-task'), 'AISDLC-1\n');
  repo = realpathSync(repo);
  wt = realpathSync(wt);
});

after(() => rmSync(base, { recursive: true, force: true }));

describe('push spellings prescribed in command / agent / skill bodies', () => {
  const files = bodies();
  const found = files.flatMap((f) => pushLines(f).map((line) => ({ f, line })));

  it('finds the push spelling in every file that prescribes one', () => {
    const names = new Set(found.map((x) => x.f.split('/').slice(-2).join('/')));
    for (const expected of [
      'commands/rebase.md',
      'commands/execute.md',
      'agents/rebase-resolver.md',
      'agents/ci-conflict-resolver.md',
      'agents/developer.md',
      'ai-sdlc-governance/SKILL.md',
    ]) {
      assert.ok(names.has(expected), `${expected} no longer shows a force-with-lease push`);
    }
  });

  it('also scans the tracked .claude/skills copy of the governance skill', () => {
    assert.ok(
      found.some((x) => x.f.includes(`${'.claude'}/skills/ai-sdlc-governance/SKILL.md`)),
      '.claude/skills/ai-sdlc-governance/SKILL.md must show the explicit spelling and be scanned',
    );
  });

  for (const { f, line } of found) {
    it(`the guard accepts: ${line}  (${f.split('/').slice(-2).join('/')})`, () => {
      const cmd = substitute(line);
      assert.ok(!/[<>$"'`;&|]/.test(cmd), `not a literal, unquoted, standalone command: ${cmd}`);
      assert.equal(verdict(cmd), 'allow', cmd);
    });

    it(`prescribes an explicit destination, never the no-colon form: ${line}`, () => {
      assert.match(
        substitute(line),
        /\sHEAD:refs\/heads\/\S+$/,
        'must end with the explicit HEAD:refs/heads/<branch> refspec',
      );
    });
  }
});

describe('spellings that must stay denied (so the files above cannot drift back)', () => {
  const denied = [
    'git push --force-with-lease origin HEAD',
    `git push --force-with-lease origin ${BRANCH}`,
    `git push --force-with-lease -u origin ${BRANCH}`,
    `git push --force-with-lease origin refs/heads/${BRANCH}`,
    'git push --force-with-lease --set-upstream origin HEAD',
    'git push --force-with-lease -u origin HEAD',
    `git push --force-with-lease origin HEAD:${BRANCH}`,
    `git push --force-with-lease origin ${BRANCH}:${BRANCH}`,
    'git push --force-with-lease origin HEAD:refs/heads/main',
    'git push --force-with-lease origin HEAD:refs/heads/master',
    'git push --force-with-lease origin main',
    'git push --force-with-lease origin HEAD:refs/tags/v1',
    'git push --force-with-lease origin HEAD:v1.2.3',
    `git push --force-with-lease origin "HEAD:refs/heads/${BRANCH}"`,
    `git push --force-with-lease origin HEAD:refs/heads/\${BRANCH}`,
    `git push --force-with-lease origin $(git branch --show-current)`,
    `cd ${'/tmp'} && git push --force-with-lease origin HEAD:refs/heads/${BRANCH}`,
    `git push --force-with-lease origin HEAD:refs/heads/${BRANCH} && echo ok`,
    `git push --force origin HEAD:refs/heads/${BRANCH}`,
  ];
  for (const cmd of denied) {
    it(`denies: ${cmd}`, () => assert.equal(verdict(cmd), 'deny', cmd));
  }

  it('control: the canonical spelling is accepted and the no-colon form is refused', () => {
    assert.equal(verdict(`git push --force-with-lease origin HEAD:refs/heads/${BRANCH}`), 'allow');
    assert.equal(
      verdict(`git push --force-with-lease -u origin HEAD:refs/heads/${BRANCH}`),
      'allow',
    );
    // The no-colon form is REFUSED (git maps it through remote.<name>.push / push.default).
    assert.equal(verdict(`git push --force-with-lease origin ${BRANCH}`), 'deny');
  });
});
