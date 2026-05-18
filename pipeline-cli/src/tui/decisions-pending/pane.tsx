/**
 * DecisionsPendingPane — RFC-0035 Phase 8 / AISDLC-292.
 *
 * Full-screen TUI pane (mode key `n`) that surfaces pending RFC-0035 Decision
 * records from the event catalog.
 *
 * Features:
 *   AC#1 — Shows pending Decision records (lifecycle: 'open')
 *   AC#2 — Decision actor routing visible per row (Engineering / Product /
 *           Operator / Framework / Unassigned)
 *   AC#3 — Operator can resolve a Decision directly from TUI:
 *           Enter on a row → detail view → `x` → option picker → resolve
 *   AC#4 — After resolution, fires multi-surface notification
 *           (sendDecisionNotifications) for Slack + email surfaces
 *   AC#5 — Composes with TuiCaptureFiled aggregator (no duplicate aggregator):
 *           resolution writes a TuiCaptureFiled event to _tui/events.jsonl
 *   AC#6 — Per-surface enablement loaded from decisions-config.yaml
 *
 * @module tui/decisions-pending/pane
 */

import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';

import { appendDecisionEvent, makeOperatorAnsweredEvent } from '../../decisions/event-log.js';
import type { Decision, DecisionOption } from '../../decisions/decision-record.js';
import {
  actorLabel,
  loadDecisionsConfig,
  resolveDecisionsConfig,
  type DecisionsConfig,
} from '../../decisions/decisions-config.js';
import { sendDecisionNotifications } from '../../decisions/notification.js';
import { writeTuiCaptureFiled } from '../analytics/tui-events-writer.js';
import { useDecisionsPending, type UseDecisionsPendingOpts } from './use-decisions-pending.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatAge(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(ms / 60_000);
  const hours = Math.floor(ms / 3_600_000);
  const days = Math.floor(ms / 86_400_000);
  if (mins < 60) return `${mins}m`;
  if (hours < 24) return `${hours}h`;
  return `${days}d`;
}

function truncate(str: string, max: number): string {
  return str.length <= max ? str : str.slice(0, max - 1) + '…';
}

function tierBadge(tier: string | undefined): string {
  if (!tier) return '';
  return `[${tier.toUpperCase()}]`;
}

/** Color for the actor label column. */
function actorColor(label: string): string {
  if (label === 'Engineering') return 'cyan';
  if (label === 'Product') return 'magenta';
  if (label === 'Operator') return 'yellow';
  if (label === 'Framework') return 'green';
  if (label === 'Design') return 'blue';
  return 'gray';
}

// ── Option picker (resolution dialog) ────────────────────────────────────────

interface OptionPickerProps {
  decision: Decision;
  onPick: (optionId: string) => void;
  onCancel: () => void;
}

function OptionPicker({ decision, onPick, onCancel }: OptionPickerProps): React.ReactElement {
  const options = decision.spec.options;
  const [selected, setSelected] = useState(0);

  useInput((input, key) => {
    if (key.escape || input === 'q') {
      onCancel();
      return;
    }
    if (key.upArrow || input === 'k') {
      setSelected((i) => Math.max(0, i - 1));
    } else if (key.downArrow || input === 'j') {
      setSelected((i) => Math.min(options.length - 1, i + 1));
    } else if (key.return) {
      const opt = options[selected];
      if (opt) onPick(opt.id);
    }
  });

  return (
    <Box flexDirection="column" borderStyle="double" paddingX={2} paddingY={1} width="100%">
      <Box marginBottom={1}>
        <Text bold>Resolve {decision.metadata.id} — choose an option:</Text>
      </Box>
      <Box marginBottom={1}>
        <Text dimColor>{decision.spec.summary}</Text>
      </Box>
      {options.map((opt: DecisionOption, idx: number) => (
        <Box key={opt.id} marginTop={idx === 0 ? 0 : 1} flexDirection="column">
          <Box>
            {idx === selected ? (
              <Text color="green" bold>
                {'> '}
              </Text>
            ) : (
              <Text>{'  '}</Text>
            )}
            <Text bold={idx === selected} color={idx === selected ? 'green' : undefined}>
              [{opt.id}] {opt.description}
            </Text>
          </Box>
          {opt.consequences && opt.consequences.length > 0 && (
            <Box paddingLeft={4} flexDirection="column">
              {opt.consequences.map((c: string, ci: number) => (
                <Text key={ci} dimColor>
                  • {c}
                </Text>
              ))}
            </Box>
          )}
        </Box>
      ))}
      <Box marginTop={1}>
        <Text color="gray" dimColor>
          [↑↓/jk] navigate [Enter] confirm [Esc/q] cancel
        </Text>
      </Box>
    </Box>
  );
}

// ── Detail view ───────────────────────────────────────────────────────────────

interface DecisionDetailProps {
  decision: Decision;
  config: DecisionsConfig;
  onClose: () => void;
  onResolve: (decision: Decision) => void;
}

function DecisionDetail({
  decision,
  config,
  onClose,
  onResolve,
}: DecisionDetailProps): React.ReactElement {
  const actor = decision.status.routing?.assignedActor;
  const label = actorLabel(actor, config);
  const color = actorColor(label);

  useInput((input, key) => {
    if (key.escape || input === 'q') onClose();
    if (input === 'x') onResolve(decision);
  });

  return (
    <Box flexDirection="column" borderStyle="double" paddingX={2} paddingY={1} width="100%">
      {/* Header */}
      <Box marginBottom={1}>
        <Text bold>
          {decision.metadata.id} — <Text color={color}>{label}</Text>
        </Text>
        {decision.status.capacity?.tier && (
          <Text color="gray"> {tierBadge(decision.status.capacity.tier)}</Text>
        )}
      </Box>

      {/* Summary */}
      <Box marginBottom={1}>
        <Text bold>{decision.spec.summary}</Text>
      </Box>

      {/* Body */}
      {decision.spec.body && (
        <Box marginBottom={1} flexDirection="column">
          {decision.spec.body.split('\n').map((line, i) => (
            <Text key={i} dimColor>
              {line}
            </Text>
          ))}
        </Box>
      )}

      {/* Options */}
      <Box marginBottom={1} flexDirection="column">
        <Text bold color="cyan">
          Options:
        </Text>
        {decision.spec.options.map((opt: DecisionOption) => (
          <Box key={opt.id} marginTop={1} flexDirection="column">
            <Text>
              <Text bold>[{opt.id}]</Text> {opt.description}
            </Text>
            {opt.consequences?.map((c: string, i: number) => (
              <Box key={i} paddingLeft={4}>
                <Text dimColor>• {c}</Text>
              </Box>
            ))}
          </Box>
        ))}
      </Box>

      {/* Routing rationale */}
      {decision.status.routing?.actorRationale && (
        <Box marginBottom={1}>
          <Text color="gray" dimColor>
            Routing: {decision.status.routing.actorRationale}
          </Text>
        </Box>
      )}

      {/* Source + scope */}
      <Box marginBottom={1}>
        <Text color="gray" dimColor>
          Source: {decision.metadata.source} Scope: {decision.metadata.scope}
        </Text>
      </Box>

      {/* Reversibility */}
      {decision.spec.reversible === false && (
        <Box marginBottom={1}>
          <Text color="red" bold>
            ⚠ Irreversible decision — auto-apply disabled, explicit confirm required.
          </Text>
        </Box>
      )}

      {/* Action shortcuts */}
      <Box marginTop={1} flexDirection="column">
        <Text color="gray">Actions:</Text>
        <Text color="green"> [x] resolve (choose option)</Text>
        <Text color="gray"> [Esc/q] back to list</Text>
      </Box>
    </Box>
  );
}

// ── Row ───────────────────────────────────────────────────────────────────────

interface DecisionRowProps {
  decision: Decision;
  isSelected: boolean;
  config: DecisionsConfig;
}

function DecisionRow({ decision, isSelected, config }: DecisionRowProps): React.ReactElement {
  const actor = decision.status.routing?.assignedActor;
  const label = actorLabel(actor, config);
  const color = actorColor(label);
  const age = formatAge(decision.metadata.updated);
  const priority =
    typeof decision.status.priority === 'number' ? `p=${decision.status.priority.toFixed(2)}` : '';

  return (
    <Box>
      {isSelected ? (
        <Text bold color="white">
          {'> '}
        </Text>
      ) : (
        <Text>{'  '}</Text>
      )}
      <Text bold={isSelected} color="cyan">
        {decision.metadata.id}
      </Text>
      <Text> </Text>
      <Text color={color}>{label.padEnd(12)}</Text>
      <Text> </Text>
      <Text dimColor={!isSelected}>{truncate(decision.spec.summary, 40)}</Text>
      {priority && (
        <Text color="gray" dimColor>
          {' '}
          {priority}
        </Text>
      )}
      <Text color="gray"> [{age}]</Text>
    </Box>
  );
}

// ── Resolution toast (brief feedback after resolving) ─────────────────────────

interface ResolutionToastProps {
  decisionId: string;
  chosenOptionId: string;
}

function ResolutionToast({ decisionId, chosenOptionId }: ResolutionToastProps): React.ReactElement {
  return (
    <Box borderStyle="round" paddingX={2} paddingY={0} marginTop={1}>
      <Text color="green" bold>
        ✓ {decisionId} resolved → {chosenOptionId}
      </Text>
    </Box>
  );
}

// ── Pane props ────────────────────────────────────────────────────────────────

export interface DecisionsPendingPaneProps {
  /** Inject hook opts (tests). */
  hookOpts?: UseDecisionsPendingOpts;
  /** Override the decisions lister (tests). */
  lister?: UseDecisionsPendingOpts['lister'];
  /** Override the decisions-config reader (tests). */
  configReader?: (path: string) => string;
  /** Project work directory. Defaults `process.cwd()`. */
  workDir?: string;
  /**
   * Override the event appender (tests). Defaults to `appendDecisionEvent`
   * from `decisions/event-log`.
   */
  eventAppender?: typeof appendDecisionEvent;
  /**
   * Override the notification sender (tests).  Defaults to
   * `sendDecisionNotifications`.
   */
  notificationSender?: typeof sendDecisionNotifications;
  /**
   * Override the TuiCaptureFiled writer (tests).  Defaults to
   * `writeTuiCaptureFiled`.
   */
  captureWriter?: typeof writeTuiCaptureFiled;
}

// ── Main pane ─────────────────────────────────────────────────────────────────

/**
 * Full-screen decisions-pending pane (mode `n`).
 *
 * Layout:
 *   Header: "🔮 DECISIONS PENDING (N)"
 *   Rows: one per open Decision (ID, actor, summary, priority, age)
 *   Footer: keystroke hints
 *   Resolution flow: Enter → detail, `x` → option picker → resolve
 */
export function DecisionsPendingPane({
  hookOpts,
  lister,
  configReader,
  workDir,
  eventAppender = appendDecisionEvent,
  notificationSender = sendDecisionNotifications,
  captureWriter = writeTuiCaptureFiled,
}: DecisionsPendingPaneProps = {}): React.ReactElement {
  const effectiveWorkDir = workDir ?? process.cwd();

  // Load config once (tui renders on every tick — stable reader ref is fine
  // because config changes require a restart per the existing TUI pattern).
  const config = loadDecisionsConfig({ workDir: effectiveWorkDir, reader: configReader });
  const resolvedConfig = resolveDecisionsConfig(config);

  // Hook: read pending decisions.
  const { decisions, error } = useDecisionsPending({
    ...hookOpts,
    workDir: effectiveWorkDir,
    ...(lister ? { lister } : {}),
  });

  const [selectedIndex, setSelectedIndex] = useState(0);
  const [detailDecision, setDetailDecision] = useState<Decision | null>(null);
  const [pickingDecision, setPickingDecision] = useState<Decision | null>(null);
  const [lastResolution, setLastResolution] = useState<{
    id: string;
    option: string;
  } | null>(null);

  const clampedIndex = Math.min(selectedIndex, Math.max(0, decisions.length - 1));

  useInput((input, key) => {
    if (detailDecision !== null || pickingDecision !== null) return;

    if (key.upArrow || input === 'k') {
      setSelectedIndex((prev) => Math.max(0, prev - 1));
    } else if (key.downArrow || input === 'j') {
      setSelectedIndex((prev) => Math.min(decisions.length - 1, prev + 1));
    } else if (key.return && decisions.length > 0) {
      setDetailDecision(decisions[clampedIndex] ?? null);
    } else if (input === 'x' && decisions.length > 0) {
      setPickingDecision(decisions[clampedIndex] ?? null);
    }
  });

  // ── Option picker flow ─────────────────────────────────────────────────────

  function handlePickOption(optionId: string): void {
    const decision = pickingDecision;
    if (!decision) return;
    setPickingDecision(null);

    // 1. Append `operator-answered` event to the Decision event log (AC#3).
    try {
      const event = makeOperatorAnsweredEvent({
        decisionId: decision.metadata.id,
        chosenOptionId: optionId,
      });
      eventAppender(event, { workDir: effectiveWorkDir });
    } catch (err) {
      process.stderr.write(
        `[decisions-pending] resolution write failed: ${(err as Error)?.message ?? err}\n`,
      );
    }

    // 2. Emit TuiCaptureFiled event to _tui/events.jsonl (AC#5 — composing
    //    with the existing TuiCaptureFiled aggregator pattern; no new
    //    aggregator needed).
    captureWriter(decision.metadata.id, { pane: 'decisions-pending' });

    // 3. Fire multi-surface notifications (AC#4) — best-effort, non-blocking.
    void notificationSender(decision, optionId, undefined, resolvedConfig.notification);

    // 4. Show resolution toast in the pane (AC#4 — TUI surface).
    setLastResolution({ id: decision.metadata.id, option: optionId });
  }

  // ── Detail-view resolve shortcut ───────────────────────────────────────────

  function handleDetailResolve(decision: Decision): void {
    setDetailDecision(null);
    setPickingDecision(decision);
  }

  // ── Render ────────────────────────────────────────────────────────────────

  // Option picker dialog — renders over the list.
  if (pickingDecision) {
    return (
      <OptionPicker
        decision={pickingDecision}
        onPick={handlePickOption}
        onCancel={() => setPickingDecision(null)}
      />
    );
  }

  // Detail view.
  if (detailDecision) {
    return (
      <DecisionDetail
        decision={detailDecision}
        config={config}
        onClose={() => setDetailDecision(null)}
        onResolve={handleDetailResolve}
      />
    );
  }

  // List view.
  return (
    <Box flexDirection="column" borderStyle="single" paddingX={1} flexGrow={1}>
      {/* Header */}
      <Text bold color={decisions.length > 0 ? 'cyan' : 'green'}>
        🔮 DECISIONS PENDING ({decisions.length})
      </Text>

      {/* Error banner */}
      {error && (
        <Box marginTop={1}>
          <Text color="yellow" dimColor>
            ⚠ Decision catalog unavailable — run `cli-decisions list` to diagnose
          </Text>
        </Box>
      )}

      {/* Empty state */}
      {decisions.length === 0 && !error && (
        <Box marginTop={1}>
          <Text color="green">✓ No pending decisions — catalog clear</Text>
        </Box>
      )}

      {/* Decision rows */}
      {decisions.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          {decisions.map((d, idx) => (
            <DecisionRow
              key={d.metadata.id}
              decision={d}
              isSelected={idx === clampedIndex}
              config={config}
            />
          ))}
        </Box>
      )}

      {/* Resolution toast */}
      {lastResolution && (
        <ResolutionToast decisionId={lastResolution.id} chosenOptionId={lastResolution.option} />
      )}

      {/* Navigation hint */}
      {decisions.length > 0 && (
        <Box marginTop={1}>
          <Text color="gray" dimColor>
            [↑↓/jk] navigate [Enter] detail [x] resolve [Esc] back
          </Text>
        </Box>
      )}
    </Box>
  );
}
