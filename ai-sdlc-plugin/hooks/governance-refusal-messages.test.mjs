/**
 * AISDLC-711: every refusal a governance hook produces must name the rule, name
 * the config key and value or the sanctioned command that resolves it, and never
 * tell the agent to ask the operator. Two layers:
 *   1. static: every deny call site in the hook sources either carries a resolver
 *      in its own text or goes through a known message builder (which layer 2
 *      exercises), and no message text tells the agent to ask a human.
 *   2. runtime: each denial the hooks can produce is triggered for real and its
 *      actual message is checked.
 *
 * Run with: node --test ai-sdlc-plugin/hooks/governance-refusal-messages.test.mjs
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const BLOCKED_HOOK = join(here, 'enforce-blocked-actions.js');
const ROLE_HOOK = join(here, 'enforce-role-tools.js');
const PERMISSION_HOOK = join(here, 'permission-check.js');

/** A config key and value, a sanctioned command, or an escalation path. */
const RESOLVER =
  /Next step|node pipeline-cli\/bin\/[\w-]+\.mjs|spec\.governance\.\w+|allowForcePush|allowMerge|blockedPaths|blockedActions|permittedExternalPaths|AI_SDLC_INTERNAL_RUN|git stash push|cli-decisions|--force-with-lease/;
/** Wording that leaves the agent waiting on a person. */
const WAITS_ON_HUMAN =
  /\bask(?:ing)? (?:the |an? )?(?:operator|maintainer|human|user)\b|\bwait(?:ing)? for (?:the )?(?:operator|human|maintainer)\b|\bhand (?:it|this) to the operator\b/i;

// ── Layer 1: static ──────────────────────────────────────────────────

const SOURCES = [
  'enforce-blocked-actions.js',
  'enforce-role-tools.js',
  'permission-check.js',
  'lib/role-tool-policy.js',
  'lib/lease-push-guard.js',
].map((f) => ({ file: f, text: readFileSync(join(here, f), 'utf-8') }));

/** Text of the call starting at `open` (index of the `(`), by paren matching. */
function callText(text, open) {
  let depth = 0;
  let quote = null;
  for (let i = open; i < text.length; i += 1) {
    const c = text[i];
    if (quote) {
      if (c === '\\') i += 1;
      else if (c === quote) quote = null;
    } else if (c === "'" || c === '"' || c === '`') {
      quote = c;
    } else if (c === '(') {
      depth += 1;
    } else if (c === ')') {
      depth -= 1;
      if (depth === 0) return text.slice(open + 1, i);
    }
  }
  return '';
}

/** deny(...) arguments that are built elsewhere; layer 2 exercises each builder. */
const INDIRECT = new Set([
  'msg',
  'verdict.reason',
  'forcePushRefusal(lease.why)',
  "untrustedMessage(`path '${hit}'`)",
  'reason',
  'message',
]);

function denySites() {
  const sites = [];
  for (const { file, text } of SOURCES) {
    for (const m of text.matchAll(/(?<![\w.])deny\(/g)) {
      const open = m.index + m[0].length - 1;
      const line = text.slice(0, m.index).split('\n').length;
      if (/function deny\($/.test(text.slice(m.index - 9, m.index + 5))) continue;
      const before = text.slice(Math.max(0, m.index - 9), m.index);
      if (/function\s+$/.test(before)) continue;
      sites.push({ file, line, arg: callText(text, open).trim() });
    }
  }
  return sites;
}

describe('refusal messages: static scan of deny call sites', () => {
  const sites = denySites();

  it('finds the deny call sites', () => {
    assert.ok(sites.length >= 15, `expected many deny sites, found ${sites.length}`);
  });

  for (const s of sites) {
    it(`${s.file}:${s.line} names a resolver or uses a covered builder`, () => {
      assert.ok(
        INDIRECT.has(s.arg) || RESOLVER.test(s.arg),
        `deny site has no resolver (config key, sanctioned command or escalation) in its text: ${s.arg.slice(0, 160)}`,
      );
    });
  }

  for (const { file, text } of SOURCES) {
    it(`${file} has no message that tells the agent to ask a human`, () => {
      const code = text
        .split('\n')
        .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
        .join('\n');
      const hit = code.match(WAITS_ON_HUMAN);
      assert.equal(hit, null, `wording that leaves the agent waiting on a person: ${hit?.[0]}`);
    });
  }
});

// ── Layer 2: runtime ─────────────────────────────────────────────────

const DEFAULT_ROLE_YAML = (governance = '') => `apiVersion: ai-sdlc.io/v1alpha1
kind: AgentRole
spec:
  role: coding-agent
  goal: test
${governance}  constraints:
    blockedPaths:
      - 'scripts/verify-attestation.mjs'
    blockedActions:
      - 'gh pr merge*'
      - 'git merge*'
      - 'git push --force*'
      - 'git push -f*'
      - 'git reset --hard*'
`;

let base;
let gitEnv;
let root;
let wt;
let neverRoot;
let toolDir;
let wrapper;

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, env: gitEnv, encoding: 'utf-8' }).trim();
}

before(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'gov-refuse-')));
  const cfg = join(base, 'gitconfig');
  writeFileSync(cfg, '');
  gitEnv = { PATH: process.env.PATH, HOME: base, GIT_CONFIG_GLOBAL: cfg, GIT_CONFIG_NOSYSTEM: '1' };
  root = join(base, 'repo');
  mkdirSync(join(root, '.ai-sdlc'), { recursive: true });
  git(root, 'init', '-q', '-b', 'main');
  writeFileSync(join(root, '.ai-sdlc', 'agent-role.yaml'), DEFAULT_ROLE_YAML());
  git(root, 'add', '-A');
  git(
    root,
    '-c',
    'user.name=t',
    '-c',
    'user.email=t@example.invalid',
    'commit',
    '-q',
    '-m',
    'init',
  );
  root = realpathSync(root);
  git(
    root,
    'worktree',
    'add',
    '-q',
    '-b',
    'ai-sdlc/aisdlc-1-own',
    join(root, '.worktrees', 'aisdlc-1'),
  );
  writeFileSync(join(root, '.worktrees', 'aisdlc-1', '.active-task'), 'AISDLC-1\n');
  wt = realpathSync(join(root, '.worktrees', 'aisdlc-1'));

  neverRoot = join(base, 'never');
  mkdirSync(join(neverRoot, '.ai-sdlc'), { recursive: true });
  writeFileSync(
    join(neverRoot, '.ai-sdlc', 'agent-role.yaml'),
    DEFAULT_ROLE_YAML('  governance:\n    allowForcePush: never\n'),
  );

  toolDir = mkdtempSync(join(tmpdir(), 'gov-refuse-bin-'));
  symlinkSync(process.execPath, join(toolDir, 'claude'));
  wrapper = join(toolDir, 'wrapper.mjs');
  writeFileSync(
    wrapper,
    `import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const [dir, board, payload, hook] = process.argv.slice(2);
mkdirSync(board, { recursive: true });
const sessions = [
  { role: 'operator-dispatch', name: 'operator-dispatch', pid: 999999991, status: 'running' },
  { role: 'executor', name: 'executor-alpha', pid: process.pid, status: 'running' },
];
writeFileSync(join(board, 'hierarchy.json'), JSON.stringify({ schemaVersion: 'v1', sessions }));
const r = spawnSync('node', [hook], {
  input: payload,
  encoding: 'utf-8',
  env: { PATH: process.env.PATH, HOME: dir, CLAUDE_PROJECT_DIR: dir },
});
process.stdout.write(JSON.stringify({ status: r.status, stdout: r.stdout, stderr: r.stderr }));
`,
  );
});

after(() => {
  rmSync(base, { recursive: true, force: true });
  rmSync(toolDir, { recursive: true, force: true });
});

function reasonOf(stdout) {
  if (!stdout || !stdout.trim()) return null;
  const d = JSON.parse(stdout).hookSpecificOutput;
  return d?.permissionDecision === 'deny' ? d.permissionDecisionReason : null;
}

function viaBlocked({ tool = 'Bash', input, cwd, project = root, env = {} }) {
  const r = spawnSync('node', [BLOCKED_HOOK], {
    input: JSON.stringify({ tool_name: tool, tool_input: input, cwd }),
    cwd,
    encoding: 'utf-8',
    timeout: 15000,
    env: { ...gitEnv, GITHUB_ACTIONS: '', CLAUDE_PROJECT_DIR: project, ...env },
  });
  return reasonOf(r.stdout);
}

function viaPermission(command) {
  const r = spawnSync('node', [PERMISSION_HOOK], {
    input: JSON.stringify({ tool_name: 'Bash', tool_input: { command } }),
    encoding: 'utf-8',
    env: { ...gitEnv, CLAUDE_PROJECT_DIR: root },
  });
  return reasonOf(r.stdout);
}

function viaRole(tool, input) {
  const out = execFileSync(
    join(toolDir, 'claude'),
    [
      wrapper,
      root,
      join(root, '.ai-sdlc', 'dispatch'),
      JSON.stringify({ tool_name: tool, tool_input: input, cwd: root }),
      ROLE_HOOK,
    ],
    { encoding: 'utf-8', timeout: 20000 },
  );
  return reasonOf(JSON.parse(out).stdout);
}

const bash = (command, extra = {}) => ({ input: { command }, cwd: wt, ...extra });

/** name, how to trigger, `rule` the message must name, `resolver` it must offer. */
const SCENARIOS = [
  [
    'raw merge',
    () => viaBlocked(bash('gh pr merge 5')),
    /gh pr merge/,
    /cli-merge-if-eligible\.mjs/,
  ],
  [
    'api merge',
    () => viaBlocked(bash('gh api repos/o/r/pulls/5/merge -X PUT')),
    /GitHub API/,
    /cli-merge-if-eligible\.mjs/,
  ],
  [
    'merge policy root override',
    () => viaBlocked(bash('AI_SDLC_MERGE_POLICY_ROOT=/x git status')),
    /merge policy root/,
    /spec\.governance\.allowMerge/,
  ],
  ['stash pop', () => viaBlocked(bash('git stash pop')), /git stash pop/, /git stash push/],
  ['stash clear', () => viaBlocked(bash('git stash clear')), /git stash clear/, /git stash push/],
  ['stash drop', () => viaBlocked(bash('git stash drop')), /git stash drop/, /git stash push/],
  [
    'force push, explicit never',
    () =>
      viaBlocked({ ...bash('git push --force origin main'), project: neverRoot, cwd: neverRoot }),
    /allowForcePush/,
    /cli-decisions\.mjs escalate/,
  ],
  [
    'force push outside a task worktree',
    () => viaBlocked({ ...bash('git push origin --force main'), cwd: root }),
    /allowForcePush/,
    /Next step|--force-with-lease/,
  ],
  [
    'lease push to main',
    () =>
      viaBlocked(
        bash('git push --force-with-lease origin HEAD:refs/heads/main', {
          env: { AI_SDLC_ACTIVE_TASK_ID: 'AISDLC-1' },
        }),
      ),
    /allowForcePush/,
    /--force-with-lease origin HEAD:refs\/heads\//,
  ],
  [
    'blockedActions pattern',
    () => viaBlocked(bash('git reset --hard HEAD')),
    /blockedActions pattern 'git reset --hard\*'/,
    /cli-decisions\.mjs escalate/,
  ],
  [
    'blockedPaths',
    () =>
      viaBlocked({
        tool: 'Write',
        input: { file_path: join(wt, 'scripts', 'verify-attestation.mjs') },
        cwd: wt,
        project: wt,
      }),
    /blockedPaths entry 'scripts\/verify-attestation\.mjs'/,
    /cli-decisions\.mjs escalate/,
  ],
  [
    'path outside the worktree',
    () => viaBlocked({ tool: 'Write', input: { file_path: join(base, 'elsewhere.txt') }, cwd: wt }),
    /outside the agent's active worktree/,
    /permittedExternalPaths/,
  ],
  [
    'untrusted run protected path',
    () =>
      viaBlocked({
        tool: 'Write',
        input: { file_path: join(wt, '.ai-sdlc', 'agent-role.yaml') },
        cwd: wt,
        env: { AI_SDLC_UNTRUSTED_RUN: '1' },
      }),
    /AISDLC-720/,
    /cli-decisions\.mjs escalate|AI_SDLC_INTERNAL_RUN/,
  ],
  [
    'permission layer blockedActions',
    () => viaPermission('git reset --hard HEAD'),
    /blockedActions pattern 'git reset --hard\*'/,
    /cli-decisions\.mjs escalate/,
  ],
  [
    'executor role: message to a non-dispatch session',
    () => viaRole('SendMessage', { to: 'executor-beta', message: 'hi' }),
    /rule message-non-dispatch/,
    /escalate to your dispatch session/,
  ],
  [
    'executor role: decision mutation',
    () =>
      viaRole('Bash', { command: 'node pipeline-cli/bin/cli-decisions.mjs answer DEC-1 opt-a' }),
    /rule decision-mutation/,
    /cli-decisions escalate/,
  ],
  [
    'executor role: top-level task',
    () => viaRole('mcp__backlog__task_create', { id: 'AISDLC-900', title: 't' }),
    /rule top-level-task/,
    /cli-dispatch/,
  ],
];

describe('refusal messages: every denial names its rule and a way forward', () => {
  for (const [name, trigger, rule, resolver] of SCENARIOS) {
    it(`${name}`, () => {
      const reason = trigger();
      assert.ok(reason, `expected a denial for: ${name}`);
      assert.match(reason, rule, 'must name the rule');
      assert.match(reason, resolver, 'must name the config key/command that resolves it');
      assert.match(reason, RESOLVER);
      assert.doesNotMatch(reason, WAITS_ON_HUMAN, 'must not tell the agent to ask a human');
    });
  }
});
