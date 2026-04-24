/**
 * CoreIdentityChanged consumer (RFC-0008 Addendum B §B.9.1).
 *
 * When the DID reconciler detects a change to an `identityClass: 'core'`
 * field, the full backlog must be rescored against the new DID — and
 * in-flight items (issues already admitted but not yet completed) must
 * be flagged as `SoulGraphStale` so reviewers know their priority
 * reflects an out-of-date interpretation of the product's soul.
 *
 * This module is the orchestration layer: it invokes dependency-
 * injected callbacks for the concrete work (recompile, rescore, flag)
 * so the core logic is testable without an admission pipeline.
 */

import type { DesignIntentDocument } from '@ai-sdlc/reference';

// ── Events ──────────────────────────────────────────────────────────

export interface CoreIdentityChangedEvent {
  type: 'CoreIdentityChanged';
  didName: string;
  changedFields: string[];
  timestamp: string;
}

export interface BacklogReshuffledEvent {
  type: 'BacklogReshuffled';
  didName: string;
  rescoredItems: number;
  inFlightFlagged: number;
  triggeredAt: string;
}

export interface SoulGraphStaleFlag {
  issueNumber: number;
  reason: string;
}

// ── Deps ────────────────────────────────────────────────────────────

export interface RescoreDeps {
  /** Load the updated DID for recompilation. */
  getDid: (didName: string) => DesignIntentDocument | undefined;
  /** Recompile DID artifacts (wraps `compileDid` + state-store persistence). */
  recompileArtifacts: (did: DesignIntentDocument) => Promise<void> | void;
  /** Rescore the non-in-flight backlog. Returns the number of items rescored. */
  rescoreFullBacklog: (did: DesignIntentDocument) => Promise<number> | number;
  /** Flag items currently in flight. Returns flags created. */
  flagInFlight: (did: DesignIntentDocument) => Promise<SoulGraphStaleFlag[]> | SoulGraphStaleFlag[];
  /** Clock injection. */
  now?: () => number;
}

// ── Consumer ────────────────────────────────────────────────────────

export interface HandleResult {
  rescored: number;
  inFlightFlags: SoulGraphStaleFlag[];
  reshuffled: BacklogReshuffledEvent;
  /** True when no DID resolved for the name — consumer is a no-op. */
  skipped: boolean;
}

export async function handleCoreIdentityChanged(
  event: CoreIdentityChangedEvent,
  deps: RescoreDeps,
): Promise<HandleResult> {
  const did = deps.getDid(event.didName);
  const nowMs = (deps.now ?? (() => Date.now()))();
  if (!did) {
    return {
      rescored: 0,
      inFlightFlags: [],
      reshuffled: {
        type: 'BacklogReshuffled',
        didName: event.didName,
        rescoredItems: 0,
        inFlightFlagged: 0,
        triggeredAt: new Date(nowMs).toISOString(),
      },
      skipped: true,
    };
  }

  await deps.recompileArtifacts(did);
  const rescored = await deps.rescoreFullBacklog(did);
  const flags = await deps.flagInFlight(did);

  return {
    rescored,
    inFlightFlags: flags,
    reshuffled: {
      type: 'BacklogReshuffled',
      didName: event.didName,
      rescoredItems: rescored,
      inFlightFlagged: flags.length,
      triggeredAt: new Date(nowMs).toISOString(),
    },
    skipped: false,
  };
}
