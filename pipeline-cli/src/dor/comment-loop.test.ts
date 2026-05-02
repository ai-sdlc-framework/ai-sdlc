/**
 * Comment loop tests — render + idempotent posting + dual-fanout (RFC-0011 §6).
 */

import { describe, expect, it } from 'vitest';
import {
  bodyForChannel,
  DOR_COMMENT_MARKER,
  dorCommentMarkerFor,
  enabledChannels,
  fanoutPost,
  gateName,
  postIdempotent,
  renderAdmitComment,
  renderClarificationComment,
  renderPrTasksComment,
  type CommentPoster,
  type ExistingComment,
  type PrTaskVerdict,
} from './comment-loop.js';
import type { RefinementVerdict } from './types.js';

function blockedVerdict(): RefinementVerdict {
  return {
    issueId: 'AISDLC-test',
    rubricVersion: 'v1',
    overallVerdict: 'needs-clarification',
    overallConfidence: 'high',
    gates: [
      {
        gateId: 1,
        verdict: 'fail',
        severity: 'block',
        stage: 'B',
        confidence: 'high',
        finding: 'AC #2 is not binary-testable',
        clarificationQuestion: 'What metric and threshold define success?',
      },
      {
        gateId: 5,
        verdict: 'fail',
        severity: 'block',
        stage: 'B',
        confidence: 'medium',
        finding: 'Surface "search" is ambiguous',
        clarificationQuestion: 'Which search surface — site search, admin, or API?',
      },
      { gateId: 2, verdict: 'pass', severity: 'block', stage: 'A', confidence: 'high' },
    ],
    signedAt: '2026-05-01T12:00:00.000Z',
    evaluatorVersion: 'e2e-stage-b-v1',
    summary: 'Blocked on Gates 1 and 5.',
    questions: [
      'What metric and threshold define success?',
      'Which search surface — site search, admin, or API?',
    ],
  };
}

function admittedVerdict(): RefinementVerdict {
  return {
    ...blockedVerdict(),
    overallVerdict: 'admit',
    gates: blockedVerdict().gates.map((g) => ({ ...g, verdict: 'pass', finding: undefined })),
    questions: [],
    summary: 'All gates passed.',
  };
}

class InMemoryPoster implements CommentPoster {
  comments: ExistingComment[] = [];
  nextId = 1;
  async list(): Promise<ExistingComment[]> {
    return [...this.comments];
  }
  async create(body: string): Promise<string> {
    const id = `c${this.nextId++}`;
    this.comments.push({ id, body });
    return id;
  }
  async update(commentId: string, body: string): Promise<void> {
    const idx = this.comments.findIndex((c) => c.id === commentId);
    if (idx >= 0) this.comments[idx] = { id: commentId, body };
  }
}

describe('renderClarificationComment', () => {
  it('includes the channel marker as the first non-empty line', () => {
    const body = renderClarificationComment(blockedVerdict());
    expect(body.startsWith(dorCommentMarkerFor('author'))).toBe(true);
  });

  it('renders one section per blocked gate', () => {
    const body = renderClarificationComment(blockedVerdict());
    expect(body).toContain('### Gate 1 — Acceptance criteria are binary-testable');
    expect(body).toContain('### Gate 5 — Affected surface is named');
    // gate 2 passes — should NOT appear as a heading
    expect(body).not.toContain('### Gate 2 —');
  });

  it('includes the questions checklist', () => {
    const body = renderClarificationComment(blockedVerdict());
    expect(body).toContain('### Clarifying questions');
    expect(body).toContain('- [ ] What metric and threshold define success?');
    expect(body).toContain('- [ ] Which search surface — site search, admin, or API?');
  });

  it('redacts secrets in findings', () => {
    const verdict = blockedVerdict();
    verdict.gates[0]!.finding =
      'token sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA exposed';
    const body = renderClarificationComment(verdict);
    expect(body).not.toContain('sk-ant-api03-');
    expect(body).toContain('[REDACTED:');
  });

  it('redacts secrets in questions', () => {
    const verdict = blockedVerdict();
    verdict.questions = ['leaked sk-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA value'];
    const body = renderClarificationComment(verdict);
    expect(body).not.toContain('sk-AAAA');
  });

  it('honors a custom rubric URL', () => {
    const body = renderClarificationComment(blockedVerdict(), { rubricUrl: 'https://x.test/rfc' });
    expect(body).toContain('https://x.test/rfc');
  });

  it('uses dedicated-slack marker when channel option set', () => {
    const body = renderClarificationComment(blockedVerdict(), { channel: 'dedicated-slack' });
    expect(body).toContain(dorCommentMarkerFor('dedicated-slack'));
    expect(body).not.toContain(dorCommentMarkerFor('author'));
  });
});

describe('renderAdmitComment', () => {
  it('declares the issue ready and embeds the rubric URL', () => {
    const body = renderAdmitComment(admittedVerdict());
    expect(body).toContain('Issue ready for execution');
    expect(body).toContain('rubric v1');
    expect(body).toContain(dorCommentMarkerFor('author'));
  });
});

describe('gateName', () => {
  it('returns canonical names for gates 1-7', () => {
    expect(gateName(1)).toContain('binary-testable');
    expect(gateName(7)).toContain('invisible dependencies');
  });

  it('falls back to "Gate N" for unknown ids', () => {
    expect(gateName(42)).toBe('Gate 42');
  });
});

describe('postIdempotent', () => {
  const ctx = (body: string, channel: 'author' = 'author') => ({
    marker: dorCommentMarkerFor(channel),
    body,
    channel,
  });

  it('creates a new comment when none exists', async () => {
    const poster = new InMemoryPoster();
    const body = `${dorCommentMarkerFor('author')}\nhello`;
    const result = await postIdempotent(poster, ctx(body));
    expect(result.action).toBe('created');
    expect(poster.comments.length).toBe(1);
  });

  it('updates the existing comment when body differs', async () => {
    const poster = new InMemoryPoster();
    const v1 = `${dorCommentMarkerFor('author')}\nv1`;
    const v2 = `${dorCommentMarkerFor('author')}\nv2`;
    await postIdempotent(poster, ctx(v1));
    const result = await postIdempotent(poster, ctx(v2));
    expect(result.action).toBe('updated');
    expect(poster.comments.length).toBe(1);
    expect(poster.comments[0]!.body).toContain('v2');
  });

  it('no-ops when body is identical', async () => {
    const poster = new InMemoryPoster();
    const body = `${dorCommentMarkerFor('author')}\nsame`;
    await postIdempotent(poster, ctx(body));
    const result = await postIdempotent(poster, ctx(body));
    expect(result.action).toBe('no-op');
    expect(poster.comments.length).toBe(1);
  });

  it('ignores comments lacking the marker', async () => {
    const poster = new InMemoryPoster();
    poster.comments.push({ id: 'unrelated', body: 'random comment' });
    const body = `${dorCommentMarkerFor('author')}\nhi`;
    const result = await postIdempotent(poster, ctx(body));
    expect(result.action).toBe('created');
    expect(poster.comments.length).toBe(2);
  });
});

describe('enabledChannels', () => {
  it('returns author when authorChannel true and no dedicated', () => {
    expect(enabledChannels({ authorChannel: true })).toEqual(['author']);
  });

  it('returns nothing when all channels disabled', () => {
    expect(enabledChannels({ authorChannel: false })).toEqual([]);
  });

  it('includes dedicated-slack and dedicated-github when set', () => {
    const channels = enabledChannels({
      authorChannel: true,
      dedicatedChannel: { slack: '#x', github_team: '@org/triage' },
    });
    expect(channels).toEqual(['author', 'dedicated-slack', 'dedicated-github']);
  });
});

describe('bodyForChannel', () => {
  it('rewrites the marker to the target channel', () => {
    const body = `${dorCommentMarkerFor('author')}\nhi`;
    const out = bodyForChannel(body, 'dedicated-slack');
    expect(out).toContain(dorCommentMarkerFor('dedicated-slack'));
    expect(out).not.toContain(dorCommentMarkerFor('author'));
  });

  it('handles the bare marker too', () => {
    const body = `${DOR_COMMENT_MARKER}\nhi`;
    const out = bodyForChannel(body, 'dedicated-github');
    expect(out).toContain(dorCommentMarkerFor('dedicated-github'));
  });
});

describe('fanoutPost', () => {
  it('posts to each enabled channel exactly once', async () => {
    const author = new InMemoryPoster();
    const slack = new InMemoryPoster();
    const body = `${dorCommentMarkerFor('author')}\nclarify please`;
    const results = await fanoutPost({ author, 'dedicated-slack': slack }, body, {
      authorChannel: true,
      dedicatedChannel: { slack: '#dor' },
    });
    expect(results.map((r) => r.channel).sort()).toEqual(['author', 'dedicated-slack']);
    expect(author.comments.length).toBe(1);
    expect(slack.comments.length).toBe(1);
    expect(slack.comments[0]!.body).toContain(dorCommentMarkerFor('dedicated-slack'));
  });

  it('skips posting when a channel poster is missing', async () => {
    const author = new InMemoryPoster();
    const body = `${dorCommentMarkerFor('author')}\nx`;
    const results = await fanoutPost({ author }, body, {
      authorChannel: true,
      dedicatedChannel: { slack: '#dor' },
    });
    expect(results.length).toBe(1);
    expect(author.comments.length).toBe(1);
  });

  it('is idempotent across re-runs (no duplicate comments per channel)', async () => {
    const author = new InMemoryPoster();
    const body = `${dorCommentMarkerFor('author')}\nx`;
    await fanoutPost({ author }, body, { authorChannel: true });
    await fanoutPost({ author }, body, { authorChannel: true });
    expect(author.comments.length).toBe(1);
  });

  it('isolates partial failures — one channel throwing does not block siblings', async () => {
    // Regression for AISDLC-115.4 round-2 reviewer feedback:
    // sequential for-loop + no try/catch meant one bad poster broke the
    // others. fanoutPost now uses Promise.allSettled so the throw is
    // captured into a per-channel `error` result and other channels still
    // post.
    class ThrowingPoster implements CommentPoster {
      async list(): Promise<ExistingComment[]> {
        throw new Error('slack outage 503');
      }
      async create(): Promise<string> {
        throw new Error('unreachable — list() throws first');
      }
      async update(): Promise<void> {
        throw new Error('unreachable — list() throws first');
      }
    }
    const author = new InMemoryPoster();
    const slack = new ThrowingPoster();
    const ghTeam = new InMemoryPoster();
    const body = `${dorCommentMarkerFor('author')}\nclarify`;
    const results = await fanoutPost(
      { author, 'dedicated-slack': slack, 'dedicated-github': ghTeam },
      body,
      {
        authorChannel: true,
        dedicatedChannel: { slack: '#dor', github_team: '@org/triage' },
      },
    );
    // Three results in stable channel order (author, dedicated-slack, dedicated-github).
    expect(results.map((r) => r.channel)).toEqual([
      'author',
      'dedicated-slack',
      'dedicated-github',
    ]);
    const byChannel = Object.fromEntries(results.map((r) => [r.channel, r] as const));
    // Sibling channels still posted.
    expect(byChannel['author']!.action).toBe('created');
    expect(byChannel['dedicated-github']!.action).toBe('created');
    expect(author.comments.length).toBe(1);
    expect(ghTeam.comments.length).toBe(1);
    // The bad channel's failure is captured for the operator, not thrown.
    expect(byChannel['dedicated-slack']!.action).toBe('error');
    expect(byChannel['dedicated-slack']!.error).toContain('slack outage 503');
  });
});

describe('renderPrTasksComment', () => {
  function blockingTaskVerdict(): PrTaskVerdict {
    return {
      ...blockedVerdict(),
      __file: 'backlog/tasks/aisdlc-test - thing.md',
    };
  }
  function cleanTaskVerdict(): PrTaskVerdict {
    return {
      ...admittedVerdict(),
      __file: 'backlog/tasks/aisdlc-clean - other.md',
    };
  }

  it('renders the clean message when no task is blocking', () => {
    const body = renderPrTasksComment([cleanTaskVerdict()]);
    expect(body).toContain('## Backlog tasks: DoR clean');
    expect(body).toContain(dorCommentMarkerFor('author'));
  });

  it('lists blocked tasks with per-gate findings', () => {
    const body = renderPrTasksComment([blockingTaskVerdict(), cleanTaskVerdict()]);
    expect(body).toContain('## Backlog tasks: DoR clarifications needed');
    expect(body).toContain('backlog/tasks/aisdlc-test - thing.md');
    expect(body).toContain('**Gate 1**');
    expect(body).toContain('**Gate 5**');
    // Clean task is NOT listed in clarifications-needed mode.
    expect(body).not.toContain('aisdlc-clean - other.md');
  });

  it('redacts secrets in PR-summary findings', () => {
    // Build the secret marker via template-literal concatenation so
    // GitHub secret-scanning doesn't trip on the test source.
    const fakeAnthropicToken = `sk-ant-` + `api03-` + 'A'.repeat(60);
    const blocking = blockingTaskVerdict();
    blocking.gates[0]!.finding = `URL extracted: https://example.test/?t=${fakeAnthropicToken}`;
    const body = renderPrTasksComment([blocking]);
    expect(body).not.toContain(fakeAnthropicToken);
    expect(body).toContain('[REDACTED:ANTHROPIC]');
  });
});

describe('round-counter helpers (RFC-0011 §6.3 + Phase 6)', () => {
  it('dorRoundMarker stamps the round number into a stable marker', async () => {
    const { dorRoundMarker } = await import('./comment-loop.js');
    expect(dorRoundMarker(1)).toBe('<!-- ai-sdlc:dor-round n="1" -->');
    expect(dorRoundMarker(7)).toBe('<!-- ai-sdlc:dor-round n="7" -->');
  });

  it('countClarificationRounds returns 0 when no markers are present', async () => {
    const { countClarificationRounds } = await import('./comment-loop.js');
    expect(countClarificationRounds([])).toBe(0);
    expect(countClarificationRounds([{ id: '1', body: 'no marker here' }])).toBe(0);
    expect(
      countClarificationRounds([
        { id: '1', body: '<!-- ai-sdlc:dor-comment -->\n## Issue not yet ready' },
      ]),
    ).toBe(0);
  });

  it('countClarificationRounds finds the highest round number across comments', async () => {
    const { countClarificationRounds, dorRoundMarker } = await import('./comment-loop.js');
    const comments = [
      { id: '1', body: `${dorRoundMarker(1)}\nfirst pass` },
      { id: '2', body: 'unrelated comment' },
      { id: '3', body: `${dorRoundMarker(3)}\nthird pass` },
      { id: '4', body: `${dorRoundMarker(2)}\nsecond pass (out of order)` },
    ];
    expect(countClarificationRounds(comments)).toBe(3);
  });

  it('countClarificationRounds handles multiple markers within one body', async () => {
    const { countClarificationRounds, dorRoundMarker } = await import('./comment-loop.js');
    const body = [dorRoundMarker(1), '...', dorRoundMarker(5), '...', dorRoundMarker(2)].join('\n');
    expect(countClarificationRounds([{ id: '1', body }])).toBe(5);
  });

  it('countClarificationRounds ignores malformed markers', async () => {
    const { countClarificationRounds } = await import('./comment-loop.js');
    expect(
      countClarificationRounds([
        { id: '1', body: '<!-- ai-sdlc:dor-round -->' },
        { id: '2', body: '<!-- ai-sdlc:dor-round n="abc" -->' },
      ]),
    ).toBe(0);
  });
});
