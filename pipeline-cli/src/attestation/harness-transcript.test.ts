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

import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
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
  locateSessionDirByAgentId,
  markerSearchRoots,
  nonceMarkerLiteral,
  readHarnessAgentType,
  resolveClaudeProjectRoot,
  resolveHarnessTranscriptPath,
  resolveMainCheckoutRoot,
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

  it('pins the session by the agent id when no session id is given, even if another session is newer', () => {
    const slugDir = join(claudeProjectsDir(), claudeProjectSlug(repoRoot));
    writeHarnessTranscript({
      projectSlugDir: slugDir,
      sessionId: 'session-reviewer',
      agentId: 'rev9',
      content: 'mine\n',
    });
    const past = new Date(Date.now() - 60_000);
    utimesSync(join(slugDir, 'session-reviewer'), past, past);
    // A different, more recently written session (an executor, the operator).
    writeHarnessTranscript({
      projectSlugDir: slugDir,
      sessionId: 'session-other',
      agentId: 'someone-else',
      content: 'theirs\n',
    });

    const result = resolveHarnessTranscriptPath({ repoRoot, agentId: 'rev9' });
    expect(result.usedFallbackHeuristic).toBe(false);
    expect(result.transcriptPath).toBe(
      join(slugDir, 'session-reviewer', 'subagents', 'agent-rev9.jsonl'),
    );
  });

  it('flags the heuristic when two sessions hold a transcript for the same agent id, and takes the newer', () => {
    const slugDir = join(claudeProjectsDir(), claudeProjectSlug(repoRoot));
    writeHarnessTranscript({
      projectSlugDir: slugDir,
      sessionId: 's-a',
      agentId: 'dup',
      content: 'a\n',
    });
    writeHarnessTranscript({
      projectSlugDir: slugDir,
      sessionId: 's-b',
      agentId: 'dup',
      content: 'b\n',
    });
    const past = new Date(Date.now() - 60_000);
    utimesSync(join(slugDir, 's-a', 'subagents', 'agent-dup.jsonl'), past, past);

    const located = locateSessionDirByAgentId(slugDir, 'dup');
    expect(located).toEqual({ sessionDir: join(slugDir, 's-b'), unique: false });
    const result = resolveHarnessTranscriptPath({ repoRoot, agentId: 'dup' });
    expect(result.usedFallbackHeuristic).toBe(true);
    expect(result.transcriptPath).toBe(join(slugDir, 's-b', 'subagents', 'agent-dup.jsonl'));
  });

  it('locateSessionDirByAgentId returns null for a missing directory or an unknown agent', () => {
    expect(locateSessionDirByAgentId(join(fakeHomeDir, 'nope'), 'x')).toEqual({
      sessionDir: null,
      unique: false,
    });
    const slugDir = join(claudeProjectsDir(), claudeProjectSlug(repoRoot));
    writeHarnessTranscript({
      projectSlugDir: slugDir,
      sessionId: 's',
      agentId: 'a',
      content: 'a\n',
    });
    writeFileSync(join(slugDir, 'not-a-dir'), 'x');
    expect(locateSessionDirByAgentId(slugDir, 'unknown')).toEqual({
      sessionDir: null,
      unique: false,
    });
  });

  it('falls back to the most-recently-modified session dir when no session holds the agent transcript', () => {
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

    const result = resolveHarnessTranscriptPath({ repoRoot, agentId: 'not-there' });
    expect(result.usedFallbackHeuristic).toBe(true);
    expect(result.transcriptPath).toBeNull();
    expect(result.reason).toContain(
      join(slugDir, 'session-new', 'subagents', 'agent-not-there.jsonl'),
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

  it('never throws even on wildly malformed input, and fails closed', () => {
    let result: ReturnType<typeof computeHarnessTranscriptHash> | undefined;
    expect(() => {
      result = computeHarnessTranscriptHash({
        repoRoot: '',
        transcriptMtimeMs: NaN,
        nonce: '',
      });
    }).not.toThrow();
    expect(result?.harnessTranscriptHash).toBeNull();
    expect(typeof result?.reason).toBe('string');
  });

  it('fails closed (null) when both the marker and the harness .meta.json lack agentType', () => {
    const now = Date.now();
    const nonce = 'a1'.repeat(32);
    writeMarker(repoRoot, 'agent-rev6.json', {
      agentId: 'rev6',
      firedAt: new Date(now).toISOString(),
    });
    const slugDir = join(claudeProjectsDir(), claudeProjectSlug(repoRoot));
    writeHarnessTranscript({
      projectSlugDir: slugDir,
      sessionId: 'session-1',
      agentId: 'rev6',
      content: `prompt ${nonceMarkerLiteral(nonce)}`,
      // meta.json present but with no agentType field at all — null-fallback
      // through both the marker AND the harness claim.
      meta: { someOtherField: true },
    });

    const result = computeHarnessTranscriptHash({
      repoRoot,
      transcriptMtimeMs: now,
      nonce,
      claudeSessionId: 'session-1',
    });

    expect(result.harnessTranscriptHash).toBeNull();
    expect(result.reason).toMatch(/not a reviewer role/);
    expect(result.reason).toContain('null');
  });
});

// ── AISDLC-589 Gap A: worktree project-dir resolution ────────────────────────

/** Init a throwaway git repo at `dir` with a single commit (needed for `git worktree add`). */
function initGitRepo(dir: string): void {
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
  writeFileSync(join(dir, 'file.txt'), 'x');
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir });
}

describe('resolveMainCheckoutRoot', () => {
  let mainRoot: string;
  let worktreeRoot: string;

  beforeEach(() => {
    mainRoot = mkdtempSync(join(tmpdir(), 'main-checkout-'));
    initGitRepo(mainRoot);
    worktreeRoot = mkdtempSync(join(tmpdir(), 'linked-worktree-'));
    rmSync(worktreeRoot, { recursive: true, force: true }); // git worktree add requires a non-existent target
    execFileSync('git', ['worktree', 'add', '-q', '-b', 'aisdlc-589-branch', worktreeRoot], {
      cwd: mainRoot,
    });
  });

  afterEach(() => {
    try {
      execFileSync('git', ['worktree', 'remove', '--force', worktreeRoot], { cwd: mainRoot });
    } catch {
      rmSync(worktreeRoot, { recursive: true, force: true });
    }
    rmSync(mainRoot, { recursive: true, force: true });
  });

  it('resolves a linked worktree back to the main checkout root', () => {
    const resolved = resolveMainCheckoutRoot(worktreeRoot);
    expect(resolved).not.toBeNull();
    expect(realpathSync(resolved as string)).toBe(realpathSync(mainRoot));
  });

  it('resolves the main checkout itself back to its own root (no-op)', () => {
    const resolved = resolveMainCheckoutRoot(mainRoot);
    expect(resolved).not.toBeNull();
    expect(realpathSync(resolved as string)).toBe(realpathSync(mainRoot));
  });

  it('returns null for a directory that is not a git repo at all', () => {
    const nonRepo = mkdtempSync(join(tmpdir(), 'not-a-repo-'));
    expect(resolveMainCheckoutRoot(nonRepo)).toBeNull();
    rmSync(nonRepo, { recursive: true, force: true });
  });
});

describe('resolveClaudeProjectRoot', () => {
  it('prefers an explicit projectDirOverride over any git-derived root', () => {
    const override = mkdtempSync(join(tmpdir(), 'override-'));
    const resolved = resolveClaudeProjectRoot({ repoRoot, projectDirOverride: override });
    expect(realpathSync(resolved)).toBe(realpathSync(override));
    rmSync(override, { recursive: true, force: true });
  });

  it('falls back to repoRoot itself when git resolution fails (not a git repo)', () => {
    const resolved = resolveClaudeProjectRoot({ repoRoot });
    expect(resolved).toBe(repoRoot);
  });
});

describe('computeHarnessTranscriptHash — AISDLC-589 Gap A worktree resolution', () => {
  let mainRoot: string;
  let worktreeRoot: string;

  beforeEach(() => {
    mainRoot = mkdtempSync(join(tmpdir(), 'main-checkout-'));
    initGitRepo(mainRoot);
    worktreeRoot = mkdtempSync(join(tmpdir(), 'linked-worktree-'));
    rmSync(worktreeRoot, { recursive: true, force: true });
    execFileSync('git', ['worktree', 'add', '-q', '-b', 'aisdlc-589-branch-2', worktreeRoot], {
      cwd: mainRoot,
    });
  });

  afterEach(() => {
    try {
      execFileSync('git', ['worktree', 'remove', '--force', worktreeRoot], { cwd: mainRoot });
    } catch {
      rmSync(worktreeRoot, { recursive: true, force: true });
    }
    rmSync(mainRoot, { recursive: true, force: true });
  });

  it('yields a non-null harnessTranscriptHash for a reviewer dispatched from a worktree, using the MAIN checkout slug', () => {
    const now = Date.now();
    const nonce = 'aa'.repeat(32);

    // Marker + transcript are looked up against `repoRoot` (a worktree here),
    // but the marker file itself is a mundane per-worktree artifact — write
    // it under the worktree, as the real hook does (CLAUDE_PROJECT_DIR is
    // the worktree in Pattern C).
    writeMarker(worktreeRoot, 'agent-w1.json', {
      agentId: 'w1',
      agentType: 'ai-sdlc:code-reviewer',
      firedAt: new Date(now).toISOString(),
    });

    // The REAL Claude Code transcript, however, lives under the MAIN
    // checkout's slug — this is exactly the Gap A mismatch. Use the
    // resolved main-checkout root (not the raw mkdtemp path) since `git`
    // may realpath-resolve symlinked tmpdirs (e.g. macOS /var -> /private/var).
    const resolvedMainRoot = resolveMainCheckoutRoot(worktreeRoot);
    expect(resolvedMainRoot).not.toBeNull();
    const mainSlugDir = join(claudeProjectsDir(), claudeProjectSlug(resolvedMainRoot as string));
    writeHarnessTranscript({
      projectSlugDir: mainSlugDir,
      sessionId: 'session-1',
      agentId: 'w1',
      content: `prompt ${nonceMarkerLiteral(nonce)}`,
      meta: { agentType: 'ai-sdlc:code-reviewer' },
    });

    const result = computeHarnessTranscriptHash({
      repoRoot: worktreeRoot,
      transcriptMtimeMs: now,
      nonce,
      claudeSessionId: 'session-1',
    });

    expect(result.harnessTranscriptHash).not.toBeNull();
    expect(result.harnessTranscriptHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('fails closed (no false credit) when no --project-dir override is given and the transcript lives ONLY under the wrong (worktree) slug', () => {
    const now = Date.now();
    const nonce = 'bb'.repeat(32);

    writeMarker(worktreeRoot, 'agent-w2.json', {
      agentId: 'w2',
      agentType: 'ai-sdlc:code-reviewer',
      firedAt: new Date(now).toISOString(),
    });

    // Nothing written under the main checkout's slug — this simulates the
    // pre-fix world (or a genuinely absent transcript). Must fail closed,
    // not fabricate a hash.
    const result = computeHarnessTranscriptHash({
      repoRoot: worktreeRoot,
      transcriptMtimeMs: now,
      nonce,
      claudeSessionId: 'session-1',
    });

    expect(result.harnessTranscriptHash).toBeNull();
  });

  it('honors an explicit --project-dir override, bypassing git resolution entirely', () => {
    const now = Date.now();
    const nonce = 'cc'.repeat(32);
    const overrideRoot = mkdtempSync(join(tmpdir(), 'override-root-'));

    writeMarker(worktreeRoot, 'agent-w3.json', {
      agentId: 'w3',
      agentType: 'ai-sdlc:code-reviewer',
      firedAt: new Date(now).toISOString(),
    });

    const overrideSlugDir = join(claudeProjectsDir(), claudeProjectSlug(overrideRoot));
    writeHarnessTranscript({
      projectSlugDir: overrideSlugDir,
      sessionId: 'session-1',
      agentId: 'w3',
      content: `prompt ${nonceMarkerLiteral(nonce)}`,
      meta: { agentType: 'ai-sdlc:code-reviewer' },
    });

    const result = computeHarnessTranscriptHash({
      repoRoot: worktreeRoot,
      transcriptMtimeMs: now,
      nonce,
      claudeSessionId: 'session-1',
      projectDirOverride: overrideRoot,
    });

    expect(result.harnessTranscriptHash).not.toBeNull();
    rmSync(overrideRoot, { recursive: true, force: true });
  });
});

// ── AISDLC-589 Gap B: plugin-namespaced agentType in the marker itself ──────

describe('computeHarnessTranscriptHash — AISDLC-589 Gap B namespaced marker.agentType', () => {
  it.each([
    'code-reviewer',
    'test-reviewer',
    'security-reviewer',
    'code-reviewer-codex',
    'test-reviewer-codex',
  ])('sets the hash when marker.agentType is namespaced ai-sdlc:%s', (bareRole) => {
    const now = Date.now();
    const nonce = 'dd'.repeat(32);
    writeMarker(repoRoot, `agent-ns-${bareRole}.json`, {
      agentId: `ns-${bareRole}`,
      agentType: `ai-sdlc:${bareRole}`,
      firedAt: new Date(now).toISOString(),
    });
    const slugDir = join(claudeProjectsDir(), claudeProjectSlug(repoRoot));
    writeHarnessTranscript({
      projectSlugDir: slugDir,
      sessionId: 'session-1',
      agentId: `ns-${bareRole}`,
      content: `prompt ${nonceMarkerLiteral(nonce)}`,
      meta: null,
    });

    const result = computeHarnessTranscriptHash({
      repoRoot,
      transcriptMtimeMs: now,
      nonce,
      claudeSessionId: 'session-1',
    });

    expect(result.harnessTranscriptHash).not.toBeNull();
  });

  it('fails closed (null) when marker.agentType is a namespaced non-reviewer role (the security-critical negative)', () => {
    const now = Date.now();
    const nonce = 'ee'.repeat(32);
    writeMarker(repoRoot, 'agent-ns-dev.json', {
      agentId: 'ns-dev',
      agentType: 'ai-sdlc:developer',
      firedAt: new Date(now).toISOString(),
    });
    const slugDir = join(claudeProjectsDir(), claudeProjectSlug(repoRoot));
    writeHarnessTranscript({
      projectSlugDir: slugDir,
      sessionId: 'session-1',
      agentId: 'ns-dev',
      content: `prompt ${nonceMarkerLiteral(nonce)}`,
      meta: null,
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
});

// ── Path-traversal hardening (security round-2 review) ───────────────────────

describe('resolveHarnessTranscriptPath — path-traversal hardening', () => {
  it('rejects a --claude-session-id containing ".." before touching the filesystem', () => {
    const slugDir = join(claudeProjectsDir(), claudeProjectSlug(repoRoot));
    mkdirSync(slugDir, { recursive: true });

    const result = resolveHarnessTranscriptPath({
      repoRoot,
      agentId: 'abc',
      claudeSessionId: '../../../tmp/evil-session',
    });
    expect(result.transcriptPath).toBeNull();
    expect(result.reason).toMatch(/outside the allowed charset/);
  });

  it('rejects a --claude-session-id containing a path separator', () => {
    const slugDir = join(claudeProjectsDir(), claudeProjectSlug(repoRoot));
    mkdirSync(slugDir, { recursive: true });

    const result = resolveHarnessTranscriptPath({
      repoRoot,
      agentId: 'abc',
      claudeSessionId: 'foo/bar',
    });
    expect(result.transcriptPath).toBeNull();
    expect(result.reason).toMatch(/outside the allowed charset/);
  });

  it('a coordinator cannot use --claude-session-id to point at a self-authored, pre-fabricated transcript outside the trusted base', () => {
    // Simulate the attack: attacker plants a fully-valid-looking fabricated
    // transcript (correct nonce, correct reviewer agentType) OUTSIDE
    // ~/.claude/projects/<slug>/, then tries to point --claude-session-id at
    // it via a traversal string.
    const nonce = 'b2'.repeat(32);
    const evilRoot = mkdtempSync(join(tmpdir(), 'evil-session-'));
    writeHarnessTranscript({
      projectSlugDir: evilRoot,
      sessionId: '.',
      agentId: 'abc',
      content: `fabricated prompt ${nonceMarkerLiteral(nonce)}`,
      meta: { agentType: 'ai-sdlc:code-reviewer' },
    });

    // Even if the slug dir exists (so the traversal has somewhere to
    // "escape" from), the attack must still fail.
    const slugDir = join(claudeProjectsDir(), claudeProjectSlug(repoRoot));
    mkdirSync(slugDir, { recursive: true });

    const relativeTraversal = `../../../..${evilRoot}`;
    const result = resolveHarnessTranscriptPath({
      repoRoot,
      agentId: 'abc',
      claudeSessionId: relativeTraversal,
    });

    expect(result.transcriptPath).toBeNull();
    rmSync(evilRoot, { recursive: true, force: true });
  });

  it('rejects a symlinked session directory that resolves outside the trusted project directory', () => {
    const slugDir = join(claudeProjectsDir(), claudeProjectSlug(repoRoot));
    mkdirSync(slugDir, { recursive: true });

    const evilRoot = mkdtempSync(join(tmpdir(), 'evil-symlink-target-'));
    writeHarnessTranscript({
      projectSlugDir: evilRoot,
      sessionId: 'payload',
      agentId: 'abc',
      content: 'fabricated content',
    });

    // Plant a symlink INSIDE the trusted slugDir that points OUTSIDE it.
    const symlinkPath = join(slugDir, 'legit-looking-session');
    symlinkSync(join(evilRoot, 'payload'), symlinkPath, 'dir');

    const result = resolveHarnessTranscriptPath({
      repoRoot,
      agentId: 'abc',
      claudeSessionId: 'legit-looking-session',
    });

    expect(result.transcriptPath).toBeNull();
    expect(result.reason).toMatch(/resolves outside the trusted project directory/);
    rmSync(evilRoot, { recursive: true, force: true });
  });

  it('computeHarnessTranscriptHash end-to-end: a traversal --claude-session-id never yields a hash even with a valid nonce + marker', () => {
    const now = Date.now();
    const nonce = 'c3'.repeat(32);
    writeMarker(repoRoot, 'agent-rev7.json', {
      agentId: 'rev7',
      agentType: 'code-reviewer',
      firedAt: new Date(now).toISOString(),
    });

    // Attacker-controlled fabricated transcript sitting entirely outside
    // ~/.claude/projects/**, with a matching nonce and reviewer agentType —
    // everything opt-a checks for, EXCEPT it isn't in the trusted location.
    const evilRoot = mkdtempSync(join(tmpdir(), 'evil-e2e-'));
    writeHarnessTranscript({
      projectSlugDir: evilRoot,
      sessionId: 'session-1',
      agentId: 'rev7',
      content: `prompt ${nonceMarkerLiteral(nonce)}`,
      meta: { agentType: 'ai-sdlc:code-reviewer' },
    });

    const result = computeHarnessTranscriptHash({
      repoRoot,
      transcriptMtimeMs: now,
      nonce,
      claudeSessionId: `../../../..${evilRoot}/session-1`,
    });

    expect(result.harnessTranscriptHash).toBeNull();
    rmSync(evilRoot, { recursive: true, force: true });
  });
});

// ── Identity binding: marker location and reviewer/agent matching ───────────
// Reported by an adopter (worktree layout, three reviewers finishing within
// seconds): markers were only looked up under the worktree, and the first
// marker inside the time window was used whatever its reviewer, so leaves
// were bound to each other's transcripts.

function sha256Hex(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

describe('computeHarnessTranscriptHash — marker location and reviewer binding', () => {
  let mainRoot: string;
  let worktreeRoot: string;
  const REVIEWERS = ['security-reviewer', 'code-reviewer', 'test-reviewer'] as const;

  beforeEach(() => {
    mainRoot = mkdtempSync(join(tmpdir(), 'main-checkout-bind-'));
    initGitRepo(mainRoot);
    worktreeRoot = mkdtempSync(join(tmpdir(), 'linked-worktree-bind-'));
    rmSync(worktreeRoot, { recursive: true, force: true });
    execFileSync('git', ['worktree', 'add', '-q', '-b', 'bind-branch', worktreeRoot], {
      cwd: mainRoot,
    });
  });

  afterEach(() => {
    try {
      execFileSync('git', ['worktree', 'remove', '--force', worktreeRoot], { cwd: mainRoot });
    } catch {
      rmSync(worktreeRoot, { recursive: true, force: true });
    }
    rmSync(mainRoot, { recursive: true, force: true });
  });

  /** Three reviewers spawned ~2 s apart from a session rooted at the MAIN checkout. */
  function setUpThreeReviewers(now: number, nonce: string): Record<string, string> {
    const resolvedMainRoot = resolveMainCheckoutRoot(worktreeRoot) as string;
    const slugDir = join(claudeProjectsDir(), claudeProjectSlug(resolvedMainRoot));
    const expected: Record<string, string> = {};
    REVIEWERS.forEach((role, i) => {
      const agentId = `agent${i}${role.slice(0, 4)}`;
      // The harness writes markers under the session's directory: the main
      // checkout, with a plugin-namespaced role.
      writeMarker(resolvedMainRoot, `${agentId}.json`, {
        agentId,
        agentType: `ai-sdlc:${role}`,
        firedAt: new Date(now - 6000 + i * 2000).toISOString(),
      });
      const content = `${role} transcript ${nonceMarkerLiteral(nonce)}\n`;
      writeHarnessTranscript({
        projectSlugDir: slugDir,
        sessionId: 'session-exec',
        agentId,
        content,
        meta: { agentType: `ai-sdlc:${role}` },
      });
      expected[role] = sha256Hex(content);
    });
    return expected;
  }

  it('finds markers written under the main checkout when --repo-root is a worktree', () => {
    const now = Date.now();
    const nonce = 'c1'.repeat(32);
    const expected = setUpThreeReviewers(now, nonce);
    expect(readdirSync(worktreeRoot)).not.toContain('.ai-sdlc');

    const result = computeHarnessTranscriptHash({
      repoRoot: worktreeRoot,
      transcriptMtimeMs: now,
      nonce,
      reviewerName: 'code-reviewer',
    });
    expect(result.harnessTranscriptHash).toBe(expected['code-reviewer']);
    expect(result.reason).toBe('ok (session resolved by the agent id of the marker)');
  });

  it('binds each leaf to its own reviewer when three reviewers finish within seconds (no rotation)', () => {
    const now = Date.now();
    const nonce = 'c2'.repeat(32);
    const expected = setUpThreeReviewers(now, nonce);

    // Emit in an order different from spawn order, back to back.
    for (const role of ['code-reviewer', 'test-reviewer', 'security-reviewer']) {
      const result = computeHarnessTranscriptHash({
        repoRoot: worktreeRoot,
        transcriptMtimeMs: now,
        nonce,
        reviewerName: role,
      });
      expect(result.harnessTranscriptHash, role).toBe(expected[role]);
    }
  });

  it('binds by agent id when the caller supplies it, and refuses an id that belongs to another reviewer', () => {
    const now = Date.now();
    const nonce = 'c3'.repeat(32);
    const expected = setUpThreeReviewers(now, nonce);

    const own = computeHarnessTranscriptHash({
      repoRoot: worktreeRoot,
      transcriptMtimeMs: now,
      nonce,
      reviewerName: 'test-reviewer',
      agentId: 'agent2test',
    });
    expect(own.harnessTranscriptHash).toBe(expected['test-reviewer']);

    // The security reviewer's agent id offered for the code reviewer's leaf.
    const crossed = computeHarnessTranscriptHash({
      repoRoot: worktreeRoot,
      transcriptMtimeMs: now,
      nonce,
      reviewerName: 'code-reviewer',
      agentId: 'agent0secu',
    });
    expect(crossed.harnessTranscriptHash).toBeNull();
    expect(crossed.reason).toContain('no matching SubagentStart marker');
  });

  it('returns null when only other reviewers have markers', () => {
    const now = Date.now();
    const nonce = 'c4'.repeat(32);
    const resolvedMainRoot = resolveMainCheckoutRoot(worktreeRoot) as string;
    writeMarker(resolvedMainRoot, 'sec.json', {
      agentId: 'sec',
      agentType: 'ai-sdlc:security-reviewer',
      firedAt: new Date(now).toISOString(),
    });
    const result = computeHarnessTranscriptHash({
      repoRoot: worktreeRoot,
      transcriptMtimeMs: now,
      nonce,
      reviewerName: 'code-reviewer',
    });
    expect(result.harnessTranscriptHash).toBeNull();
  });

  it('refuses a legacy untyped marker whose harness-recorded role is another reviewer', () => {
    const now = Date.now();
    const nonce = 'c5'.repeat(32);
    const resolvedMainRoot = resolveMainCheckoutRoot(worktreeRoot) as string;
    const slugDir = join(claudeProjectsDir(), claudeProjectSlug(resolvedMainRoot));
    writeMarker(resolvedMainRoot, 'legacy.json', {
      agentId: 'legacy',
      firedAt: new Date(now).toISOString(),
    });
    writeHarnessTranscript({
      projectSlugDir: slugDir,
      sessionId: 's',
      agentId: 'legacy',
      content: `x ${nonceMarkerLiteral(nonce)}\n`,
      meta: { agentType: 'ai-sdlc:security-reviewer' },
    });
    const result = computeHarnessTranscriptHash({
      repoRoot: worktreeRoot,
      transcriptMtimeMs: now,
      nonce,
      reviewerName: 'code-reviewer',
    });
    expect(result.harnessTranscriptHash).toBeNull();
    expect(result.reason).toContain("does not match the leaf's reviewer 'code-reviewer'");
  });

  it('also searches an explicit --project-dir for markers', () => {
    const now = Date.now();
    const nonce = 'c6'.repeat(32);
    const sessionDir = mkdtempSync(join(tmpdir(), 'session-root-'));
    try {
      writeMarker(sessionDir, 'p1.json', {
        agentId: 'p1',
        agentType: 'code-reviewer',
        firedAt: new Date(now).toISOString(),
      });
      const content = `p ${nonceMarkerLiteral(nonce)}\n`;
      writeHarnessTranscript({
        projectSlugDir: join(claudeProjectsDir(), claudeProjectSlug(sessionDir)),
        sessionId: 's',
        agentId: 'p1',
        content,
        meta: { agentType: 'code-reviewer' },
      });
      const result = computeHarnessTranscriptHash({
        repoRoot: worktreeRoot,
        transcriptMtimeMs: now,
        nonce,
        reviewerName: 'code-reviewer',
        projectDirOverride: sessionDir,
      });
      expect(result.harnessTranscriptHash).toBe(sha256Hex(content));
    } finally {
      rmSync(sessionDir, { recursive: true, force: true });
    }
  });

  it('markerSearchRoots lists the main checkout and the override, never repoRoot itself', () => {
    const resolvedMainRoot = resolveMainCheckoutRoot(worktreeRoot) as string;
    expect(markerSearchRoots({ repoRoot: worktreeRoot })).toEqual([resolvedMainRoot]);
    expect(markerSearchRoots({ repoRoot: resolvedMainRoot })).toEqual([]);
    expect(
      markerSearchRoots({ repoRoot: worktreeRoot, projectDirOverride: '/somewhere/else' }),
    ).toEqual([resolvedMainRoot, '/somewhere/else']);
    expect(markerSearchRoots({ repoRoot: repoRoot })).toEqual([]);
  });
});

describe('findMatchingSubagentMarker — deterministic choice', () => {
  it('prefers the most recent marker of the reviewer role, independent of file name order', () => {
    const now = Date.now();
    writeMarker(repoRoot, 'a-older.json', {
      agentId: 'older',
      agentType: 'code-reviewer',
      firedAt: new Date(now - 60_000).toISOString(),
    });
    writeMarker(repoRoot, 'z-newer.json', {
      agentId: 'newer',
      agentType: 'code-reviewer',
      firedAt: new Date(now - 1_000).toISOString(),
    });
    const match = findMatchingSubagentMarker({
      repoRoot,
      transcriptMtimeMs: now,
      reviewerName: 'ai-sdlc:code-reviewer',
    });
    expect(match?.agentId).toBe('newer');
  });

  it('without a reviewer name keeps accepting any marker in the window', () => {
    const now = Date.now();
    writeMarker(repoRoot, 'm.json', { agentId: 'm', firedAt: new Date(now).toISOString() });
    expect(findMatchingSubagentMarker({ repoRoot, transcriptMtimeMs: now })?.agentId).toBe('m');
  });
});
