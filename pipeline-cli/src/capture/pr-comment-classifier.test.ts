/**
 * Unit tests for `pr-comment-classifier.ts` (RFC-0024 Refit Phase 4 /
 * AISDLC-276).
 *
 * Covers AC-1 through AC-7 + the bidirectional-sync helpers. The
 * combined integration test (AC-8) lives in
 * `pr-comment-classifier.integration.test.ts` — it exercises the full
 * un-marked + classifier-yes vs un-marked + classifier-no flow against
 * the real `classify()` substrate.
 *
 * @module capture/pr-comment-classifier.test
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FakeLlmInvoker } from '../classifier/substrate/fake-invoker.js';
import {
  AI_AGENT_BOT_LOGINS,
  CAPTURE_ID_MARKER_PREFIX,
  PR_COMMENT_DEFAULT_THRESHOLD,
  appendCaptureMarkerToComment,
  classifyPrCommentForCapture,
  classifyPrCommentsBatch,
  detectCommentBodyChange,
  extractCaptureIdFromComment,
  isAiAgentAuthor,
  stripCaptureIdMarker,
} from './pr-comment-classifier.js';

// ── Setup ────────────────────────────────────────────────────────────────────

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'pr-comment-classifier-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

// Helper — builds a substrate invoker that returns is-capture with a
// scripted confidence.
function invokerYes(confidence: number) {
  return new FakeLlmInvoker({
    'pr-comment-is-capture': {
      classification: 'is-capture',
      confidence,
      reasoning: 'looks like a follow-up concern',
      inputTokens: 50,
      outputTokens: 20,
    },
  });
}

function invokerNo() {
  return new FakeLlmInvoker({
    'pr-comment-is-capture': {
      classification: 'not-capture',
      confidence: 0.9,
      reasoning: 'pure typo nit',
      inputTokens: 30,
      outputTokens: 15,
    },
  });
}

// ── Default threshold ────────────────────────────────────────────────────────

describe('PR_COMMENT_DEFAULT_THRESHOLD', () => {
  it('is 0.5 per OQ-3 (2026-05-15)', () => {
    expect(PR_COMMENT_DEFAULT_THRESHOLD).toBe(0.5);
  });
});

// ── AC-4: marker-tagged bypass ───────────────────────────────────────────────

describe('AC-4: marker-tagged comments bypass classifier', () => {
  it('returns kind=marker when comment carries ai-sdlc:capture marker', async () => {
    const comment = {
      body:
        `<!-- ai-sdlc:capture severity=major triage=new-issue -->\n` +
        `auth middleware drops tokens on clock skew`,
      author: { login: 'reviewer' },
    };
    const decision = await classifyPrCommentForCapture(comment, {
      invoker: invokerNo(), // would say no — but we should never call it
      repoRoot: tmp,
      corpusDir: join(tmp, 'corpus'),
    });
    expect(decision.kind).toBe('marker');
    if (decision.kind === 'marker') {
      expect(decision.severity).toBe('major');
      expect(decision.triage).toBe('new-issue');
      expect(decision.finding).toContain('clock skew');
    }
  });

  it('does not invoke the classifier when marker is found', async () => {
    const invoker = invokerNo();
    const comment = {
      body: `<!-- ai-sdlc:capture triage=quick-fix -->\nlint nit`,
      author: { login: 'reviewer' },
    };
    await classifyPrCommentForCapture(comment, {
      invoker,
      repoRoot: tmp,
      corpusDir: join(tmp, 'corpus'),
    });
    expect(invoker.getCallCount('pr-comment-is-capture')).toBe(0);
  });
});

// ── AC-5: AI-agent bypass ────────────────────────────────────────────────────

describe('AC-5: AI-agent-authored comments bypass classifier', () => {
  it('treats github-actions login as AI agent', () => {
    expect(isAiAgentAuthor({ body: '', author: { login: 'github-actions' } })).toBe(true);
  });

  it('treats anything ending in [bot] as AI agent', () => {
    expect(isAiAgentAuthor({ body: '', author: { login: 'dependabot[bot]' } })).toBe(true);
  });

  it('does not treat human logins as AI agent', () => {
    expect(isAiAgentAuthor({ body: '', author: { login: 'alice' } })).toBe(false);
  });

  it('returns false when comment has no author info at all', () => {
    expect(isAiAgentAuthor({ body: 'orphan comment' })).toBe(false);
  });

  it('classifier path tolerates missing author info (falls through to substrate)', async () => {
    const invoker = invokerYes(0.8);
    const decision = await classifyPrCommentForCapture(
      { body: 'orphan finding' },
      { invoker, repoRoot: tmp, corpusDir: join(tmp, 'corpus') },
    );
    // No author → isAiAgentAuthor returns false → classifier runs.
    expect(decision.kind).toBe('classified-capture');
    expect(invoker.getCallCount('pr-comment-is-capture')).toBe(1);
  });

  it('exports the known-bot allowlist for callers', () => {
    expect(AI_AGENT_BOT_LOGINS.has('github-actions')).toBe(true);
    expect(AI_AGENT_BOT_LOGINS.has('github-actions[bot]')).toBe(true);
  });

  it('returns kind=ai-agent for bot-authored comments, no classifier call', async () => {
    const invoker = invokerNo();
    const comment = {
      body: 'review-bot finding: unused import in foo.ts',
      author: { login: 'github-actions[bot]' },
    };
    const decision = await classifyPrCommentForCapture(comment, {
      invoker,
      repoRoot: tmp,
      corpusDir: join(tmp, 'corpus'),
    });
    expect(decision.kind).toBe('ai-agent');
    if (decision.kind === 'ai-agent') {
      expect(decision.finding).toContain('unused import');
    }
    expect(invoker.getCallCount('pr-comment-is-capture')).toBe(0);
  });

  it('honors treatAuthorAsAiAgent override for callers with out-of-band knowledge', async () => {
    const invoker = invokerNo();
    const comment = {
      body: 'custom-subagent: race condition in cache layer',
      author: { login: 'custom-subagent-account' }, // not in bot list
    };
    const decision = await classifyPrCommentForCapture(comment, {
      invoker,
      repoRoot: tmp,
      corpusDir: join(tmp, 'corpus'),
      treatAuthorAsAiAgent: true,
    });
    expect(decision.kind).toBe('ai-agent');
    expect(invoker.getCallCount('pr-comment-is-capture')).toBe(0);
  });
});

// ── AC-1 + AC-2: classifier-yes path ─────────────────────────────────────────

describe('AC-1 + AC-2: confidence >= 0.5 → indexed as capture', () => {
  it('returns kind=classified-capture when classifier returns is-capture above threshold', async () => {
    const invoker = invokerYes(0.85);
    const comment = {
      body: 'we should also handle the case where the upstream returns 429 — looks like a follow-up',
      author: { login: 'alice' },
      url: 'https://github.com/o/r/pull/1#issuecomment-100',
      prNumber: 1,
    };
    const decision = await classifyPrCommentForCapture(comment, {
      invoker,
      repoRoot: tmp,
      corpusDir: join(tmp, 'corpus'),
    });
    expect(decision.kind).toBe('classified-capture');
    if (decision.kind === 'classified-capture') {
      expect(decision.decision.confidence).toBe(0.85);
      expect(decision.decision.classification).toBe('is-capture');
      expect(decision.finding).toContain('429');
    }
    expect(invoker.getCallCount('pr-comment-is-capture')).toBe(1);
  });

  it('passes context (author / prNumber / commentUrl) to the substrate', async () => {
    let observedPrompt = '';
    const invoker = new FakeLlmInvoker({
      'pr-comment-is-capture': (req) => {
        observedPrompt = req.prompt;
        return {
          classification: 'is-capture',
          confidence: 0.8,
          reasoning: 'ok',
          inputTokens: 10,
          outputTokens: 5,
        };
      },
    });
    await classifyPrCommentForCapture(
      {
        body: 'arch concern',
        author: { login: 'alice' },
        prNumber: 42,
        url: 'https://github.com/o/r/pull/42#discussion_r9',
      },
      { invoker, repoRoot: tmp, corpusDir: join(tmp, 'corpus') },
    );
    expect(observedPrompt).toContain('arch concern');
    expect(observedPrompt).toContain('alice');
    expect(observedPrompt).toContain('42');
    expect(observedPrompt).toContain('discussion_r9');
  });
});

// ── AC-3: classifier-no / below-threshold path ───────────────────────────────

describe('AC-3: confidence < 0.5 → ignored (no capture record)', () => {
  it('returns classified-skip with reason=below-threshold when is-capture but confidence too low', async () => {
    const invoker = invokerYes(0.4); // below 0.5
    const comment = { body: 'minor stylistic nit', author: { login: 'alice' } };
    const decision = await classifyPrCommentForCapture(comment, {
      invoker,
      repoRoot: tmp,
      corpusDir: join(tmp, 'corpus'),
    });
    expect(decision.kind).toBe('classified-skip');
    if (decision.kind === 'classified-skip') {
      expect(decision.reason).toBe('below-threshold');
      expect(decision.decision?.confidence).toBe(0.4);
    }
  });

  it('returns classified-skip with reason=not-capture when classifier rejects', async () => {
    const invoker = invokerNo();
    const comment = { body: 'typo in line 4', author: { login: 'alice' } };
    const decision = await classifyPrCommentForCapture(comment, {
      invoker,
      repoRoot: tmp,
      corpusDir: join(tmp, 'corpus'),
    });
    expect(decision.kind).toBe('classified-skip');
    if (decision.kind === 'classified-skip') {
      expect(decision.reason).toBe('not-capture');
    }
  });

  it('returns classified-skip with reason=classifier-fall-open on substrate fall-open', async () => {
    // No invoker supplied → substrate returns pending sentinel.
    const comment = { body: 'something', author: { login: 'alice' } };
    const decision = await classifyPrCommentForCapture(comment, {
      repoRoot: tmp,
      corpusDir: join(tmp, 'corpus'),
    });
    expect(decision.kind).toBe('classified-skip');
    if (decision.kind === 'classified-skip') {
      expect(decision.reason).toBe('classifier-fall-open');
    }
  });

  it('respects per-call threshold override (looser)', async () => {
    const invoker = invokerYes(0.4);
    const comment = { body: 'borderline', author: { login: 'alice' } };
    const decision = await classifyPrCommentForCapture(comment, {
      invoker,
      repoRoot: tmp,
      corpusDir: join(tmp, 'corpus'),
      threshold: 0.3, // looser than the 0.5 default → 0.4 now passes
    });
    expect(decision.kind).toBe('classified-capture');
  });

  it('respects per-call threshold override (stricter)', async () => {
    const invoker = invokerYes(0.6);
    const comment = { body: 'borderline', author: { login: 'alice' } };
    const decision = await classifyPrCommentForCapture(comment, {
      invoker,
      repoRoot: tmp,
      corpusDir: join(tmp, 'corpus'),
      threshold: 0.8, // stricter than the 0.5 default → 0.6 now fails
    });
    expect(decision.kind).toBe('classified-skip');
    if (decision.kind === 'classified-skip') {
      expect(decision.reason).toBe('below-threshold');
    }
  });
});

// ── AC-7: bidirectional-sync marker helpers ──────────────────────────────────

describe('AC-7: appendCaptureMarkerToComment', () => {
  it('appends the marker to a comment that lacks it', () => {
    const r = appendCaptureMarkerToComment('review finding here', 'cap_2026-05-23T12-34-56_abc123');
    expect(r.changed).toBe(true);
    expect(r.alreadyLinked).toBe(false);
    expect(r.body).toContain(`${CAPTURE_ID_MARKER_PREFIX}cap_2026-05-23T12-34-56_abc123 -->`);
    expect(r.body).toMatch(/review finding here\n\n<!-- ai-sdlc:capture-id=/);
  });

  it('is idempotent — returns unchanged body when same marker already present', () => {
    const original =
      'review finding\n\n<!-- ai-sdlc:capture-id=cap_2026-05-23T12-34-56_abc123 -->\n';
    const r = appendCaptureMarkerToComment(original, 'cap_2026-05-23T12-34-56_abc123');
    expect(r.changed).toBe(false);
    expect(r.alreadyLinked).toBe(true);
    expect(r.body).toBe(original);
  });

  it('preserves the original marker when a DIFFERENT capture id is supplied (GitHub-edit-wins)', () => {
    const original =
      'review finding\n\n<!-- ai-sdlc:capture-id=cap_2026-05-23T12-34-56_abc123 -->\n';
    const r = appendCaptureMarkerToComment(original, 'cap_2026-05-23T12-34-57_def456');
    expect(r.changed).toBe(false);
    expect(r.alreadyLinked).toBe(true);
    expect(r.body).toContain('abc123');
    expect(r.body).not.toContain('def456');
  });

  it('handles an empty comment body gracefully', () => {
    const r = appendCaptureMarkerToComment('', 'cap_2026-05-23T12-34-56_abc123');
    expect(r.changed).toBe(true);
    expect(r.body.startsWith(CAPTURE_ID_MARKER_PREFIX)).toBe(true);
  });

  it('round-trips through extractCaptureIdFromComment', () => {
    const r = appendCaptureMarkerToComment('finding', 'cap_2026-05-23T12-34-56_abc123');
    expect(extractCaptureIdFromComment(r.body)).toBe('cap_2026-05-23T12-34-56_abc123');
  });

  it('extractCaptureIdFromComment returns null when no marker present', () => {
    expect(extractCaptureIdFromComment('just a normal comment')).toBe(null);
  });
});

describe('AC-7: already-linked short-circuit', () => {
  it('returns kind=already-linked when comment carries the capture-id marker — no classifier call', async () => {
    const invoker = invokerYes(0.99);
    const comment = {
      body: 'finding\n\n<!-- ai-sdlc:capture-id=cap_2026-05-23T12-34-56_abc123 -->\n',
      author: { login: 'alice' },
    };
    const decision = await classifyPrCommentForCapture(comment, {
      invoker,
      repoRoot: tmp,
      corpusDir: join(tmp, 'corpus'),
    });
    expect(decision.kind).toBe('already-linked');
    if (decision.kind === 'already-linked') {
      expect(decision.existingCaptureId).toBe('cap_2026-05-23T12-34-56_abc123');
    }
    // Idempotence — short-circuit MUST run before any classifier work.
    expect(invoker.getCallCount('pr-comment-is-capture')).toBe(0);
  });
});

// ── AC-6: re-sync detection ──────────────────────────────────────────────────

describe('AC-6: detectCommentBodyChange', () => {
  it('reports unchanged when only the capture-id marker differs in placement', () => {
    const previous = 'finding text\n\n<!-- ai-sdlc:capture-id=cap_2026-05-23T12-34-56_abc123 -->\n';
    const current = 'finding text\n<!-- ai-sdlc:capture-id=cap_2026-05-23T12-34-56_abc123 -->\n';
    const result = detectCommentBodyChange(current, previous);
    expect(result.changed).toBe(false);
    expect(result.currentVisible).toBe('finding text');
    expect(result.previousVisible).toBe('finding text');
  });

  it('reports changed when the visible text differs', () => {
    const previous = 'original finding';
    const current = 'edited finding with more context';
    expect(detectCommentBodyChange(current, previous).changed).toBe(true);
  });

  it('strips the capture-id marker from comparison so the marker append does NOT count as a change', () => {
    const previous = 'finding text';
    const current = 'finding text\n\n<!-- ai-sdlc:capture-id=cap_2026-05-23T12-34-56_abc123 -->\n';
    expect(detectCommentBodyChange(current, previous).changed).toBe(false);
  });
});

describe('stripCaptureIdMarker', () => {
  it('removes the marker if present', () => {
    expect(
      stripCaptureIdMarker(
        'finding\n\n<!-- ai-sdlc:capture-id=cap_2026-05-23T12-34-56_abc123 -->\n',
      ),
    ).toBe('finding');
  });

  it('is a no-op when no marker present', () => {
    expect(stripCaptureIdMarker('finding')).toBe('finding');
  });
});

// ── batch entry point ────────────────────────────────────────────────────────

describe('classifyPrCommentsBatch', () => {
  it('runs each comment through the classifier in order', async () => {
    const invoker = new FakeLlmInvoker({
      'pr-comment-is-capture': (_req, callIndex) => ({
        classification: callIndex === 0 ? 'is-capture' : 'not-capture',
        confidence: 0.9,
        reasoning: 'fixture',
        inputTokens: 10,
        outputTokens: 5,
      }),
    });
    const comments = [
      { body: 'arch concern', author: { login: 'alice' } },
      { body: 'typo', author: { login: 'bob' } },
    ];
    const results = await classifyPrCommentsBatch(comments, {
      invoker,
      repoRoot: tmp,
      corpusDir: join(tmp, 'corpus'),
    });
    expect(results).toHaveLength(2);
    expect(results[0].decision.kind).toBe('classified-capture');
    expect(results[1].decision.kind).toBe('classified-skip');
  });

  it('mixes marker / ai-agent / classified results', async () => {
    const invoker = invokerYes(0.8);
    const comments = [
      { body: '<!-- ai-sdlc:capture triage=new-issue -->\ntagged', author: { login: 'alice' } },
      { body: 'bot finding', author: { login: 'github-actions[bot]' } },
      { body: 'human reflection on architecture', author: { login: 'bob' } },
    ];
    const results = await classifyPrCommentsBatch(comments, {
      invoker,
      repoRoot: tmp,
      corpusDir: join(tmp, 'corpus'),
    });
    expect(results[0].decision.kind).toBe('marker');
    expect(results[1].decision.kind).toBe('ai-agent');
    expect(results[2].decision.kind).toBe('classified-capture');
    // Marker + ai-agent bypass → only the classified comment actually
    // invoked the LLM.
    expect(invoker.getCallCount('pr-comment-is-capture')).toBe(1);
  });
});
