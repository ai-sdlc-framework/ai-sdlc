/**
 * RFC-0024 §7 — triage rubric.
 *
 * Maps each `CaptureTriageValue` to a human-readable description and
 * the framework action that should be taken. The rubric is a fixed enum
 * (not free-form) so the framework can route deterministically.
 *
 * This module is intentionally thin — it documents the meaning of each
 * triage value and provides a description string for CLI/TUI rendering.
 * The actual adapter calls (create Issue, create Feature Issue, append AC)
 * are out of scope for the v1 CLI and will be wired in the adapter layer
 * (RFC-0003) in a follow-up task.
 *
 * @module capture/triage-rubric
 */

import type { CaptureTriageValue } from './capture-record.js';

// ── Rubric entry ──────────────────────────────────────────────────────────────

export interface TriageRubricEntry {
  /** The triage value. */
  value: CaptureTriageValue;
  /** One-line label for TUI/CLI rendering. */
  label: string;
  /** Human description of the triage meaning. */
  description: string;
  /**
   * Framework action taken when this triage is applied (description only —
   * actual adapter calls are out of scope for v1).
   */
  frameworkAction: string;
  /** True when the triage disposition is terminal (closes the tbd state). */
  isTerminal: boolean;
  /** TUI one-keystroke shortcut (RFC-0024 §10). */
  shortcut?: string;
}

// ── Rubric table ──────────────────────────────────────────────────────────────

export const TRIAGE_RUBRIC: readonly TriageRubricEntry[] = [
  {
    value: 'tbd',
    label: 'Pending',
    description: 'Captured but operator has not yet decided what to do.',
    frameworkAction: 'Surfaces in TUI Blockers pane until resolved.',
    isTerminal: false,
    shortcut: undefined,
  },
  {
    value: 'quick-fix',
    label: 'Quick fix',
    description: 'Small scope; can ship standalone or alongside current work.',
    frameworkAction:
      'Adapter creates an Issue with priority:low and labels quick-fix + source-context.',
    isTerminal: true,
    shortcut: 'q',
  },
  {
    value: 'new-issue',
    label: 'New issue',
    description: 'Separate contract, normal scope; will be scheduled by PPA + DoR.',
    frameworkAction: 'Adapter creates an Issue in Draft state; operator refines before dispatch.',
    isTerminal: true,
    shortcut: 't',
  },
  {
    value: 'scope-extension',
    label: 'Scope extension',
    description: "Belongs in the current issue's AC list (same contract).",
    frameworkAction:
      'Adapter appends AC to extensionTargetIssueId; emits CaptureScopeExtended event.',
    isTerminal: true,
    shortcut: 'e',
  },
  {
    value: 'new-feature-issue',
    label: 'New Feature Issue',
    description: 'Upstream design decision required before any execution Issue can be scoped.',
    frameworkAction:
      'Adapter creates a Feature Issue (Draft) in the configured tracker; surfaces in TUI for operator drafting.',
    isTerminal: true,
    shortcut: 'r',
  },
  {
    value: 'framework-bug',
    label: 'Framework bug',
    description: 'Framework misbehaved (per RFC-0025 taxonomy).',
    frameworkAction:
      'Adapter creates a Bug Issue (kind=bug, label=framework-bug); auto-fills evidence.',
    isTerminal: true,
    shortcut: 'f',
  },
  {
    value: 'not-actionable',
    label: 'Not actionable',
    description: "Known limitation, expected behavior, or won't fix.",
    frameworkAction: 'Records reasoning in capture; archives to _captures/_archive/.',
    isTerminal: true,
    shortcut: 'n',
  },
];

/** Map for O(1) lookups by value. */
export const TRIAGE_RUBRIC_MAP: ReadonlyMap<CaptureTriageValue, TriageRubricEntry> = new Map(
  TRIAGE_RUBRIC.map((e) => [e.value, e]),
);

/**
 * Look up the rubric entry for a given triage value.
 * Returns the 'tbd' entry when the value is not recognised (defensive).
 */
export function getRubricEntry(triage: CaptureTriageValue): TriageRubricEntry {
  return TRIAGE_RUBRIC_MAP.get(triage) ?? TRIAGE_RUBRIC[0];
}

/**
 * Render the rubric as a human-readable table for CLI help output.
 */
export function renderRubricTable(): string {
  const lines: string[] = [
    'Triage values (RFC-0024 §7):',
    '',
    '  Value              Shortcut  Description',
    '  -----------------  --------  -----------------------------------------------',
  ];
  for (const entry of TRIAGE_RUBRIC) {
    const shortcut = entry.shortcut ?? '-';
    const val = entry.value.padEnd(17);
    const sc = shortcut.padEnd(8);
    lines.push(`  ${val}  ${sc}  ${entry.description}`);
  }
  lines.push('');
  lines.push('  Framework action is taken immediately when a terminal triage value is applied.');
  lines.push('  "tbd" captures surface in the TUI Blockers pane until resolved.');
  return lines.join('\n');
}
