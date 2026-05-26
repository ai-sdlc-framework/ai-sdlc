/**
 * Tests for RFC-0024 Refit Phase 5 — DoR-clarification → emergent-capture
 * integration (AISDLC-277 / OQ-11).
 *
 * Covers all 7 acceptance criteria:
 *   AC #1 — DoR Stage B clarification response handler invokes classifier
 *           (verified by `proposeCapturesFromDorAnswer` test exercising
 *           the substrate end-to-end with FakeLlmInvoker)
 *   AC #2 — Multi-class output `clarification | new-concern | ambiguous`
 *           per segment (verified by direct classifier-result inspection)
 *   AC #3 — `new-concern` segments above threshold auto-extract to
 *           capture records (verified by proposal + commit flow)
 *   AC #4 — Capture records reference DoR thread by ID (verified by
 *           inspecting written capture.blocksIssueId)
 *   AC #5 — Operator confirms in TUI before commit (verified by the
 *           propose-vs-commit separation + the `confirm` callback hook)
 *   AC #6 — RFC-0011 admission semantics unchanged (verified by
 *           absence-of-coupling: no DoR verdict or composite is called
 *           from this module)
 *   AC #7 — Integration test: mixed clarification + new-concern segments
 *           produce correct extraction (verified by the multi-segment
 *           integration test below)
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  segmentDorAnswer,
  classifyDorAnswerSegments,
  proposeCapturesFromDorAnswer,
  commitDorAnswerCaptures,
  processDorAnswer,
  type CaptureProposal,
} from './dor-answer-capture.js';
import {
  FakeLlmInvoker,
  type FakeInvokerFixture,
  type LlmInvocationResponse,
} from '../classifier/substrate/index.js';
import type { CaptureRecord } from '../capture/index.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeTmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function readWrittenCaptures(artifactsDir: string): CaptureRecord[] {
  const capturesDir = join(artifactsDir, '_captures');
  let files: string[];
  try {
    files = readdirSync(capturesDir).filter((f) => f.endsWith('.jsonl'));
  } catch {
    return [];
  }
  return files.map((f) => {
    const raw = readFileSync(join(capturesDir, f), 'utf8').trim();
    return JSON.parse(raw) as CaptureRecord;
  });
}

function newConcernResponse(
  confidence: number,
  reasoning = 'looks like a new concern',
): LlmInvocationResponse {
  return {
    classification: 'new-concern',
    confidence,
    reasoning,
    inputTokens: 30,
    outputTokens: 10,
  };
}

function clarificationResponse(confidence = 0.9): LlmInvocationResponse {
  return {
    classification: 'clarification',
    confidence,
    reasoning: 'answers the question',
    inputTokens: 30,
    outputTokens: 10,
  };
}

function ambiguousResponse(confidence = 0.4): LlmInvocationResponse {
  return {
    classification: 'ambiguous',
    confidence,
    reasoning: 'could be either',
    inputTokens: 30,
    outputTokens: 10,
  };
}

// ── segmentDorAnswer ──────────────────────────────────────────────────────────

describe('segmentDorAnswer', () => {
  it('returns empty array for empty / whitespace-only input', () => {
    expect(segmentDorAnswer('')).toEqual([]);
    expect(segmentDorAnswer('   \n\n   ')).toEqual([]);
  });

  it('returns one segment for a single paragraph', () => {
    expect(segmentDorAnswer('the cache eviction policy is LRU')).toEqual([
      'the cache eviction policy is LRU',
    ]);
  });

  it('splits blank-line-separated paragraphs into segments', () => {
    const answer = `paragraph one explains the existing behavior.

paragraph two raises a follow-up concern.

paragraph three has more nuance.`;
    expect(segmentDorAnswer(answer)).toEqual([
      'paragraph one explains the existing behavior.',
      'paragraph two raises a follow-up concern.',
      'paragraph three has more nuance.',
    ]);
  });

  it('splits a bulleted paragraph into per-line segments', () => {
    const answer = `- first bullet finding
- second bullet finding
- third bullet finding`;
    expect(segmentDorAnswer(answer)).toEqual([
      'first bullet finding',
      'second bullet finding',
      'third bullet finding',
    ]);
  });

  it('handles numbered-list markers', () => {
    const answer = `1. first numbered item
2. second numbered item
3. third numbered item`;
    expect(segmentDorAnswer(answer)).toEqual([
      'first numbered item',
      'second numbered item',
      'third numbered item',
    ]);
  });

  it('treats single-bullet paragraphs as one segment (no splitting)', () => {
    // Edge case: a single line that happens to start with a bullet marker
    // is one segment, not "stripped of marker" — splitting only fires
    // when there are >1 lines all bulleted.
    expect(segmentDorAnswer('- only one bullet')).toEqual(['- only one bullet']);
  });

  it('handles mixed paragraph + bullet structures across blank lines', () => {
    const answer = `the existing logic does X.

- but bullet one raises Y
- bullet two raises Z

paragraph three concludes.`;
    expect(segmentDorAnswer(answer)).toEqual([
      'the existing logic does X.',
      'but bullet one raises Y',
      'bullet two raises Z',
      'paragraph three concludes.',
    ]);
  });

  it('handles non-string input defensively', () => {
    expect(segmentDorAnswer(null as unknown as string)).toEqual([]);
    expect(segmentDorAnswer(undefined as unknown as string)).toEqual([]);
  });

  it('strips both * and - and • bullet markers', () => {
    const answer = `* star bullet
- dash bullet
• unicode bullet`;
    expect(segmentDorAnswer(answer)).toEqual(['star bullet', 'dash bullet', 'unicode bullet']);
  });
});

// ── classifyDorAnswerSegments (AC #2) ─────────────────────────────────────────

describe('classifyDorAnswerSegments — AC #2 multi-class output per segment', () => {
  let repoRoot: string;
  let corpusDir: string;

  beforeEach(() => {
    repoRoot = makeTmp('aisdlc-277-classify-');
    corpusDir = join(repoRoot, '.ai-sdlc', 'classifier-corpus');
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it('returns one classifier decision per segment in input order (AC #2)', async () => {
    // 3 segments, scripted classifier returns: new-concern, clarification, ambiguous
    const responses: LlmInvocationResponse[] = [
      newConcernResponse(0.85),
      clarificationResponse(),
      ambiguousResponse(),
    ];
    const fixture: FakeInvokerFixture = (_req, callIndex) => responses[callIndex]!;
    const invoker = new FakeLlmInvoker({ 'dor-answer-is-new-concern': fixture });

    const segments = [
      'this surfaces a separate concern about token expiry',
      'yes, the cache eviction policy is LRU',
      'might also be worth thinking about jitter',
    ];

    const classified = await classifyDorAnswerSegments(segments, {
      invoker,
      repoRoot,
      corpusDir,
    });

    expect(classified).toHaveLength(3);
    expect(classified[0]!.segment).toBe(segments[0]);
    expect(classified[0]!.decision.classification).toBe('new-concern');
    expect(classified[1]!.decision.classification).toBe('clarification');
    expect(classified[2]!.decision.classification).toBe('ambiguous');
    // AC #2 — all three valid classifications appear in the per-segment output.
  });

  it('preserves segment text exactly (no re-segmentation inside classifier wrapper)', async () => {
    const invoker = new FakeLlmInvoker({
      'dor-answer-is-new-concern': clarificationResponse(),
    });
    const odd = ['  segment with leading whitespace already trimmed by caller'];
    const classified = await classifyDorAnswerSegments(odd, { invoker, repoRoot, corpusDir });
    expect(classified[0]!.segment).toBe(odd[0]);
  });

  it('inherits substrate fall-open: invoker throw → pending sentinel + low confidence', async () => {
    const invoker = new FakeLlmInvoker({
      throws: new Error('boom'),
      'dor-answer-is-new-concern': clarificationResponse(),
    });
    const classified = await classifyDorAnswerSegments(['some segment'], {
      invoker,
      repoRoot,
      corpusDir,
    });
    expect(classified).toHaveLength(1);
    expect(classified[0]!.decision.classification).toBe('pending');
    expect(classified[0]!.decision.confidence).toBe(0);
    expect(classified[0]!.decision.metBehindThreshold).toBe(false);
  });
});

// ── proposeCapturesFromDorAnswer (AC #1 + AC #3) ──────────────────────────────

describe('proposeCapturesFromDorAnswer', () => {
  let repoRoot: string;
  let corpusDir: string;

  beforeEach(() => {
    repoRoot = makeTmp('aisdlc-277-propose-');
    corpusDir = join(repoRoot, '.ai-sdlc', 'classifier-corpus');
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it('AC #1: invokes the classifier for each segment (call count matches)', async () => {
    const invoker = new FakeLlmInvoker({
      'dor-answer-is-new-concern': clarificationResponse(),
    });
    const answer = `first paragraph.

second paragraph.

third paragraph.`;

    await proposeCapturesFromDorAnswer(answer, {
      invoker,
      dorThreadIssueId: 'AISDLC-999',
      repoRoot,
      corpusDir,
    });

    expect(invoker.getCallCount('dor-answer-is-new-concern')).toBe(3);
  });

  it('AC #3: only new-concern segments above threshold become proposals', async () => {
    const responses: LlmInvocationResponse[] = [
      newConcernResponse(0.85), // above threshold → proposal
      newConcernResponse(0.5), // below threshold → clarification
      clarificationResponse(), // never a proposal
      ambiguousResponse(), // never a proposal
    ];
    const fixture: FakeInvokerFixture = (_req, callIndex) => responses[callIndex]!;
    const invoker = new FakeLlmInvoker({ 'dor-answer-is-new-concern': fixture });

    const answer = `proposal-worthy concern raised here.

low-confidence concern uncertain.

just clarifying the question.

might be related, who knows.`;

    const result = await proposeCapturesFromDorAnswer(answer, {
      invoker,
      dorThreadIssueId: 'AISDLC-999',
      repoRoot,
      corpusDir,
    });

    expect(result.captureProposals).toHaveLength(1);
    expect(result.captureProposals[0]!.finding).toBe('proposal-worthy concern raised here.');
    expect(result.captureProposals[0]!.aboveThreshold).toBe(true);
    expect(result.captureProposals[0]!.decision.classification).toBe('new-concern');

    // The 3 non-proposal segments stay in clarification.
    expect(result.clarificationSegments).toEqual([
      'low-confidence concern uncertain.',
      'just clarifying the question.',
      'might be related, who knows.',
    ]);

    // Per-segment classifier results surfaced for all 4 (AC #2 visibility).
    expect(result.classifierResults).toHaveLength(4);
  });

  it('fast-path: empty answer → empty proposal (no LLM call)', async () => {
    const invoker = new FakeLlmInvoker({
      'dor-answer-is-new-concern': newConcernResponse(0.99),
    });
    const result = await proposeCapturesFromDorAnswer('   \n\n  ', {
      invoker,
      dorThreadIssueId: 'AISDLC-999',
      repoRoot,
      corpusDir,
    });
    expect(result.captureProposals).toEqual([]);
    expect(result.clarificationSegments).toEqual([]);
    expect(result.classifierResults).toEqual([]);
    expect(invoker.getCallCount('dor-answer-is-new-concern')).toBe(0);
  });

  it('classifier-failure path: invoker throws → no proposals, all segments stay (fall-open)', async () => {
    const invoker = new FakeLlmInvoker({
      throws: new Error('haiku 503'),
      'dor-answer-is-new-concern': newConcernResponse(0.95),
    });
    const answer = `paragraph one is critical.

paragraph two is also critical.`;

    const result = await proposeCapturesFromDorAnswer(answer, {
      invoker,
      dorThreadIssueId: 'AISDLC-999',
      repoRoot,
      corpusDir,
    });
    // Fall-open: every segment stays as clarification, none auto-extracted.
    expect(result.captureProposals).toEqual([]);
    expect(result.clarificationSegments).toEqual([
      'paragraph one is critical.',
      'paragraph two is also critical.',
    ]);
  });

  it('per-call threshold override changes the auto-extraction bar', async () => {
    const invoker = new FakeLlmInvoker({
      'dor-answer-is-new-concern': newConcernResponse(0.55),
    });
    // At default 0.7 threshold, 0.55-confidence new-concern is NOT proposed.
    const lowResult = await proposeCapturesFromDorAnswer('a real concern', {
      invoker,
      dorThreadIssueId: 'AISDLC-999',
      repoRoot,
      corpusDir,
    });
    expect(lowResult.captureProposals).toHaveLength(0);

    // With threshold 0.5, the same 0.55-confidence response qualifies.
    const highResult = await proposeCapturesFromDorAnswer('a real concern', {
      invoker,
      dorThreadIssueId: 'AISDLC-999',
      repoRoot,
      corpusDir,
      threshold: 0.5,
    });
    expect(highResult.captureProposals).toHaveLength(1);
  });
});

// ── commitDorAnswerCaptures (AC #4 + AC #5) ───────────────────────────────────

describe('commitDorAnswerCaptures', () => {
  let artifactsDir: string;

  beforeEach(() => {
    artifactsDir = makeTmp('aisdlc-277-commit-');
  });

  afterEach(() => {
    rmSync(artifactsDir, { recursive: true, force: true });
  });

  function makeProposal(finding: string): CaptureProposal {
    return {
      finding,
      decision: {
        classification: 'new-concern',
        confidence: 0.85,
        reasoning: 'looks like a new concern',
        metBehindThreshold: true,
        effectiveThreshold: 0.7,
        corpusEntryId: 'corpus-id-stub',
        model: 'claude-haiku-4-5',
      },
      aboveThreshold: true,
      corpusEntryId: 'corpus-id-stub',
    };
  }

  it('AC #4: every written capture has blocksIssueId set to the DoR thread', () => {
    const proposals = [makeProposal('first concern'), makeProposal('second concern')];
    const written = commitDorAnswerCaptures(proposals, {
      dorThreadIssueId: 'AISDLC-444',
      operator: 'operator@example.com',
      artifactsDir,
    });
    expect(written).toHaveLength(2);
    for (const record of written) {
      expect(record.blocksIssueId).toBe('AISDLC-444');
      expect(record.source.type).toBe('operator');
      expect(record.source.operator).toBe('operator@example.com');
      expect(record.source.context).toContain('AISDLC-444');
    }
  });

  it('AC #5 boundary: commit only writes what is handed to it (operator subset)', () => {
    // The TUI confirms only a subset; commit writes only that subset.
    const proposals = [makeProposal('only this one is confirmed')];
    const written = commitDorAnswerCaptures(proposals, {
      dorThreadIssueId: 'AISDLC-444',
      operator: 'operator@example.com',
      artifactsDir,
    });
    expect(written).toHaveLength(1);
    expect(written[0]!.finding).toBe('only this one is confirmed');

    // The on-disk record count matches the in-memory result.
    expect(readWrittenCaptures(artifactsDir)).toHaveLength(1);
  });

  it('records source.context including the DoR question context when supplied', () => {
    const proposals = [makeProposal('finding')];
    const written = commitDorAnswerCaptures(proposals, {
      dorThreadIssueId: 'AISDLC-111',
      operator: 'op@example.com',
      dorQuestionContext: 'Gate 5: is the affected surface named?',
      artifactsDir,
    });
    expect(written[0]!.source.context).toBe(
      'DoR clarification on AISDLC-111: Gate 5: is the affected surface named?',
    );
    expect(written[0]!.evidence.additionalContext).toBe('Gate 5: is the affected surface named?');
  });

  it('writes captures with triage=tbd (operator triages later in TUI)', () => {
    const written = commitDorAnswerCaptures([makeProposal('x')], {
      dorThreadIssueId: 'AISDLC-1',
      operator: 'op@example.com',
      artifactsDir,
    });
    // OQ-11 keeps triage at tbd — operator decides in TUI per §10.
    expect(written[0]!.triage).toBe('tbd');
    expect(written[0]!.severity).toBe('unknown');
  });

  it('returns empty array for empty proposals (no-op safe)', () => {
    const written = commitDorAnswerCaptures([], {
      dorThreadIssueId: 'AISDLC-1',
      operator: 'op@example.com',
      artifactsDir,
    });
    expect(written).toEqual([]);
    expect(readWrittenCaptures(artifactsDir)).toEqual([]);
  });
});

// ── processDorAnswer composite + AC #5 confirmation hook ──────────────────────

describe('processDorAnswer — AC #5 operator-confirmation hook', () => {
  let repoRoot: string;
  let corpusDir: string;
  let artifactsDir: string;

  beforeEach(() => {
    repoRoot = makeTmp('aisdlc-277-process-');
    corpusDir = join(repoRoot, '.ai-sdlc', 'classifier-corpus');
    artifactsDir = makeTmp('aisdlc-277-process-art-');
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(artifactsDir, { recursive: true, force: true });
  });

  it('AC #5: confirm callback can reject proposals → no captures written', async () => {
    const invoker = new FakeLlmInvoker({
      'dor-answer-is-new-concern': newConcernResponse(0.95),
    });

    const result = await processDorAnswer('a real new concern that surfaces here', {
      invoker,
      dorThreadIssueId: 'AISDLC-222',
      operator: 'op@example.com',
      repoRoot,
      corpusDir,
      artifactsDir,
      // Operator declines all proposals — confirm returns empty array.
      confirm: () => [],
    });

    expect(result.proposal.captureProposals).toHaveLength(1); // classifier proposed
    expect(result.confirmedProposals).toHaveLength(0); // operator declined
    expect(result.writtenCaptures).toHaveLength(0); // nothing committed
    expect(readWrittenCaptures(artifactsDir)).toHaveLength(0);
  });

  it('AC #5: confirm callback can subset proposals → only confirmed are written', async () => {
    const responses: LlmInvocationResponse[] = [newConcernResponse(0.95), newConcernResponse(0.92)];
    const fixture: FakeInvokerFixture = (_req, callIndex) => responses[callIndex]!;
    const invoker = new FakeLlmInvoker({ 'dor-answer-is-new-concern': fixture });

    const answer = `first new concern here.

second new concern here.`;

    const result = await processDorAnswer(answer, {
      invoker,
      dorThreadIssueId: 'AISDLC-222',
      operator: 'op@example.com',
      repoRoot,
      corpusDir,
      artifactsDir,
      // Operator confirms only the FIRST proposal.
      confirm: (proposals) => [proposals[0]!],
    });

    expect(result.proposal.captureProposals).toHaveLength(2);
    expect(result.confirmedProposals).toHaveLength(1);
    expect(result.writtenCaptures).toHaveLength(1);
    expect(result.writtenCaptures[0]!.finding).toBe('first new concern here.');
  });

  it('default confirm (no callback) confirms ALL proposals', async () => {
    const invoker = new FakeLlmInvoker({
      'dor-answer-is-new-concern': newConcernResponse(0.95),
    });
    const result = await processDorAnswer('single new concern', {
      invoker,
      dorThreadIssueId: 'AISDLC-222',
      operator: 'op@example.com',
      repoRoot,
      corpusDir,
      artifactsDir,
      // No confirm callback supplied — default confirms all.
    });
    expect(result.confirmedProposals).toEqual(result.proposal.captureProposals);
    expect(result.writtenCaptures).toHaveLength(1);
  });

  it('residual clarification stitches clarification segments with blank-line separators', async () => {
    const responses: LlmInvocationResponse[] = [
      clarificationResponse(),
      newConcernResponse(0.95),
      clarificationResponse(),
    ];
    const fixture: FakeInvokerFixture = (_req, callIndex) => responses[callIndex]!;
    const invoker = new FakeLlmInvoker({ 'dor-answer-is-new-concern': fixture });

    const answer = `paragraph A clarifies.

paragraph B raises a new concern.

paragraph C clarifies more.`;

    const result = await processDorAnswer(answer, {
      invoker,
      dorThreadIssueId: 'AISDLC-222',
      operator: 'op@example.com',
      repoRoot,
      corpusDir,
      artifactsDir,
    });

    expect(result.residualClarification).toBe(
      'paragraph A clarifies.\n\nparagraph C clarifies more.',
    );
  });
});

// ── AC #7 integration test ────────────────────────────────────────────────────

describe('AC #7 — integration test: mixed clarification + new-concern segments', () => {
  let repoRoot: string;
  let corpusDir: string;
  let artifactsDir: string;

  beforeEach(() => {
    repoRoot = makeTmp('aisdlc-277-integration-');
    corpusDir = join(repoRoot, '.ai-sdlc', 'classifier-corpus');
    artifactsDir = makeTmp('aisdlc-277-integration-art-');
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(artifactsDir, { recursive: true, force: true });
  });

  it('extracts 2 captures + leaves 2 clarification segments from a 4-segment answer (AC #7)', async () => {
    // Realistic scenario: operator answering Gate 5 ("named the surface")
    // gives a 4-paragraph answer mixing direct clarification with two
    // new concerns that surfaced while writing.
    const operatorAnswer = `Yes, the affected surface is \`src/auth/middleware.ts\` — specifically the \`refreshTokens\` function.

Actually, while looking at this I noticed the rate-limiter middleware doesn't apply jitter on its retry loop. That's a separate concern worth tracking.

The middleware also calls \`getSession\` which is in \`src/session/get.ts\`.

One more thing — the session-token cache doesn't handle clock skew between nodes. That's been bothering me for a while; we should file it.`;

    // Scripted classifier: para 1 + para 3 = clarification, para 2 + para 4 = new-concern (high conf)
    const responses: LlmInvocationResponse[] = [
      clarificationResponse(0.9),
      newConcernResponse(0.88, 'introduces a separate concern about jitter'),
      clarificationResponse(0.92),
      newConcernResponse(0.91, 'introduces a separate concern about clock skew'),
    ];
    const fixture: FakeInvokerFixture = (_req, callIndex) => responses[callIndex]!;
    const invoker = new FakeLlmInvoker({ 'dor-answer-is-new-concern': fixture });

    const result = await processDorAnswer(operatorAnswer, {
      invoker,
      dorThreadIssueId: 'AISDLC-700',
      operator: 'operator@example.com',
      dorQuestionContext: 'Gate 5: is the affected surface named?',
      repoRoot,
      corpusDir,
      artifactsDir,
    });

    // 4 segments classified.
    expect(result.proposal.classifierResults).toHaveLength(4);

    // 2 captures auto-proposed (the two new-concern segments above threshold).
    expect(result.proposal.captureProposals).toHaveLength(2);
    expect(result.proposal.captureProposals[0]!.finding).toContain('rate-limiter');
    expect(result.proposal.captureProposals[1]!.finding).toContain('clock skew');

    // Operator (default-confirm) writes both.
    expect(result.writtenCaptures).toHaveLength(2);

    // AC #4: both records reference the DoR thread.
    for (const record of result.writtenCaptures) {
      expect(record.blocksIssueId).toBe('AISDLC-700');
      expect(record.source.context).toContain('AISDLC-700');
      expect(record.source.context).toContain('Gate 5');
      expect(record.source.type).toBe('operator');
      expect(record.source.operator).toBe('operator@example.com');
      expect(record.triage).toBe('tbd');
    }

    // Disk match.
    const onDisk = readWrittenCaptures(artifactsDir);
    expect(onDisk).toHaveLength(2);

    // Residual clarification is just the 2 clarifying paragraphs.
    expect(result.residualClarification).toContain('src/auth/middleware.ts');
    expect(result.residualClarification).toContain('src/session/get.ts');
    expect(result.residualClarification).not.toContain('rate-limiter');
    expect(result.residualClarification).not.toContain('clock skew');

    // AC #1 invoked exactly once per segment.
    expect(invoker.getCallCount('dor-answer-is-new-concern')).toBe(4);
  });

  it('AC #6: RFC-0011 admission semantics unchanged — no DoR composite is called', async () => {
    // Structural assertion: this module imports from `capture/` + the
    // classifier substrate, but NOT from `dor/composite`, `dor/evaluate`,
    // `dor/stage-b`, etc. Confirms OQ-11's design contract — no new gate,
    // no admission impact.
    // We do an import-shape check: the module's own source must not
    // reference RFC-0011 verdict / gate / admission paths.
    const moduleSource = readFileSync(join(__dirname, 'dor-answer-capture.ts'), 'utf8');

    // It does refer to "RFC-0011" + "admission" in DOCSTRINGS (explaining
    // the contract). But it must not import any of:
    //   - evaluate.js
    //   - composite.js
    //   - stage-b.js (we get the answer text but do not call Stage B)
    //   - gates/
    //   - upstream-oq-gate.js
    //   - escalation.js
    //   - bypass.js
    const forbiddenImports = [
      `from './evaluate.js'`,
      `from './composite.js'`,
      `from './stage-b.js'`,
      `from './gates/`,
      `from './upstream-oq-gate.js'`,
      `from './escalation.js'`,
      `from './bypass.js'`,
      `from './ingress-claude.js'`,
    ];
    for (const forbidden of forbiddenImports) {
      expect(moduleSource).not.toContain(forbidden);
    }
  });
});
