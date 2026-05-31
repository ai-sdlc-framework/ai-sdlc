/**
 * Hermetic tests for the RFC-0028 §7.2 drift TUI surface (AC-5 / AC-7).
 *
 * Coverage:
 *   - Side-by-side: structural + statistical drift for one Soul render
 *     together under that soul.
 *   - Panel model: counts + hasBlocking reflect composition.
 *   - Empty input renders a stable "no drift" line.
 */

import { describe, it, expect } from 'vitest';
import { buildDriftPanelModel, renderDriftPanel } from './drift-tui-surface.js';
import type { DriftEvent } from './drift-composition.js';

const STRUCTURAL_A: DriftEvent = {
  driftClass: 'structural',
  soulId: 'soul-a',
  severity: 'high',
  blocking: true,
  summary: 'substrate-structural-drift-detected: Soul "soul-a" — phantom-Soul DID',
};
const STATISTICAL_A: DriftEvent = {
  driftClass: 'statistical',
  soulId: 'soul-a',
  severity: 'advisory',
  blocking: false,
  summary: 'soul-statistical-drift-detected: Soul "soul-a" — rolling 30d mean 0.250 < 0.4',
};
const STATISTICAL_B: DriftEvent = {
  driftClass: 'statistical',
  soulId: 'soul-b',
  severity: 'advisory',
  blocking: false,
  summary: 'soul-statistical-drift-detected: Soul "soul-b" — rolling 30d stddev 0.200 > 0.15',
};

describe('buildDriftPanelModel', () => {
  it('groups both classes for one soul side-by-side (AC-5)', () => {
    const model = buildDriftPanelModel([STRUCTURAL_A, STATISTICAL_A, STATISTICAL_B]);
    expect(model.structuralCount).toBe(1);
    expect(model.statisticalCount).toBe(2);
    expect(model.hasBlocking).toBe(true);

    const soulA = model.groups.find((g) => g.soulId === 'soul-a');
    expect(soulA?.structural).toHaveLength(1);
    expect(soulA?.statistical).toHaveLength(1);

    const soulB = model.groups.find((g) => g.soulId === 'soul-b');
    expect(soulB?.structural).toHaveLength(0);
    expect(soulB?.statistical).toHaveLength(1);
  });

  it('no events → empty groups, no blocking', () => {
    const model = buildDriftPanelModel([]);
    expect(model.groups).toHaveLength(0);
    expect(model.hasBlocking).toBe(false);
    expect(model.structuralCount).toBe(0);
    expect(model.statisticalCount).toBe(0);
  });

  it('only statistical → not blocking', () => {
    const model = buildDriftPanelModel([STATISTICAL_B]);
    expect(model.hasBlocking).toBe(false);
  });
});

describe('renderDriftPanel', () => {
  it('renders structural (BLOCKS) and statistical (surface) for the same soul', () => {
    const out = renderDriftPanel([STRUCTURAL_A, STATISTICAL_A]);
    expect(out).toContain('Soul: soul-a');
    expect(out).toContain('Structural (REJECTS deployment):');
    expect(out).toContain('[BLOCKS · high]');
    expect(out).toContain('Statistical (surfaces to operator — non-blocking):');
    expect(out).toContain('[surface · advisory]');
    // Structural section appears before statistical section for the soul.
    expect(out.indexOf('Structural (REJECTS')).toBeLessThan(out.indexOf('Statistical (surfaces'));
  });

  it('renders a stable line when there is no drift', () => {
    const out = renderDriftPanel([]);
    expect(out).toContain('(no drift events)');
  });

  it('header reports both counts', () => {
    const out = renderDriftPanel([STRUCTURAL_A, STATISTICAL_A, STATISTICAL_B]);
    expect(out).toContain('1 structural (blocking)');
    expect(out).toContain('2 statistical (advisory)');
  });

  it('soul with only statistical shows (none) under structural', () => {
    const out = renderDriftPanel([STATISTICAL_B]);
    expect(out).toContain('Soul: soul-b');
    expect(out).toContain('Structural (REJECTS deployment):');
    expect(out).toContain('    (none)');
  });
});
