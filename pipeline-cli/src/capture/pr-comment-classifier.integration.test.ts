/**
 * Integration test for RFC-0024 Refit Phase 4 (AISDLC-276) — closes
 * AC-8: "un-marked comment + classifier-yes → indexed; un-marked
 * comment + classifier-no → ignored".
 *
 * This test wires the full chain end-to-end:
 *
 *   PR-comment fan-out → `classifyPrCommentsBatch` → for each
 *   `classified-capture` decision, write a real capture record + append
 *   the `<!-- ai-sdlc:capture-id=... -->` footer back into the comment
 *   (the bidirectional-sync half of AC-7) → second pass over the same
 *   comment list short-circuits via the `already-linked` branch (no
 *   classifier call, no duplicate capture record).
 *
 * Uses the substrate's `FakeLlmInvoker` so it's hermetic. The
 * `repoRoot` + `corpusDir` are tmpdir-scoped so no project filesystem
 * is touched.
 *
 * @module capture/pr-comment-classifier.integration.test
 */

import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { writeSubmittedCaptureFile } from './draft-capture.js';
import { generateCaptureId } from './capture-record.js';
import type { CaptureRecord } from './capture-record.js';
import { FakeLlmInvoker } from '../classifier/substrate/fake-invoker.js';
import { appendCaptureMarkerToComment, classifyPrCommentsBatch } from './pr-comment-classifier.js';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'pr-comment-classifier-int-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/**
 * Build a `CaptureRecord` from a `classified-capture` decision and write
 * it to `backlog/captures/<id>.md` via the framework's standard
 * submitted-capture writer. Returns the written record.
 *
 * In production this lives in the caller (typically a webhook handler or
 * the `cli-capture sync-pr` command); here we inline it so the test
 * exercises the same persistence layer the rest of the framework uses.
 */
function persistClassifiedCapture(opts: {
  finding: string;
  prNumber?: number;
  commentUrl?: string;
  repoRoot: string;
}): CaptureRecord {
  const now = new Date();
  const id = generateCaptureId(now);
  const record: CaptureRecord = {
    id,
    schemaVersion: 'v1',
    timestamp: now.toISOString(),
    finding: opts.finding,
    severity: 'unknown',
    triage: 'tbd',
    source: {
      type: 'ai-agent',
      agentRole: null,
      operator: null,
      context: `pr-comment-classifier: classified PR #${opts.prNumber ?? '?'} comment as is-capture`,
    },
    evidence: {
      prNumber: opts.prNumber ?? null,
      commentUrl: opts.commentUrl ?? null,
    },
    relatedIssueId: null,
    extensionTargetIssueId: null,
    featureIssueCarveRef: null,
    blocksIssueId: null,
    createdIssueId: null,
    createdFeatureIssueId: null,
    resolvedAt: null,
    resolvedBy: null,
    auditTrail: [
      {
        action: 'captured',
        by: 'pr-comment-classifier',
        at: now.toISOString(),
        source: 'classified',
      },
    ],
  };
  writeSubmittedCaptureFile(record, opts.repoRoot);
  return record;
}

describe('AC-8: integration — un-marked classifier-yes vs classifier-no end-to-end', () => {
  it('classifier-yes path persists a capture + appends the bidirectional marker; classifier-no path persists nothing', async () => {
    // Two un-marked comments; the fake classifier returns is-capture for
    // the first and not-capture for the second.
    const comments = [
      {
        body: 'we should probably extract the rate-limit policy into a shared util — same shape in 3 places',
        author: { login: 'human-reviewer' },
        url: 'https://github.com/o/r/pull/100#discussion_r1',
        prNumber: 100,
      },
      {
        body: 'typo: rename `fooo` to `foo`',
        author: { login: 'human-reviewer' },
        url: 'https://github.com/o/r/pull/100#discussion_r2',
        prNumber: 100,
      },
    ];

    const invoker = new FakeLlmInvoker({
      'pr-comment-is-capture': (_req, callIndex) =>
        callIndex === 0
          ? {
              classification: 'is-capture',
              confidence: 0.8,
              reasoning: 'follow-up refactor concern',
              inputTokens: 80,
              outputTokens: 30,
            }
          : {
              classification: 'not-capture',
              confidence: 0.9,
              reasoning: 'cosmetic nit',
              inputTokens: 50,
              outputTokens: 20,
            },
    });

    const batch = await classifyPrCommentsBatch(comments, {
      invoker,
      repoRoot: tmp,
      corpusDir: join(tmp, 'corpus'),
    });

    expect(batch).toHaveLength(2);
    expect(batch[0].decision.kind).toBe('classified-capture');
    expect(batch[1].decision.kind).toBe('classified-skip');

    // ── Materialise the persistence side of the integration ───────────
    const indexedIds: string[] = [];
    const updatedBodies: Array<{ url: string; body: string }> = [];

    for (const { comment, decision } of batch) {
      if (decision.kind !== 'classified-capture') continue;
      const record = persistClassifiedCapture({
        finding: decision.finding,
        prNumber: comment.prNumber,
        commentUrl: comment.url,
        repoRoot: tmp,
      });
      indexedIds.push(record.id);
      const appended = appendCaptureMarkerToComment(comment.body, record.id);
      expect(appended.changed).toBe(true);
      updatedBodies.push({ url: comment.url ?? '', body: appended.body });
    }

    // ── Assert: only ONE capture indexed (the classifier-yes one) ──────
    const capturesDir = join(tmp, 'backlog', 'captures');
    expect(existsSync(capturesDir)).toBe(true);
    const files = readdirSync(capturesDir).filter((f) => f.endsWith('.md'));
    expect(files).toHaveLength(1);
    expect(files[0]).toBe(`${indexedIds[0]}.md`);

    // ── Assert: the indexed comment now carries the capture-id marker ──
    expect(updatedBodies).toHaveLength(1);
    expect(updatedBodies[0].body).toContain(`<!-- ai-sdlc:capture-id=${indexedIds[0]} -->`);
    expect(updatedBodies[0].url).toBe('https://github.com/o/r/pull/100#discussion_r1');

    // ── Second pass: re-running the batch on the same (now-marked)
    //     comment must short-circuit via `already-linked` (AC-7
    //     idempotence). No new classifier call, no new capture record.
    const reFetchedComments = [
      { ...comments[0], body: updatedBodies[0].body },
      comments[1], // unchanged
    ];
    const callCountBeforeRerun = invoker.getCallCount('pr-comment-is-capture');
    const batch2 = await classifyPrCommentsBatch(reFetchedComments, {
      invoker,
      repoRoot: tmp,
      corpusDir: join(tmp, 'corpus'),
    });
    expect(batch2[0].decision.kind).toBe('already-linked');
    if (batch2[0].decision.kind === 'already-linked') {
      expect(batch2[0].decision.existingCaptureId).toBe(indexedIds[0]);
    }
    // The previously-classified-no comment still gets re-classified
    // (no marker carries forward) — that's correct: classifier-no
    // doesn't append a marker, so we re-evaluate on every pass.
    expect(batch2[1].decision.kind).toBe('classified-skip');
    // First comment did NOT re-invoke the classifier.
    expect(invoker.getCallCount('pr-comment-is-capture')).toBe(callCountBeforeRerun + 1);

    // Still only one capture on disk.
    const files2 = readdirSync(capturesDir).filter((f) => f.endsWith('.md'));
    expect(files2).toHaveLength(1);
  });
});
