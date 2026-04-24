/**
 * C5 — Design authority signal detection (RFC-0008 §A.5).
 *
 * Determines whether the issue's author or any commenter is listed as a
 * `designAuthority` principal on the resolved DesignSystemBinding, and
 * parses the explicit signal type from issue labels (preferred) or
 * structured comment markers.
 */

import type { DesignSystemBinding } from '@ai-sdlc/reference';
import type { DesignAuthoritySignalType } from './admission-score.js';

/**
 * Label-encoded design signal types. Short, stable slugs keep GitHub
 * label names readable; the map below converts them to the
 * `DesignAuthoritySignalType` used downstream.
 */
const LABEL_TO_SIGNAL: Readonly<Record<string, DesignAuthoritySignalType>> = Object.freeze({
  'design/advances-coherence': 'advances-design-coherence',
  'design/fills-gap': 'fills-catalog-gap',
  'design/fragments-catalog': 'fragments-component-catalog',
  'design/misaligned-brand': 'misaligned-with-brand',
});

export interface CheckDesignAuthorityInput {
  /** GitHub login of the issue author. */
  authorLogin?: string;
  /** GitHub logins of anyone who commented on the issue. */
  commenterLogins?: readonly string[];
  /** Labels attached to the issue — used to parse the signal type. */
  labels: readonly string[];
}

export interface DesignAuthoritySignalResult {
  isDesignAuthority: boolean;
  signalType: DesignAuthoritySignalType;
}

/**
 * Determine whether the issue author or any commenter is a
 * designAuthority principal, and resolve the signal type from labels.
 * Returns `{ isDesignAuthority: false, signalType: 'unspecified' }`
 * when no DSB is present.
 */
export function checkDesignAuthority(
  input: CheckDesignAuthorityInput,
  binding: DesignSystemBinding | undefined,
): DesignAuthoritySignalResult {
  const principals = binding?.spec.stewardship.designAuthority.principals ?? [];
  const authorityParticipants = collectAuthorityParticipants(input, principals);
  const isDesignAuthority = authorityParticipants.length > 0;
  const signalType = parseDesignSignalType(input.labels);
  return { isDesignAuthority, signalType };
}

function collectAuthorityParticipants(
  input: CheckDesignAuthorityInput,
  principals: readonly string[],
): string[] {
  if (principals.length === 0) return [];
  const principalSet = new Set(principals.map((p) => p.toLowerCase()));
  const participants: string[] = [];
  if (input.authorLogin && principalSet.has(input.authorLogin.toLowerCase())) {
    participants.push(input.authorLogin);
  }
  for (const c of input.commenterLogins ?? []) {
    if (principalSet.has(c.toLowerCase())) participants.push(c);
  }
  return participants;
}

/**
 * Resolve the design-signal type from issue labels.
 *
 * Priority order mirrors the RFC's weighting (positive signals first),
 * so an issue tagged with both a positive and a negative label resolves
 * to the positive one. This is deliberate: design authorities shouldn't
 * dual-tag in practice, but if they do, we don't want to default to the
 * punitive path.
 */
export function parseDesignSignalType(labels: readonly string[]): DesignAuthoritySignalType {
  const priority: DesignAuthoritySignalType[] = [
    'advances-design-coherence',
    'fills-catalog-gap',
    'fragments-component-catalog',
    'misaligned-with-brand',
  ];

  const lowered = labels.map((l) => l.toLowerCase());
  for (const target of priority) {
    const label = Object.entries(LABEL_TO_SIGNAL).find(([, v]) => v === target)?.[0];
    if (label && lowered.includes(label)) return target;
  }
  return 'unspecified';
}
