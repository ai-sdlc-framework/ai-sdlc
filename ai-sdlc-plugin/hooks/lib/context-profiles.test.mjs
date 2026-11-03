/**
 * AISDLC-781: RFC-0053 context profiles.
 * Run with: node --test ai-sdlc-plugin/hooks/lib/context-profiles.test.mjs
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const {
  DEFAULT_PROFILES,
  parseConfig,
  validateConfig,
  resolveProfile,
  checkProfileChange,
} = require('./context-profiles.js');
const { loadProfile } = require('./context-surface.js');
const { buildFixedPrefix, renderFixedPrefix } = require('./fixed-prefix.js');

const shipped = readFileSync(
  join(here, '..', '..', '..', '.ai-sdlc', 'context-profiles.yaml'),
  'utf-8',
);
const clone = (o) => JSON.parse(JSON.stringify(o));
const base = () => ({ profiles: clone(DEFAULT_PROFILES), modelOverrides: {} });

describe('schema', () => {
  it('accepts the shipped file and it equals the defaults', () => {
    const cfg = parseConfig(shipped);
    assert.deepEqual(validateConfig(cfg), []);
    assert.deepEqual(cfg.profiles, DEFAULT_PROFILES);
  });
  it('rejects an unknown moment', () => {
    const c = base();
    c.profiles.planner.moments.push('everyKeystroke');
    assert.match(validateConfig(c).join('\n'), /unknown moment "everyKeystroke"/);
  });
  it('rejects a negative budget', () => {
    const c = base();
    c.profiles.executor.budget.taskClaim = -1;
    assert.match(validateConfig(c).join('\n'), /non-negative/);
  });
  it('rejects a floor outside 0 to 1', () => {
    for (const v of [-0.1, 1.5]) {
      const c = base();
      c.profiles.planner.minScore = v;
      assert.match(validateConfig(c).join('\n'), /between 0 and 1/);
    }
  });
  it('rejects unknown keys, a bad cap and unknown top-level keys', () => {
    const c = base();
    c.profiles.planner.controls = [];
    c.profiles.planner.maxInjectionsPerNTurns = { n: 0, max: 1 };
    c.prefix = {};
    const e = validateConfig(c).join('\n');
    assert.match(e, /unknown key "controls"/);
    assert.match(e, /maxInjectionsPerNTurns/);
    assert.match(e, /unknown top-level key "prefix"/);
  });
});

describe('shipped defaults match the OQ-8 role table', () => {
  const P = DEFAULT_PROFILES;
  it('planner: all moments at the largest budgets', () => {
    assert.equal(P.planner.moments.length, 6);
    for (const [role, p] of Object.entries(P))
      if (role !== 'planner')
        for (const [m, v] of Object.entries(p.budget)) assert.ok(P.planner.budget[m] >= v);
  });
  it('operator-dispatch: session start, task claim, compaction', () => {
    assert.deepEqual(P['operator-dispatch'].moments, ['sessionStart', 'taskClaim', 'compaction']);
  });
  it('executor: session start and task claim plus per-tool on governance paths', () => {
    assert.deepEqual(P.executor.moments, ['sessionStart', 'taskClaim', 'toolTouch']);
    assert.equal(P.executor.toolTouchPaths, 'governance-bearing');
    assert.ok(P.executor.budget.sessionStart <= P.planner.budget.sessionStart);
  });
  it('reviewer: task claim only', () => {
    assert.deepEqual(P.reviewer.moments, ['taskClaim']);
  });
  it('relay: session start only', () => {
    assert.deepEqual(P.relay.moments, ['sessionStart']);
  });
});

describe('role is primary, model alias overrides only named fields', () => {
  it('layers the alias over the role', () => {
    const c = base();
    c.modelOverrides.haiku = { minScore: 0.9, budget: { taskClaim: 100 } };
    const r = resolveProfile(c, 'executor', 'haiku');
    assert.equal(r.minScore, 0.9);
    assert.equal(r.budget.taskClaim, 100);
    assert.equal(r.budget.sessionStart, 1000);
    assert.deepEqual(r.moments, DEFAULT_PROFILES.executor.moments);
    assert.equal(r.toolTouchPaths, 'governance-bearing');
  });
  it('unknown alias or role', () => {
    assert.deepEqual(resolveProfile(base(), 'executor', 'nope'), DEFAULT_PROFILES.executor);
    assert.equal(resolveProfile(base(), 'ghost', 'haiku'), null);
  });
  it('parses modelOverrides from yaml', () => {
    const cfg = parseConfig(
      `${shipped.replace('modelOverrides: {}', '')}modelOverrides:\n  haiku:\n    minScore: 0.8\n`,
    );
    assert.equal(cfg.modelOverrides.haiku.minScore, 0.8);
    assert.deepEqual(validateConfig(cfg), []);
  });
});

describe('profiles cannot alter governance controls', () => {
  it('fixed prefix is identical under every profile', () => {
    const gov = 'spec:\n  governance:\n    allowMerge: never\n';
    const render = () =>
      renderFixedPrefix(buildFixedPrefix({ governanceYaml: gov, role: 'executor' }));
    const reference = render();
    for (const role of Object.keys(DEFAULT_PROFILES)) {
      const c = base();
      c.profiles[role].moments = [];
      assert.deepEqual(validateConfig(c), []);
      assert.equal(render(), reference);
    }
  });
  it('a profile has no field that could name a control', () => {
    for (const key of ['controls', 'prefix', 'governance', 'hardRules']) {
      const c = base();
      c.profiles.planner[key] = [];
      assert.match(validateConfig(c).join('\n'), new RegExp(`unknown key "${key}"`));
    }
  });
});

describe('asymmetric change path', () => {
  it('refuses adding a moment or raising a budget without a decision id', () => {
    const add = base();
    add.profiles.reviewer.moments.push('sessionStart');
    const r1 = checkProfileChange(base(), add);
    assert.equal(r1.ok, false);
    assert.match(r1.errors.join(), /decision-record id/);

    const raise = base();
    raise.profiles.executor.budget.taskClaim = 2000;
    assert.equal(checkProfileChange(base(), raise).ok, false);
    assert.equal(checkProfileChange(base(), raise, { decisionId: 'nope' }).ok, false);
    assert.equal(checkProfileChange(base(), raise, { decisionId: 'DEC-0300' }).ok, true);

    const floor = base();
    floor.profiles.planner.minScore = 0.1;
    assert.equal(checkProfileChange(base(), floor).ok, false);

    const added = base();
    added.profiles.newrole = { moments: ['taskClaim'] };
    assert.equal(checkProfileChange(base(), added).ok, false);
  });
  it('accepts removing a moment or lowering a budget with no id', () => {
    const c = base();
    c.profiles.planner.moments = c.profiles.planner.moments.filter((m) => m !== 'toolTouch');
    c.profiles.executor.budget.taskClaim = 500;
    const r = checkProfileChange(base(), c);
    assert.deepEqual(r, { ok: true, widening: [], errors: [] });
  });
  it('still refuses an invalid target even when narrowing', () => {
    const c = base();
    c.profiles.executor.budget.taskClaim = -5;
    assert.equal(checkProfileChange(base(), c).ok, false);
  });
});

describe('hooks read the active profile', () => {
  it('moment, budget and floor come from the file; model override applies; invalid file falls back', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ctx-prof-'));
    try {
      mkdirSync(join(dir, '.ai-sdlc'));
      const f = join(dir, '.ai-sdlc', 'context-profiles.yaml');
      writeFileSync(
        f,
        'profiles:\n  executor:\n    moments: [taskClaim]\n    budget: { taskClaim: 321 }\n    minScore: 0.7\nmodelOverrides:\n  haiku:\n    minScore: 0.9\n',
      );
      const p = loadProfile(dir, 'executor');
      assert.deepEqual(p.moments, ['taskClaim']);
      assert.equal(p.budget.taskClaim, 321);
      assert.equal(p.minScore, 0.7);
      assert.equal(loadProfile(dir, 'executor', 'haiku').minScore, 0.9);
      writeFileSync(f, 'profiles:\n  executor:\n    moments: [bogus]\n');
      assert.deepEqual(loadProfile(dir, 'executor').moments, DEFAULT_PROFILES.executor.moments);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
