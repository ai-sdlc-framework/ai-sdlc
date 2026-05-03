/**
 * Hermetic tests for the AISDLC-142 incremental-review primitives.
 *
 * Covers AC #8 scenarios (rebase-no-content-change → skip; small-fix →
 * delta-only; large-refactor → full; first-push → full) plus the marker
 * parse/format round-trip + the delta-size predicate + contentHashV3
 * algorithm parity with the orchestrator copy.
 *
 * AISDLC-151 also exercises the bash-side defense-in-depth validator that
 * lives in `.github/workflows/ai-sdlc-review.yml` (analyze job) — see the
 * final `describe('AISDLC-151 …')` block at the bottom of this file.
 */

import { spawnSync } from 'node:child_process';
import { createHash, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _resetWarnLatchForTests,
  buildAutoApprovedVerdict,
  collectChangedFileDeltaEntries,
  computeContentHashV3,
  DEFAULT_MAX_DELTA_LINES,
  decideIncrementalReview,
  filterTrustedComments,
  findMarkerInComments,
  findTrustedMarkerInComments,
  formatMarker,
  MARKER_HMAC_SECRET_ENV,
  MARKER_PREFIX,
  MARKER_SUFFIX,
  parseMarker,
  parseNumstatForDelta,
  TRUSTED_MARKER_AUTHOR_ASSOCIATIONS,
  TRUSTED_MARKER_AUTHOR_LOGINS,
  type CommentWithAuthor,
  type DeltaStats,
  type MarkerPayload,
  type RunGit,
} from './incremental.js';

// Reset module-level warn latch + env between tests so the v1-deprecation /
// v2-no-secret / format-no-secret warnings fire deterministically on demand.
// Without these resets the latch state leaks across test files in vitest's
// shared-module mode and the "warns once" assertions become order-dependent.
beforeEach(() => {
  _resetWarnLatchForTests();
  delete process.env[MARKER_HMAC_SECRET_ENV];
});

// ── Marker parse / format round-trip ────────────────────────────────

describe('formatMarker / parseMarker', () => {
  it('round-trips a payload exactly', () => {
    const payload: MarkerPayload = {
      contentHash: 'a'.repeat(64),
      reviewedSha: 'b'.repeat(40),
      reviewedAt: '2026-05-01T12:34:56.000Z',
    };
    const body = formatMarker(payload);
    expect(body.startsWith(MARKER_PREFIX)).toBe(true);
    expect(body.endsWith(' -->')).toBe(true);
    const parsed = parseMarker(body);
    expect(parsed).toEqual(payload);
  });

  it('locates the marker even when surrounded by other markdown', () => {
    const payload: MarkerPayload = {
      contentHash: 'c'.repeat(64),
      reviewedSha: 'd'.repeat(40),
      reviewedAt: '2026-05-02T01:02:03.000Z',
    };
    const body = `## AI-SDLC: incremental review state\n\nLast reviewed: foo\n\n${formatMarker(payload)}\n\n_Edit at your own peril._`;
    expect(parseMarker(body)).toEqual(payload);
  });

  it('returns null when no marker is present', () => {
    expect(parseMarker('## Some other comment\n\nHello world.\n')).toBeNull();
    expect(parseMarker('')).toBeNull();
  });

  it('returns null on a malformed marker (corrupt b64)', () => {
    const body = `${MARKER_PREFIX}!!! not base64 !!! -->`;
    expect(parseMarker(body)).toBeNull();
  });

  it('returns null when the parsed JSON has the wrong shape', () => {
    const body = `${MARKER_PREFIX}${Buffer.from('{"contentHash":"too-short","reviewedSha":"x","reviewedAt":"now"}').toString('base64url')} -->`;
    expect(parseMarker(body)).toBeNull();
  });

  it('returns null when the marker is unterminated', () => {
    expect(parseMarker(`${MARKER_PREFIX}some-payload-but-no-suffix`)).toBeNull();
  });

  it('returns null when the encoded payload is empty', () => {
    expect(parseMarker(`${MARKER_PREFIX} -->`)).toBeNull();
  });

  it('lowercases case-insensitive hex fields on parse', () => {
    const body = formatMarker({
      contentHash: 'A'.repeat(64),
      reviewedSha: 'B'.repeat(40),
      reviewedAt: '2026-05-01T00:00:00.000Z',
    });
    const parsed = parseMarker(body);
    expect(parsed?.contentHash).toBe('a'.repeat(64));
    expect(parsed?.reviewedSha).toBe('b'.repeat(40));
  });
});

describe('findMarkerInComments', () => {
  it('returns the LAST marker when multiple comments carry one (freshest wins)', () => {
    const older = formatMarker({
      contentHash: '1'.repeat(64),
      reviewedSha: '1'.repeat(40),
      reviewedAt: '2026-05-01T00:00:00.000Z',
    });
    const newer = formatMarker({
      contentHash: '2'.repeat(64),
      reviewedSha: '2'.repeat(40),
      reviewedAt: '2026-05-02T00:00:00.000Z',
    });
    expect(findMarkerInComments([older, 'no marker here', newer])?.contentHash).toBe(
      '2'.repeat(64),
    );
  });

  it('returns null when no comment has a marker', () => {
    expect(findMarkerInComments(['hello', 'world'])).toBeNull();
  });

  it('returns null on an empty list', () => {
    expect(findMarkerInComments([])).toBeNull();
  });
});

// ── ContentHashV3 parity with orchestrator ─────────────────────────

/**
 * Reference implementation of the canonical `contentHashV3` encoding pulled
 * verbatim from `orchestrator/src/runtime/attestations.ts#computeContentHashV3`.
 * Re-implementing it here keeps the parity check hermetic (no cross-package
 * src import) while still asserting the algorithms are byte-identical. If
 * the orchestrator copy ever changes, this test must be updated too.
 */
function referenceContentHashV3(
  entries: { path: string; baseBlobSha: string; headBlobSha: string }[],
): string {
  const sha256Hex = (s: string): string => createHash('sha256').update(s, 'utf-8').digest('hex');
  const byPath = new Map<string, { baseBlobSha: string; headBlobSha: string }>();
  for (const e of entries) {
    const normalizedPath = e.path.replace(/\\/g, '/');
    byPath.set(normalizedPath, {
      baseBlobSha: e.baseBlobSha.toLowerCase(),
      headBlobSha: e.headBlobSha.toLowerCase(),
    });
  }
  const sorted = [...byPath.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const canonical = sorted
    .map(([path, { baseBlobSha, headBlobSha }]) => {
      const fileDeltaHash = sha256Hex(`${baseBlobSha} -> ${headBlobSha}`);
      return `${path}\t${fileDeltaHash}\n`;
    })
    .join('');
  return sha256Hex(canonical);
}

describe('computeContentHashV3 — algorithm parity with orchestrator', () => {
  it('produces byte-identical hashes to the orchestrator reference implementation', () => {
    const entries = [
      { path: 'src/foo.ts', baseBlobSha: 'aa'.repeat(20), headBlobSha: 'bb'.repeat(20) },
      { path: 'docs/intro.md', baseBlobSha: '', headBlobSha: 'cc'.repeat(20) },
    ];
    expect(computeContentHashV3(entries)).toBe(referenceContentHashV3(entries));
  });

  it('ignores path order via dedup-by-path + sort', () => {
    const a = [
      { path: 'a.ts', baseBlobSha: '11'.repeat(20), headBlobSha: '22'.repeat(20) },
      { path: 'b.ts', baseBlobSha: '33'.repeat(20), headBlobSha: '44'.repeat(20) },
    ];
    const b = [a[1], a[0]];
    expect(computeContentHashV3(a)).toBe(computeContentHashV3(b));
  });

  it('returns sha256("") for an empty entry list (well-defined no-op)', () => {
    // sha256 of the empty string — verifiable independently.
    expect(computeContentHashV3([])).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  it('rejects path entries containing tabs or newlines (canonical injectivity)', () => {
    expect(() =>
      computeContentHashV3([{ path: 'a\tb.ts', baseBlobSha: '', headBlobSha: '' }]),
    ).toThrow(/tab or newline/);
    expect(() =>
      computeContentHashV3([{ path: 'a\nb.ts', baseBlobSha: '', headBlobSha: '' }]),
    ).toThrow(/tab or newline/);
  });

  it('rejects malformed inputs with a precise reason', () => {
    expect(() => computeContentHashV3([{ path: '', baseBlobSha: '', headBlobSha: '' }])).toThrow(
      /non-empty/,
    );
    // Force the bad-type branches via `any`-style casts — pure-function
    // contract validation, not type-system sugar.
    expect(() =>
      computeContentHashV3([
        { path: 'a.ts', baseBlobSha: 1 as unknown as string, headBlobSha: '' },
      ]),
    ).toThrow(/baseBlobSha/);
    expect(() =>
      computeContentHashV3([
        { path: 'a.ts', baseBlobSha: '', headBlobSha: 1 as unknown as string },
      ]),
    ).toThrow(/headBlobSha/);
  });
});

// ── collectChangedFileDeltaEntries — exercises the runGit injection ─

describe('collectChangedFileDeltaEntries', () => {
  function makeRunGit(responses: Record<string, string>): RunGit {
    return (args: string[], _cwd: string) => {
      const key = args.join(' ');
      for (const k of Object.keys(responses)) {
        if (key.includes(k)) return responses[k];
      }
      throw new Error(`unexpected git invocation: ${key}`);
    };
  }

  it('walks merge-base + diff --name-only + ls-tree and assembles entries', () => {
    const runGit = makeRunGit({
      'merge-base origin/main HEAD': 'a'.repeat(40) + '\n',
      'diff --name-only --no-renames origin/main...HEAD': 'src/foo.ts\nsrc/bar.ts\n',
      [`ls-tree -r ${'a'.repeat(40)} -- src/foo.ts`]: `100644 blob ${'1'.repeat(40)}\tsrc/foo.ts\n`,
      'ls-tree -r HEAD -- src/foo.ts': `100644 blob ${'2'.repeat(40)}\tsrc/foo.ts\n`,
      [`ls-tree -r ${'a'.repeat(40)} -- src/bar.ts`]: '', // newly added file
      'ls-tree -r HEAD -- src/bar.ts': `100644 blob ${'3'.repeat(40)}\tsrc/bar.ts\n`,
    });
    const entries = collectChangedFileDeltaEntries('origin/main', 'HEAD', '/tmp/repo', runGit);
    expect(entries).toEqual([
      { path: 'src/foo.ts', baseBlobSha: '1'.repeat(40), headBlobSha: '2'.repeat(40) },
      { path: 'src/bar.ts', baseBlobSha: '', headBlobSha: '3'.repeat(40) },
    ]);
  });

  it('throws a tagged error when git merge-base fails', () => {
    const runGit: RunGit = (args) => {
      if (args[0] === 'merge-base') throw new Error('boom');
      return '';
    };
    expect(() => collectChangedFileDeltaEntries('a', 'b', '/r', runGit)).toThrow(
      /git merge-base failed/,
    );
  });

  it('throws when merge-base returns non-SHA output (defends against weird CI envs)', () => {
    const runGit: RunGit = (args) => (args[0] === 'merge-base' ? 'not-a-sha\n' : '');
    expect(() => collectChangedFileDeltaEntries('a', 'b', '/r', runGit)).toThrow(/non-SHA output/);
  });

  it('throws when git diff --name-only fails', () => {
    const runGit: RunGit = (args) => {
      if (args[0] === 'merge-base') return 'a'.repeat(40) + '\n';
      throw new Error('diff blew up');
    };
    expect(() => collectChangedFileDeltaEntries('a', 'b', '/r', runGit)).toThrow(
      /git diff --name-only failed/,
    );
  });

  it('rejects paths containing tab/newline (mirrors injectivity guard)', () => {
    const runGit: RunGit = (args) => {
      if (args[0] === 'merge-base') return 'a'.repeat(40) + '\n';
      if (args.includes('--name-only')) return 'bad\tpath.ts\n';
      return '';
    };
    expect(() => collectChangedFileDeltaEntries('origin/main', 'HEAD', '/r', runGit)).toThrow(
      /tab or newline/,
    );
  });

  it('treats empty ls-tree output as a deleted file (empty blob marker)', () => {
    const runGit = makeRunGit({
      'merge-base origin/main HEAD': 'a'.repeat(40) + '\n',
      'diff --name-only --no-renames origin/main...HEAD': 'src/old.ts\n',
      [`ls-tree -r ${'a'.repeat(40)} -- src/old.ts`]: `100644 blob ${'4'.repeat(40)}\tsrc/old.ts\n`,
      'ls-tree -r HEAD -- src/old.ts': '', // file deleted at HEAD
    });
    const entries = collectChangedFileDeltaEntries('origin/main', 'HEAD', '/r', runGit);
    expect(entries[0].headBlobSha).toBe('');
    expect(entries[0].baseBlobSha).toBe('4'.repeat(40));
  });

  it('treats ls-tree throwing as an empty blob (path missing at ref)', () => {
    const runGit: RunGit = (args) => {
      if (args[0] === 'merge-base') return 'a'.repeat(40) + '\n';
      if (args.includes('--name-only')) return 'src/x.ts\n';
      throw new Error('ls-tree exploded');
    };
    const entries = collectChangedFileDeltaEntries('origin/main', 'HEAD', '/r', runGit);
    expect(entries).toEqual([{ path: 'src/x.ts', baseBlobSha: '', headBlobSha: '' }]);
  });
});

// ── parseNumstatForDelta ────────────────────────────────────────────

describe('parseNumstatForDelta', () => {
  it('sums lines + collects top-level dirs', () => {
    const out = parseNumstatForDelta(
      ['10\t2\tsrc/foo.ts', '0\t5\tdocs/intro.md', '3\t0\tREADME.md'].join('\n'),
    );
    expect(out.linesAdded).toBe(13);
    expect(out.linesRemoved).toBe(7);
    expect(out.totalLines).toBe(20);
    expect(out.filesChanged).toBe(3);
    expect([...out.topLevelDirs].sort()).toEqual(['', 'docs', 'src']);
  });

  it("treats `-` (binary) as 0 lines so binary churn doesn't fall through to the cap", () => {
    const out = parseNumstatForDelta('-\t-\tsrc/image.png\n10\t0\tsrc/wire.ts\n');
    expect(out.linesAdded).toBe(10);
    expect(out.linesRemoved).toBe(0);
    expect(out.filesChanged).toBe(2);
  });

  it('skips blank lines + malformed lines', () => {
    const out = parseNumstatForDelta('\nnot-a-numstat-line\n5\t1\tsrc/foo.ts\n');
    expect(out.totalLines).toBe(6);
    expect(out.filesChanged).toBe(1);
  });
});

// ── decideIncrementalReview — AC #8 scenarios ──────────────────────

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const SHA_A = '1'.repeat(40);

const emptyStats: DeltaStats = {
  linesAdded: 0,
  linesRemoved: 0,
  totalLines: 0,
  topLevelDirs: new Set<string>(),
  filesChanged: 0,
};

describe('decideIncrementalReview — AC #8 scenarios', () => {
  it('AC #8.4 first-push (no marker) → full review (`no-marker`)', () => {
    const d = decideIncrementalReview({
      prior: null,
      currentContentHash: HASH_A,
      deltaStats: emptyStats,
      fullDiffTopLevelDirs: new Set(['src']),
    });
    expect(d.skip).toBe(false);
    expect(d.deltaOnly).toBe(false);
    expect(d.reason).toBe('no-marker');
    expect(d.lastReviewedSha).toBeNull();
    expect(d.priorContentHash).toBeNull();
    expect(d.currentContentHash).toBe(HASH_A);
  });

  it('AC #8.1 rebase-no-content-change (hash equal) → SKIP (`unchanged`)', () => {
    const d = decideIncrementalReview({
      prior: { contentHash: HASH_A, reviewedSha: SHA_A, reviewedAt: '2026-05-01T00:00:00.000Z' },
      currentContentHash: HASH_A,
      deltaStats: { ...emptyStats, totalLines: 999 }, // even huge delta
      fullDiffTopLevelDirs: new Set(['src']),
    });
    expect(d.skip).toBe(true);
    expect(d.deltaOnly).toBe(false);
    expect(d.reason).toBe('unchanged');
    expect(d.lastReviewedSha).toBe(SHA_A);
    expect(d.priorContentHash).toBe(HASH_A);
  });

  it('AC #8.2 small-fix scenario → DELTA-ONLY (`delta-only`)', () => {
    const d = decideIncrementalReview({
      prior: { contentHash: HASH_A, reviewedSha: SHA_A, reviewedAt: '2026-05-01T00:00:00.000Z' },
      currentContentHash: HASH_B,
      deltaStats: {
        linesAdded: 4,
        linesRemoved: 1,
        totalLines: 5,
        topLevelDirs: new Set(['src']),
        filesChanged: 1,
      },
      fullDiffTopLevelDirs: new Set(['src', 'docs']),
    });
    expect(d.skip).toBe(false);
    expect(d.deltaOnly).toBe(true);
    expect(d.reason).toBe('delta-only');
    expect(d.deltaSize).toBe(5);
  });

  it('AC #8.3 large-refactor scenario → FULL review (`delta-too-large`)', () => {
    const d = decideIncrementalReview({
      prior: { contentHash: HASH_A, reviewedSha: SHA_A, reviewedAt: '2026-05-01T00:00:00.000Z' },
      currentContentHash: HASH_B,
      deltaStats: {
        linesAdded: 350,
        linesRemoved: 100,
        totalLines: 450,
        topLevelDirs: new Set(['src']),
        filesChanged: 12,
      },
      fullDiffTopLevelDirs: new Set(['src']),
    });
    expect(d.skip).toBe(false);
    expect(d.deltaOnly).toBe(false);
    expect(d.reason).toBe('delta-too-large');
  });

  it('boundary: delta exactly at the cap stays delta-only (cap is `>`, not `>=`)', () => {
    const d = decideIncrementalReview({
      prior: { contentHash: HASH_A, reviewedSha: SHA_A, reviewedAt: '2026-05-01T00:00:00.000Z' },
      currentContentHash: HASH_B,
      deltaStats: {
        linesAdded: DEFAULT_MAX_DELTA_LINES,
        linesRemoved: 0,
        totalLines: DEFAULT_MAX_DELTA_LINES,
        topLevelDirs: new Set(['src']),
        filesChanged: 1,
      },
      fullDiffTopLevelDirs: new Set(['src']),
    });
    expect(d.deltaOnly).toBe(true);
  });

  it('configurable cap: `--max-delta-lines 50` shrinks the threshold', () => {
    const d = decideIncrementalReview({
      prior: { contentHash: HASH_A, reviewedSha: SHA_A, reviewedAt: '2026-05-01T00:00:00.000Z' },
      currentContentHash: HASH_B,
      deltaStats: {
        linesAdded: 60,
        linesRemoved: 0,
        totalLines: 60,
        topLevelDirs: new Set(['src']),
        filesChanged: 1,
      },
      fullDiffTopLevelDirs: new Set(['src']),
      maxDeltaLines: 50,
    });
    expect(d.reason).toBe('delta-too-large');
  });

  it('safety: delta touches a top-level dir not in full PR → FULL (`new-top-level-dir`)', () => {
    // Arises when the delta itself adds a brand-new top-level dir vs. the
    // full PR diff at the time of the prior review. We approximate via the
    // current full-diff set; if the delta dir isn't in that set, the delta
    // is the FIRST push touching it.
    const d = decideIncrementalReview({
      prior: { contentHash: HASH_A, reviewedSha: SHA_A, reviewedAt: '2026-05-01T00:00:00.000Z' },
      currentContentHash: HASH_B,
      deltaStats: {
        linesAdded: 10,
        linesRemoved: 0,
        totalLines: 10,
        topLevelDirs: new Set(['scripts']), // scripts NOT in full-diff set
        filesChanged: 1,
      },
      fullDiffTopLevelDirs: new Set(['src']),
    });
    expect(d.deltaOnly).toBe(false);
    expect(d.reason).toBe('new-top-level-dir');
  });

  it('safety: delta-only never returned with skip=true (mutual exclusion)', () => {
    // Defensive — verify the function NEVER returns both flags true.
    const cases: Parameters<typeof decideIncrementalReview>[0][] = [
      {
        prior: null,
        currentContentHash: HASH_A,
        deltaStats: emptyStats,
        fullDiffTopLevelDirs: new Set(),
      },
      {
        prior: { contentHash: HASH_A, reviewedSha: SHA_A, reviewedAt: '' },
        currentContentHash: HASH_A,
        deltaStats: emptyStats,
        fullDiffTopLevelDirs: new Set(),
      },
      {
        prior: { contentHash: HASH_A, reviewedSha: SHA_A, reviewedAt: '' },
        currentContentHash: HASH_B,
        deltaStats: { ...emptyStats, totalLines: 5, topLevelDirs: new Set(['src']) },
        fullDiffTopLevelDirs: new Set(['src']),
      },
    ];
    for (const inp of cases) {
      const d = decideIncrementalReview(inp);
      expect(d.skip && d.deltaOnly).toBe(false);
    }
  });
});

// ── Trusted-author filter (AISDLC-142 round-2 CRITICAL fix) ────────
//
// Threat model: an external GitHub user (or a fork-PR contributor) posts a
// PR comment whose body contains a forged
// `<!-- ai-sdlc:last-reviewed-contenthash:<base64url> -->` marker carrying
// the publicly-computable current contentHashV3. Without an author filter,
// the next push reads the marker, sees `prior.contentHash === current` →
// SKIP review → auto-approves all 3 reviewers → satisfies the
// required-merge-gate check. Authorization bypass with the same blast
// radius as a forged review approval.
//
// Defense (Layer 1 in this module): `filterTrustedComments` drops every
// comment whose `authorLogin` is not in `TRUSTED_MARKER_AUTHOR_LOGINS` AND
// whose `authorAssociation` is not in `TRUSTED_MARKER_AUTHOR_ASSOCIATIONS`.
// `findTrustedMarkerInComments` chains the filter with the marker search
// so callers can't accidentally skip the filter.

describe('TRUSTED_MARKER_AUTHOR_LOGINS / TRUSTED_MARKER_AUTHOR_ASSOCIATIONS', () => {
  it('includes both flavors of the github-actions login (GraphQL + REST)', () => {
    expect(TRUSTED_MARKER_AUTHOR_LOGINS.has('github-actions')).toBe(true);
    expect(TRUSTED_MARKER_AUTHOR_LOGINS.has('github-actions[bot]')).toBe(true);
  });

  it('does NOT trust the legacy ai-sdlc-ci-attestor login (removed in AISDLC-152)', () => {
    // The AISDLC-87 CI-side attestor was removed in AISDLC-140 sub-4
    // (attestation made audit-only) and AISDLC-152 (this task) ripped
    // the remaining wiring including the trust allowlist entries.
    expect(TRUSTED_MARKER_AUTHOR_LOGINS.has('ai-sdlc-ci-attestor')).toBe(false);
    expect(TRUSTED_MARKER_AUTHOR_LOGINS.has('ai-sdlc-ci-attestor[bot]')).toBe(false);
  });

  it('does NOT trust unrelated bots (codecov, dependabot, etc.)', () => {
    expect(TRUSTED_MARKER_AUTHOR_LOGINS.has('codecov')).toBe(false);
    expect(TRUSTED_MARKER_AUTHOR_LOGINS.has('codecov[bot]')).toBe(false);
    expect(TRUSTED_MARKER_AUTHOR_LOGINS.has('dependabot[bot]')).toBe(false);
  });

  it('trusts only push-access associations (OWNER / MEMBER / COLLABORATOR)', () => {
    for (const a of ['OWNER', 'MEMBER', 'COLLABORATOR']) {
      expect(TRUSTED_MARKER_AUTHOR_ASSOCIATIONS.has(a)).toBe(true);
    }
    for (const a of ['CONTRIBUTOR', 'NONE', 'FIRST_TIME_CONTRIBUTOR', 'FIRST_TIMER']) {
      expect(TRUSTED_MARKER_AUTHOR_ASSOCIATIONS.has(a)).toBe(false);
    }
  });
});

describe('filterTrustedComments', () => {
  const validMarker = formatMarker({
    contentHash: 'a'.repeat(64),
    reviewedSha: '1'.repeat(40),
    reviewedAt: '2026-05-01T00:00:00.000Z',
  });

  it('keeps comments authored by github-actions (workflow-authored markers)', () => {
    const comments: CommentWithAuthor[] = [
      { authorLogin: 'github-actions', authorAssociation: 'CONTRIBUTOR', body: validMarker },
    ];
    expect(filterTrustedComments(comments)).toEqual([validMarker]);
  });

  it('drops comments authored by the legacy ai-sdlc-ci-attestor bot (AISDLC-152)', () => {
    // The CI-side attestor was retired (AISDLC-140 sub-4 + AISDLC-152);
    // its login is no longer in TRUSTED_MARKER_AUTHOR_LOGINS, so a
    // comment carrying NONE / OUTSIDE_COLLABORATOR association from
    // that login is now correctly filtered out.
    const comments: CommentWithAuthor[] = [
      { authorLogin: 'ai-sdlc-ci-attestor[bot]', authorAssociation: 'NONE', body: validMarker },
    ];
    expect(filterTrustedComments(comments)).toEqual([]);
  });

  it('keeps comments from OWNER / MEMBER / COLLABORATOR even with unknown logins', () => {
    const comments: CommentWithAuthor[] = [
      { authorLogin: 'maintainer-1', authorAssociation: 'OWNER', body: 'a' },
      { authorLogin: 'maintainer-2', authorAssociation: 'MEMBER', body: 'b' },
      { authorLogin: 'maintainer-3', authorAssociation: 'COLLABORATOR', body: 'c' },
    ];
    expect(filterTrustedComments(comments)).toEqual(['a', 'b', 'c']);
  });

  it('AC #2 — DROPS comments authored by external-attacker carrying a forged marker', () => {
    const comments: CommentWithAuthor[] = [
      { authorLogin: 'external-attacker', authorAssociation: 'NONE', body: validMarker },
      { authorLogin: 'fork-pr-contributor', authorAssociation: 'CONTRIBUTOR', body: validMarker },
      {
        authorLogin: 'first-timer',
        authorAssociation: 'FIRST_TIME_CONTRIBUTOR',
        body: validMarker,
      },
    ];
    expect(filterTrustedComments(comments)).toEqual([]);
  });

  it('drops unrelated bots (codecov, dependabot) even when they post lookalike bodies', () => {
    const comments: CommentWithAuthor[] = [
      { authorLogin: 'codecov', authorAssociation: 'NONE', body: validMarker },
      { authorLogin: 'codecov[bot]', authorAssociation: 'NONE', body: validMarker },
      { authorLogin: 'dependabot[bot]', authorAssociation: 'CONTRIBUTOR', body: validMarker },
    ];
    expect(filterTrustedComments(comments)).toEqual([]);
  });

  it('preserves input order (idempotent against the freshest-wins findMarker scan)', () => {
    const comments: CommentWithAuthor[] = [
      { authorLogin: 'github-actions', authorAssociation: 'CONTRIBUTOR', body: 'first' },
      { authorLogin: 'external', authorAssociation: 'NONE', body: 'attacker' },
      { authorLogin: 'github-actions', authorAssociation: 'CONTRIBUTOR', body: 'second' },
    ];
    expect(filterTrustedComments(comments)).toEqual(['first', 'second']);
  });

  it('returns an empty list for an empty input (no crash)', () => {
    expect(filterTrustedComments([])).toEqual([]);
  });

  it('treats missing authorLogin / authorAssociation as untrusted (defense-in-depth)', () => {
    const comments: CommentWithAuthor[] = [
      { authorLogin: '', authorAssociation: '', body: validMarker },
    ];
    expect(filterTrustedComments(comments)).toEqual([]);
  });
});

describe('findTrustedMarkerInComments — end-to-end safety check', () => {
  const trustedMarker = formatMarker({
    contentHash: 'a'.repeat(64),
    reviewedSha: '1'.repeat(40),
    reviewedAt: '2026-05-01T00:00:00.000Z',
  });
  const forgedMarker = formatMarker({
    contentHash: 'f'.repeat(64),
    reviewedSha: '2'.repeat(40),
    reviewedAt: '2026-05-02T00:00:00.000Z',
  });

  it('AC #2 — IGNORES a forged marker authored by external-attacker (returns null)', () => {
    const comments: CommentWithAuthor[] = [
      { authorLogin: 'external-attacker', authorAssociation: 'NONE', body: forgedMarker },
    ];
    expect(findTrustedMarkerInComments(comments)).toBeNull();
  });

  it('AC #3 — HONORS a marker authored by github-actions[bot] normally', () => {
    const comments: CommentWithAuthor[] = [
      { authorLogin: 'github-actions', authorAssociation: 'CONTRIBUTOR', body: trustedMarker },
    ];
    const m = findTrustedMarkerInComments(comments);
    expect(m).not.toBeNull();
    expect(m?.contentHash).toBe('a'.repeat(64));
    expect(m?.reviewedSha).toBe('1'.repeat(40));
  });

  it('AC #2+#3 mixed — picks the LATEST trusted marker, ignores attacker comments interleaved', () => {
    // Threat scenario: attacker posts AFTER the bot, trying to override.
    // Without the filter, findMarkerInComments would return the attacker's
    // forged marker (LAST-occurrence wins). With the filter, the attacker
    // is dropped and the bot's earlier marker survives.
    const comments: CommentWithAuthor[] = [
      { authorLogin: 'github-actions', authorAssociation: 'CONTRIBUTOR', body: trustedMarker },
      { authorLogin: 'external-attacker', authorAssociation: 'NONE', body: forgedMarker },
    ];
    const m = findTrustedMarkerInComments(comments);
    expect(m?.contentHash).toBe('a'.repeat(64)); // trusted, not 'f'.repeat(64)
  });

  it('returns null when ALL trusted comments are non-marker (no false positive)', () => {
    const comments: CommentWithAuthor[] = [
      { authorLogin: 'github-actions', authorAssociation: 'CONTRIBUTOR', body: 'CI build status' },
      { authorLogin: 'maintainer', authorAssociation: 'OWNER', body: 'LGTM' },
    ];
    expect(findTrustedMarkerInComments(comments)).toBeNull();
  });

  it('returns null when comment list is empty', () => {
    expect(findTrustedMarkerInComments([])).toBeNull();
  });
});

// ── buildAutoApprovedVerdict ────────────────────────────────────────

describe('buildAutoApprovedVerdict', () => {
  it('produces the auto-approved shape that matches AISDLC-141 schema', () => {
    const v = buildAutoApprovedVerdict('1'.repeat(40));
    expect(v.approved).toBe(true);
    expect(v.findings).toEqual([]);
    expect(v.summary).toMatch(/Skipped by incremental review/);
    expect(v.summary).toContain('1'.repeat(40));
  });
});

// ── HMAC-signed v2 markers (AISDLC-146 — Layer 2 defense-in-depth) ──
//
// Threat model: a TRUSTED COLLABORATOR (login passes the AISDLC-142
// Layer-1 trusted-author filter) posts a forged marker comment binding
// the publicly-computable current contentHashV3. Without HMAC, the
// next push would honor that comment, skip review, and auto-approve.
// With HMAC the forgery has to also produce a valid SHA-256 keyed by
// the bot's secret — a key the attacker doesn't possess.
//
// Coverage matrix (AC #4):
//   1. v2 with valid HMAC                              → parses
//   2. v2 with tampered HMAC (single-bit flip)         → null
//   3. v2 with payload tampered, HMAC re-signed under
//      a DIFFERENT secret                              → null
//   4. v1 marker                                       → parses with warn
//   5. Missing secret env var:
//        formatMarker → v1 + console.warn
//        parseMarker  → rejects v2 entirely
//   6. Operator v1 marker by trusted author + valid
//      contentHash                                     → still respected

const SECRET_A = 'a'.repeat(64); // primary secret (test fixture)
const SECRET_B = 'b'.repeat(64); // attacker's "guess" secret

const v2Payload: MarkerPayload = {
  contentHash: 'd'.repeat(64),
  reviewedSha: 'e'.repeat(40),
  reviewedAt: '2026-05-01T12:00:00.000Z',
};

/** Reference HMAC computer pinned to Node's `crypto` for parity assertions. */
function refHmac(json: string, secret: string): string {
  return createHmac('sha256', secret).update(json, 'utf-8').digest('hex');
}

describe('formatMarker — version selection (AISDLC-146 AC #1)', () => {
  it('emits v2 by default when MARKER_HMAC_SECRET env is set', () => {
    process.env[MARKER_HMAC_SECRET_ENV] = SECRET_A;
    const body = formatMarker(v2Payload);
    expect(body.startsWith(`${MARKER_PREFIX}v2:`)).toBe(true);
    expect(body.endsWith(MARKER_SUFFIX)).toBe(true);
    // Wire shape: `<prefix>v2:<base64>:<hmac><suffix>` — verify the HMAC
    // segment is exactly 64 hex chars (sha256 hex digest).
    const inner = body.slice(MARKER_PREFIX.length, body.length - MARKER_SUFFIX.length);
    const lastColon = inner.lastIndexOf(':');
    const hmacPart = inner.slice(lastColon + 1);
    expect(/^[0-9a-f]{64}$/.test(hmacPart)).toBe(true);
  });

  it('emits v1 with one-time console.warn when env secret is missing', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const body = formatMarker(v2Payload);
    expect(body.startsWith(`${MARKER_PREFIX}v1:`)).toBe(true);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toMatch(/MARKER_HMAC_SECRET/);
    // Second call within the same process must NOT re-warn — the latch
    // ensures CI logs aren't flooded on multi-step pushes.
    formatMarker(v2Payload);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });

  it('honors explicit opts.version=1 even when secret is set (escape hatch)', () => {
    process.env[MARKER_HMAC_SECRET_ENV] = SECRET_A;
    const body = formatMarker(v2Payload, { version: 1 });
    expect(body.startsWith(`${MARKER_PREFIX}v1:`)).toBe(true);
    // No warn — explicit `opts.version` short-circuits the missing-secret
    // banner branch.
  });

  it('honors explicit opts.secret override (env-independent)', () => {
    // No env, but caller passes a secret directly → v2 still emitted.
    const body = formatMarker(v2Payload, { secret: SECRET_A });
    expect(body.startsWith(`${MARKER_PREFIX}v2:`)).toBe(true);
  });

  it('throws when v2 is requested but no secret is available (no silent v2-without-key)', () => {
    expect(() => formatMarker(v2Payload, { version: 2 })).toThrow(
      /v2 requires a non-empty MARKER_HMAC_SECRET/,
    );
  });

  it('treats empty-string secret as missing (CI-env "" handling)', () => {
    process.env[MARKER_HMAC_SECRET_ENV] = '';
    const body = formatMarker(v2Payload);
    // Empty string ≠ "secret present" — fall back to v1, not crash.
    expect(body.startsWith(`${MARKER_PREFIX}v1:`)).toBe(true);
  });
});

describe('parseMarker — v2 HMAC validation (AISDLC-146 AC #2)', () => {
  it('parses a v2 marker with a valid HMAC under the same secret', () => {
    process.env[MARKER_HMAC_SECRET_ENV] = SECRET_A;
    const body = formatMarker(v2Payload);
    const parsed = parseMarker(body);
    expect(parsed).toEqual(v2Payload);
  });

  it('rejects a v2 marker whose HMAC has been tampered with (single-char flip)', () => {
    process.env[MARKER_HMAC_SECRET_ENV] = SECRET_A;
    const body = formatMarker(v2Payload);
    // Flip the LAST hex char of the HMAC — minimal corruption that any
    // honest verifier must catch. base64url + hmac segments are
    // delimited by `:`; the suffix ` -->` is fixed.
    const suffix = MARKER_SUFFIX;
    const lastChar = body.charAt(body.length - suffix.length - 1);
    const flipped = lastChar === 'f' ? '0' : 'f';
    const tampered = body.slice(0, body.length - suffix.length - 1) + flipped + suffix;
    expect(parseMarker(tampered)).toBeNull();
  });

  it('rejects a v2 marker whose payload was tampered + HMAC re-signed under a DIFFERENT secret', () => {
    // Attacker controls the wire — they MUTATE the payload (flip a
    // contentHash bit) AND recompute the HMAC under their best-guess
    // secret. Without timing-safe HMAC verification under the bot's
    // real secret, this would parse cleanly. We must reject.
    process.env[MARKER_HMAC_SECRET_ENV] = SECRET_A;
    const tamperedPayload: MarkerPayload = {
      ...v2Payload,
      contentHash: 'f'.repeat(64), // attacker's chosen hash
    };
    const json = JSON.stringify(tamperedPayload);
    const b64 = Buffer.from(json, 'utf-8').toString('base64url');
    const hmacUnderWrongSecret = refHmac(json, SECRET_B);
    const forged = `${MARKER_PREFIX}v2:${b64}:${hmacUnderWrongSecret}${MARKER_SUFFIX}`;
    expect(parseMarker(forged)).toBeNull();
  });

  it('rejects a v2 marker when the verifier has no secret (cannot verify)', () => {
    // Bot signed the marker with SECRET_A, but the verifier process
    // doesn't have MARKER_HMAC_SECRET set — must reject (do not parse
    // an unverifiable signed payload).
    const body = formatMarker(v2Payload, { secret: SECRET_A });
    expect(parseMarker(body)).toBeNull(); // no env → reject
  });

  it('warns ONCE when rejecting v2 markers due to missing secret (operator visibility)', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const body = formatMarker(v2Payload, { secret: SECRET_A });
    parseMarker(body);
    parseMarker(body);
    parseMarker(body);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toMatch(/v2 marker.*MARKER_HMAC_SECRET/);
    warnSpy.mockRestore();
  });

  it('rejects v2 marker whose HMAC segment is the wrong length (structural guard)', () => {
    process.env[MARKER_HMAC_SECRET_ENV] = SECRET_A;
    const json = JSON.stringify(v2Payload);
    const b64 = Buffer.from(json, 'utf-8').toString('base64url');
    // 32-hex-char HMAC (half-length) — rejected by the regex guard
    // before timingSafeEqual.
    const shortHmac = '1234567890abcdef'.repeat(2);
    const body = `${MARKER_PREFIX}v2:${b64}:${shortHmac}${MARKER_SUFFIX}`;
    expect(parseMarker(body)).toBeNull();
  });

  it('rejects v2 marker missing the hmac segment entirely', () => {
    process.env[MARKER_HMAC_SECRET_ENV] = SECRET_A;
    const json = JSON.stringify(v2Payload);
    const b64 = Buffer.from(json, 'utf-8').toString('base64url');
    // No `:hmac` segment after the base64.
    const body = `${MARKER_PREFIX}v2:${b64}${MARKER_SUFFIX}`;
    expect(parseMarker(body)).toBeNull();
  });

  it('honors opts.secret override on parse (test ergonomics + custom-source callers)', () => {
    // Caller threads the secret in directly (e.g. read from a vault
    // rather than env). Symmetry with formatMarker's opts.secret.
    const body = formatMarker(v2Payload, { secret: SECRET_A });
    expect(parseMarker(body, { secret: SECRET_A })).toEqual(v2Payload);
    expect(parseMarker(body, { secret: SECRET_B })).toBeNull(); // wrong secret
  });
});

describe('parseMarker — v1 backward-compat (AISDLC-146 AC #2 + #6)', () => {
  it('AC #4 + #6 — parses an explicit v1 marker (transition compat) with deprecation warn', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const body = formatMarker(v2Payload, { version: 1 });
    // No env secret needed; v1 has no HMAC.
    const parsed = parseMarker(body);
    expect(parsed).toEqual(v2Payload);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toMatch(/v1 .*deprecated/);
    warnSpy.mockRestore();
  });

  it('parses pre-AISDLC-146 markers (no version prefix) as v1 for transition', () => {
    // Wire shape PRE-AISDLC-146 was `<prefix><base64><suffix>` (no
    // `v1:` segment). PRs that already carry such a marker must NOT
    // strand on the next push — accept silently as v1.
    const json = JSON.stringify(v2Payload);
    const b64 = Buffer.from(json, 'utf-8').toString('base64url');
    const legacyBody = `${MARKER_PREFIX}${b64}${MARKER_SUFFIX}`;
    const parsed = parseMarker(legacyBody);
    expect(parsed).toEqual(v2Payload);
  });

  it('warns ONCE about v1 deprecation across multiple parses (no log spam)', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const body = formatMarker(v2Payload, { version: 1 });
    parseMarker(body);
    parseMarker(body);
    parseMarker(body);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });

  it('AC #6 — operator-posted v1 marker by trusted author + valid contentHash is still respected', () => {
    // Threat-model adjacent assertion: a trusted-author v1 marker (e.g.
    // an in-flight marker written by the previous workflow run before
    // AISDLC-146 deployed) MUST still be honoured during the transition
    // window. Otherwise every PR with a pre-existing v1 marker re-runs
    // FULL review on the first post-deploy push (mass cost regression).
    const v1Body = formatMarker(v2Payload, { version: 1 });
    const comments: CommentWithAuthor[] = [
      {
        authorLogin: 'github-actions',
        authorAssociation: 'CONTRIBUTOR',
        body: v1Body,
      },
    ];
    const m = findTrustedMarkerInComments(comments);
    expect(m).not.toBeNull();
    expect(m?.contentHash).toBe(v2Payload.contentHash);
    expect(m?.reviewedSha).toBe(v2Payload.reviewedSha);
  });
});

describe('findMarkerInComments — HMAC-aware filtering (AISDLC-146 AC #3)', () => {
  it('returns null when the only candidate marker fails HMAC validation', () => {
    process.env[MARKER_HMAC_SECRET_ENV] = SECRET_A;
    // Forged marker — payload signed under SECRET_B, but verifier has SECRET_A.
    const json = JSON.stringify(v2Payload);
    const b64 = Buffer.from(json, 'utf-8').toString('base64url');
    const forged = `${MARKER_PREFIX}v2:${b64}:${refHmac(json, SECRET_B)}${MARKER_SUFFIX}`;
    expect(findMarkerInComments([forged])).toBeNull();
  });

  it('skips a forged v2 marker and returns the older valid v2 marker beneath it', () => {
    // findMarkerInComments scans newest-first (last-occurrence-wins).
    // If the freshest comment carries a forged marker, it must be
    // rejected and the search must continue to the next candidate —
    // NOT short-circuit "freshest-wins" into "freshest-attacker-wins".
    process.env[MARKER_HMAC_SECRET_ENV] = SECRET_A;
    const validBody = formatMarker(v2Payload); // valid v2
    const forgedJson = JSON.stringify({
      ...v2Payload,
      contentHash: '9'.repeat(64),
    });
    const forgedB64 = Buffer.from(forgedJson, 'utf-8').toString('base64url');
    const forgedBody = `${MARKER_PREFIX}v2:${forgedB64}:${refHmac(forgedJson, SECRET_B)}${MARKER_SUFFIX}`;
    const out = findMarkerInComments([validBody, forgedBody]);
    // Forged marker rejected; older valid marker survives.
    expect(out?.contentHash).toBe(v2Payload.contentHash);
  });

  it('threads opts.secret through to parseMarker (no env reliance)', () => {
    const body = formatMarker(v2Payload, { secret: SECRET_A });
    expect(findMarkerInComments([body], { secret: SECRET_A })).toEqual(v2Payload);
    expect(findMarkerInComments([body], { secret: SECRET_B })).toBeNull();
  });
});

// ── AISDLC-151: bash-side PRIOR_SHA validation in ai-sdlc-review.yml ───
//
// Defense-in-depth follow-up to the AISDLC-142 round-3 security review.
// The analyze job extracts PRIOR_SHA from the marker JSON via
// `jq -r '.reviewedSha'` and interpolates it into a git command. The
// TS-side `parseMarker` validates SHA shape, but the bash side cannot
// trust `jq`'s output blindly — a trusted COLLABORATOR could in principle
// craft a marker with a `reviewedSha` containing git-option-injection
// content (e.g. `--upload-pack=evil`). These tests verify the workflow
// carries the shell-side hex-only validator AND that the validator
// behaves correctly under a real bash interpreter for several adversarial
// inputs.

const __filename_test = fileURLToPath(import.meta.url);
const __dirname_test = dirname(__filename_test);
const WORKFLOW_PATH = resolve(__dirname_test, '../../../.github/workflows/ai-sdlc-review.yml');

/**
 * Runs the bash-side PRIOR_SHA validator in isolation against `input` and
 * returns the resulting PRIOR_SHA value (empty string when rejected).
 *
 * Mirrors the snippet in `.github/workflows/ai-sdlc-review.yml` exactly:
 *
 *   if [ -n "$PRIOR_SHA" ] && ! [[ "$PRIOR_SHA" =~ ^[0-9a-fA-F]{40}$ ]]; then
 *     echo "::warning::…" >&2
 *     PRIOR_SHA=""
 *   fi
 */
function runBashValidator(input: string): { priorSha: string; warned: boolean } {
  // Pass the input via env to avoid quoting hassles with embedded newlines
  // / single quotes — exactly matching how `$PRIOR_SHA` reaches the
  // workflow validator (a shell variable populated from a subprocess).
  const script = [
    `if [ -n "$PRIOR_SHA" ] && ! [[ "$PRIOR_SHA" =~ ^[0-9a-fA-F]{40}$ ]]; then`,
    `  echo "::warning::PRIOR_SHA from incremental-review marker failed shell-side hex validation (\\"$PRIOR_SHA\\"); falling back to FULL review" >&2`,
    `  PRIOR_SHA=""`,
    `fi`,
    `printf '%s' "$PRIOR_SHA"`,
  ].join('\n');
  const r = spawnSync('bash', ['-c', script], {
    encoding: 'utf8',
    env: { ...process.env, PRIOR_SHA: input },
  });
  if (r.status !== 0) {
    throw new Error(`bash validator exited ${r.status}: ${r.stderr}`);
  }
  return { priorSha: r.stdout, warned: r.stderr.includes('::warning::') };
}

// Skip on Windows runners (no bash). All AI-SDLC dev + CI runs on
// macOS/Linux, but vitest is occasionally invoked on Windows for
// editor-driven workflows; better to skip than throw spurious failures.
const describeBash = process.platform === 'win32' ? describe.skip : describe;

describeBash('AISDLC-151 — workflow carries bash-side PRIOR_SHA validator', () => {
  const yaml = readFileSync(WORKFLOW_PATH, 'utf8');

  it('the analyze job contains the hex-only validator regex', () => {
    // Anchored on the literal bash `[[ =~ ]]` test used by the validator.
    // If anyone refactors the workflow and drops the validator, this test
    // breaks loudly (intentional drift gate).
    expect(yaml).toContain('"$PRIOR_SHA" =~ ^[0-9a-fA-F]{40}$');
  });

  it('the validator clears PRIOR_SHA on rejection (no silent pass-through)', () => {
    expect(yaml).toMatch(/PRIOR_SHA=""/);
  });

  it('the validator emits a ::warning:: annotation for operator visibility', () => {
    expect(yaml).toContain('::warning::PRIOR_SHA');
  });

  it('the validator runs BEFORE the git diff invocation (AC #4)', () => {
    // The validator block must appear textually before the
    // `git diff "$PRIOR_SHA"...HEAD --numstat` invocation in the
    // workflow. Otherwise an unvalidated value could reach git.
    const validatorIdx = yaml.indexOf('"$PRIOR_SHA" =~ ^[0-9a-fA-F]{40}$');
    // Match the actual invocation (`--numstat` suffix), not the prose
    // mention of `git diff PRIOR_SHA…HEAD` in surrounding comments.
    const gitDiffIdx = yaml.indexOf('git diff "$PRIOR_SHA"...HEAD --numstat');
    expect(validatorIdx).toBeGreaterThan(-1);
    expect(gitDiffIdx).toBeGreaterThan(-1);
    expect(validatorIdx).toBeLessThan(gitDiffIdx);
  });
});

describeBash('AISDLC-151 — bash validator behavior (real shell)', () => {
  it('accepts a valid lowercase 40-char hex SHA', () => {
    const sha = 'a'.repeat(40);
    const { priorSha, warned } = runBashValidator(sha);
    expect(priorSha).toBe(sha);
    expect(warned).toBe(false);
  });

  it('accepts a valid uppercase 40-char hex SHA (case-insensitive)', () => {
    const sha = 'ABCDEF0123456789'.padEnd(40, 'A');
    const { priorSha, warned } = runBashValidator(sha);
    expect(priorSha).toBe(sha);
    expect(warned).toBe(false);
  });

  it('accepts a realistic mixed-case 40-char hex SHA', () => {
    const sha = 'DeadBeefCafe1234567890abcdefABCDEF012345';
    const { priorSha, warned } = runBashValidator(sha);
    expect(priorSha).toBe(sha);
    expect(warned).toBe(false);
  });

  it('rejects empty string as no-prior-SHA (no warning, just empty)', () => {
    // Empty input is the "no marker found" path — not adversarial,
    // shouldn't generate a noisy warning.
    const { priorSha, warned } = runBashValidator('');
    expect(priorSha).toBe('');
    expect(warned).toBe(false);
  });

  it('rejects a SHA that is too short (39 chars)', () => {
    const { priorSha, warned } = runBashValidator('a'.repeat(39));
    expect(priorSha).toBe('');
    expect(warned).toBe(true);
  });

  it('rejects a SHA that is too long (41 chars)', () => {
    const { priorSha, warned } = runBashValidator('a'.repeat(41));
    expect(priorSha).toBe('');
    expect(warned).toBe(true);
  });

  it('rejects git option-injection attempt (--upload-pack=evil padded to 40)', () => {
    // The headline AISDLC-151 threat. Reject anything beginning with `--`.
    const { priorSha, warned } = runBashValidator('--upload-pack=evil-payload-padded-toooo40');
    expect(priorSha).toBe('');
    expect(warned).toBe(true);
  });

  it('rejects a 40-char string containing non-hex characters (g-z)', () => {
    const { priorSha, warned } = runBashValidator('z'.repeat(40));
    expect(priorSha).toBe('');
    expect(warned).toBe(true);
  });

  it('rejects a SHA with a trailing newline (defeats anchored ^…$)', () => {
    // Embedded newlines could otherwise smuggle a second arg to git.
    const { priorSha, warned } = runBashValidator(`${'a'.repeat(40)}\n--evil`);
    expect(priorSha).toBe('');
    expect(warned).toBe(true);
  });

  it('rejects whitespace-padded valid hex (leading space)', () => {
    const { priorSha, warned } = runBashValidator(` ${'a'.repeat(39)}`);
    expect(priorSha).toBe('');
    expect(warned).toBe(true);
  });

  it('rejects shell-metacharacter injection (`$(whoami)` padded)', () => {
    // The single-quoted assignment inside runBashValidator already prevents
    // shell expansion, but this confirms the validator itself rejects the
    // literal payload — defense in depth.
    const { priorSha, warned } = runBashValidator('$(whoami)aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    expect(priorSha).toBe('');
    expect(warned).toBe(true);
  });
});
