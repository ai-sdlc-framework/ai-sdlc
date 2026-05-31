/**
 * RFC-0028 §7.2 — drift composition TUI surface (AC-5).
 *
 * Renders structural + statistical drift events side-by-side for the operator
 * batch-review panel. Composes with the RFC-0023 operator TUI: this module
 * produces a plain-text section (a `DriftPanel` string + a structured
 * `DriftPanelModel`) that the TUI host embeds in its pipeline-visibility view.
 * Keeping the render pure (string in / string out, no terminal control codes)
 * lets the RFC-0023 surface own layout, paging, and color while this module
 * owns the drift-specific content.
 *
 * Side-by-side requirement (RFC-0028 §7.2 rule 3): events are grouped by Soul
 * DID via {@link correlateDriftBySoul} so each soul shows its structural
 * (rejected-at-CI, HIGH) and statistical (caught-at-runtime, advisory) drift
 * together — closing the "drift caught early vs drift that escaped" loop.
 *
 * @see spec/rfcs/RFC-0023-operator-tui.md (the host surface)
 * @see spec/rfcs/RFC-0028-engineering-axis-substrate-enforcement.md §7.2
 * @module substrate/drift-tui-surface
 */

import { correlateDriftBySoul, type DriftClass, type DriftEvent } from './drift-composition.js';

/** A single rendered row in the drift panel. */
export interface DriftPanelRow {
  soulId: string;
  driftClass: DriftClass;
  /** `BLOCKS` for structural, `surface` for statistical. */
  disposition: 'BLOCKS' | 'surface';
  severity: DriftEvent['severity'];
  summary: string;
}

/** Per-soul grouping for the side-by-side panel model. */
export interface DriftPanelSoulGroup {
  soulId: string;
  structural: DriftPanelRow[];
  statistical: DriftPanelRow[];
}

/** The structured model a TUI host can render however it likes (AC-5). */
export interface DriftPanelModel {
  /** Souls in stable (insertion) order, each with both drift classes. */
  groups: DriftPanelSoulGroup[];
  structuralCount: number;
  statisticalCount: number;
  /** True if any structural (blocking) drift is present. */
  hasBlocking: boolean;
}

function toRow(event: DriftEvent): DriftPanelRow {
  return {
    soulId: event.soulId,
    driftClass: event.driftClass,
    disposition: event.driftClass === 'structural' ? 'BLOCKS' : 'surface',
    severity: event.severity,
    summary: event.summary,
  };
}

/**
 * Build the structured panel model from composed drift events. Souls appear
 * in first-seen order; within each soul, structural rows precede statistical
 * rows (hard gate first, then advisory).
 */
export function buildDriftPanelModel(events: DriftEvent[]): DriftPanelModel {
  const bySoul = correlateDriftBySoul(events);
  const groups: DriftPanelSoulGroup[] = [];
  let structuralCount = 0;
  let statisticalCount = 0;
  let hasBlocking = false;

  for (const [soulId, soulEvents] of bySoul) {
    const structural: DriftPanelRow[] = [];
    const statistical: DriftPanelRow[] = [];
    for (const evt of soulEvents) {
      const row = toRow(evt);
      if (evt.driftClass === 'structural') {
        structural.push(row);
        structuralCount += 1;
        hasBlocking = true;
      } else {
        statistical.push(row);
        statisticalCount += 1;
      }
    }
    groups.push({ soulId, structural, statistical });
  }

  return { groups, structuralCount, statisticalCount, hasBlocking };
}

/**
 * Render the drift panel as a plain-text section for the RFC-0023 TUI.
 *
 * Produces a per-soul block with structural drift (rejected at CI, hard gate)
 * and statistical drift (surfaced for operator review, non-blocking) shown
 * side-by-side under each Soul DID. Empty input renders a single "no drift"
 * line so the panel never collapses to nothing.
 */
export function renderDriftPanel(events: DriftEvent[]): string {
  const model = buildDriftPanelModel(events);
  const lines: string[] = [];

  lines.push('Substrate Drift — structural (CI hard gate) + statistical (runtime, G0)');
  lines.push(
    `  ${model.structuralCount} structural (blocking) · ${model.statisticalCount} statistical (advisory)`,
  );

  if (model.groups.length === 0) {
    lines.push('  (no drift events)');
    return lines.join('\n');
  }

  for (const group of model.groups) {
    lines.push('');
    lines.push(`Soul: ${group.soulId}`);
    lines.push('  Structural (REJECTS deployment):');
    if (group.structural.length === 0) {
      lines.push('    (none)');
    } else {
      for (const row of group.structural) {
        lines.push(`    [BLOCKS · ${row.severity}] ${row.summary}`);
      }
    }
    lines.push('  Statistical (surfaces to operator — non-blocking):');
    if (group.statistical.length === 0) {
      lines.push('    (none)');
    } else {
      for (const row of group.statistical) {
        lines.push(`    [surface · ${row.severity}] ${row.summary}`);
      }
    }
  }

  return lines.join('\n');
}
