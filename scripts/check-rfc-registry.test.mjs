import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  frontmatter,
  checkRegistry,
  applyFixes,
  bodyStatusOf,
  checkBodyStatus,
  BODY_STATUS_KNOWN,
  loadRfcs,
} from './check-rfc-registry.mjs';
import { statusOf, fixStatus } from './check-completed-status.mjs';

const rfc = {
  num: '0005',
  file: 'RFC-0005-x.md',
  title: 'X',
  status: 'Draft',
  lifecycle: 'Signed Off',
  author: 'A',
};
const readme = [
  '| 0004 | Y | a | Draft | 0 | A | [RFC-0004-y.md](RFC-0004-y.md) | n |',
  '| 0006 | Z | a | Draft | 0 | A | [RFC-0006-z.md](RFC-0006-z.md) | n |',
].join('\n');

test('frontmatter parses scalar keys', () => {
  assert.equal(frontmatter('---\nlifecycle: "Draft"\ntitle: T\n---\nbody').lifecycle, 'Draft');
  assert.deepEqual(frontmatter('no fm'), {});
});

test('missing row is reported and inserted in order', () => {
  const { lines, problems } = checkRegistry(readme, [rfc]);
  assert.equal(problems[0].kind, 'missing');
  const fixed = applyFixes(lines, problems);
  assert.match(fixed[1], /^\| 0005 \| X \| Draft \| Signed Off /);
  assert.equal(checkRegistry(fixed.join('\n'), [rfc]).problems.length, 0);
});

test('stale lifecycle is reported and rewritten', () => {
  const r = { ...rfc, num: '0004', file: 'RFC-0004-y.md', status: 'a', lifecycle: 'Implemented' };
  const { lines, problems } = checkRegistry(readme, [r]);
  assert.equal(problems[0].kind, 'stale');
  assert.equal(checkRegistry(applyFixes(lines, problems).join('\n'), [r]).problems.length, 0);
});

test('completed status helpers', () => {
  const t = '---\nid: A\nstatus: To Do\n---\nstatus: keep\n';
  assert.equal(statusOf(t), 'To Do');
  assert.equal(statusOf(fixStatus(t)), 'Done');
  assert.ok(fixStatus(t).endsWith('status: keep\n'));
  assert.equal(statusOf('none'), null);
});

test('stale Status cell is reported with both values and rewritten', () => {
  const r = {
    ...rfc,
    num: '0004',
    file: 'RFC-0004-y.md',
    status: 'Implemented',
    lifecycle: 'Draft',
  };
  const { lines, problems } = checkRegistry(readme, [r]);
  assert.equal(problems.length, 1);
  assert.equal(problems[0].kind, 'status');
  assert.equal(problems[0].current, 'a');
  assert.equal(problems[0].rfc.status, 'Implemented');
  assert.equal(checkRegistry(applyFixes(lines, problems).join('\n'), [r]).problems.length, 0);
});

test('body Status line: fails, passes by lifecycle or status, passes when absent', () => {
  const base = { num: '0099', status: 'Approved', lifecycle: 'Implemented' };
  const none = new Set();
  const bad = checkBodyStatus([{ ...base, bodyStatus: 'Draft v1' }], none);
  assert.equal(bad[0].kind, 'body');
  assert.equal(checkBodyStatus([{ ...base, bodyStatus: 'Implemented (v2)' }], none).length, 0);
  assert.equal(checkBodyStatus([{ ...base, bodyStatus: 'Approved' }], none).length, 0);
  assert.equal(checkBodyStatus([{ ...base, bodyStatus: null }], none).length, 0);
  assert.equal(bodyStatusOf('---\nstatus: X\n---\n**Status:** Foo bar\n'), 'Foo bar');
  assert.equal(bodyStatusOf('---\nstatus: X\n---\nnothing'), null);
});

test('BODY_STATUS_KNOWN entries must still fail; unknown failures are reported', () => {
  const ok = { num: '0017', status: 'A', lifecycle: 'A', bodyStatus: 'A' };
  assert.equal(checkBodyStatus([ok], new Set(['0017']))[0].kind, 'known-stale');
  const bad = { ...ok, bodyStatus: 'Z' };
  assert.equal(checkBodyStatus([bad], new Set(['0017'])).length, 0);
  const dir = join(dirname(fileURLToPath(import.meta.url)), '../spec/rfcs');
  assert.deepEqual(checkBodyStatus(loadRfcs(dir), BODY_STATUS_KNOWN), []);
});
