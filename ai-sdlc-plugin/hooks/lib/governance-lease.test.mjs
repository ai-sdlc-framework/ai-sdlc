/**
 * Tests for the leaseOnOwnBranch / operational additions to the governance
 * resolver, and their rendering in both SessionStart and SubagentStart hooks.
 *
 * Run with: node --test ai-sdlc-plugin/hooks/lib/governance-lease.test.mjs
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const {
  OPERATIONAL_ACTIONS,
  STRICT_DEFAULTS,
  parseGovernanceBlock,
  resolveGovernance,
  resolveGovernanceFromYaml,
  resolveGovernanceExtrasFromYaml,
  resolveForcePushMode,
  resolveOperational,
  resolveProtectedBranches,
  renderOperationalRules,
  renderSessionStartHardRules,
  renderSubagentHardRules,
} = require('./governance-resolver.js');

const ALL_OPS = [
  'rebase-own-branch',
  'lease-push-own-branch',
  'retrigger-ci',
  'requeue',
  'file-subid-followups',
  'answer-operational-decisions',
  'clear-executor-context',
];

// The exact snippet the operator commits to .ai-sdlc/agent-role.yaml (shown in
// the PR body). Resolved here from a string, never from the real file.
const OPERATOR_SNIPPET = `apiVersion: ai-sdlc.io/v1alpha1
kind: AgentRole
metadata:
  name: coding-agent
spec:
  role: coding-agent
  goal: Fix bugs and implement small features
  governance:
    allowForcePush: leaseOnOwnBranch
    operational:
      - rebase-own-branch
      - lease-push-own-branch
      - retrigger-ci
      - requeue
      - file-subid-followups
      - answer-operational-decisions
      - clear-executor-context
  constraints:
    blockedActions:
      - 'git push --force*'
`;

describe('resolver - allowForcePush enum', () => {
  it('closed operational set matches the documented seven', () => {
    assert.deepEqual([...OPERATIONAL_ACTIONS], ALL_OPS);
  });

  it('leaseOnOwnBranch and true resolve to lease; everything else fails closed to never', () => {
    assert.equal(resolveForcePushMode({ allowForcePush: 'leaseOnOwnBranch' }), 'leaseOnOwnBranch');
    assert.equal(resolveForcePushMode({ allowForcePush: true }), 'leaseOnOwnBranch');
    for (const v of [
      false,
      'never',
      'yes',
      'LeaseOnOwnBranch',
      1,
      null,
      undefined,
      {},
      [],
      'true',
    ]) {
      assert.equal(resolveForcePushMode({ allowForcePush: v }), 'never', String(v));
    }
    assert.equal(resolveForcePushMode(null), 'never');
    assert.equal(resolveForcePushMode(undefined), 'never');
    assert.equal(resolveForcePushMode('x'), 'never');
    assert.equal(resolveForcePushMode({}), 'never');
  });

  it('a preset never sets the force-push mode', () => {
    assert.equal(resolveForcePushMode({ preset: 'operator-trusted' }), 'never');
  });

  it('resolveGovernance keeps its shape; allowForcePush enum maps onto the boolean view', () => {
    const lease = resolveGovernance({ allowForcePush: 'leaseOnOwnBranch' });
    assert.equal(lease.allowForcePush, true);
    assert.deepEqual(Object.keys(lease).sort(), Object.keys(STRICT_DEFAULTS).sort());
    assert.equal(resolveGovernance({ allowForcePush: 'never' }).allowForcePush, false);
    assert.equal(resolveGovernance({ allowForcePush: 'bogus' }).allowForcePush, false);
  });

  it('parses the enum from YAML text', () => {
    const y = 'spec:\n  governance:\n    allowForcePush: leaseOnOwnBranch\n';
    assert.equal(resolveGovernanceFromYaml(y).allowForcePush, true);
    assert.equal(resolveGovernanceExtrasFromYaml(y).forcePushMode, 'leaseOnOwnBranch');
    const q = "spec:\n  governance:\n    allowForcePush: 'never'\n";
    assert.equal(resolveGovernanceExtrasFromYaml(q).forcePushMode, 'never');
  });

  it('absent governance / non-string yaml -> strict extras', () => {
    for (const y of ['spec:\n  role: x\n', '', undefined, null]) {
      assert.deepEqual(resolveGovernanceExtrasFromYaml(y), {
        forcePushMode: 'never',
        operational: [],
        protectedBranches: [],
      });
    }
  });
});

describe('resolver - operational list', () => {
  it('keeps known entries, drops unknown / non-string / duplicates, never throws', () => {
    assert.deepEqual(
      resolveOperational({
        operational: ['requeue', 'merge-anything', 7, null, {}, 'requeue', 'retrigger-ci'],
      }),
      ['requeue', 'retrigger-ci'],
    );
  });

  it('non-array values yield an empty list', () => {
    for (const v of ['requeue', 5, {}, null, undefined, true]) {
      assert.deepEqual(resolveOperational({ operational: v }), []);
    }
    assert.deepEqual(resolveOperational(null), []);
    assert.deepEqual(resolveOperational('x'), []);
  });

  it('parses block-list and inline-list YAML; unknown entries dropped', () => {
    const block =
      'spec:\n  governance:\n    operational:\n      - requeue\n      - "retrigger-ci"\n      - bogus # c\n    allowMerge: never\n';
    assert.deepEqual(resolveGovernanceExtrasFromYaml(block).operational, [
      'requeue',
      'retrigger-ci',
    ]);
    const inline =
      "spec:\n  governance:\n    operational: [requeue, 'clear-executor-context', nope]\n";
    assert.deepEqual(resolveGovernanceExtrasFromYaml(inline).operational, [
      'requeue',
      'clear-executor-context',
    ]);
    const scalar = 'spec:\n  governance:\n    operational: requeue\n';
    assert.deepEqual(resolveGovernanceExtrasFromYaml(scalar).operational, ['requeue']);
  });

  it('a list under a different governance key does not leak into operational', () => {
    const y = 'spec:\n  governance:\n    allowMerge: never\n    other:\n      - requeue\n';
    assert.deepEqual(resolveGovernanceExtrasFromYaml(y).operational, []);
  });

  it('operational does not alter any other resolved key', () => {
    const y = 'spec:\n  governance:\n    operational: [requeue]\n';
    assert.deepEqual(resolveGovernanceFromYaml(y), { ...STRICT_DEFAULTS });
  });
});

describe('resolver - protectedBranches', () => {
  it('keeps well-formed names, drops malformed, non-array -> []', () => {
    assert.deepEqual(
      resolveProtectedBranches({ protectedBranches: ['release/*', 'prod', 'bad name', 5, '$x'] }),
      ['release/*', 'prod'],
    );
    assert.deepEqual(resolveProtectedBranches({ protectedBranches: 'prod' }), []);
    assert.deepEqual(resolveProtectedBranches(null), []);
    assert.deepEqual(resolveProtectedBranches('x'), []);
  });

  it('parses from YAML', () => {
    const y = 'spec:\n  governance:\n    protectedBranches:\n      - release/*\n      - prod\n';
    assert.deepEqual(resolveGovernanceExtrasFromYaml(y).protectedBranches, ['release/*', 'prod']);
  });
});

describe('operator snippet (manual step) resolves cleanly', () => {
  it('resolves to leaseOnOwnBranch + all seven operational entries with no unknown keys or values', () => {
    const raw = parseGovernanceBlock(OPERATOR_SNIPPET);
    assert.deepEqual(Object.keys(raw).sort(), ['allowForcePush', 'operational']);
    assert.equal(raw.operational.length, ALL_OPS.length);
    const extras = resolveGovernanceExtrasFromYaml(OPERATOR_SNIPPET);
    assert.equal(extras.forcePushMode, 'leaseOnOwnBranch');
    // nothing dropped: resolved list equals the raw list
    assert.deepEqual(extras.operational, raw.operational);
    assert.deepEqual(extras.operational, ALL_OPS);
    assert.equal(resolveGovernanceFromYaml(OPERATOR_SNIPPET).allowMerge, 'never');
  });
});

describe('render text', () => {
  it('never/unset text is unchanged', () => {
    assert.match(renderSessionStartHardRules({ ...STRICT_DEFAULTS }), /\*\*NEVER force push\.\*\*/);
    assert.match(renderSubagentHardRules({ ...STRICT_DEFAULTS }), /\*\*Never force-push\*\*/);
  });

  it('lease text names the own-branch rule in both renderers', () => {
    const lease = resolveGovernanceFromYaml(OPERATOR_SNIPPET);
    for (const text of [renderSessionStartHardRules(lease), renderSubagentHardRules(lease)]) {
      assert.match(
        text,
        /force-with-lease permitted on this worktree's own branch only; never on main/,
      );
      assert.match(text, /allowForcePush: leaseOnOwnBranch/);
    }
  });

  it('operational rules render only for operator-dispatch with a non-empty list', () => {
    assert.match(renderOperationalRules(ALL_OPS, 'operator-dispatch'), /`requeue`/);
    assert.equal(renderOperationalRules(ALL_OPS, undefined), '');
    assert.equal(renderOperationalRules(ALL_OPS, 'executor'), '');
    assert.equal(renderOperationalRules(ALL_OPS, 'Operator-Dispatch'), '');
    assert.equal(renderOperationalRules([], 'operator-dispatch'), '');
    assert.equal(renderOperationalRules(undefined, 'operator-dispatch'), '');
  });
});

describe('hooks render the resolved policy', () => {
  let dir;
  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'gov-lease-render-'));
    mkdirSync(join(dir, '.ai-sdlc'), { recursive: true });
    writeFileSync(join(dir, '.ai-sdlc', 'agent-role.yaml'), OPERATOR_SNIPPET);
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  function runHook(script, input, role) {
    const env = { ...process.env, CLAUDE_PROJECT_DIR: dir };
    delete env.AI_SDLC_HIERARCHY_ROLE;
    delete env.CLAUDE_PLUGIN_ROOT;
    delete env.CLAUDE_PLUGIN_DIR;
    delete env.__AI_SDLC_INSTALL_RUNTIME_DEPS_ERROR;
    if (role) env.AI_SDLC_HIERARCHY_ROLE = role;
    const out = execFileSync('node', [join(__dirname, '..', script)], {
      input: JSON.stringify(input),
      encoding: 'utf-8',
      env,
      timeout: 15000,
    });
    return JSON.parse(out.trim()).hookSpecificOutput?.additionalContext ?? '';
  }

  const hooks = [
    ['session-start.js', { session_id: 's1' }],
    ['subagent-start.js', { hook_event_name: 'SubagentStart', agent_id: 'a1' }],
  ];
  for (const [script, input] of hooks) {
    it(`${script}: lease text, and operational list only for operator-dispatch`, () => {
      const plain = runHook(script, input);
      assert.match(plain, /own branch only; never on main/);
      assert.doesNotMatch(plain, /Operational actions granted/);
      const dispatch = runHook(script, input, 'operator-dispatch');
      assert.match(dispatch, /Operational actions granted to this dispatch role/);
      for (const op of ALL_OPS) assert.ok(dispatch.includes(`\`${op}\``), op);
      const other = runHook(script, input, 'executor');
      assert.doesNotMatch(other, /Operational actions granted/);
    });
  }
});

describe('resolver - comments and blank lines inside lists', () => {
  it('protectedBranches survives interleaved comments, blank lines and trailing comments', () => {
    const y =
      'spec:\n  governance:\n    protectedBranches:\n      - release/*\n      # keep prod\n\n      - prod # trailing\n  # dedented comment\n      - staging\n    allowMerge: never\n';
    assert.deepEqual(resolveGovernanceExtrasFromYaml(y).protectedBranches, [
      'release/*',
      'prod',
      'staging',
    ]);
  });

  it('operational survives interleaved comments, blank lines and trailing comments', () => {
    const y =
      'spec:\n  governance:\n    operational:\n      - requeue # a\n      # note\n\n      - retrigger-ci\n        # indented note\n      - clear-executor-context\n';
    assert.deepEqual(resolveGovernanceExtrasFromYaml(y).operational, [
      'requeue',
      'retrigger-ci',
      'clear-executor-context',
    ]);
  });

  it('a real following key still ends the list', () => {
    const y =
      'spec:\n  governance:\n    operational:\n      - requeue\n    allowMerge: never\n      - retrigger-ci\n';
    assert.deepEqual(resolveGovernanceExtrasFromYaml(y).operational, ['requeue']);
  });
});
