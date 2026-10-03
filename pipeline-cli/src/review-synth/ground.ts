/**
 * Grounding drop rule and coverage accounting for the synthesize stage.
 *
 * A finding must rest on evidence a probe actually produced. `groundFindings`
 * removes, before aggregation, any finding whose evidence names no probe in the
 * bundle, names a probe that did not complete, names a probe that completed with no
 * evidence, or quotes an excerpt that probe did not return. Pure and deterministic: no I/O,
 * same input, same output.
 *
 * Coverage follows the same rule: a refused, failed or skipped probe, or an `ok` probe
 * with no evidence, is an uncovered hunk, never coverage.
 *
 * @module review-synth/ground
 */

import { redactSecrets } from '@ai-sdlc/reference';
import type {
  DroppedFinding,
  DropReason,
  GroundingResult,
  StagedFinding,
  StagedVerdict,
} from './types.js';
import {
  DATA_TRUNCATION_MARKER,
  EVIDENCE_TRUNCATION_MARKER,
  type EvidenceBundle,
  type EvidenceEntry,
} from '../review-plan/executor.js';

function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Text with the executor's own truncation markers removed: a marker is not evidence. */
function withoutMarkers(text: unknown): string {
  if (typeof text !== 'string') return '';
  return text.split(EVIDENCE_TRUNCATION_MARKER).join('').split(DATA_TRUNCATION_MARKER).join('');
}

function isSubstantive(text: unknown): boolean {
  return withoutMarkers(text).trim() !== '';
}

/**
 * True only for an entry that completed (`ok`) AND carries at least one piece of real
 * evidence: a non-blank observation, an excerpt or command output with non-blank text,
 * or a non-blank answer. A truncation marker alone is not evidence. An `ok` entry with
 * none of these (output that parsed as `{}`, a byte budget that cut it to a marker,
 * excerpts that were all refused) is not coverage and cannot ground a finding.
 */
export function entryHasEvidence(entry: EvidenceEntry): boolean {
  if (entry?.status !== 'ok') return false;
  return (
    (entry.observations ?? []).some(isSubstantive) ||
    (entry.excerpts ?? []).some((e) => isSubstantive(e?.text)) ||
    (entry.commands ?? []).some((c) => isSubstantive(c?.output)) ||
    isSubstantive(entry.answer?.text)
  );
}

/**
 * Every piece of text a probe returned, normalised for substring matching. The model only
 * ever sees the redacted form of this text, so the haystack is built from the redacted form.
 */
function probeHaystack(p: EvidenceEntry): string[] {
  return [
    ...(p.excerpts ?? []).map((e) => e.text),
    ...(p.observations ?? []),
    ...(p.commands ?? []).map((c) => c.output),
    ...(p.answer ? [p.answer.text] : []),
  ]
    .filter((t): t is string => typeof t === 'string')
    .map((t) => normalize(redactSecrets(t)));
}

/**
 * The single lookup rule for duplicate probe ids, shared by grounding and coverage: an id
 * resolves to the FIRST entry in the bundle with that id; later entries with the same id
 * are ignored.
 */
function firstEntryById(evidence: EvidenceBundle): Map<string, EvidenceEntry> {
  const byId = new Map<string, EvidenceEntry>();
  for (const p of evidence.entries) if (!byId.has(p.probeId)) byId.set(p.probeId, p);
  return byId;
}

function judge(
  finding: StagedFinding,
  probes: ReadonlyMap<string, EvidenceEntry>,
): { reason: DropReason; detail: string } | undefined {
  const refs: unknown = finding?.evidence;
  if (!Array.isArray(refs) || refs.length === 0)
    return { reason: 'no-evidence', detail: 'the finding cites no evidence' };
  for (const ref of refs as unknown[]) {
    const probeId = (ref as { probeId?: unknown } | null)?.probeId;
    if (typeof probeId !== 'string' || !probes.has(probeId)) {
      const named = typeof probeId === 'string' ? probeId : '(none)';
      return {
        reason: 'unknown-probe',
        detail: `evidence names probe ${named}, which is not in the bundle`,
      };
    }
    const probe = probes.get(probeId) as EvidenceEntry;
    if (probe.status !== 'ok')
      return {
        reason: 'probe-not-completed',
        detail: `probe ${probeId} was ${probe.status}, so it produced no evidence`,
      };
    if (!entryHasEvidence(probe))
      return {
        reason: 'probe-no-evidence',
        detail: `probe ${probeId} completed but returned no evidence, so nothing can rest on it`,
      };
    const excerpt = (ref as { excerpt?: unknown }).excerpt;
    if (excerpt !== undefined) {
      const wanted = typeof excerpt === 'string' ? normalize(redactSecrets(excerpt)) : '';
      if (wanted === '' || !probeHaystack(probe).some((h) => h.includes(wanted)))
        return {
          reason: 'excerpt-not-in-bundle',
          detail: `the excerpt cited for probe ${probeId} is not in that probe's evidence`,
        };
    }
  }
  return undefined;
}

/**
 * Remove ungrounded findings from a verdict. Returns a new verdict with
 * `groundingDropped` set to the number removed, and the dropped findings with
 * the reason for each. The input is not modified.
 */
export function groundFindings(verdict: StagedVerdict, evidence: EvidenceBundle): GroundingResult {
  const probes = firstEntryById(evidence);
  const kept: StagedFinding[] = [];
  const dropped: DroppedFinding[] = [];
  for (const finding of verdict.findings ?? []) {
    const problem = judge(finding, probes);
    if (problem) dropped.push({ finding, ...problem });
    else kept.push(finding);
  }
  return {
    verdict: { ...verdict, findings: kept, groundingDropped: dropped.length },
    dropped,
  };
}

export interface PlanProbeRef {
  id: string;
  covers: readonly string[];
}

/**
 * Hunks covered by a probe that completed AND returned evidence (`entryHasEvidence`).
 * A hunk whose only probes were refused, failed, skipped or `ok` with no evidence is not
 * covered. Duplicate probe ids resolve to the first entry, exactly as in `groundFindings`.
 */
export function coveredHunkIds(
  planProbes: readonly PlanProbeRef[],
  evidence: EvidenceBundle,
): Set<string> {
  const byId = firstEntryById(evidence);
  const covered = new Set<string>();
  for (const p of planProbes) {
    const e = byId.get(p.id);
    if (!e || !entryHasEvidence(e)) continue;
    for (const h of p.covers) covered.add(h);
  }
  return covered;
}

/** Hunk ids with no completed probe, in the order given. */
export function uncoveredHunkIds(
  hunkIds: readonly string[],
  planProbes: readonly PlanProbeRef[],
  evidence: EvidenceBundle,
): string[] {
  const covered = coveredHunkIds(planProbes, evidence);
  return hunkIds.filter((h) => !covered.has(h));
}
