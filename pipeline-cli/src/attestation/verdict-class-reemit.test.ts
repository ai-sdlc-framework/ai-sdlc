/**
 * AISDLC-734: re-emitting a leaf for the same reviewer run is idempotent and
 * keeps its class; a different head cannot use an old run (no relabeling).
 *
 * Reproduction of the reported behaviour: before this task the first emit
 * deleted the SubagentStart marker, so a second emit for the same agent fell
 * back to `self-authored` even inside the 30 minute window (test (1) below
 * fails on the old code).
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  buildMarkerClaim,
  consumeSubagentMarker,
  determineVerdictClass,
  listSubagentMarkerCandidates,
  subagentSessionsDir,
} from './verdict-class.js';

let repoRoot: string;
const HEAD_A = 'a'.repeat(40);
const HEAD_B = 'b'.repeat(40);

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), 'verdict-class-reemit-'));
});
afterEach(() => {
  rmSync(repoRoot, { recursive: true, force: true });
});

function writeMarker(name: string, agentType = 'code-reviewer', firedAt = new Date()): string {
  const dir = subagentSessionsDir(repoRoot);
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, name);
  writeFileSync(
    filePath,
    JSON.stringify({
      agentId: name.replace(/\.json$/, ''),
      agentType,
      firedAt: firedAt.toISOString(),
    }),
  );
  return filePath;
}

describe('AISDLC-734 idempotent re-emit', () => {
  it('(1) a second emit for the same head and reviewer keeps `independent`', () => {
    const now = Date.now();
    writeMarker('agent-1.json');
    const opts = {
      repoRoot,
      transcriptMtimeMs: now,
      reviewerName: 'code-reviewer',
      headSha: HEAD_A,
    };
    expect(determineVerdictClass(opts)).toBe('independent');
    expect(determineVerdictClass(opts)).toBe('independent');
    expect(determineVerdictClass(opts)).toBe('independent');
  });

  it('(2) the marker is kept and bound to the head and reviewer it backed', () => {
    const file = writeMarker('agent-1.json');
    determineVerdictClass({
      repoRoot,
      transcriptMtimeMs: Date.now(),
      reviewerName: 'ai-sdlc:code-reviewer',
      headSha: HEAD_A.toUpperCase(),
    });
    expect(existsSync(file)).toBe(true);
    const marker = JSON.parse(readFileSync(file, 'utf8'));
    expect(marker.consumedFor).toEqual({ headSha: HEAD_A, reviewer: 'code-reviewer' });
    expect(marker.agentType).toBe('code-reviewer');
  });

  it('(3) no relabeling: an old run cannot back a leaf for a different head', () => {
    const now = Date.now();
    writeMarker('agent-1.json');
    const base = { repoRoot, transcriptMtimeMs: now, reviewerName: 'code-reviewer' };
    expect(determineVerdictClass({ ...base, headSha: HEAD_A })).toBe('independent');
    expect(determineVerdictClass({ ...base, headSha: HEAD_B })).toBe('self-authored');
    // ...and the original head is unaffected by the refused attempt.
    expect(determineVerdictClass({ ...base, headSha: HEAD_A })).toBe('independent');
  });

  it('(4) no relabeling across reviewers: a consumed marker never serves another role claim', () => {
    const now = Date.now();
    writeMarker('agent-1.json', 'code-reviewer');
    expect(
      determineVerdictClass({
        repoRoot,
        transcriptMtimeMs: now,
        reviewerName: 'code-reviewer',
        headSha: HEAD_A,
      }),
    ).toBe('independent');
    expect(
      determineVerdictClass({
        repoRoot,
        transcriptMtimeMs: now,
        reviewerName: 'test-reviewer',
        headSha: HEAD_A,
      }),
    ).toBe('self-authored');
  });

  it('(5) a consumed marker is invisible to lookups without a matching claim', () => {
    const file = writeMarker('agent-1.json');
    const claim = buildMarkerClaim(HEAD_A, 'code-reviewer');
    consumeSubagentMarker(file, claim);
    const query = { roots: [repoRoot], transcriptMtimeMs: Date.now(), allowUntyped: true };
    expect(listSubagentMarkerCandidates(query)).toHaveLength(0);
    expect(listSubagentMarkerCandidates({ ...query, claim })).toHaveLength(1);
    expect(
      listSubagentMarkerCandidates({
        ...query,
        claim: buildMarkerClaim(HEAD_B, 'code-reviewer'),
      }),
    ).toHaveLength(0);
  });

  it('(6) without a head the earlier delete-on-use behaviour is preserved', () => {
    const file = writeMarker('agent-1.json');
    const opts = { repoRoot, transcriptMtimeMs: Date.now() };
    expect(determineVerdictClass(opts)).toBe('independent');
    expect(existsSync(file)).toBe(false);
    expect(determineVerdictClass(opts)).toBe('self-authored');
  });

  it('(7) a hand-edited malformed claim fails safe to consumed-for-someone-else', () => {
    const file = writeMarker('agent-1.json');
    const marker = JSON.parse(readFileSync(file, 'utf8'));
    writeFileSync(file, JSON.stringify({ ...marker, consumedFor: { headSha: 5 } }));
    expect(
      determineVerdictClass({
        repoRoot,
        transcriptMtimeMs: Date.now(),
        reviewerName: 'code-reviewer',
        headSha: HEAD_A,
      }),
    ).toBe('self-authored');
  });

  it('(8) a re-emit prefers the run that already backed the claim over a fresher marker', () => {
    const now = Date.now();
    const first = writeMarker('agent-old.json', 'code-reviewer', new Date(now - 1000));
    const claim = buildMarkerClaim(HEAD_A, 'code-reviewer');
    consumeSubagentMarker(first, claim);
    writeMarker('agent-new.json', 'code-reviewer', new Date(now));
    const list = listSubagentMarkerCandidates({
      roots: [repoRoot],
      transcriptMtimeMs: now,
      reviewerName: 'code-reviewer',
      claim,
    });
    expect(list[0]?.marker.agentId).toBe('agent-old');
  });
});

describe('buildMarkerClaim', () => {
  it('returns null without a head and lowercases the head', () => {
    expect(buildMarkerClaim(undefined, 'code-reviewer')).toBeNull();
    expect(buildMarkerClaim(HEAD_A.toUpperCase(), undefined)).toEqual({
      headSha: HEAD_A,
      reviewer: '',
    });
  });
});
