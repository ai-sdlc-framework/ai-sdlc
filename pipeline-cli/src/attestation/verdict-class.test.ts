/**
 * Hermetic tests for AISDLC-568 verdictClass detection.
 *
 * Coverage:
 *   (a) independent-reviewer path: a fresh SubagentStart marker within the
 *       lookback window -> 'independent', and the marker is consumed.
 *   (b) self-authored / coordinator path: no marker present -> 'self-authored'.
 *   (c) stale marker (outside the lookback window) -> 'self-authored'.
 *   (d) malformed marker JSON -> 'self-authored' (fail-safe).
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  AGENT_ID_PATTERN,
  MARKER_MAX_AGE_MS,
  determineVerdictClass,
  fileMtimeMs,
  selectSubagentMarker,
  stripAgentTypeNamespace,
  subagentSessionsDir,
} from './verdict-class.js';

let repoRoot: string;

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), 'verdict-class-test-'));
});

afterEach(() => {
  rmSync(repoRoot, { recursive: true, force: true });
});

function writeMarker(
  repoRoot: string,
  name: string,
  firedAt: string,
  agentType: string | null = 'code-reviewer',
): string {
  const dir = subagentSessionsDir(repoRoot);
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, name);
  writeFileSync(
    filePath,
    JSON.stringify({ agentId: name.replace(/\.json$/, ''), agentType, firedAt }),
  );
  return filePath;
}

describe('determineVerdictClass', () => {
  it('(a) returns independent when a fresh marker exists within the lookback window', () => {
    const now = Date.now();
    writeMarker(repoRoot, 'agent-abc123.json', new Date(now).toISOString());

    const result = determineVerdictClass({ repoRoot, transcriptMtimeMs: now });

    expect(result).toBe('independent');
  });

  it('(a) consumes the marker file after a match (cannot back-stop a second leaf)', () => {
    const now = Date.now();
    writeMarker(repoRoot, 'agent-abc123.json', new Date(now).toISOString());

    const first = determineVerdictClass({ repoRoot, transcriptMtimeMs: now });
    const second = determineVerdictClass({ repoRoot, transcriptMtimeMs: now });

    expect(first).toBe('independent');
    expect(second).toBe('self-authored');
    expect(readdirSync(subagentSessionsDir(repoRoot))).toHaveLength(0);
  });

  it('(b) returns self-authored when no subagent-sessions directory exists', () => {
    const result = determineVerdictClass({ repoRoot, transcriptMtimeMs: Date.now() });
    expect(result).toBe('self-authored');
    expect(existsSync(subagentSessionsDir(repoRoot))).toBe(false);
  });

  it('(b) returns self-authored when the directory exists but is empty', () => {
    mkdirSync(subagentSessionsDir(repoRoot), { recursive: true });
    const result = determineVerdictClass({ repoRoot, transcriptMtimeMs: Date.now() });
    expect(result).toBe('self-authored');
  });

  it('(c) returns self-authored when the marker is older than MARKER_MAX_AGE_MS', () => {
    const now = Date.now();
    const staleFiredAt = new Date(now - MARKER_MAX_AGE_MS - 60_000).toISOString();
    writeMarker(repoRoot, 'agent-stale.json', staleFiredAt);

    const result = determineVerdictClass({ repoRoot, transcriptMtimeMs: now });

    expect(result).toBe('self-authored');
  });

  it('(c) returns self-authored when the marker is from the future beyond the window', () => {
    const now = Date.now();
    const futureFiredAt = new Date(now + MARKER_MAX_AGE_MS + 60_000).toISOString();
    writeMarker(repoRoot, 'agent-future.json', futureFiredAt);

    const result = determineVerdictClass({ repoRoot, transcriptMtimeMs: now });

    expect(result).toBe('self-authored');
  });

  it('(d) returns self-authored on malformed marker JSON (fail-safe)', () => {
    const dir = subagentSessionsDir(repoRoot);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'agent-broken.json'), '{ not valid json');

    const result = determineVerdictClass({ repoRoot, transcriptMtimeMs: Date.now() });

    expect(result).toBe('self-authored');
  });

  it('(d) returns self-authored when firedAt is missing or unparsable', () => {
    const dir = subagentSessionsDir(repoRoot);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'no-firedat.json'), JSON.stringify({ agentId: 'x' }));
    writeFileSync(join(dir, 'bad-firedat.json'), JSON.stringify({ agentId: 'y', firedAt: 'nope' }));

    const result = determineVerdictClass({ repoRoot, transcriptMtimeMs: Date.now() });

    expect(result).toBe('self-authored');
  });

  it('ignores non-.json files in the sessions directory', () => {
    const dir = subagentSessionsDir(repoRoot);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'README.txt'), 'not a marker');

    const result = determineVerdictClass({ repoRoot, transcriptMtimeMs: Date.now() });

    expect(result).toBe('self-authored');
  });
});

describe('determineVerdictClass — AISDLC-572 role binding', () => {
  it('a developer-typed marker in-window is NOT credited as independent (reproduces the report)', () => {
    const now = Date.now();
    writeMarker(repoRoot, 'agent-dev.json', new Date(now).toISOString(), 'developer');

    const result = determineVerdictClass({ repoRoot, transcriptMtimeMs: now });

    expect(result).toBe('self-authored');
  });

  it('a code-reviewer-typed marker in-window IS credited as independent', () => {
    const now = Date.now();
    writeMarker(repoRoot, 'agent-cr.json', new Date(now).toISOString(), 'code-reviewer');

    const result = determineVerdictClass({ repoRoot, transcriptMtimeMs: now });

    expect(result).toBe('independent');
  });

  it('a null-agentType (legacy) marker in-window falls back to self-authored', () => {
    const now = Date.now();
    writeMarker(repoRoot, 'agent-legacy.json', new Date(now).toISOString(), null);

    const result = determineVerdictClass({ repoRoot, transcriptMtimeMs: now });

    expect(result).toBe('self-authored');
  });

  it('a rebase-resolver-typed marker in-window is NOT credited as independent', () => {
    const now = Date.now();
    writeMarker(repoRoot, 'agent-rebase.json', new Date(now).toISOString(), 'rebase-resolver');

    const result = determineVerdictClass({ repoRoot, transcriptMtimeMs: now });

    expect(result).toBe('self-authored');
  });

  it('a refinement-reviewer-typed marker in-window is NOT credited as independent (DoR reviewer, not a diff review)', () => {
    const now = Date.now();
    writeMarker(
      repoRoot,
      'agent-refinement.json',
      new Date(now).toISOString(),
      'refinement-reviewer',
    );

    const result = determineVerdictClass({ repoRoot, transcriptMtimeMs: now });

    expect(result).toBe('self-authored');
  });

  it.each(['test-reviewer', 'security-reviewer', 'code-reviewer-codex', 'test-reviewer-codex'])(
    '%s-typed marker in-window IS credited as independent',
    (agentType) => {
      const now = Date.now();
      writeMarker(repoRoot, `agent-${agentType}.json`, new Date(now).toISOString(), agentType);

      const result = determineVerdictClass({ repoRoot, transcriptMtimeMs: now });

      expect(result).toBe('independent');
    },
  );

  it('a developer marker + a separately fired reviewer marker: only the reviewer marker qualifies', () => {
    const now = Date.now();
    writeMarker(repoRoot, 'agent-dev.json', new Date(now).toISOString(), 'developer');
    writeMarker(repoRoot, 'agent-cr.json', new Date(now).toISOString(), 'code-reviewer');

    const result = determineVerdictClass({ repoRoot, transcriptMtimeMs: now });

    expect(result).toBe('independent');
  });

  // ── AISDLC-589 Gap B: plugin-namespaced agentType ──────────────────────────

  it.each([
    'code-reviewer',
    'test-reviewer',
    'security-reviewer',
    'code-reviewer-codex',
    'test-reviewer-codex',
  ])('a plugin-namespaced ai-sdlc:%s marker in-window IS credited as independent', (bareRole) => {
    const now = Date.now();
    writeMarker(
      repoRoot,
      `agent-${bareRole}-ns.json`,
      new Date(now).toISOString(),
      `ai-sdlc:${bareRole}`,
    );

    const result = determineVerdictClass({ repoRoot, transcriptMtimeMs: now });

    expect(result).toBe('independent');
  });

  it('a plugin-namespaced ai-sdlc:developer marker is NOT credited as independent (the security-critical negative)', () => {
    const now = Date.now();
    writeMarker(repoRoot, 'agent-dev-ns.json', new Date(now).toISOString(), 'ai-sdlc:developer');

    const result = determineVerdictClass({ repoRoot, transcriptMtimeMs: now });

    expect(result).toBe('self-authored');
  });

  it('consumes a namespaced marker after a match, same as an unnamespaced one', () => {
    const now = Date.now();
    const filePath = writeMarker(
      repoRoot,
      'agent-ns-consume.json',
      new Date(now).toISOString(),
      'ai-sdlc:code-reviewer',
    );

    determineVerdictClass({ repoRoot, transcriptMtimeMs: now });

    expect(existsSync(filePath)).toBe(false);
  });
});

describe('stripAgentTypeNamespace', () => {
  it('strips the ai-sdlc: namespace prefix', () => {
    expect(stripAgentTypeNamespace('ai-sdlc:code-reviewer')).toBe('code-reviewer');
  });

  it('strips a codex-variant role with the namespace prefix', () => {
    expect(stripAgentTypeNamespace('ai-sdlc:code-reviewer-codex')).toBe('code-reviewer-codex');
  });

  it('passes a bare, unnamespaced value through unchanged', () => {
    expect(stripAgentTypeNamespace('code-reviewer')).toBe('code-reviewer');
  });

  it('returns null for null, undefined, non-string, or empty input', () => {
    expect(stripAgentTypeNamespace(null)).toBeNull();
    expect(stripAgentTypeNamespace(undefined)).toBeNull();
    expect(stripAgentTypeNamespace('')).toBeNull();
  });
});

describe('fileMtimeMs', () => {
  it('returns the mtime in ms for an existing file', () => {
    const filePath = join(repoRoot, 'x.txt');
    writeFileSync(filePath, 'hi');
    const mtime = fileMtimeMs(filePath);
    expect(mtime).not.toBeNull();
    expect(typeof mtime).toBe('number');
  });

  it('returns null for a missing file', () => {
    expect(fileMtimeMs(join(repoRoot, 'nope.txt'))).toBeNull();
  });
});

// ── Identity binding (reviewer name, agent id, extra roots) ─────────────────

describe('determineVerdictClass — bound to the reviewer the leaf is for', () => {
  it("consumes only the named reviewer's marker and leaves the others for their own leaves", () => {
    const now = Date.now();
    const iso = new Date(now).toISOString();
    const sec = writeMarker(repoRoot, 'a-sec.json', iso, 'ai-sdlc:security-reviewer');
    const code = writeMarker(repoRoot, 'b-code.json', iso, 'ai-sdlc:code-reviewer');
    const test = writeMarker(repoRoot, 'c-test.json', iso, 'ai-sdlc:test-reviewer');

    expect(
      determineVerdictClass({ repoRoot, transcriptMtimeMs: now, reviewerName: 'test-reviewer' }),
    ).toBe('independent');
    expect(existsSync(test)).toBe(false);
    expect(existsSync(sec)).toBe(true);
    expect(existsSync(code)).toBe(true);

    expect(
      determineVerdictClass({ repoRoot, transcriptMtimeMs: now, reviewerName: 'code-reviewer' }),
    ).toBe('independent');
    expect(
      determineVerdictClass({
        repoRoot,
        transcriptMtimeMs: now,
        reviewerName: 'security-reviewer',
      }),
    ).toBe('independent');
    expect(readdirSync(subagentSessionsDir(repoRoot))).toEqual([]);
  });

  it("does not credit a leaf with another reviewer's marker, and does not consume it", () => {
    const now = Date.now();
    const sec = writeMarker(repoRoot, 'sec.json', new Date(now).toISOString(), 'security-reviewer');
    expect(
      determineVerdictClass({ repoRoot, transcriptMtimeMs: now, reviewerName: 'code-reviewer' }),
    ).toBe('self-authored');
    expect(existsSync(sec)).toBe(true);
  });

  it('a second leaf for the same reviewer is self-authored once the marker is consumed', () => {
    const now = Date.now();
    writeMarker(repoRoot, 'code.json', new Date(now).toISOString(), 'code-reviewer');
    const opts = { repoRoot, transcriptMtimeMs: now, reviewerName: 'code-reviewer' };
    expect(determineVerdictClass(opts)).toBe('independent');
    expect(determineVerdictClass(opts)).toBe('self-authored');
  });

  it('finds the marker under an extra root (session directory differs from the worktree)', () => {
    const now = Date.now();
    const sessionRoot = mkdtempSync(join(tmpdir(), 'verdict-class-session-'));
    try {
      const marker = writeMarker(
        sessionRoot,
        'code.json',
        new Date(now).toISOString(),
        'ai-sdlc:code-reviewer',
      );
      expect(
        determineVerdictClass({ repoRoot, transcriptMtimeMs: now, reviewerName: 'code-reviewer' }),
      ).toBe('self-authored');
      expect(
        determineVerdictClass({
          repoRoot,
          transcriptMtimeMs: now,
          reviewerName: 'code-reviewer',
          extraRoots: [sessionRoot],
        }),
      ).toBe('independent');
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(sessionRoot, { recursive: true, force: true });
    }
  });

  it('with an agent id, only that agent marker counts, and its role must match the reviewer', () => {
    const now = Date.now();
    const iso = new Date(now).toISOString();
    writeMarker(repoRoot, 'run1.json', iso, 'code-reviewer');
    writeMarker(repoRoot, 'run2.json', iso, 'security-reviewer');

    expect(
      determineVerdictClass({
        repoRoot,
        transcriptMtimeMs: now,
        reviewerName: 'code-reviewer',
        agentId: 'run2',
      }),
    ).toBe('self-authored');
    expect(
      determineVerdictClass({
        repoRoot,
        transcriptMtimeMs: now,
        reviewerName: 'code-reviewer',
        agentId: 'missing',
      }),
    ).toBe('self-authored');
    expect(readdirSync(subagentSessionsDir(repoRoot)).sort()).toEqual(['run1.json', 'run2.json']);
    expect(
      determineVerdictClass({
        repoRoot,
        transcriptMtimeMs: now,
        reviewerName: 'code-reviewer',
        agentId: 'run1',
      }),
    ).toBe('independent');
    expect(readdirSync(subagentSessionsDir(repoRoot))).toEqual(['run2.json']);
  });

  it('a reviewer name that is not a reviewer role is never independent, even with its own marker', () => {
    const now = Date.now();
    writeMarker(repoRoot, 'dev.json', new Date(now).toISOString(), 'developer');
    expect(
      determineVerdictClass({ repoRoot, transcriptMtimeMs: now, reviewerName: 'developer' }),
    ).toBe('self-authored');
  });
});

describe('selectSubagentMarker', () => {
  it('returns null for an empty or malformed reviewer name or agent id', () => {
    const now = Date.now();
    writeMarker(repoRoot, 'code.json', new Date(now).toISOString(), 'code-reviewer');
    const base = { roots: [repoRoot], transcriptMtimeMs: now };
    expect(selectSubagentMarker({ ...base, reviewerName: '' })).toBeNull();
    expect(selectSubagentMarker({ ...base, agentId: '../code' })).toBeNull();
    expect(selectSubagentMarker({ ...base, agentId: 'a b' })).toBeNull();
    expect(AGENT_ID_PATTERN.test('a1b2c3d4e5f6')).toBe(true);
  });

  it('skips empty roots, de-duplicates roots, and survives a root that does not exist', () => {
    const now = Date.now();
    writeMarker(repoRoot, 'code.json', new Date(now).toISOString(), 'code-reviewer');
    const sel = selectSubagentMarker({
      roots: ['', join(repoRoot, 'missing'), repoRoot, repoRoot],
      transcriptMtimeMs: now,
      reviewerName: 'code-reviewer',
    });
    expect(sel?.marker.agentId).toBe('code');
    expect(sel?.filePath).toBe(join(subagentSessionsDir(repoRoot), 'code.json'));
  });

  it('prefers a typed marker over an untyped one, then the most recent, then the lower agent id', () => {
    const now = Date.now();
    const iso = (ms: number) => new Date(ms).toISOString();
    writeMarker(repoRoot, 'untyped.json', iso(now), null);
    writeMarker(repoRoot, 'old.json', iso(now - 120_000), 'code-reviewer');
    writeMarker(repoRoot, 'tie-b.json', iso(now - 5_000), 'code-reviewer');
    writeMarker(repoRoot, 'tie-a.json', iso(now - 5_000), 'code-reviewer');
    const q = { roots: [repoRoot], transcriptMtimeMs: now, reviewerName: 'code-reviewer' };
    expect(selectSubagentMarker({ ...q, allowUntyped: true })?.marker.agentId).toBe('tie-a');
    expect(selectSubagentMarker(q)?.marker.agentId).toBe('tie-a');
  });

  it('accepts an untyped marker only when asked to, and never a marker outside the window', () => {
    const now = Date.now();
    writeMarker(repoRoot, 'untyped.json', new Date(now).toISOString(), null);
    writeMarker(
      repoRoot,
      'stale.json',
      new Date(now - MARKER_MAX_AGE_MS - 1000).toISOString(),
      'code-reviewer',
    );
    const q = { roots: [repoRoot], transcriptMtimeMs: now, reviewerName: 'code-reviewer' };
    expect(selectSubagentMarker(q)).toBeNull();
    expect(selectSubagentMarker({ ...q, allowUntyped: true })?.marker.agentId).toBe('untyped');
  });

  it('reviewerRolesOnly rejects a typed non-reviewer role', () => {
    const now = Date.now();
    writeMarker(repoRoot, 'dev.json', new Date(now).toISOString(), 'ai-sdlc:developer');
    const q = { roots: [repoRoot], transcriptMtimeMs: now };
    expect(selectSubagentMarker(q)?.marker.agentId).toBe('dev');
    expect(selectSubagentMarker({ ...q, reviewerRolesOnly: true })).toBeNull();
  });
});
