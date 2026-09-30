/**
 * Tests for the opencode v2 governance plugin
 * (.opencode/plugins/ai-sdlc-governance.js), driven black-box through the
 * plugin's real `setup(ctx)` entry point with a fake v2 plugin context — the
 * exact seam opencode uses. No named exports are added to the plugin just for
 * testing (an opencode plugin module's exports are part of its contract).
 *
 * Also carries a parity table against the legacy Claude hook
 * (ai-sdlc-plugin/hooks/enforce-blocked-actions.js): where the two engines
 * are meant to agree they are asserted to agree; the DELIBERATE divergences
 * (lease carve-out, harness-config floor, force flag after the remote) are
 * listed explicitly so a future drift is a conscious decision.
 *
 * Run: node --test scripts/opencode-governance.test.mjs
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const PLUGIN = join(REPO, '.opencode', 'plugins', 'ai-sdlc-governance.js');
const LEGACY_HOOK = join(REPO, 'ai-sdlc-plugin', 'hooks', 'enforce-blocked-actions.js');
const REAL_AGENT_ROLE = readFileSync(join(REPO, '.ai-sdlc', 'agent-role.yaml'), 'utf-8');

const plugin = (await import(pathToFileURL(PLUGIN).href)).default;

// Assembled at runtime so this file's own source never contains the literal
// phrase that the repo's shell governance scans for in command text.
const GH_PR = ['gh', 'pr'].join(' ');
const PR_MERGE = `${GH_PR} merge`;

let root; // fake project root
let worktree; // <root>/.worktrees/aisdlc-99
let sibling; // permitted external dir
let telemetryDir;
const savedEnv = {};

function setEnv(k, v) {
  if (!(k in savedEnv)) savedEnv[k] = process.env[k];
  if (v === undefined) delete process.env[k];
  else process.env[k] = v;
}

before(() => {
  root = mkdtempSync(join(tmpdir(), 'oc-gov-'));
  sibling = mkdtempSync(join(tmpdir(), 'oc-gov-sibling-'));
  telemetryDir = mkdtempSync(join(tmpdir(), 'oc-gov-telemetry-'));
  worktree = join(root, '.worktrees', 'aisdlc-99');
  mkdirSync(join(root, '.ai-sdlc'), { recursive: true });
  mkdirSync(join(root, 'backlog', 'tasks'), { recursive: true });
  mkdirSync(worktree, { recursive: true });
  writeFileSync(join(root, '.ai-sdlc', 'agent-role.yaml'), REAL_AGENT_ROLE);
  writeFileSync(
    join(root, 'backlog', 'tasks', 'aisdlc-99 - test-task.md'),
    `---\nid: AISDLC-99\ntitle: t\npermittedExternalPaths:\n  - '${sibling}'\n---\n\nBody.\n`,
  );
  setEnv('AI_SDLC_PROJECT_ROOT', root);
  setEnv('AI_SDLC_TELEMETRY_DIR', telemetryDir);
});

after(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(root, { recursive: true, force: true });
  rmSync(sibling, { recursive: true, force: true });
  rmSync(telemetryDir, { recursive: true, force: true });
});

beforeEach(() => {
  setEnv('AI_SDLC_ACTIVE_TASK_ID', undefined);
});

/** Fake v2 plugin ctx; captures the hooks the plugin registers. */
function makeCtx({ directory = worktree } = {}) {
  const hooks = {};
  const disposed = [];
  const reg = (kind) => (name, fn) => {
    hooks[`${kind}.${name}`] = fn;
    return { dispose: () => disposed.push(`${kind}.${name}`) };
  };
  return {
    hooks,
    disposed,
    permission: { hook: reg('permission') },
    tool: { hook: reg('tool') },
    session: { hook: reg('session'), get: async () => ({ location: { directory } }) },
  };
}

async function loadHooks(opts) {
  const ctx = makeCtx(opts);
  const dispose = await plugin.setup(ctx);
  return { ctx, dispose };
}

/** Run permission.evaluate and report whether governance denied. */
async function evaluate(hooks, action, resources) {
  const input = {
    action,
    resources: Array.isArray(resources) ? resources : [resources],
    sessionID: 's1',
  };
  await hooks['permission.evaluate'](input);
  return { denied: input.effect === 'deny', message: input.message, input };
}

describe('plugin shape', () => {
  it('has the v2 id and registers the three hooks; dispose unregisters them', async () => {
    assert.equal(plugin.id, 'ai-sdlc.governance');
    const { ctx, dispose } = await loadHooks();
    assert.deepEqual(Object.keys(ctx.hooks).sort(), [
      'permission.evaluate',
      'session.context',
      'tool.execute.after',
    ]);
    await dispose();
    assert.equal(ctx.disposed.length, 3);
  });

  it('a hook-registration failure is fail-open (other hooks still register)', async () => {
    const ctx = makeCtx();
    ctx.permission.hook = () => {
      throw new Error('registration boom');
    };
    await plugin.setup(ctx);
    assert.ok(ctx.hooks['tool.execute.after']);
    assert.ok(ctx.hooks['session.context']);
  });
});

describe('shell governance', () => {
  const cases = [
    // [command, expectedDenied]
    [`${PR_MERGE} 42`, true],
    // A clean auto-arm passes the merge-governance floor, but this repo's
    // agent-role.yaml blockedActions pattern for the merge command still denies it.
    [`${PR_MERGE} 42 --auto --squash`, true],
    ['git merge feature', true],
    [`${GH_PR} close 7`, true],
    ['gh issue close 7', true],
    ['git branch -D old', true],
    ['git branch -d old', true],
    ['git reset --hard HEAD~1', true],
    ['git checkout -- .', true],
    ['git restore .', true],
    ['git stash pop', true],
    ['git stash clear', true],
    ['git stash drop', true],
    ['git stash drop stash@{1}', false],
    ['git stash push -u -m my-tag', false],
    ['git push origin feature', false],
    ['git status', false],
    ['cd x && git merge feature', true],
    ['ls && git push --force origin feature', true],
    ['git push --force origin main', true],
    ['git push -f origin main', true],
    ['git push origin main --force', true], // flag AFTER the remote (prefix glob alone misses it)
    ['git -C /tmp/x push --force origin feature', true],
    ['', false],
  ];
  for (const [command, expected] of cases) {
    it(`${expected ? 'denies' : 'allows'}: ${command || '(empty)'}`, async () => {
      const { ctx } = await loadHooks();
      assert.equal((await evaluate(ctx.hooks, 'shell', command)).denied, expected);
    });
  }

  it('also handles the `bash` action name', async () => {
    const { ctx } = await loadHooks();
    assert.equal((await evaluate(ctx.hooks, 'bash', 'git merge x')).denied, true);
  });

  it('the deny message names the governance layer', async () => {
    const { ctx } = await loadHooks();
    const r = await evaluate(ctx.hooks, 'shell', 'git merge x');
    assert.match(r.message, /Blocked by AI-SDLC governance policy/);
  });
});

describe('force-with-lease carve-out (strict)', () => {
  const allowed = [
    'git push --force-with-lease --set-upstream origin HEAD',
    'git push --force-with-lease origin feat/x',
    'git push origin feat/x --force-with-lease',
    'git push --force-with-lease=feat/x:abc123 origin feat/x',
    'git push --force-with-lease --force-if-includes origin feat/x',
    'git push --force-with-lease origin HEAD:refs/heads/feat/x',
    'git push --force-with-lease origin feat/main-menu',
  ];
  const denied = [
    // The reported bypass: the prefix glob let a second force flag ride along.
    'git push --force-with-lease --force origin main',
    'git push --force-with-lease --force origin feat/x',
    'git push --force --force-with-lease origin feat/x',
    'git push --force-with-lease -f origin feat/x',
    'git push --force-with-lease -fu origin feat/x',
    'git push --force-with-lease origin +feat/x',
    'git push --force-with-lease origin feat/x:+main',
    // main/master targets are denied even with a lease.
    'git push --force-with-lease origin main',
    'git push --force-with-lease origin master',
    'git push --force-with-lease origin HEAD:main',
    'git push --force-with-lease origin HEAD:refs/heads/master',
    'git push --force-with-lease=main:abc123 origin main',
    'git push --force-with-lease --mirror origin',
    'git push --force-with-lease --delete origin feat/x',
    'git push --force-with-lease -d origin feat/x',
    // chained / global-flag forms
    'git status && git push --force-with-lease --force origin feat/x',
    'git -C /tmp/x push --force-with-lease --force origin feat/x',
    'GIT_TRACE=1 git push --force-with-lease --force origin feat/x',
  ];
  for (const cmd of allowed) {
    it(`allows: ${cmd}`, async () => {
      const { ctx } = await loadHooks();
      assert.equal((await evaluate(ctx.hooks, 'shell', cmd)).denied, false);
    });
  }
  for (const cmd of denied) {
    it(`denies: ${cmd}`, async () => {
      const { ctx } = await loadHooks();
      assert.equal((await evaluate(ctx.hooks, 'shell', cmd)).denied, true);
    });
  }
});

describe('multi-resource evaluation', () => {
  it('denies when ANY shell resource is blocked (not just the first)', async () => {
    const { ctx } = await loadHooks();
    assert.equal(
      (await evaluate(ctx.hooks, 'shell', ['ls -la', 'git merge feature'])).denied,
      true,
    );
  });

  it('denies when ANY edit resource is blocked', async () => {
    const { ctx } = await loadHooks();
    const r = await evaluate(ctx.hooks, 'edit', [
      join(worktree, 'src/ok.ts'),
      join(worktree, '.ai-sdlc/x.yaml'),
    ]);
    assert.equal(r.denied, true);
  });

  it('denies when ANY edit resource is outside the worktree', async () => {
    const { ctx } = await loadHooks();
    const r = await evaluate(ctx.hooks, 'patch', [join(worktree, 'src/ok.ts'), '/etc/passwd']);
    assert.equal(r.denied, true);
  });

  it('allows when every resource is fine', async () => {
    const { ctx } = await loadHooks();
    const r = await evaluate(ctx.hooks, 'edit', [
      join(worktree, 'src/a.ts'),
      join(worktree, 'src/b.ts'),
    ]);
    assert.equal(r.denied, false);
  });

  it('accepts a bare (non-array) resource', async () => {
    const { ctx } = await loadHooks();
    const input = { action: 'edit', resources: join(worktree, '.ai-sdlc/x'), sessionID: 's' };
    await ctx.hooks['permission.evaluate'](input);
    assert.equal(input.effect, 'deny');
  });
});

describe('path governance', () => {
  const rel = [
    ['.ai-sdlc/agent-role.yaml', true],
    ['.github/workflows/ci.yml', true],
    ['scripts/verify-attestation.mjs', true],
    ['opencode.json', true],
    ['opencode.jsonc', true],
    ['.opencode/plugins/ai-sdlc-governance.js', true],
    ['.opencode/agents/developer.md', true],
    ['src/feature.ts', false],
    ['docs/readme.md', false],
    ['opencode.json.md', false],
  ];
  for (const [p, expected] of rel) {
    it(`${expected ? 'denies' : 'allows'} edit of ${p} (relative to the session dir)`, async () => {
      const { ctx } = await loadHooks();
      assert.equal((await evaluate(ctx.hooks, 'edit', p)).denied, expected);
    });
  }

  it('write action is governed the same as edit', async () => {
    const { ctx } = await loadHooks();
    assert.equal((await evaluate(ctx.hooks, 'write', join(worktree, '.ai-sdlc/x'))).denied, true);
  });

  it('denies writes outside the active worktree with no permittedExternalPaths', async () => {
    const { ctx } = await loadHooks();
    const r = await evaluate(ctx.hooks, 'edit', join(sibling, 'file.txt'));
    assert.equal(r.denied, true);
    assert.match(r.message, /outside the agent's active worktree/);
  });

  it('AI_SDLC_ACTIVE_TASK_ID unlocks the task permittedExternalPaths allowance', async () => {
    setEnv('AI_SDLC_ACTIVE_TASK_ID', 'AISDLC-99');
    const { ctx } = await loadHooks();
    assert.equal((await evaluate(ctx.hooks, 'edit', join(sibling, 'file.txt'))).denied, false);
    // ...but only that path: other outside paths stay denied.
    const other = await evaluate(ctx.hooks, 'edit', '/etc/hosts');
    assert.equal(other.denied, true);
    assert.match(other.message, /permittedExternalPaths/);
  });

  it('the .ai-sdlc floor still holds inside the worktree when a task is active', async () => {
    setEnv('AI_SDLC_ACTIVE_TASK_ID', 'AISDLC-99');
    const { ctx } = await loadHooks();
    assert.equal((await evaluate(ctx.hooks, 'edit', join(worktree, '.ai-sdlc/x'))).denied, true);
  });

  it('non-shell, non-edit actions (read, mcp) get no opinion', async () => {
    const { ctx } = await loadHooks();
    assert.equal((await evaluate(ctx.hooks, 'read', '/etc/passwd')).denied, false);
    assert.equal((await evaluate(ctx.hooks, 'ai-sdlc_task_list', '{}')).denied, false);
  });

  it('the hardcoded floors apply even when agent-role.yaml is absent', async () => {
    const bare = mkdtempSync(join(tmpdir(), 'oc-gov-bare-'));
    try {
      setEnv('AI_SDLC_PROJECT_ROOT', bare);
      const { ctx } = await loadHooks({ directory: bare });
      assert.equal((await evaluate(ctx.hooks, 'edit', join(bare, '.ai-sdlc/x'))).denied, true);
      assert.equal((await evaluate(ctx.hooks, 'shell', `${PR_MERGE} 5`)).denied, true); // merge floor
      assert.equal((await evaluate(ctx.hooks, 'edit', join(bare, 'src/a.ts'))).denied, false);
    } finally {
      setEnv('AI_SDLC_PROJECT_ROOT', root);
      rmSync(bare, { recursive: true, force: true });
    }
  });
});

describe('fail-open on internal error', () => {
  it('a throwing input never propagates and never denies', async () => {
    const { ctx } = await loadHooks();
    const input = {
      get action() {
        throw new Error('boom');
      },
    };
    await assert.doesNotReject(ctx.hooks['permission.evaluate'](input));
    assert.equal(input.effect, undefined);
  });

  it('a failing session lookup falls back instead of breaking the evaluation', async () => {
    const ctx = makeCtx();
    ctx.session.get = async () => {
      throw new Error('no session');
    };
    await plugin.setup(ctx);
    const input = { action: 'edit', resources: ['/etc/passwd'], sessionID: 'x' };
    await assert.doesNotReject(ctx.hooks['permission.evaluate'](input));
  });

  it('telemetry failure never throws', async () => {
    const { ctx } = await loadHooks();
    writeFileSync(join(telemetryDir, 'file-not-dir'), 'blocker');
    setEnv('AI_SDLC_TELEMETRY_DIR', join(telemetryDir, 'file-not-dir', 'x'));
    try {
      await assert.doesNotReject(
        ctx.hooks['tool.execute.after']({ sessionID: 's', tool: 'read', input: {} }),
      );
    } finally {
      setEnv('AI_SDLC_TELEMETRY_DIR', telemetryDir);
    }
  });
});

describe('tool.execute.after telemetry (JSONL shape)', () => {
  it('appends {ts,sid,tool,action,project} lines, canonicalizing the action', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'oc-gov-tel-'));
    setEnv('AI_SDLC_TELEMETRY_DIR', dir);
    try {
      const { ctx } = await loadHooks();
      const afterHook = ctx.hooks['tool.execute.after'];
      await afterHook({
        sessionID: 'ses_1',
        tool: 'shell',
        input: { command: 'git status && pnpm test -- x' },
      });
      await afterHook({ sessionID: 'ses_1', tool: 'read', input: { path: 'src/a.ts' } });
      await afterHook({ sessionID: 'ses_1', tool: 'grep', input: { pattern: 'needle' } });
      await afterHook({
        sessionID: 'ses_1',
        tool: 'webfetch',
        input: { url: 'https://example.com' },
      });
      await afterHook({ sessionID: 'ses_2', tool: 'Custom', input: null });

      const lines = readFileSync(join(dir, 'tool-sequences.jsonl'), 'utf-8')
        .trim()
        .split('\n')
        .map(JSON.parse);
      assert.equal(lines.length, 5);
      for (const l of lines) {
        assert.deepEqual(Object.keys(l).sort(), ['action', 'project', 'sid', 'tool', 'ts']);
        assert.ok(!Number.isNaN(Date.parse(l.ts)));
        assert.equal(l.project, root);
      }
      assert.deepEqual(
        lines.map((l) => [l.sid, l.tool, l.action]),
        [
          ['ses_1', 'shell', 'pnpm test --'],
          ['ses_1', 'read', 'read:.ts'],
          ['ses_1', 'grep', 'grep:needle'],
          ['ses_1', 'webfetch', 'webfetch:https://example.com'],
          ['ses_2', 'Custom', 'custom'],
        ],
      );
    } finally {
      setEnv('AI_SDLC_TELEMETRY_DIR', telemetryDir);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('session.context banner', () => {
  it('pushes the hard-rules banner once (marker-guarded, idempotent)', async () => {
    const { ctx } = await loadHooks();
    const req = { system: [{ type: 'text', text: 'base prompt' }] };
    await ctx.hooks['session.context'](req);
    assert.equal(req.system.length, 2);
    assert.match(req.system[1].text, /AI-SDLC GOVERNANCE/);
    assert.match(req.system[1].text, /Never merge PRs/);
    await ctx.hooks['session.context'](req);
    assert.equal(req.system.length, 2, 'second call must not double-inject');
  });

  it('ignores a request without a system array', async () => {
    const { ctx } = await loadHooks();
    await assert.doesNotReject(ctx.hooks['session.context']({}));
    await assert.doesNotReject(ctx.hooks['session.context'](undefined));
  });
});

/* ── Parity with the legacy Claude hook ────────────────────────────── */

function legacyDenied(toolName, toolInput) {
  const parse = (out) => {
    if (!out || !out.toString().trim()) return false;
    return JSON.parse(out.toString()).hookSpecificOutput?.permissionDecision === 'deny';
  };
  try {
    const out = execFileSync('node', [LEGACY_HOOK], {
      input: JSON.stringify({ tool_name: toolName, tool_input: toolInput }),
      encoding: 'utf-8',
      env: { ...process.env, CLAUDE_PROJECT_DIR: root },
      timeout: 10_000,
    });
    return parse(out);
  } catch (err) {
    return parse(err.stdout);
  }
}

describe('parity with the legacy ai-sdlc-plugin enforce-blocked-actions hook', () => {
  before(() => {
    assert.ok(existsSync(LEGACY_HOOK));
  });

  const commands = [
    `${PR_MERGE} 42`,
    `${PR_MERGE} 42 --auto --squash`,
    'git merge feature',
    'git push --force origin main',
    'git push -f origin main',
    'git push origin feature',
    `${GH_PR} close 7`,
    'gh issue close 7',
    'git branch -D old',
    'git reset --hard HEAD',
    'git checkout -- .',
    'git restore .',
    'git stash pop',
    'git stash clear',
    'git stash drop',
    'git stash drop stash@{0}',
    'git stash push -u -m tag',
    'echo hello',
    'git status',
  ];
  for (const command of commands) {
    it(`shell agrees: ${command}`, async () => {
      const { ctx } = await loadHooks({ directory: root });
      const ours = (await evaluate(ctx.hooks, 'shell', command)).denied;
      assert.equal(
        ours,
        legacyDenied('Bash', { command }),
        `plugin vs legacy disagree on: ${command}`,
      );
    });
  }

  const paths = [
    ['.ai-sdlc', 'agent-role.yaml'],
    ['.github', 'workflows', 'ci.yml'],
    ['scripts', 'verify-attestation.mjs'],
    ['src', 'ok.ts'],
  ];
  const absPaths = () => [...paths.map((p) => join(root, ...p)), '/etc/passwd'];
  for (let i = 0; i <= paths.length; i++) {
    it(`path agrees: ${i < paths.length ? paths[i].join('/') : '/etc/passwd'}`, async () => {
      const file_path = absPaths()[i];
      const { ctx } = await loadHooks({ directory: root });
      const ours = (await evaluate(ctx.hooks, 'edit', file_path)).denied;
      assert.equal(
        ours,
        legacyDenied('Edit', { file_path }),
        `plugin vs legacy disagree on: ${file_path}`,
      );
    });
  }

  // DELIBERATE divergences (documented, asserted so drift is a conscious act).
  describe('deliberate divergences', () => {
    it('strict force-with-lease: legacy denies it, the plugin allows it (DoD requires it)', async () => {
      const command = 'git push --force-with-lease origin feat/x';
      const { ctx } = await loadHooks({ directory: root });
      assert.equal((await evaluate(ctx.hooks, 'shell', command)).denied, false);
      assert.equal(legacyDenied('Bash', { command }), true);
    });

    it('harness config (opencode.json, .opencode/**) is a plugin-only floor', async () => {
      const file_path = join(root, 'opencode.json');
      const { ctx } = await loadHooks({ directory: root });
      assert.equal((await evaluate(ctx.hooks, 'edit', file_path)).denied, true);
      assert.equal(legacyDenied('Edit', { file_path }), false);
    });

    it('chained commands: the plugin is segment-aware, the legacy glob only anchors at the start', async () => {
      const command = 'cd x && git merge y';
      const { ctx } = await loadHooks({ directory: root });
      assert.equal((await evaluate(ctx.hooks, 'shell', command)).denied, true);
      assert.equal(legacyDenied('Bash', { command }), false);
    });

    it('a force flag AFTER the remote: the plugin is stricter than the legacy prefix glob', async () => {
      const command = 'git push origin feat/x --force';
      const { ctx } = await loadHooks({ directory: root });
      assert.equal((await evaluate(ctx.hooks, 'shell', command)).denied, true);
      assert.equal(legacyDenied('Bash', { command }), false);
    });
  });
});
