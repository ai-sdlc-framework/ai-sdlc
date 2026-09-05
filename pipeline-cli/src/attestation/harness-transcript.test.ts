/**
 * Hermetic tests for AISDLC-570 harness-transcript binding (DEC-0013 → opt1).
 *
 * Coverage:
 *   - claudeProjectSlug / resolveMostRecentSessionDir path derivation.
 *   - findMatchingSubagentMarker: read-only marker scan (fresh/stale/malformed,
 *     non-consuming).
 *   - resolveHarnessTranscriptPath: explicit session-id vs. fallback heuristic,
 *     missing project dir / session dir / transcript file.
 *   - transcriptContainsNonce / readHarnessAgentType.
 *   - computeHarnessTranscriptHash: full integration — set when resolvable +
 *     nonce present + reviewer agentType; null (fail-safe) in every other case
 *     (no marker, no transcript, missing nonce, non-reviewer role).
 *
 * Hermetic under CI: `homedir()` is mocked so no test touches the real
 * `~/.claude/projects/` directory; a fresh mkdtemp fake home is used per test.
 */

import { mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let fakeHomeDir = '';

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => fakeHomeDir };
});

const {
  HARNESS_REVIEWER_AGENT_TYPES,
  claudeProjectSlug,
  claudeProjectsDir,
  computeHarnessTranscriptHash,
  findMatchingSubagentMarker,
  nonceMarkerLiteral,
  readHarnessAgentType,
  resolveHarnessTranscriptPath,
  resolveMostRecentSessionDir,
  transcriptContainsNonce,
} = await import('./harness-transcript.js');
const { subagentSessionsDir, MARKER_MAX_AGE_MS } = await import('./verdict-class.js');

let repoRoot: string;

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), 'harness-transcript-repo-'));
  fakeHomeDir = mkdtempSync(join(tmpdir(), 'harness-transcript-home-'));
});

afterEach(() => {
  rmSync(repoRoot, { recursive: true, force: true });
  rmSync(fakeHomeDir, { recursive: true, force: true });
});

// ── Path derivation ─────────────────────────────────────────────────────────

describe('claudeProjectSlug', () => {
  it('replaces every path separator with a dash', () => {
    expect(claudeProjectSlug('/Users/dominique/Documents/dev/ai-sdlc')).toBe(
      '-Users-dominique-Documents-dev-ai-sdlc',
    );
  });
});

describe('claudeProjectsDir', () => {
  it('resolves under the (mocked) home directory', () => {
    expect(claudeProjectsDir()).toBe(join(fakeHomeDir, '.claude', 'projects'));
  });
});

describe('resolveMostRecentSessionDir', () => {
  it('returns null when the directory does not exist', () => {
    expect(resolveMostRecentSessionDir(join(fakeHomeDir, 'nope'))).toBeNull();
  });

  it('returns null when the directory has no subdirectories', () => {
    const dir = mkdtempSync(join(tmpdir(), 'no-subdirs-'));
    writeFileSync(join(dir, 'not-a-dir.txt'), 'x');
    expect(resolveMostRecentSessionDir(dir)).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns the most-recently-modified subdirectory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'multi-session-'));
    const older = join(dir, 'session-older');
    const newer = join(dir, 'session-newer');
    mkdirSync(older);
    mkdirSync(newer);
    const past = new Date(Date.now() - 60_000);
    const now = new Date();
    utimesSync(older, past, past);
    utimesSync(newer, now, now);

    expect(resolveMostRecentSessionDir(dir)).toBe(newer);
    rmSync(dir, { recursive: true, force: true });
  });
});

// ── Marker scan (read-only) ──────────────────────────────────────────────────

function writeMarker(
  repoRootDir: string,
  name: string,
  fields: { agentId: string; agentType?: string | null; firedAt: string },
): void {
  const dir = subagentSessionsDir(repoRootDir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), JSON.stringify(fields));
}

describe('findMatchingSubagentMarker', () => {
  it('returns null when no subagent-sessions directory exists', () => {
    expect(findMatchingSubagentMarker({ repoRoot, transcriptMtimeMs: Date.now() })).toBeNull();
  });

  it('finds a fresh marker within the window and does NOT consume it', () => {
    const now = Date.now();
    writeMarker(repoRoot, 'agent-abc.json', {
      agentId: 'abc',
      firedAt: new Date(now).toISOString(),
    });

    const match = findMatchingSubagentMarker({ repoRoot, transcriptMtimeMs: now });
    expect(match).toEqual({
      agentId: 'abc',
      agentType: null,
      firedAt: new Date(now).toISOString(),
    });
    // Read-only: the marker file must still exist afterwards.
    expect(readdirSync(subagentSessionsDir(repoRoot))).toHaveLength(1);
  });

  it('surfaces agentType when present (AISDLC-572 composition)', () => {
    const now = Date.now();
    writeMarker(repoRoot, 'agent-abc.json', {
      agentId: 'abc',
      agentType: 'code-reviewer',
      firedAt: new Date(now).toISOString(),
    });

    const match = findMatchingSubagentMarker({ repoRoot, transcriptMtimeMs: now });
    expect(match?.agentType).toBe('code-reviewer');
  });

  it('returns null for a stale marker outside MARKER_MAX_AGE_MS', () => {
    const now = Date.now();
    writeMarker(repoRoot, 'agent-stale.json', {
      agentId: 'stale',
      firedAt: new Date(now - MARKER_MAX_AGE_MS - 60_000).toISOString(),
    });

    expect(findMatchingSubagentMarker({ repoRoot, transcriptMtimeMs: now })).toBeNull();
  });

  it('returns null for malformed marker JSON (fail-safe)', () => {
    const dir = subagentSessionsDir(repoRoot);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'broken.json'), '{ not valid json');

    expect(findMatchingSubagentMarker({ repoRoot, transcriptMtimeMs: Date.now() })).toBeNull();
  });
});

// ── Harness transcript path resolution ───────────────────────────────────────

function writeHarnessTranscript(opts: {
  projectSlugDir: string;
  sessionId: string;
  agentId: string;
  content: string;
  meta?: Record<string, unknown> | null;
}): void {
  const subagentsDir = join(opts.projectSlugDir, opts.sessionId, 'subagents');
  mkdirSync(subagentsDir, { recursive: true });
  writeFileSync(join(subagentsDir, `agent-${opts.agentId}.jsonl`), opts.content);
  if (opts.meta !== null) {
    writeFileSync(
      join(subagentsDir, `agent-${opts.agentId}.meta.json`),
      JSON.stringify(opts.meta ?? { agentType: 'ai-sdlc:code-reviewer' }),
    );
  }
}

describe('resolveHarnessTranscriptPath', () => {
  it('fails closed when the Claude Code project directory does not exist', () => {
    const result = resolveHarnessTranscriptPath({ repoRoot, agentId: 'abc' });
    expect(result.transcriptPath).toBeNull();
    expect(result.reason).toMatch(/no Claude Code project directory/);
  });

  it('resolves via explicit --claude-session-id', () => {
    const slugDir = join(claudeProjectsDir(), claudeProjectSlug(repoRoot));
    writeHarnessTranscript({
      projectSlugDir: slugDir,
      sessionId: 'session-1',
      agentId: 'abc',
      content: 'line1\n',
    });

    const result = resolveHarnessTranscriptPath({
      repoRoot,
      agentId: 'abc',
      claudeSessionId: 'session-1',
    });
    expect(result.transcriptPath).toBe(join(slugDir, 'session-1', 'subagents', 'agent-abc.jsonl'));
    expect(result.metaPath).not.toBeNull();
    expect(result.usedFallbackHeuristic).toBe(false);
  });

  it('fails closed when the explicit session id does not exist', () => {
    const slugDir = join(claudeProjectsDir(), claudeProjectSlug(repoRoot));
    mkdirSync(slugDir, { recursive: true });

    const result = resolveHarnessTranscriptPath({
      repoRoot,
      agentId: 'abc',
      claudeSessionId: 'does-not-exist',
    });
    expect(result.transcriptPath).toBeNull();
    expect(result.reason).toMatch(/not found/);
  });

  it('falls back to the most-recently-modified session dir when no session id is given', () => {
    const slugDir = join(claudeProjectsDir(), claudeProjectSlug(repoRoot));
    writeHarnessTranscript({
      projectSlugDir: slugDir,
      sessionId: 'session-old',
      agentId: 'abc',
      content: 'old\n',
    });
    const oldDir = join(slugDir, 'session-old');
    const past = new Date(Date.now() - 60_000);
    utimesSync(oldDir, past, past);

    writeHarnessTranscript({
      projectSlugDir: slugDir,
      sessionId: 'session-new',
      agentId: 'xyz',
      content: 'new\n',
    });

    const result = resolveHarnessTranscriptPath({ repoRoot, agentId: 'xyz' });
    expect(result.usedFallbackHeuristic).toBe(true);
    expect(result.transcriptPath).toBe(
      join(slugDir, 'session-new', 'subagents', 'agent-xyz.jsonl'),
    );
  });

  it('fails closed when the transcript file itself is missing', () => {
    const slugDir = join(claudeProjectsDir(), claudeProjectSlug(repoRoot));
    mkdirSync(join(slugDir, 'session-1'), { recursive: true });

    const result = resolveHarnessTranscriptPath({
      repoRoot,
      agentId: 'missing-agent',
      claudeSessionId: 'session-1',
    });
    expect(result.transcriptPath).toBeNull();
    expect(result.reason).toMatch(/harness transcript not found/);
  });

  it('sanitizes agentId path-injection characters (never escapes the subagents dir)', () => {
    const slugDir = join(claudeProjectsDir(), claudeProjectSlug(repoRoot));
    mkdirSync(join(slugDir, 'session-1'), { recursive: true });

    const result = resolveHarnessTranscriptPath({
      repoRoot,
      agentId: '../../etc/passwd',
      claudeSessionId: 'session-1',
    });
    // Not found (no such sanitized file was written) — but critically the
    // resolution never throws or escapes the subagents dir; it fails closed.
    expect(result.transcriptPath).toBeNull();
    expect(result.reason).toMatch(/harness transcript not found/);
    // The reason string must reference a path still nested under this
    // session's own subagents dir, not an escaped path.
    expect(result.reason).toContain(join(slugDir, 'session-1', 'subagents'));
    expect(result.reason).not.toContain('/etc/passwd');
  });
});

// ── Nonce + agentType helpers ─────────────────────────────────────────────────

describe('transcriptContainsNonce', () => {
  it('returns true when the literal nonce marker is present', () => {
    const filePath = join(repoRoot, 'transcript.jsonl');
    const nonce = 'a'.repeat(64);
    writeFileSync(filePath, `some prompt text ${nonceMarkerLiteral(nonce)} more text`);
    expect(transcriptContainsNonce(filePath, nonce)).toBe(true);
  });

  it('returns false when the nonce is absent', () => {
    const filePath = join(repoRoot, 'transcript.jsonl');
    writeFileSync(filePath, 'no nonce here');
    expect(transcriptContainsNonce(filePath, 'a'.repeat(64))).toBe(false);
  });

  it('returns false for a missing file (fail-safe)', () => {
    expect(transcriptContainsNonce(join(repoRoot, 'nope.jsonl'), 'a'.repeat(64))).toBe(false);
  });
});

describe('readHarnessAgentType', () => {
  it('returns null for a null metaPath', () => {
    expect(readHarnessAgentType(null)).toBeNull();
  });

  it('strips the ai-sdlc: namespace prefix', () => {
    const filePath = join(repoRoot, 'meta.json');
    writeFileSync(filePath, JSON.stringify({ agentType: 'ai-sdlc:code-reviewer' }));
    expect(readHarnessAgentType(filePath)).toBe('code-reviewer');
  });

  it('returns null on malformed JSON (fail-safe)', () => {
    const filePath = join(repoRoot, 'meta.json');
    writeFileSync(filePath, '{ not json');
    expect(readHarnessAgentType(filePath)).toBeNull();
  });
});

describe('HARNESS_REVIEWER_AGENT_TYPES', () => {
  it('includes the expected reviewer roles and excludes developer', () => {
    expect(HARNESS_REVIEWER_AGENT_TYPES).toContain('code-reviewer');
    expect(HARNESS_REVIEWER_AGENT_TYPES).toContain('security-reviewer');
    expect(HARNESS_REVIEWER_AGENT_TYPES as readonly string[]).not.toContain('developer');
  });
});

// ── Full integration: computeHarnessTranscriptHash ───────────────────────────

describe('computeHarnessTranscriptHash', () => {
  it('returns null when no SubagentStart marker exists', () => {
    const result = computeHarnessTranscriptHash({
      repoRoot,
      transcriptMtimeMs: Date.now(),
      nonce: 'a'.repeat(64),
    });
    expect(result.harnessTranscriptHash).toBeNull();
    expect(result.reason).toMatch(/no matching SubagentStart marker/);
  });

  it('sets the hash when marker + transcript + nonce + reviewer agentType (via .meta.json) all line up', () => {
    const now = Date.now();
    const nonce = 'b'.repeat(64);
    writeMarker(repoRoot, 'agent-rev1.json', {
      agentId: 'rev1',
      firedAt: new Date(now).toISOString(),
    });
    const slugDir = join(claudeProjectsDir(), claudeProjectSlug(repoRoot));
    const content = `{"type":"user","message":"Review this diff ${nonceMarkerLiteral(nonce)}"}\n`;
    writeHarnessTranscript({
      projectSlugDir: slugDir,
      sessionId: 'session-1',
      agentId: 'rev1',
      content,
      meta: { agentType: 'ai-sdlc:code-reviewer' },
    });

    const result = computeHarnessTranscriptHash({
      repoRoot,
      transcriptMtimeMs: now,
      nonce,
      claudeSessionId: 'session-1',
    });

    expect(result.harnessTranscriptHash).not.toBeNull();
    expect(result.harnessTranscriptHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.reason).toMatch(/^ok/);
  });

  it('prefers marker.agentType over the harness .meta.json once AISDLC-572 populates it', () => {
    const now = Date.now();
    const nonce = 'c'.repeat(64);
    writeMarker(repoRoot, 'agent-rev2.json', {
      agentId: 'rev2',
      agentType: 'security-reviewer',
      firedAt: new Date(now).toISOString(),
    });
    const slugDir = join(claudeProjectsDir(), claudeProjectSlug(repoRoot));
    writeHarnessTranscript({
      projectSlugDir: slugDir,
      sessionId: 'session-1',
      agentId: 'rev2',
      content: `prompt ${nonceMarkerLiteral(nonce)}`,
      // Deliberately mismatched meta.json agentType — marker wins.
      meta: { agentType: 'ai-sdlc:developer' },
    });

    const result = computeHarnessTranscriptHash({
      repoRoot,
      transcriptMtimeMs: now,
      nonce,
      claudeSessionId: 'session-1',
    });

    expect(result.harnessTranscriptHash).not.toBeNull();
  });

  it('fails closed (null) when the nonce is missing from the transcript', () => {
    const now = Date.now();
    writeMarker(repoRoot, 'agent-rev3.json', {
      agentId: 'rev3',
      firedAt: new Date(now).toISOString(),
    });
    const slugDir = join(claudeProjectsDir(), claudeProjectSlug(repoRoot));
    writeHarnessTranscript({
      projectSlugDir: slugDir,
      sessionId: 'session-1',
      agentId: 'rev3',
      content: 'no nonce in here at all',
      meta: { agentType: 'ai-sdlc:code-reviewer' },
    });

    const result = computeHarnessTranscriptHash({
      repoRoot,
      transcriptMtimeMs: now,
      nonce: 'd'.repeat(64),
      claudeSessionId: 'session-1',
    });

    expect(result.harnessTranscriptHash).toBeNull();
    expect(result.reason).toMatch(/diff-binding nonce not found/);
  });

  it('fails closed (null) when the resolved agentType is not a reviewer role', () => {
    const now = Date.now();
    const nonce = 'e'.repeat(64);
    writeMarker(repoRoot, 'agent-rev4.json', {
      agentId: 'rev4',
      firedAt: new Date(now).toISOString(),
    });
    const slugDir = join(claudeProjectsDir(), claudeProjectSlug(repoRoot));
    writeHarnessTranscript({
      projectSlugDir: slugDir,
      sessionId: 'session-1',
      agentId: 'rev4',
      content: `prompt ${nonceMarkerLiteral(nonce)}`,
      meta: { agentType: 'ai-sdlc:developer' },
    });

    const result = computeHarnessTranscriptHash({
      repoRoot,
      transcriptMtimeMs: now,
      nonce,
      claudeSessionId: 'session-1',
    });

    expect(result.harnessTranscriptHash).toBeNull();
    expect(result.reason).toMatch(/not a reviewer role/);
  });

  it('fails closed (null) when the harness transcript cannot be resolved at all', () => {
    const now = Date.now();
    writeMarker(repoRoot, 'agent-rev5.json', {
      agentId: 'rev5',
      firedAt: new Date(now).toISOString(),
    });
    // No ~/.claude/projects/<slug> directory created at all.

    const result = computeHarnessTranscriptHash({
      repoRoot,
      transcriptMtimeMs: now,
      nonce: 'f'.repeat(64),
    });

    expect(result.harnessTranscriptHash).toBeNull();
    expect(result.reason).toMatch(/no Claude Code project directory/);
  });

  it('never throws even on wildly malformed input', () => {
    expect(() =>
      computeHarnessTranscriptHash({
        repoRoot: '',
        transcriptMtimeMs: NaN,
        nonce: '',
      }),
    ).not.toThrow();
  });
});
