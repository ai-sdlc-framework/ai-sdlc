/**
 * Tests for render-role-tool-rules.mjs.
 *
 * Run with: node --test ai-sdlc-plugin/scripts/render-role-tool-rules.test.mjs
 *
 * The script prints the rules the PreToolUse role hook enforces, rendered from
 * the same module, so a skill's narration cannot drift from the enforcement.
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, 'render-role-tool-rules.mjs');
const require = createRequire(import.meta.url);
const {
  DEFAULT_ROLE_BLOCKED_TOOLS,
  describeRule,
  renderRoleToolRules,
} = require('../hooks/lib/role-tool-policy.js');

const dirs = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true });
});

function project(yaml) {
  const dir = mkdtempSync(join(tmpdir(), 'render-role-rules-'));
  dirs.push(dir);
  if (yaml !== undefined) {
    mkdirSync(join(dir, '.ai-sdlc'), { recursive: true });
    writeFileSync(join(dir, '.ai-sdlc', 'agent-role.yaml'), yaml);
  }
  return dir;
}

function render(dir, ...args) {
  return spawnSync('node', [script, ...args], {
    encoding: 'utf-8',
    env: { PATH: process.env.PATH, CLAUDE_PROJECT_DIR: dir },
    timeout: 20000,
  });
}

describe('render-role-tool-rules.mjs', () => {
  it('prints the strict executor defaults when there is no policy', () => {
    const res = render(project(), '--role', 'executor');
    assert.equal(res.status, 0, res.stderr);
    assert.equal(
      res.stdout,
      renderRoleToolRules('executor', DEFAULT_ROLE_BLOCKED_TOOLS.executor) + '\n',
    );
    for (const rule of DEFAULT_ROLE_BLOCKED_TOOLS.executor) {
      assert.ok(res.stdout.includes(describeRule(rule)), rule.id);
    }
  });

  it('prints the same defaults when the policy has no roles section', () => {
    const res = render(project('role: coding-agent\ngoal: test\n'), '--role', 'executor');
    assert.equal(res.status, 0, res.stderr);
    assert.match(
      res.stdout,
      /Every other subcommand, answer, resolve and override included, is refused/,
    );
  });

  it('prints what the repo configured: an emptied list', () => {
    const dir = project('governance:\n  roles:\n    executor:\n      blockedTools: []\n');
    const res = render(dir, '--role', 'executor');
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.stdout, 'No tool rules are configured for the executor role.\n');
  });

  it('prints what the repo configured: a replacement list', () => {
    const dir = project(
      [
        'governance:',
        '  roles:',
        '    executor:',
        '      blockedTools:',
        '        - tool: Bash',
        '          argument: command',
        "          contains: 'rm -rf'",
        "          reason: 'No recursive deletes.'",
        '',
      ].join('\n'),
    );
    const res = render(dir, '--role', 'executor');
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /- No recursive deletes\./);
    assert.doesNotMatch(res.stdout, /Every other subcommand, answer/);
  });

  it('shows the strict defaults, not an empty list, for a malformed override', () => {
    const dir = project(
      'governance:\n  roles:\n    executor:\n      blockedTools:\n        - tool: Bash\n          match: nope\n',
    );
    const res = render(dir, '--role', 'executor');
    assert.equal(
      res.stdout,
      renderRoleToolRules('executor', DEFAULT_ROLE_BLOCKED_TOOLS.executor) + '\n',
    );
  });

  it('prints a notice for a role with no rules', () => {
    const res = render(project(), '--role', 'planner');
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.stdout, 'No tool rules are configured for the planner role.\n');
  });

  it('refuses a missing or unknown role', () => {
    for (const args of [[], ['--role'], ['--role', 'wizard']]) {
      const res = render(project(), ...args);
      assert.equal(res.status, 2, args.join(' '));
      assert.match(res.stderr, /--role must be one of/);
      assert.equal(res.stdout, '');
    }
  });
});

describe('executor skill drift', () => {
  const body = readFileSync(join(here, '..', 'commands', 'executor.md'), 'utf-8');

  it('prints the rendered rules instead of restating them', () => {
    assert.match(body, /render-role-tool-rules\.mjs" --role executor/);
    for (const rule of DEFAULT_ROLE_BLOCKED_TOOLS.executor) {
      assert.ok(
        !body.includes(describeRule(rule)),
        `${rule.id} must not be duplicated in the skill`,
      );
    }
  });
});
