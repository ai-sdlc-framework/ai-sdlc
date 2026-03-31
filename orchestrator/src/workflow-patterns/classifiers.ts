/**
 * Pattern type classifiers — refine detected patterns into
 * specific automation types based on their structure.
 */

import type { DetectedPattern, CanonicalStep } from './types.js';

/**
 * Classify a detected pattern into a specific type and suggest an artifact.
 */
export function classifyPattern(pattern: DetectedPattern): DetectedPattern {
  // Check classifiers in priority order
  if (isCopyPasteCycle(pattern.steps)) {
    return {
      ...pattern,
      patternType: 'copy-paste-cycle',
      suggestedArtifactType: 'skill',
    };
  }

  if (isPeriodicTask(pattern)) {
    return {
      ...pattern,
      patternType: 'periodic-task',
      suggestedArtifactType: 'workflow',
    };
  }

  // Default: command sequence
  return {
    ...pattern,
    patternType: 'command-sequence',
    suggestedArtifactType: 'command',
  };
}

/**
 * Copy-paste cycle: Read from one file, then Write/Edit a different file type.
 * Suggests the user is copying boilerplate or scaffolding from templates.
 */
function isCopyPasteCycle(steps: CanonicalStep[]): boolean {
  let hasRead = false;
  let hasWriteAfterRead = false;

  for (const step of steps) {
    if (step.category === 'read') {
      hasRead = true;
    } else if (hasRead && step.category === 'write') {
      hasWriteAfterRead = true;
    }
  }

  // Must have at least one read→write transition
  if (!hasWriteAfterRead) return false;

  // The write should target a different file than the read
  const readActions = steps.filter((s) => s.category === 'read').map((s) => s.action);
  const writeActions = steps.filter((s) => s.category === 'write').map((s) => s.action);

  // If reads and writes target different extensions, it's likely scaffolding
  const readExts = new Set(readActions.map((a) => a.split(':').pop()));
  const writeExts = new Set(writeActions.map((a) => a.split(':').pop()));

  // Different file types or at least some diversity
  const hasDistinctTargets =
    readExts.size > 0 && writeExts.size > 0 && ![...readExts].every((e) => writeExts.has(e));

  return hasDistinctTargets || (readActions.length > 0 && writeActions.length > 1);
}

/**
 * Periodic task: same pattern occurs with regular time spacing.
 * Requires firstSeen and lastSeen spanning 7+ days.
 */
function isPeriodicTask(pattern: DetectedPattern): boolean {
  if (!pattern.firstSeen || !pattern.lastSeen) return false;

  const first = new Date(pattern.firstSeen).getTime();
  const last = new Date(pattern.lastSeen).getTime();
  const spanDays = (last - first) / (1000 * 60 * 60 * 24);

  // Must span at least 7 days with regular occurrence
  return spanDays >= 7 && pattern.sessionCount >= 3;
}
