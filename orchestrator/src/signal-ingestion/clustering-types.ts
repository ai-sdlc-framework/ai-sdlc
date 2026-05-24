/**
 * Input shape consumed by `clusterSignals()` per RFC-0030 Phase 3.
 *
 * `ClusteredSignalInput` is a subset of `ClassifiedSignal` (Phase 2 output)
 * carried through the clusterer plus optional adapter-tier metadata used
 * during cluster aggregation. Kept in a separate file so consumers can
 * import the input shape without pulling in the clusterer's full surface
 * (algorithm types, options) — and so the classifier doesn't depend on
 * clustering.ts (avoid circular imports).
 *
 * @module signal-ingestion/clustering-types
 */

import type { ICPResonance } from './classifier.js';
import type { CustomerTier, RawSignal, SignalTier } from './types.js';

/**
 * Per-signal input to the clusterer.
 *
 * A subset of `ClassifiedSignal` (Phase 2) chosen to keep clustering
 * decoupled from Phase 2's full output shape:
 *   - `signal`, `customerTier`, `icpResonance`, `recencyDecay` are carried
 *     through and surfaced on the resulting `DemandCluster.members` so
 *     Phase 4/5 consumers retain access without re-running classification.
 *   - `adapterTier` is an OPTIONAL hint that lets Phase 4 sum `tier1` /
 *     `tier2` member counts without re-deriving from `signal.metadata`.
 *     When absent, the clusterer falls back to `signal.metadata.adapterTier`
 *     then to Tier 1 (matches classifier convention).
 */
export interface ClusteredSignalInput {
  signal: RawSignal;
  customerTier: CustomerTier;
  icpResonance: ICPResonance;
  recencyDecay: number;
  /** Optional adapter tier hint (Tier 1 default when absent). */
  adapterTier?: SignalTier;
}
