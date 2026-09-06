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
  MARKER_MAX_AGE_MS,
  determineVerdictClass,
  fileMtimeMs,
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
