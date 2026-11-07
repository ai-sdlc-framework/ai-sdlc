import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  pickExisting,
  exportable,
  missingPermissionMessage,
  RULESET_FILE,
} from './apply-codeql-ruleset.mjs';

test('pickExisting matches by name', () => {
  assert.equal(pickExisting([{ name: 'a', id: 1 }], 'a').id, 1);
  assert.equal(pickExisting([{ name: 'a', id: 1 }], 'b'), undefined);
});

test('exportable strips server fields and defaults bypass_actors', () => {
  const out = exportable({
    id: 9,
    name: 'n',
    target: 'branch',
    enforcement: 'active',
    conditions: {},
    rules: [],
  });
  assert.deepEqual(Object.keys(out).sort(), [
    'bypass_actors',
    'conditions',
    'enforcement',
    'name',
    'rules',
    'target',
  ]);
  assert.deepEqual(out.bypass_actors, []);
});

test('missingPermissionMessage flags admin errors only', () => {
  assert.match(missingPermissionMessage('HTTP 403'), /Administration/);
  assert.equal(missingPermissionMessage('boom'), null);
});

test('ruleset file carries the CodeQL high-or-higher rule', () => {
  const r = JSON.parse(readFileSync(RULESET_FILE, 'utf8'));
  const tool = r.rules[0].parameters.code_scanning_tools[0];
  assert.equal(tool.tool, 'CodeQL');
  assert.equal(tool.security_alerts_threshold, 'high_or_higher');
});
