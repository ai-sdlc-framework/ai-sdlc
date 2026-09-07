/**
 * Tests for the AI-SDLC governance resolver (RFC-0048 Phase 1 / AISDLC-601).
 *
 * Run with: node --test ai-sdlc-plugin/hooks/lib/governance-resolver.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  STRICT_DEFAULTS,
  parseGovernanceBlock,
  resolveGovernance,
  resolveGovernanceFromYaml,
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
    assert.equal(resolved.allowForcePush, false);
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
      allowForcePush: false,
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
  it('renders the strict three-line banner by default', () => {
    const text = renderSessionStartHardRules({ ...STRICT_DEFAULTS });
    assert.equal(
      text,
      '**NEVER merge PRs. Only humans merge.**\n**NEVER close issues or PRs.**\n**NEVER force push.**',
    );
  });

  it('softens the merge line under onGreenClean', () => {
    const text = renderSessionStartHardRules({ ...STRICT_DEFAULTS, allowMerge: 'onGreenClean' });
    assert.match(text, /mergeStateStatus == CLEAN/);
    assert.doesNotMatch(text, /NEVER merge PRs/);
    // Other two lines stay strict.
    assert.match(text, /NEVER close issues or PRs/);
    assert.match(text, /NEVER force push/);
  });
});

describe('renderSubagentHardRules', () => {
  it('renders the strict five-bullet list by default', () => {
    const text = renderSubagentHardRules({ ...STRICT_DEFAULTS });
    assert.match(text, /Never merge PRs/);
    assert.match(text, /Never force-push/);
    assert.match(text, /Never close PRs or issues/);
    assert.match(text, /Never delete branches/);
    assert.match(text, /Never run destructive git/);
  });

  it('softens only the merge bullet under onGreenClean, leaves the other four strict', () => {
    const text = renderSubagentHardRules({ ...STRICT_DEFAULTS, allowMerge: 'onGreenClean' });
    assert.match(text, /mergeStateStatus == CLEAN/);
    assert.doesNotMatch(text, /Never merge PRs/);
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
