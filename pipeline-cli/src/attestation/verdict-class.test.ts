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
  subagentSessionsDir,
} from './verdict-class.js';

let repoRoot: string;

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), 'verdict-class-test-'));
});

afterEach(() => {
  rmSync(repoRoot, { recursive: true, force: true });
});

function writeMarker(repoRoot: string, name: string, firedAt: string): string {
  const dir = subagentSessionsDir(repoRoot);
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, name);
  writeFileSync(filePath, JSON.stringify({ agentId: name.replace(/\.json$/, ''), firedAt }));
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
