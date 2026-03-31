/**
 * Workflow pattern detector — mines frequent n-gram sequences
 * from tool call histories across Claude Code sessions.
 */

import { createHash } from 'node:crypto';
import type { ToolSequenceEvent } from '../state/types.js';
import { categorizeAction } from './telemetry-ingest.js';
import type { CanonicalStep, NGram, DetectedPattern, DetectionOptions } from './types.js';
import { DEFAULT_DETECTION_OPTIONS } from './types.js';

/**
 * Convert a raw tool event to a canonical step.
 */
export function canonicalizeStep(event: ToolSequenceEvent): CanonicalStep {
  return {
    tool: event.toolName,
    action: event.actionCanonical,
    category: categorizeAction(event.toolName, event.actionCanonical),
  };
}

/**
 * Hash a sequence of canonical steps for grouping.
 */
export function hashSequence(steps: CanonicalStep[]): string {
  const key = steps.map((s) => `${s.tool}:${s.action}`).join('|');
  return createHash('sha256').update(key).digest('hex').slice(0, 16);
}

/**
 * Group tool sequence events by session, ordered by timestamp.
 */
export function extractSessionSequences(events: ToolSequenceEvent[]): Map<string, CanonicalStep[]> {
  const sessions = new Map<string, ToolSequenceEvent[]>();

  for (const event of events) {
    const existing = sessions.get(event.sessionId) ?? [];
    existing.push(event);
    sessions.set(event.sessionId, existing);
  }

  const result = new Map<string, CanonicalStep[]>();
  for (const [sessionId, sessionEvents] of sessions) {
    const sorted = sessionEvents.sort(
      (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
    );
    result.set(sessionId, sorted.map(canonicalizeStep));
  }

  return result;
}

/**
 * Generate all contiguous n-grams from a sequence.
 */
export function generateNGrams(
  sequence: CanonicalStep[],
  sessionId: string,
  minN: number,
  maxN: number,
): NGram[] {
  const ngrams: NGram[] = [];

  for (let n = minN; n <= Math.min(maxN, sequence.length); n++) {
    for (let i = 0; i <= sequence.length - n; i++) {
      const steps = sequence.slice(i, i + n);
      ngrams.push({
        steps,
        hash: hashSequence(steps),
        sessionId,
      });
    }
  }

  return ngrams;
}

interface NGramAggregate {
  steps: CanonicalStep[];
  hash: string;
  frequency: number;
  sessionIds: Set<string>;
  timestamps: string[];
}

/**
 * Mine frequent patterns from tool sequence events.
 */
export function mineFrequentPatterns(
  events: ToolSequenceEvent[],
  opts?: Partial<DetectionOptions>,
): DetectedPattern[] {
  const options = { ...DEFAULT_DETECTION_OPTIONS, ...opts };

  // Filter by project and time
  let filtered = events;
  if (options.projectFilter) {
    filtered = filtered.filter((e) => e.projectPath === options.projectFilter);
  }
  if (options.since) {
    const sinceDate = new Date(options.since).getTime();
    filtered = filtered.filter((e) => new Date(e.timestamp).getTime() >= sinceDate);
  }

  if (filtered.length === 0) return [];

  // Group by session
  const sessions = extractSessionSequences(filtered);
  const totalSessions = sessions.size;

  if (totalSessions < options.minSessionCount) return [];

  // Generate n-grams across all sessions
  const aggregates = new Map<string, NGramAggregate>();

  for (const [sessionId, sequence] of sessions) {
    const ngrams = generateNGrams(
      sequence,
      sessionId,
      options.minSequenceLength,
      options.maxSequenceLength,
    );

    // Deduplicate within a session (same hash counted once per session)
    const seenInSession = new Set<string>();
    for (const ngram of ngrams) {
      if (seenInSession.has(ngram.hash)) continue;
      seenInSession.add(ngram.hash);

      const existing = aggregates.get(ngram.hash);
      if (existing) {
        existing.frequency++;
        existing.sessionIds.add(sessionId);
      } else {
        aggregates.set(ngram.hash, {
          steps: ngram.steps,
          hash: ngram.hash,
          frequency: 1,
          sessionIds: new Set([sessionId]),
          timestamps: [],
        });
      }
    }
  }

  // Filter by minimum frequency and session count
  let patterns: NGramAggregate[] = [];
  for (const agg of aggregates.values()) {
    if (agg.frequency >= options.minFrequency && agg.sessionIds.size >= options.minSessionCount) {
      patterns.push(agg);
    }
  }

  // Compute confidence and find max frequency for normalization
  const maxFrequency = Math.max(1, ...patterns.map((p) => p.frequency));

  // Remove subsumed patterns (shorter patterns contained in longer ones with similar frequency)
  patterns = removeSubsumedPatterns(patterns);

  // Build detected patterns with confidence scoring
  const detected: DetectedPattern[] = [];
  for (const p of patterns) {
    const confidence = Math.min(
      1.0,
      (p.sessionIds.size / totalSessions) * (p.frequency / maxFrequency),
    );

    if (confidence < options.minConfidence) continue;

    detected.push({
      hash: p.hash,
      steps: p.steps,
      frequency: p.frequency,
      sessionCount: p.sessionIds.size,
      confidence,
      patternType: 'command-sequence', // Default — classifiers refine this
      suggestedArtifactType: 'command',
      firstSeen: '', // Populated by caller from event timestamps
      lastSeen: '',
      exampleSessionIds: Array.from(p.sessionIds).slice(0, 5),
    });
  }

  // Sort by confidence * length descending
  detected.sort((a, b) => b.confidence * b.steps.length - a.confidence * a.steps.length);

  return detected;
}

/**
 * Remove patterns that are subsumed by longer patterns with similar frequency.
 * A 3-gram is subsumed by a 5-gram if the 3-gram's steps appear contiguously
 * in the 5-gram and the 5-gram has >= 70% of the 3-gram's frequency.
 */
function removeSubsumedPatterns(patterns: NGramAggregate[]): NGramAggregate[] {
  // Sort by length descending so longer patterns take priority
  const sorted = [...patterns].sort((a, b) => b.steps.length - a.steps.length);
  const kept: NGramAggregate[] = [];
  const removed = new Set<string>();

  for (const pattern of sorted) {
    if (removed.has(pattern.hash)) continue;
    kept.push(pattern);

    // Mark shorter patterns that are subsumed
    for (const other of sorted) {
      if (other.hash === pattern.hash || removed.has(other.hash)) continue;
      if (other.steps.length >= pattern.steps.length) continue;

      if (isSubsequence(other.steps, pattern.steps) && pattern.frequency >= other.frequency * 0.7) {
        removed.add(other.hash);
      }
    }
  }

  return kept;
}

/**
 * Check if `short` appears as a contiguous subsequence in `long`.
 */
function isSubsequence(short: CanonicalStep[], long: CanonicalStep[]): boolean {
  if (short.length > long.length) return false;

  for (let i = 0; i <= long.length - short.length; i++) {
    let match = true;
    for (let j = 0; j < short.length; j++) {
      if (short[j].tool !== long[i + j].tool || short[j].action !== long[i + j].action) {
        match = false;
        break;
      }
    }
    if (match) return true;
  }

  return false;
}
