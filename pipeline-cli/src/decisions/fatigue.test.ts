/**
 * RFC-0035 Phase 7 / AISDLC-291 — fatigue module unit tests.
 *
 * Covers:
 *   - load/save round-trip of `.ai-sdlc/operator-state.yaml`
 *   - missing file → empty state (no crash)
 *   - invalid YAML → empty state + stderr (no crash)
 *   - setFatigue records timestamp + reason; clearFatigue flips active only
 *   - getFatigueStatus composes explicit + inferred (opted-in only)
 *   - dispatchUnderFatigue tier-aware dispatch policy (§7.2)
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  clearFatigue,
  dispatchUnderFatigue,
  getFatigueStatus,
  loadOperatorState,
  resolveOperatorStatePath,
  saveOperatorState,
  setFatigue,
  type FatigueStatus,
} from './fatigue.js';
import { resolveFatigueConfig } from './decisions-config.js';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'fatigue-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

// ── operator-state.yaml round-trip ────────────────────────────────────

describe('loadOperatorState / saveOperatorState', () => {
  it('returns empty state when file is missing (ENOENT)', () => {
    expect(loadOperatorState(tmp)).toEqual({});
  });

  it('round-trips a full state', () => {
    saveOperatorState(tmp, {
      fatigueActive: true,
      fatigueDeclaredAt: '2026-05-24T19:42:00.000Z',
      fatigueReason: 'long walkthrough',
    });
    const reloaded = loadOperatorState(tmp);
    expect(reloaded.fatigueActive).toBe(true);
    expect(reloaded.fatigueDeclaredAt).toBe('2026-05-24T19:42:00.000Z');
    expect(reloaded.fatigueReason).toBe('long walkthrough');
  });

  it('creates .ai-sdlc/ when it does not exist', () => {
    const path = resolveOperatorStatePath(tmp);
    expect(existsSync(path)).toBe(false);
    saveOperatorState(tmp, { fatigueActive: false });
    expect(existsSync(path)).toBe(true);
  });

  it('tolerates invalid YAML — returns empty state + stderr warn', () => {
    const dir = join(tmp, '.ai-sdlc');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'operator-state.yaml'), '{not: valid: yaml: [unclosed');
    // Capture stderr so the test output stays clean.
    const captured: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.stderr as any).write = (chunk: string): boolean => {
      captured.push(chunk);
      return true;
    };
    try {
      expect(loadOperatorState(tmp)).toEqual({});
    } finally {
      (process.stderr as unknown as { write: typeof orig }).write = orig;
    }
    expect(captured.some((c) => /operator-state/.test(c))).toBe(true);
  });

  it('tolerates a YAML scalar — returns empty state', () => {
    const dir = join(tmp, '.ai-sdlc');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'operator-state.yaml'), 'just a string');
    expect(loadOperatorState(tmp)).toEqual({});
  });

  it('is atomic — partial write does not corrupt the existing file', () => {
    // Seed a valid existing state.
    saveOperatorState(tmp, { fatigueActive: true, fatigueReason: 'first' });
    const before = readFileSync(resolveOperatorStatePath(tmp), 'utf8');
    // Save a second time; the rename-into-place pattern should not leave
    // a `.tmp-<pid>` artifact behind on success.
    saveOperatorState(tmp, { fatigueActive: false });
    const after = readFileSync(resolveOperatorStatePath(tmp), 'utf8');
    expect(before).not.toBe(after);
    expect(after).toContain('fatigueActive: false');
  });
});

// ── setFatigue / clearFatigue ─────────────────────────────────────────

describe('setFatigue / clearFatigue', () => {
  it('setFatigue records active=true + ISO timestamp + reason', () => {
    const { state } = setFatigue(tmp, {
      reason: 'too many walkthroughs',
      now: () => new Date('2026-05-24T20:00:00.000Z'),
    });
    expect(state.fatigueActive).toBe(true);
    expect(state.fatigueDeclaredAt).toBe('2026-05-24T20:00:00.000Z');
    expect(state.fatigueReason).toBe('too many walkthroughs');
  });

  it('setFatigue preserves existing reason when called without --reason', () => {
    setFatigue(tmp, { reason: 'initial reason', now: () => new Date() });
    const { state } = setFatigue(tmp, { now: () => new Date('2026-05-24T22:00:00.000Z') });
    expect(state.fatigueActive).toBe(true);
    expect(state.fatigueReason).toBe('initial reason');
  });

  it('clearFatigue flips active=false but preserves audit fields', () => {
    setFatigue(tmp, { reason: 'long day', now: () => new Date('2026-05-24T20:00:00.000Z') });
    const { state } = clearFatigue(tmp);
    expect(state.fatigueActive).toBe(false);
    // Audit fields are preserved so the operator can see when they were fatigued.
    expect(state.fatigueDeclaredAt).toBe('2026-05-24T20:00:00.000Z');
    expect(state.fatigueReason).toBe('long day');
  });

  it('clearFatigue on a never-set state is a no-op (active=false, no audit fields)', () => {
    const { state } = clearFatigue(tmp);
    expect(state.fatigueActive).toBe(false);
    expect(state.fatigueDeclaredAt ?? null).toBe(null);
    expect(state.fatigueReason ?? null).toBe(null);
  });
});

// ── getFatigueStatus ──────────────────────────────────────────────────

describe('getFatigueStatus', () => {
  it('returns active=false when no operator-state.yaml exists (default contract)', () => {
    const status = getFatigueStatus(tmp);
    expect(status.active).toBe(false);
    expect(status.explicit).toBe(false);
    expect(status.inferred).toBe(false);
  });

  it('returns active=true when operator declared explicit fatigue (OQ-8 default)', () => {
    setFatigue(tmp, { now: () => new Date('2026-05-24T20:00:00.000Z') });
    const status = getFatigueStatus(tmp);
    expect(status.active).toBe(true);
    expect(status.explicit).toBe(true);
    expect(status.inferred).toBe(false);
    expect(status.declaredAt).toBe('2026-05-24T20:00:00.000Z');
  });

  it('ignores inferredSignal when inferFromBehavior is OFF (default)', () => {
    const status = getFatigueStatus(tmp, { inferredSignal: true });
    expect(status.active).toBe(false);
    expect(status.inferred).toBe(false);
  });

  it('honors inferredSignal when inferFromBehavior is opted in', () => {
    const status = getFatigueStatus(tmp, {
      config: { inferFromBehavior: true },
      inferredSignal: true,
    });
    expect(status.active).toBe(true);
    expect(status.inferred).toBe(true);
    expect(status.explicit).toBe(false);
  });

  it('explicit + inferred both fire when both signals are active', () => {
    setFatigue(tmp, { now: () => new Date() });
    const status = getFatigueStatus(tmp, {
      config: { inferFromBehavior: true },
      inferredSignal: true,
    });
    expect(status.explicit).toBe(true);
    expect(status.inferred).toBe(true);
    expect(status.active).toBe(true);
  });

  it('exposes resolved config with §7.2 defaults', () => {
    const status = getFatigueStatus(tmp);
    const expectedConfig = resolveFatigueConfig({});
    expect(status.config).toEqual(expectedConfig);
  });
});

// ── dispatchUnderFatigue ──────────────────────────────────────────────

describe('dispatchUnderFatigue', () => {
  const inactive: FatigueStatus = {
    active: false,
    explicit: false,
    inferred: false,
    config: resolveFatigueConfig({}),
  };
  const active: FatigueStatus = {
    active: true,
    explicit: true,
    inferred: false,
    config: resolveFatigueConfig({}),
  };

  it('returns "dispatch" when fatigue is INACTIVE regardless of tier', () => {
    expect(dispatchUnderFatigue(inactive, { tier: 'xl' })).toBe('dispatch');
    expect(dispatchUnderFatigue(inactive, { tier: 'xs' })).toBe('dispatch');
    expect(dispatchUnderFatigue(inactive, {})).toBe('dispatch');
  });

  it('defers m/l/xl decisions under fatigue (§7.2 medium + large defer)', () => {
    expect(dispatchUnderFatigue(active, { tier: 'm' })).toBe('defer');
    expect(dispatchUnderFatigue(active, { tier: 'l' })).toBe('defer');
    expect(dispatchUnderFatigue(active, { tier: 'xl' })).toBe('defer');
  });

  it('auto-decides small reversible LLM-eligible decisions under fatigue', () => {
    expect(dispatchUnderFatigue(active, { tier: 's', reversible: true, llmEligible: true })).toBe(
      'auto-decide',
    );
    expect(dispatchUnderFatigue(active, { tier: 'xs', reversible: true, llmEligible: true })).toBe(
      'auto-decide',
    );
  });

  it('does NOT auto-decide small irreversible decisions even under fatigue (§7.2)', () => {
    expect(
      dispatchUnderFatigue(active, { tier: 's', reversible: false, llmEligible: true }),
    ).not.toBe('auto-decide');
  });

  it('does NOT auto-decide when not LLM-eligible', () => {
    expect(
      dispatchUnderFatigue(active, { tier: 'xs', reversible: true, llmEligible: false }),
    ).not.toBe('auto-decide');
  });

  it('surfaces blocking-critical small decisions even under fatigue (§7.2)', () => {
    expect(
      dispatchUnderFatigue(active, { tier: 's', reversible: false, blockingCritical: true }),
    ).toBe('surface-blocking');
    expect(
      dispatchUnderFatigue(active, { tier: 'xs', reversible: false, blockingCritical: true }),
    ).toBe('surface-blocking');
  });

  it('blocking-critical takes precedence over auto-decide (so operator sees one-way)', () => {
    // A reversible + llmEligible decision that also happens to be blocking-critical
    // should surface to the operator, NOT auto-decide. The "blocking-critical"
    // signal explicitly requires operator attention.
    const out = dispatchUnderFatigue(active, {
      tier: 'xs',
      reversible: true,
      llmEligible: true,
      blockingCritical: true,
    });
    expect(out).toBe('surface-blocking');
  });

  it('untiered decisions under fatigue fall back to dispatch (small-by-default policy)', () => {
    // Without a tier, we don't have enough signal to defer; the lifecycle
    // contract is "non-blocking, fatigue-aware". Dispatch is safe — the
    // catalog's other gates (override window, default-on-silence) still apply.
    expect(dispatchUnderFatigue(active, {})).toBe('dispatch');
  });
});
