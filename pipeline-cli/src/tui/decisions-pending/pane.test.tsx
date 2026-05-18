/**
 * DecisionsPendingPane unit tests — AISDLC-292 AC#1–#5.
 */

import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';

import { DecisionsPendingPane } from './pane.js';
import type { Decision } from '../../decisions/decision-record.js';
import type { ReadEventsOpts } from '../../decisions/event-log.js';

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeDecision(id: string, assignedActor?: string, priority?: number): Decision {
  return {
    apiVersion: 'ai-sdlc.io/v1alpha1',
    kind: 'Decision',
    metadata: {
      id,
      source: 'ad-hoc',
      scope: 'workspace',
      created: '2026-05-01T00:00:00Z',
      updated: '2026-05-01T00:00:00Z',
    },
    spec: {
      summary: `Summary for ${id}`,
      options: [
        { id: 'opt-a', description: 'Option A', consequences: ['Consequence 1'] },
        { id: 'opt-b', description: 'Option B' },
      ],
    },
    status: {
      lifecycle: 'open',
      priority: priority ?? null,
      routing: assignedActor ? { assignedActor } : undefined,
    },
    decisionLog: [],
  };
}

function noopLister(_opts?: ReadEventsOpts): { decisions: Decision[]; skipped: number } {
  return { decisions: [], skipped: 0 };
}

function makeLister(
  decisions: Decision[],
): (_opts?: ReadEventsOpts) => { decisions: Decision[]; skipped: number } {
  return (_opts?: ReadEventsOpts) => ({ decisions, skipped: 0 });
}

// ── Empty state ───────────────────────────────────────────────────────────────

describe('DecisionsPendingPane — empty state', () => {
  it('shows the empty-state message when no pending decisions', () => {
    const { lastFrame } = render(
      <DecisionsPendingPane
        lister={noopLister}
        hookOpts={{ intervalMs: 999_999_999, lister: noopLister }}
      />,
    );
    expect(lastFrame()).toContain('No pending decisions');
  });

  it('shows the DECISIONS PENDING header with count', () => {
    const { lastFrame } = render(
      <DecisionsPendingPane
        lister={noopLister}
        hookOpts={{ intervalMs: 999_999_999, lister: noopLister }}
      />,
    );
    expect(lastFrame()).toContain('DECISIONS PENDING (0)');
  });
});

// ── AC#1 — Shows pending Decision records ─────────────────────────────────────

describe('DecisionsPendingPane — AC#1 pending records', () => {
  it('lists pending decisions by ID', () => {
    const decisions = [makeDecision('DEC-0001'), makeDecision('DEC-0002')];
    const lister = makeLister(decisions);
    const { lastFrame } = render(
      <DecisionsPendingPane lister={lister} hookOpts={{ intervalMs: 999_999_999, lister }} />,
    );
    expect(lastFrame()).toContain('DEC-0001');
    expect(lastFrame()).toContain('DEC-0002');
    expect(lastFrame()).toContain('DECISIONS PENDING (2)');
  });
});

// ── AC#2 — Actor routing visible per row ─────────────────────────────────────

describe('DecisionsPendingPane — AC#2 actor routing', () => {
  it('shows actor label Engineering for engineering pillar owner', () => {
    const decisions = [makeDecision('DEC-0001', 'eng@example.com')];
    const lister = makeLister(decisions);
    const configReader = () => `pillarOwners:\n  engineering: eng@example.com\n`;
    const { lastFrame } = render(
      <DecisionsPendingPane
        lister={lister}
        hookOpts={{ intervalMs: 999_999_999, lister }}
        configReader={configReader}
      />,
    );
    expect(lastFrame()).toContain('Engineering');
  });

  it('shows "Operator" for operator literal actor', () => {
    const decisions = [makeDecision('DEC-0001', 'operator')];
    const lister = makeLister(decisions);
    const { lastFrame } = render(
      <DecisionsPendingPane
        lister={lister}
        hookOpts={{ intervalMs: 999_999_999, lister }}
        configReader={() => ''}
      />,
    );
    expect(lastFrame()).toContain('Operator');
  });

  it('shows "Framework" for framework actor', () => {
    const decisions = [makeDecision('DEC-0001', 'framework')];
    const lister = makeLister(decisions);
    const { lastFrame } = render(
      <DecisionsPendingPane
        lister={lister}
        hookOpts={{ intervalMs: 999_999_999, lister }}
        configReader={() => ''}
      />,
    );
    expect(lastFrame()).toContain('Framework');
  });

  it('shows "Unassigned" when no routing actor set', () => {
    const decisions = [makeDecision('DEC-0001', undefined)];
    const lister = makeLister(decisions);
    const { lastFrame } = render(
      <DecisionsPendingPane
        lister={lister}
        hookOpts={{ intervalMs: 999_999_999, lister }}
        configReader={() => ''}
      />,
    );
    expect(lastFrame()).toContain('Unassigned');
  });
});

// ── AC#3 — Operator can resolve (event appender called) ───────────────────────

describe('DecisionsPendingPane — AC#3 resolve from TUI', () => {
  it('calls eventAppender with operator-answered event when resolution completes', async () => {
    const decisions = [makeDecision('DEC-0001', 'operator')];
    const lister = makeLister(decisions);
    const appender = vi.fn();
    const captureWriter = vi.fn().mockReturnValue(true);
    const notificationSender = vi.fn().mockResolvedValue([]);

    const { stdin } = render(
      <DecisionsPendingPane
        lister={lister}
        hookOpts={{ intervalMs: 999_999_999, lister }}
        configReader={() => ''}
        eventAppender={appender}
        captureWriter={captureWriter}
        notificationSender={notificationSender}
      />,
    );

    // Wait for initial useInput effects to register raw-mode stdin listener.
    await new Promise((r) => setTimeout(r, 20));
    // Navigate to first decision (already selected), open option picker.
    stdin.write('x');
    // Wait for OptionPicker's useInput effects to register.
    await new Promise((r) => setTimeout(r, 20));
    // Confirm with Enter (first option is selected by default).
    stdin.write('\r');
    await new Promise((r) => setTimeout(r, 20));

    expect(appender).toHaveBeenCalledOnce();
    const [event] = appender.mock.calls[0] as [{ type: string; chosenOptionId: string }];
    expect(event.type).toBe('operator-answered');
    expect(event.chosenOptionId).toBe('opt-a');
  });
});

// ── AC#3+5+4 combined — verify all three spies in one pass ───────────────────

describe('DecisionsPendingPane — combined resolution spies', () => {
  it('calls all three: eventAppender + captureWriter + notificationSender', async () => {
    const decisions = [makeDecision('DEC-0099', 'operator')];
    const lister = makeLister(decisions);
    const appender = vi.fn();
    const captureWriter = vi.fn().mockReturnValue(true);
    const notificationSender = vi.fn().mockResolvedValue([]);

    const { stdin } = render(
      <DecisionsPendingPane
        lister={lister}
        hookOpts={{ intervalMs: 999_999_999, lister }}
        configReader={() => ''}
        eventAppender={appender}
        captureWriter={captureWriter}
        notificationSender={notificationSender}
      />,
    );

    await new Promise((r) => setTimeout(r, 20)); // wait for initial useInput effects to register
    stdin.write('x');
    await new Promise((r) => setTimeout(r, 20)); // wait for OptionPicker's useInput effects to register
    stdin.write('\r');
    await new Promise((r) => setTimeout(r, 20)); // wait for handlePickOption to complete

    // All three must be called in the same handlePickOption invocation.
    expect(appender).toHaveBeenCalledOnce();
    expect(captureWriter).toHaveBeenCalledOnce();
    expect(notificationSender).toHaveBeenCalledOnce();
  });
});

// ── AC#5 — TuiCaptureFiled composed (no duplicate aggregator) ─────────────────

describe('DecisionsPendingPane — AC#5 TuiCaptureFiled compose', () => {
  it('calls captureWriter with the decision ID after resolution', async () => {
    const decisions = [makeDecision('DEC-0042', 'operator')];
    const lister = makeLister(decisions);
    const appender = vi.fn();
    const captureWriter = vi.fn().mockReturnValue(true);
    const notificationSender = vi.fn().mockResolvedValue([]);

    const { stdin } = render(
      <DecisionsPendingPane
        lister={lister}
        hookOpts={{ intervalMs: 999_999_999, lister }}
        configReader={() => ''}
        eventAppender={appender}
        captureWriter={captureWriter}
        notificationSender={notificationSender}
      />,
    );

    await new Promise((r) => setTimeout(r, 20)); // wait for initial useInput effects to register
    stdin.write('x');
    await new Promise((r) => setTimeout(r, 20)); // wait for OptionPicker's useInput effects to register
    stdin.write('\r');
    await new Promise((r) => setTimeout(r, 20)); // wait for handlePickOption to complete

    expect(captureWriter).toHaveBeenCalledOnce();
    const [captureId, opts] = captureWriter.mock.calls[0] as [string, { pane: string }];
    expect(captureId).toBe('DEC-0042');
    expect(opts.pane).toBe('decisions-pending');
  });
});

// ── AC#4 — Notification sender called ────────────────────────────────────────

describe('DecisionsPendingPane — AC#4 notification sender', () => {
  it('calls notificationSender after resolution', async () => {
    const decisions = [makeDecision('DEC-0001', 'operator')];
    const lister = makeLister(decisions);
    const appender = vi.fn();
    const captureWriter = vi.fn().mockReturnValue(true);
    const notificationSender = vi.fn().mockResolvedValue([]);

    const { stdin } = render(
      <DecisionsPendingPane
        lister={lister}
        hookOpts={{ intervalMs: 999_999_999, lister }}
        configReader={() => ''}
        eventAppender={appender}
        captureWriter={captureWriter}
        notificationSender={notificationSender}
      />,
    );

    await new Promise((r) => setTimeout(r, 20)); // wait for initial useInput effects to register
    stdin.write('x');
    await new Promise((r) => setTimeout(r, 20)); // wait for OptionPicker's useInput effects to register
    stdin.write('\r');
    await new Promise((r) => setTimeout(r, 20)); // wait for handlePickOption to complete

    expect(notificationSender).toHaveBeenCalledOnce();
    const [dec, optionId] = notificationSender.mock.calls[0] as [Decision, string];
    expect(dec.metadata.id).toBe('DEC-0001');
    expect(optionId).toBe('opt-a');
  });
});
