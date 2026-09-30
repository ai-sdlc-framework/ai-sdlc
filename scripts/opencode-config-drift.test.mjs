/**
 * Drift check: opencode.json's declarative permission denies vs
 * .ai-sdlc/agent-role.yaml (READ-ONLY; this test never writes to .ai-sdlc/).
 *
 * opencode.json carries a hand-maintained mirror of the agent-role.yaml
 * blockedActions / blockedPaths policy (see the header comment in
 * opencode.json: "Keep this section and .ai-sdlc/agent-role.yaml in sync").
 * Nothing enforced that until now. This test fails when either side gains a
 * rule the other lacks, except for the explicitly enumerated opencode-only
 * additions below.
 *
 * Run: node --test scripts/opencode-config-drift.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const yaml = readFileSync(join(REPO, '.ai-sdlc', 'agent-role.yaml'), 'utf-8');

/** opencode.json is JSONC; only full-line `//` comments are used in it. */
function readOpencodeJson() {
  const text = readFileSync(join(REPO, 'opencode.json'), 'utf-8')
    .split('\n')
    .filter((l) => !/^\s*\/\//.test(l))
    .join('\n');
  return JSON.parse(text);
}

function parseListField(text, field) {
  const items = [];
  let inSection = false;
  for (const line of text.split('\n')) {
    if (new RegExp(`^\\s*${field}:\\s*$`).test(line)) {
      inSection = true;
      continue;
    }
    if (!inSection) continue;
    if (/^[a-zA-Z]/.test(line) || /^\s{0,4}[a-zA-Z]+:\s*$/.test(line)) break;
    if (/^\s*$/.test(line) || /^\s*#/.test(line)) continue;
    const m = line.match(/^\s+-\s+['"]?(.+?)['"]?\s*$/);
    if (m) items.push(m[1]);
  }
  return items;
}

const cfg = readOpencodeJson();
const yamlActions = parseListField(yaml, 'blockedActions');
const yamlPaths = parseListField(yaml, 'blockedPaths');
const bashDenies = Object.entries(cfg.permission.bash)
  .filter(([, v]) => v === 'deny')
  .map(([k]) => k);
const editDenies = Object.entries(cfg.permission.edit)
  .filter(([, v]) => v === 'deny')
  .map(([k]) => k);

/**
 * opencode-only bash denies: governance the opencode layer adds on top of the
 * yaml (the stash guard is enforced by the legacy hook's hardcoded floor, not
 * listed in the yaml) plus the force-push lease-bypass defence in depth. The
 * plugin (.opencode/plugins/ai-sdlc-governance.js) is authoritative for all of
 * these; see the comments in opencode.json.
 */
const OPENCODE_ONLY_BASH = (pattern) => /^git stash /.test(pattern) || /^git push\*/.test(pattern);

/**
 * opencode-only edit denies that have NO counterpart in agent-role.yaml yet.
 *
 * TODO(operator): AISDLC-660 review item 11 asked for `opencode.json`,
 * `opencode.jsonc` and `.opencode/**` to ALSO be added to agent-role.yaml
 * blockedPaths. That file is under .ai-sdlc/** (agent-edit-forbidden), so the
 * developer agent declined; the operator owns that change. Until it lands
 * these are asserted as a KNOWN, enumerated gap rather than failing the test.
 * Once the operator adds them to the yaml, this list can be emptied (the test
 * keeps passing either way because it only checks opencode-only entries).
 */
const PENDING_YAML_BLOCKED_PATHS = new Set([
  'opencode.json',
  'opencode.jsonc',
  '**/opencode.json',
  '**/opencode.jsonc',
  '.opencode/**',
  '**/.opencode/**',
]);

/** Glob-spelling variants of a yaml path that opencode.json spells differently. */
const EQUIVALENT_EDIT_DENY = (pattern) =>
  pattern === '**/.ai-sdlc/**' && yamlPaths.includes('.ai-sdlc/**');

describe('opencode.json <-> .ai-sdlc/agent-role.yaml drift', () => {
  it('parses both sources (guards the parsers themselves)', () => {
    assert.ok(yamlActions.length >= 8, `expected blockedActions, got ${yamlActions.length}`);
    assert.ok(yamlPaths.length >= 2, `expected blockedPaths, got ${yamlPaths.length}`);
    assert.ok(bashDenies.length >= yamlActions.length);
    assert.ok(editDenies.length >= yamlPaths.length);
  });

  it('every yaml blockedAction is denied declaratively in opencode.json', () => {
    const missing = yamlActions.filter((a) => cfg.permission.bash[a] !== 'deny');
    assert.deepEqual(missing, [], `blockedActions missing from opencode.json permission.bash`);
  });

  it('every opencode.json bash deny is a yaml blockedAction or a known opencode-only addition', () => {
    const unexplained = bashDenies.filter(
      (p) => !yamlActions.includes(p) && !OPENCODE_ONLY_BASH(p),
    );
    assert.deepEqual(
      unexplained,
      [],
      `opencode.json denies not present in agent-role.yaml blockedActions`,
    );
  });

  it('every yaml blockedPath is denied declaratively in opencode.json', () => {
    const missing = yamlPaths.filter((p) => cfg.permission.edit[p] !== 'deny');
    assert.deepEqual(missing, [], `blockedPaths missing from opencode.json permission.edit`);
  });

  it('every opencode.json edit deny is a yaml blockedPath, a glob variant, or the enumerated pending set', () => {
    const unexplained = editDenies.filter(
      (p) =>
        !yamlPaths.includes(p) && !EQUIVALENT_EDIT_DENY(p) && !PENDING_YAML_BLOCKED_PATHS.has(p),
    );
    assert.deepEqual(unexplained, [], `opencode.json edit denies with no yaml counterpart`);
  });

  it('the harness-config denies are present in opencode.json (plugin floor mirror)', () => {
    for (const p of ['opencode.json', 'opencode.jsonc', '.opencode/**']) {
      assert.equal(cfg.permission.edit[p], 'deny', `${p} must be denied`);
    }
  });

  it('the force-with-lease allow is the only bash allow, and sits before its bypass re-denies', () => {
    const entries = Object.entries(cfg.permission.bash);
    const allows = entries.filter(([, v]) => v === 'allow').map(([k]) => k);
    assert.deepEqual(allows, ['git push --force-with-lease*']);
    const allowIdx = entries.findIndex(([k]) => k === 'git push --force-with-lease*');
    const secondForceIdx = entries.findIndex(([k]) => k === 'git push*--force *');
    assert.ok(
      secondForceIdx > allowIdx,
      'last-match-wins: the bypass denies must come AFTER the lease allow',
    );
  });
});
