/**
 * Hermetic tests for the AISDLC-142 incremental-review primitives.
 *
 * Covers AC #8 scenarios (rebase-no-content-change → skip; small-fix →
 * delta-only; large-refactor → full; first-push → full) plus the marker
 * parse/format round-trip + the delta-size predicate + contentHashV3
 * algorithm parity with the orchestrator copy.
 */

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  buildAutoApprovedVerdict,
  collectChangedFileDeltaEntries,
  computeContentHashV3,
  DEFAULT_MAX_DELTA_LINES,
  decideIncrementalReview,
  findMarkerInComments,
  formatMarker,
  MARKER_PREFIX,
  parseMarker,
  parseNumstatForDelta,
  type DeltaStats,
  type MarkerPayload,
  type RunGit,
} from './incremental.js';

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
