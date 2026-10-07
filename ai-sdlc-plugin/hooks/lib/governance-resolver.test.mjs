/**
 * Tests for the AI-SDLC governance resolver (RFC-0048 Phase 1 / AISDLC-601).
 *
 * Run with: node --test ai-sdlc-plugin/hooks/lib/governance-resolver.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  UNTRUSTED_MARKER_FILE,
  findUntrustedMarker,
  STRICT_DEFAULTS,
  isUntrustedRun,
  parseGovernanceBlock,
  resolveGovernance,
  resolveGovernanceFromYaml,
  resolveForcePushMode,
  describeForcePushPolicyFromYaml,
  resolveMergeAuthors,
  resolveMergeAuthorsFromYaml,
  renderSessionStartHardRules,
  renderSubagentHardRules,
} from './governance-resolver.js';

describe('parseGovernanceBlock', () => {
  it('returns null when no governance section exists', () => {
    const yaml = `spec:\n  role: coding-agent\n  goal: fix bugs\n`;
    assert.equal(parseGovernanceBlock(yaml), null);
  });

  it('parses scalar keys under governance:', () => {
    const yaml = `spec:\n  governance:\n    allowMerge: onGreenClean\n    allowForcePush: false\n  role: coding-agent\n`;
    const raw = parseGovernanceBlock(yaml);
    assert.deepEqual(raw, { allowMerge: 'onGreenClean', allowForcePush: false });
  });

  it('parses a preset key', () => {
    const yaml = `spec:\n  governance:\n    preset: operator-trusted\n`;
    assert.deepEqual(parseGovernanceBlock(yaml), { preset: 'operator-trusted' });
  });

  it('stops the block at dedent (does not leak sibling keys)', () => {
    const yaml = `spec:\n  governance:\n    allowMerge: onGreenClean\n  role: coding-agent\n  goal: something\n`;
    const raw = parseGovernanceBlock(yaml);
    assert.deepEqual(raw, { allowMerge: 'onGreenClean' });
  });

  it('skips nested-map/list values (not part of this schema)', () => {
    const yaml = `spec:\n  governance:\n    allowMerge: onGreenClean\n    nested:\n      foo: bar\n`;
    const raw = parseGovernanceBlock(yaml);
    assert.equal(raw.allowMerge, 'onGreenClean');
    assert.equal(raw.nested, undefined);
  });
});

describe('resolveGovernance — strict defaults / absence', () => {
  it('resolves to strict defaults when rawGovernance is null', () => {
    assert.deepEqual(resolveGovernance(null), { ...STRICT_DEFAULTS });
  });

  it('resolves to strict defaults when rawGovernance is undefined', () => {
    assert.deepEqual(resolveGovernance(undefined), { ...STRICT_DEFAULTS });
  });

  it('resolves to strict defaults for an empty object', () => {
    assert.deepEqual(resolveGovernance({}), { ...STRICT_DEFAULTS });
  });
});

describe('resolveGovernance — granular keys', () => {
  it('honors an explicit allowMerge: onGreenClean', () => {
    const resolved = resolveGovernance({ allowMerge: 'onGreenClean' });
    assert.equal(resolved.allowMerge, 'onGreenClean');
    // AISDLC-710: unset allowForcePush keeps the leaseOnOwnBranch default.
    assert.equal(resolved.allowForcePush, true);
  });

  it('honors explicit boolean keys', () => {
    const resolved = resolveGovernance({
      allowForcePush: true,
      allowClosePrIssue: true,
      allowBranchDelete: true,
      allowResetHard: true,
    });
    assert.equal(resolved.allowForcePush, true);
    assert.equal(resolved.allowClosePrIssue, true);
    assert.equal(resolved.allowBranchDelete, true);
    assert.equal(resolved.allowResetHard, true);
    // allowMerge untouched -> stays strict
    assert.equal(resolved.allowMerge, 'never');
  });
});

describe('resolveGovernance — operator-trusted preset (OQ-5)', () => {
  it('expands operator-trusted to allowMerge: onGreenClean, rest strict', () => {
    const resolved = resolveGovernance({ preset: 'operator-trusted' });
    assert.deepEqual(resolved, {
      allowMerge: 'onGreenClean',
      allowForcePush: true, // AISDLC-710 default (leaseOnOwnBranch), presets never touch it
      allowClosePrIssue: false,
      allowBranchDelete: false,
      allowResetHard: false,
    });
  });

  it('strict preset is a no-op (identical to defaults)', () => {
    assert.deepEqual(resolveGovernance({ preset: 'strict' }), { ...STRICT_DEFAULTS });
  });

  it('explicit granular keys override the preset', () => {
    const resolved = resolveGovernance({ preset: 'operator-trusted', allowMerge: 'never' });
    assert.equal(resolved.allowMerge, 'never');
  });

  it('a preset cannot set anything the granular schema could not (no unknown fields leak through)', () => {
    const resolved = resolveGovernance({ preset: 'operator-trusted' });
    const keys = Object.keys(resolved).sort();
    assert.deepEqual(keys, Object.keys(STRICT_DEFAULTS).sort());
  });
});

describe('resolveGovernance — fail-closed on malformed/unknown values', () => {
  it('ignores an unknown preset name (fails closed to strict)', () => {
    assert.deepEqual(resolveGovernance({ preset: 'yolo-mode' }), { ...STRICT_DEFAULTS });
  });

  it('ignores a malformed allowMerge value (fails closed to strict)', () => {
    const resolved = resolveGovernance({ allowMerge: 'always' });
    assert.equal(resolved.allowMerge, 'never');
  });

  it('ignores a non-boolean value for a boolean key (fails closed to strict)', () => {
    const resolved = resolveGovernance({ allowForcePush: 'yes' });
    assert.equal(resolved.allowForcePush, false);
  });

  it('ignores unknown keys entirely (no crash, no leak into resolved shape)', () => {
    const resolved = resolveGovernance({ someRandomKey: 'whatever' });
    assert.deepEqual(resolved, { ...STRICT_DEFAULTS });
    assert.equal(resolved.someRandomKey, undefined);
  });

  it('malformed allowMerge does not defeat a valid preset expansion', () => {
    const resolved = resolveGovernance({ preset: 'operator-trusted', allowMerge: 'always' });
    // malformed override ignored -> preset's onGreenClean survives
    assert.equal(resolved.allowMerge, 'onGreenClean');
  });
});

describe('resolveGovernanceFromYaml', () => {
  it('resolves strict defaults from real agent-role.yaml text with no governance section', () => {
    const yaml = `spec:\n  role: coding-agent\n  blockedActions:\n    - 'gh pr merge*'\n`;
    assert.deepEqual(resolveGovernanceFromYaml(yaml), { ...STRICT_DEFAULTS });
  });

  it('resolves onGreenClean from real agent-role.yaml text via the granular key', () => {
    const yaml = `spec:\n  governance:\n    allowMerge: onGreenClean\n  role: coding-agent\n`;
    assert.equal(resolveGovernanceFromYaml(yaml).allowMerge, 'onGreenClean');
  });

  it('resolves onGreenClean from real agent-role.yaml text via the operator-trusted preset', () => {
    const yaml = `spec:\n  governance:\n    preset: operator-trusted\n  role: coding-agent\n`;
    assert.equal(resolveGovernanceFromYaml(yaml).allowMerge, 'onGreenClean');
  });
});

describe('renderSessionStartHardRules', () => {
  it('renders the never-merge banner by default, naming the configuration key', () => {
    const text = renderSessionStartHardRules({ ...STRICT_DEFAULTS, allowForcePush: false });
    const lines = text.split('\n');
    assert.equal(lines.length, 3);
    assert.match(lines[0], /this repository's configuration forbids agent merges/);
    assert.match(lines[0], /governance\.allowMerge: never/);
    assert.match(lines[0], /\.ai-sdlc\/agent-role\.yaml/);
    assert.doesNotMatch(text, /only humans merge/i);
    assert.equal(lines[1], '**NEVER close issues or PRs.**');
    assert.equal(lines[2], '**NEVER force push.**');
  });

  it('renders the helper path under onGreenClean with no humans-only sentence (AISDLC-753)', () => {
    const text = renderSessionStartHardRules({
      ...STRICT_DEFAULTS,
      allowForcePush: false,
      allowMerge: 'onGreenClean',
    });
    assert.match(
      text,
      /node pipeline-cli\/bin\/cli-merge-if-eligible\.mjs <pr> --source-kind backlog \[--arm\]/,
    );
    assert.doesNotMatch(text, /only humans merge|human to merge|human to click merge/i);
    assert.doesNotMatch(text, /forbids agent merges/);
  });

  it('softens the merge line under onGreenClean', () => {
    const text = renderSessionStartHardRules({
      ...STRICT_DEFAULTS,
      allowForcePush: false,
      allowMerge: 'onGreenClean',
    });
    assert.match(text, /mergeStateStatus == CLEAN/);
    assert.doesNotMatch(text, /NEVER merge PRs/);
    assert.doesNotMatch(text, /forbids agent merges/);
    // Other two lines stay strict.
    assert.match(text, /NEVER close issues or PRs/);
    assert.match(text, /NEVER force push/);
  });
});

describe('renderSubagentHardRules', () => {
  it('renders the strict five-bullet list by default', () => {
    const text = renderSubagentHardRules({ ...STRICT_DEFAULTS, allowForcePush: false });
    assert.match(text, /configuration forbids agent merges/);
    assert.match(text, /governance\.allowMerge: never/);
    assert.doesNotMatch(text, /only humans merge/i);
    assert.match(text, /Never force-push/);
    assert.match(text, /Never close PRs or issues/);
    assert.match(text, /Never delete branches/);
    assert.match(text, /Never run destructive git/);
  });

  it('softens only the merge bullet under onGreenClean, leaves the other four strict', () => {
    const text = renderSubagentHardRules({
      ...STRICT_DEFAULTS,
      allowForcePush: false,
      allowMerge: 'onGreenClean',
    });
    assert.match(text, /mergeStateStatus == CLEAN/);
    assert.match(text, /cli-merge-if-eligible\.mjs <pr> --source-kind backlog \[--arm\]/);
    assert.doesNotMatch(text, /forbids agent merges/);
    assert.doesNotMatch(text, /only humans merge/i);
    assert.match(text, /Never force-push/);
    assert.match(text, /Never close PRs or issues/);
    assert.match(text, /Never delete branches/);
    assert.match(text, /Never run destructive git/);
  });

  it('softens the force-push bullet when allowForcePush is true', () => {
    const text = renderSubagentHardRules({ ...STRICT_DEFAULTS, allowForcePush: true });
    assert.doesNotMatch(text, /Never force-push/);
    assert.match(text, /Force-push is allowed per repo policy/);
  });
});

describe('allowForcePush default (AISDLC-710)', () => {
  it('the default is leaseOnOwnBranch, explicit settings win, malformed fails closed to never', () => {
    assert.equal(STRICT_DEFAULTS.allowForcePush, true);
    assert.equal(resolveForcePushMode(null), 'leaseOnOwnBranch');
    assert.equal(resolveForcePushMode({}), 'leaseOnOwnBranch');
    assert.equal(resolveForcePushMode({ preset: 'operator-trusted' }), 'leaseOnOwnBranch');
    assert.equal(resolveForcePushMode({ allowForcePush: 'leaseOnOwnBranch' }), 'leaseOnOwnBranch');
    assert.equal(resolveForcePushMode({ allowForcePush: true }), 'leaseOnOwnBranch');
    assert.equal(resolveForcePushMode({ allowForcePush: 'never' }), 'never');
    assert.equal(resolveForcePushMode({ allowForcePush: false }), 'never');
    for (const bad of ['yes', 'Never', 'always', '', 1, 0, null, [], {}]) {
      assert.equal(resolveForcePushMode({ allowForcePush: bad }), 'never', `bad=${String(bad)}`);
    }
  });

  it('text with no governance block, or no allowForcePush key, resolves to the default', () => {
    assert.equal(resolveGovernanceFromYaml('spec:\n  role: x\n').allowForcePush, true);
    const noKey = 'spec:\n  governance:\n    allowMerge: never\n';
    assert.equal(resolveGovernanceFromYaml(noKey).allowForcePush, true);
    assert.deepEqual(describeForcePushPolicyFromYaml(noKey), {
      mode: 'leaseOnOwnBranch',
      source: 'default',
      raw: undefined,
    });
    assert.equal(describeForcePushPolicyFromYaml('').source, 'default');
  });

  it('explicit never / false in yaml text still resolves to never (explicit wins)', () => {
    for (const v of ['never', 'false', '"never"']) {
      const yaml = `spec:\n  governance:\n    allowForcePush: ${v}\n`;
      assert.equal(resolveGovernanceFromYaml(yaml).allowForcePush, false, v);
      const d = describeForcePushPolicyFromYaml(yaml);
      assert.equal(d.mode, 'never');
      assert.equal(d.source, 'explicit');
    }
  });

  it('a present-but-empty or garbage value fails closed to never', () => {
    for (const v of ['', 'sure', 'leaseonownbranch']) {
      const yaml = `spec:\n  governance:\n    allowForcePush: ${v}\n    allowMerge: never\n`;
      assert.equal(resolveGovernanceFromYaml(yaml).allowForcePush, false, `v=${v}`);
      assert.equal(describeForcePushPolicyFromYaml(yaml).source, 'malformed', `v=${v}`);
    }
  });

  it('a governance key with an unparseable inline value fails closed (never the default)', () => {
    for (const head of ['governance: {allowForcePush: never}', 'governance: *anchor']) {
      const yaml = `spec:\n  ${head}\n    allowForcePush: leaseOnOwnBranch\n`;
      assert.equal(resolveGovernanceFromYaml(yaml).allowForcePush, false, head);
      assert.equal(describeForcePushPolicyFromYaml(yaml).source, 'malformed', head);
    }
  });

  it('a trailing comment after the governance key is parsed normally', () => {
    const yaml = 'spec:\n  governance:   # note\n    allowForcePush: never\n';
    assert.equal(describeForcePushPolicyFromYaml(yaml).source, 'explicit');
    assert.equal(
      describeForcePushPolicyFromYaml('spec:\n  governance: # note\n    allowMerge: never\n')
        .source,
      'default',
    );
  });
});

describe('resolveMergeAuthors (merge-if-eligible allow-list)', () => {
  it('is empty when absent, null or not an array (fail closed)', () => {
    assert.deepEqual(resolveMergeAuthors(null), []);
    assert.deepEqual(resolveMergeAuthors({}), []);
    assert.deepEqual(resolveMergeAuthors({ mergeAuthors: 'octocat' }), []);
    assert.deepEqual(resolveMergeAuthorsFromYaml('spec:\n  role: x\n'), []);
    assert.deepEqual(resolveMergeAuthorsFromYaml(undefined), []);
  });

  it('reads a block list and an inline list from the governance block', () => {
    const block = 'spec:\n  governance:\n    mergeAuthors:\n      - octocat\n      - "Hub-Bot9"\n';
    assert.deepEqual(resolveMergeAuthorsFromYaml(block), ['octocat', 'Hub-Bot9']);
    const inline = 'spec:\n  governance:\n    mergeAuthors: [octocat, other-user]\n';
    assert.deepEqual(resolveMergeAuthorsFromYaml(inline), ['octocat', 'other-user']);
  });

  it('drops malformed logins and case-insensitive duplicates', () => {
    const list = resolveMergeAuthors({
      mergeAuthors: [
        'ok',
        'OK',
        '-bad',
        'bad-',
        'a--b',
        'has space',
        'x[bot]',
        42,
        '',
        'a'.repeat(40),
      ],
    });
    assert.deepEqual(list, ['ok']);
  });

  it('does not change the resolved governance shape', () => {
    const yaml =
      'spec:\n  governance:\n    allowMerge: onGreenClean\n    mergeAuthors: [octocat]\n';
    assert.deepEqual(resolveGovernanceFromYaml(yaml), {
      ...STRICT_DEFAULTS,
      allowMerge: 'onGreenClean',
    });
  });
});

describe('isUntrustedRun (AISDLC-720)', () => {
  it('defaults to internal with no signal', () => {
    assert.deepEqual(isUntrustedRun({}), { untrusted: false, reason: '' });
  });
  it('is untrusted only for truthy values, and carries the reason', () => {
    for (const v of ['1', 'true', 'YES', ' on ']) {
      assert.equal(isUntrustedRun({ AI_SDLC_UNTRUSTED_RUN: v }).untrusted, true, v);
    }
    for (const v of ['0', 'false', 'No', 'OFF', '', '  ']) {
      assert.equal(isUntrustedRun({ AI_SDLC_UNTRUSTED_RUN: v }).untrusted, false, v);
    }
    // Fail closed: unknown non-empty values are untrusted.
    for (const v of ['maybe', 'enabled', '2', 'tru']) {
      assert.equal(isUntrustedRun({ AI_SDLC_UNTRUSTED_RUN: v }).untrusted, true, v);
    }
    assert.equal(
      isUntrustedRun({ AI_SDLC_UNTRUSTED_RUN: '1', AI_SDLC_UNTRUSTED_REASON: 'fork PR' }).reason,
      'fork PR',
    );
  });
  it('AISDLC-720(a): GITHUB_ACTIONS with no internal marker is untrusted', () => {
    const r = isUntrustedRun({ GITHUB_ACTIONS: 'true' });
    assert.equal(r.untrusted, true);
    assert.match(r.reason, /GitHub Actions/);
    // an explicit falsy untrusted signal is not an internal marker
    assert.equal(
      isUntrustedRun({ GITHUB_ACTIONS: 'true', AI_SDLC_UNTRUSTED_RUN: '0' }).untrusted,
      true,
    );
    assert.equal(
      isUntrustedRun({ GITHUB_ACTIONS: 'true', AI_SDLC_INTERNAL_RUN: '0' }).untrusted,
      true,
    );
  });
  it('AISDLC-720(a): an explicit internal marker trusts a CI run; the untrusted signal still wins', () => {
    assert.equal(
      isUntrustedRun({ GITHUB_ACTIONS: 'true', AI_SDLC_INTERNAL_RUN: '1' }).untrusted,
      false,
    );
    assert.equal(
      isUntrustedRun({
        GITHUB_ACTIONS: 'true',
        AI_SDLC_INTERNAL_RUN: '1',
        AI_SDLC_UNTRUSTED_RUN: '1',
      }).untrusted,
      true,
    );
  });
  it('AISDLC-720(a): a local run with no signal stays internal, even with an internal marker absent', () => {
    assert.equal(isUntrustedRun({}).untrusted, false);
    assert.equal(isUntrustedRun({ GITHUB_ACTIONS: '' }).untrusted, false);
    assert.equal(isUntrustedRun({ GITHUB_ACTIONS: 'false' }).untrusted, false);
  });
});

describe('AISDLC-730: untrusted marker file', () => {
  const mk = () => mkdtempSync(join(tmpdir(), 'aisdlc-730-'));
  it('marker in a .git dir marks every cwd below it untrusted, with no env signal', () => {
    const d = mk();
    try {
      mkdirSync(join(d, '.git'));
      mkdirSync(join(d, 'a', 'b'), { recursive: true });
      assert.equal(isUntrustedRun({}, join(d, 'a', 'b')).untrusted, false);
      writeFileSync(join(d, '.git', UNTRUSTED_MARKER_FILE), 'rework-pr source\n');
      const r = isUntrustedRun({}, join(d, 'a', 'b'));
      assert.equal(r.untrusted, true);
      assert.match(r.reason, /rework-pr source/);
      assert.equal(findUntrustedMarker(join(d, 'a')), 'rework-pr source');
      // an explicit internal marker or a falsy env signal cannot override the file
      assert.equal(
        isUntrustedRun({ AI_SDLC_UNTRUSTED_RUN: '0', AI_SDLC_INTERNAL_RUN: '1' }, d).untrusted,
        true,
      );
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
  it('follows a gitdir file (linked worktree) and fails closed on an unreadable marker', () => {
    const d = mk();
    try {
      mkdirSync(join(d, 'gd'));
      mkdirSync(join(d, 'wt'));
      writeFileSync(join(d, 'wt', '.git'), `gitdir: ${join(d, 'gd')}\n`);
      assert.equal(findUntrustedMarker(join(d, 'wt')), null);
      writeFileSync(join(d, 'gd', UNTRUSTED_MARKER_FILE), '');
      assert.equal(findUntrustedMarker(join(d, 'wt')), 'marker');
      rmSync(join(d, 'gd', UNTRUSTED_MARKER_FILE));
      mkdirSync(join(d, 'gd', UNTRUSTED_MARKER_FILE)); // a directory: read fails with EISDIR
      assert.equal(isUntrustedRun({}, join(d, 'wt')).untrusted, true);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
  it('collects markers from EVERY enclosing .git, not only the nearest', () => {
    const d = mk();
    try {
      mkdirSync(join(d, '.git'));
      writeFileSync(join(d, '.git', UNTRUSTED_MARKER_FILE), 'outer\n');
      mkdirSync(join(d, 'x', '.git'), { recursive: true }); // `git init x && cd x`
      assert.equal(findUntrustedMarker(join(d, 'x')), 'outer');
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
  it('a .git pointer to a missing gitdir is inconclusive (never untrusted by itself)', () => {
    const d = mk();
    try {
      mkdirSync(join(d, 'wt'));
      writeFileSync(join(d, 'wt', '.git'), `gitdir: ${join(d, 'gone')}\n`);
      assert.equal(findUntrustedMarker(join(d, 'wt')), null);
      assert.equal(isUntrustedRun({}, join(d, 'wt')).untrusted, false);
      writeFileSync(join(d, 'wt', '.git'), 'garbage');
      assert.equal(findUntrustedMarker(join(d, 'wt')), null);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
  it('recovers the marker of a worktree whose .git pointer was overwritten, via git back-pointer', () => {
    const d = mk();
    try {
      const admin = join(d, '.git', 'worktrees', 'w1');
      mkdirSync(admin, { recursive: true });
      mkdirSync(join(d, '.worktrees', 'w1'), { recursive: true });
      const ptr = join(d, '.worktrees', 'w1', '.git');
      writeFileSync(join(admin, 'gitdir'), `${ptr}\n`);
      writeFileSync(join(admin, UNTRUSTED_MARKER_FILE), 'rework-pr source\n');
      writeFileSync(ptr, `gitdir: ${join(d, 'nonexistent')}\n`);
      assert.equal(findUntrustedMarker(join(d, '.worktrees', 'w1')), 'rework-pr source');
      // a different worktree with a broken pointer is NOT marked
      mkdirSync(join(d, '.worktrees', 'w2'), { recursive: true });
      writeFileSync(join(d, '.worktrees', 'w2', '.git'), `gitdir: ${join(d, 'nonexistent')}\n`);
      assert.equal(findUntrustedMarker(join(d, '.worktrees', 'w2')), null);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
  it('no cwd or no checkout means no marker', () => {
    assert.equal(findUntrustedMarker(null), null);
    assert.equal(isUntrustedRun({}).untrusted, false);
  });
});
