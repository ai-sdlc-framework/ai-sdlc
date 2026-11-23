/**
 * Run with: node --test ai-sdlc-plugin/hooks/lib/fix-pr-head.test.mjs
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const require = createRequire(import.meta.url);
const { readFixPrHead } = require('./fix-pr-head.js');

describe('readFixPrHead (AISDLC-1363)', () => {
  let root;
  let inflight;
  const put = (m, name = 'AISDLC-1.dispatch.json') =>
    writeFileSync(join(inflight, name), typeof m === 'string' ? m : JSON.stringify(m));
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'fix-pr-head-'));
    inflight = join(root, '.ai-sdlc', 'dispatch', 'inflight');
    mkdirSync(inflight, { recursive: true });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('reads fixesPr and prHeadRef (task id case-insensitive)', () => {
    put({ id: 'AISDLC-1', fixesPr: 262, prHeadRef: 'ai-sdlc/acs-13-x' });
    assert.deepEqual(readFixPrHead(root, 'aisdlc-1'), {
      fixesPr: 262,
      prHeadRef: 'ai-sdlc/acs-13-x',
    });
  });

  it('returns null for missing, malformed or incomplete manifests', () => {
    assert.equal(readFixPrHead(root, 'aisdlc-1'), null);
    put('{not json');
    assert.equal(readFixPrHead(root, 'aisdlc-1'), null);
    put({ fixesPr: 262 });
    assert.equal(readFixPrHead(root, 'aisdlc-1'), null);
    put({ prHeadRef: 'x' });
    assert.equal(readFixPrHead(root, 'aisdlc-1'), null);
    put({ fixesPr: 'x', prHeadRef: 'x' });
    assert.equal(readFixPrHead(root, 'aisdlc-1'), null);
    put('null');
    assert.equal(readFixPrHead(root, 'aisdlc-1'), null);
  });

  it('returns null for a head in another repository', () => {
    put({ fixesPr: 1, prHeadRef: 'owner:branch' });
    assert.equal(readFixPrHead(root, 'aisdlc-1'), null);
    put({ fixesPr: 1, prHeadRef: 'b', isCrossRepository: true });
    assert.equal(readFixPrHead(root, 'aisdlc-1'), null);
  });

  it('returns null for a symlinked manifest, a bad task id or a bad root', () => {
    writeFileSync(join(root, 'real.json'), JSON.stringify({ fixesPr: 1, prHeadRef: 'b' }));
    symlinkSync(join(root, 'real.json'), join(inflight, 'AISDLC-1.dispatch.json'));
    assert.equal(readFixPrHead(root, 'aisdlc-1'), null);
    assert.equal(readFixPrHead(root, '../x'), null);
    assert.equal(readFixPrHead(root, null), null);
    assert.equal(readFixPrHead(null, 'aisdlc-1'), null);
  });
});
