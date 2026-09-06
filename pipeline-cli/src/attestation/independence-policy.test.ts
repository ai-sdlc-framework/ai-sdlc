/**
 * Hermetic tests for RFC-0046 Phase 4 (AISDLC-591) — `requiredTier` policy
 * loading + gate-topology-agnostic enforcement.
 *
 * Covers:
 *   - tier ordering + shortfall detection
 *   - `requiredTier: none` (default) — no behavior change (regression guard)
 *   - `requiredTier: attested` — blocks on `none`, passes on `attested`/`isolated`
 *   - `requiredTier: isolated` — unsatisfiable while `isolatedTierAvailable()`
 *     is `false` (current state; AISDLC-597 will add the satisfiable case)
 *   - policy file loader (missing file, flat YAML parse, malformed value)
 *   - the SAME `evaluateIndependencePolicy()` call exercised from two call
 *     sites, simulating the branch-protection (`ai-sdlc/pr-ready`) and
 *     procedural-gate (ship-skill) enforcement surfaces — one comparison,
 *     two callers, per RFC-0046 §Rollout (OQ-5).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_INDEPENDENCE_POLICY,
  evaluateIndependencePolicy,
  INDEPENDENCE_TIER_ORDER,
  isolatedTierAvailable,
  loadIndependencePolicy,
  parseIndependencePolicyYaml,
  resolveIndependencePolicyPath,
  type IndependenceTier,
} from './independence-policy.js';

describe('INDEPENDENCE_TIER_ORDER — tier ordering', () => {
  it('orders none < attested < isolated', () => {
    expect(INDEPENDENCE_TIER_ORDER.none).toBeLessThan(INDEPENDENCE_TIER_ORDER.attested);
    expect(INDEPENDENCE_TIER_ORDER.attested).toBeLessThan(INDEPENDENCE_TIER_ORDER.isolated);
  });
});

describe('isolatedTierAvailable — capability switch (AISDLC-591 stub, AISDLC-597 flips)', () => {
  it('returns false — isolated tier producer not yet wired into policy enforcement', () => {
    expect(isolatedTierAvailable()).toBe(false);
  });
});

describe('loadIndependencePolicy — missing file defaults to none', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'aisdlc-591-policy-'));
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('resolves to requiredTier: none when .ai-sdlc/independence-policy.yaml is absent', () => {
    const policy = loadIndependencePolicy({ repoRoot: tmpRoot });
    expect(policy).toEqual(DEFAULT_INDEPENDENCE_POLICY);
    expect(policy.requiredTier).toBe('none');
  });

  it('resolveIndependencePolicyPath points at .ai-sdlc/independence-policy.yaml under repoRoot', () => {
    expect(resolveIndependencePolicyPath({ repoRoot: tmpRoot })).toBe(
      join(tmpRoot, '.ai-sdlc', 'independence-policy.yaml'),
    );
  });

  it('honors an explicit filePath override', () => {
    const explicitPath = join(tmpRoot, 'custom-policy.yaml');
    expect(resolveIndependencePolicyPath({ filePath: explicitPath })).toBe(explicitPath);
  });
});

describe('parseIndependencePolicyYaml — flat scalar parser', () => {
  it('parses requiredTier: attested', () => {
    expect(parseIndependencePolicyYaml('requiredTier: attested\n')).toEqual({
      requiredTier: 'attested',
    });
  });

  it('parses requiredTier: isolated', () => {
    expect(parseIndependencePolicyYaml('requiredTier: isolated\n')).toEqual({
      requiredTier: 'isolated',
    });
  });

  it('unwraps quoted values', () => {
    expect(parseIndependencePolicyYaml("requiredTier: 'attested'\n")).toEqual({
      requiredTier: 'attested',
    });
    expect(parseIndependencePolicyYaml('requiredTier: "attested"\n')).toEqual({
      requiredTier: 'attested',
    });
  });

  it('ignores comments and blank lines, defaults to none when key absent', () => {
    expect(parseIndependencePolicyYaml('# comment\n\n')).toEqual({ requiredTier: 'none' });
  });

  it('throws on an unrecognized requiredTier value (fail loud, not silent downgrade)', () => {
    expect(() => parseIndependencePolicyYaml('requiredTier: bogus\n')).toThrow(
      /invalid requiredTier/,
    );
  });
});

describe('loadIndependencePolicy — reads the on-disk file', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'aisdlc-591-policy-'));
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('reads requiredTier: attested from .ai-sdlc/independence-policy.yaml', () => {
    const dir = join(tmpRoot, '.ai-sdlc');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'independence-policy.yaml'), 'requiredTier: attested\n');
    expect(loadIndependencePolicy({ repoRoot: tmpRoot })).toEqual({ requiredTier: 'attested' });
  });
});

describe('evaluateIndependencePolicy — requiredTier: none (default, regression guard)', () => {
  it.each<IndependenceTier>(['none', 'attested', 'isolated'])(
    'always passes regardless of overallIndependenceTier=%s',
    (overallIndependenceTier) => {
      const outcome = evaluateIndependencePolicy({ requiredTier: 'none', overallIndependenceTier });
      expect(outcome.status).toBe('pass');
      expect(outcome.requiredTier).toBe('none');
      expect(outcome.overallIndependenceTier).toBe(overallIndependenceTier);
    },
  );
});

describe('evaluateIndependencePolicy — requiredTier: attested', () => {
  it('blocks (shortfall) when overallIndependenceTier is none', () => {
    const outcome = evaluateIndependencePolicy({
      requiredTier: 'attested',
      overallIndependenceTier: 'none',
    });
    expect(outcome.status).toBe('shortfall');
    expect(outcome.message).toMatch(/shortfall/);
  });

  it('passes when overallIndependenceTier is attested', () => {
    const outcome = evaluateIndependencePolicy({
      requiredTier: 'attested',
      overallIndependenceTier: 'attested',
    });
    expect(outcome.status).toBe('pass');
  });

  it('passes when overallIndependenceTier is isolated (strictly stronger)', () => {
    const outcome = evaluateIndependencePolicy({
      requiredTier: 'attested',
      overallIndependenceTier: 'isolated',
    });
    expect(outcome.status).toBe('pass');
  });
});

describe('evaluateIndependencePolicy — requiredTier: isolated (currently unsatisfiable)', () => {
  it('reports unsatisfiable even when overallIndependenceTier already claims isolated', () => {
    // AISDLC-597 will add the satisfiable case once isolatedTierAvailable()
    // flips true; until then, even a claimed 'isolated' envelope must NOT
    // be credited — a forged or stale claim must never satisfy an
    // unsatisfiable policy.
    const outcome = evaluateIndependencePolicy({
      requiredTier: 'isolated',
      overallIndependenceTier: 'isolated',
    });
    expect(outcome.status).toBe('unsatisfiable');
    expect(outcome.message).toMatch(/RFC-0047|AISDLC-597/);
  });

  it('reports unsatisfiable when overallIndependenceTier is none', () => {
    const outcome = evaluateIndependencePolicy({
      requiredTier: 'isolated',
      overallIndependenceTier: 'none',
    });
    expect(outcome.status).toBe('unsatisfiable');
  });
});

describe('gate-topology-agnostic enforcement — same comparison, two call sites', () => {
  // Simulates the `ai-sdlc/pr-ready` rollup job (branch-protection repos):
  // reads the policy, evaluates, and would fail the CI job on non-pass.
  function branchProtectionSurface(
    requiredTier: IndependenceTier,
    overallIndependenceTier: IndependenceTier,
  ): { blocked: boolean; outcome: ReturnType<typeof evaluateIndependencePolicy> } {
    const outcome = evaluateIndependencePolicy({ requiredTier, overallIndependenceTier });
    return { blocked: outcome.status !== 'pass', outcome };
  }

  // Simulates a ship-skill invocation for a procedural-gate adopter (no
  // branch protection, e.g. local-trades): same evaluator, different caller,
  // refusing to ship on non-pass instead of failing a CI check.
  function shipSkillSurface(
    requiredTier: IndependenceTier,
    overallIndependenceTier: IndependenceTier,
  ): { refuseShip: boolean; outcome: ReturnType<typeof evaluateIndependencePolicy> } {
    const outcome = evaluateIndependencePolicy({ requiredTier, overallIndependenceTier });
    return { refuseShip: outcome.status !== 'pass', outcome };
  }

  it('both surfaces agree: requiredTier=attested + overall=none → blocked/refused', () => {
    const ci = branchProtectionSurface('attested', 'none');
    const ship = shipSkillSurface('attested', 'none');
    expect(ci.blocked).toBe(true);
    expect(ship.refuseShip).toBe(true);
    expect(ci.outcome).toEqual(ship.outcome);
  });

  it('both surfaces agree: requiredTier=attested + overall=attested → allowed', () => {
    const ci = branchProtectionSurface('attested', 'attested');
    const ship = shipSkillSurface('attested', 'attested');
    expect(ci.blocked).toBe(false);
    expect(ship.refuseShip).toBe(false);
    expect(ci.outcome).toEqual(ship.outcome);
  });

  it('both surfaces agree: requiredTier=none → always allowed (default, no behavior change)', () => {
    const ci = branchProtectionSurface('none', 'none');
    const ship = shipSkillSurface('none', 'none');
    expect(ci.blocked).toBe(false);
    expect(ship.refuseShip).toBe(false);
  });

  it('both surfaces agree: requiredTier=isolated → always blocked/refused today', () => {
    const ci = branchProtectionSurface('isolated', 'isolated');
    const ship = shipSkillSurface('isolated', 'isolated');
    expect(ci.blocked).toBe(true);
    expect(ship.refuseShip).toBe(true);
    expect(ci.outcome.status).toBe('unsatisfiable');
    expect(ship.outcome.status).toBe('unsatisfiable');
  });
});
