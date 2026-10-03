/**
 * Types for the staged-review risk map (`review-risk-map.v1`).
 *
 * The map is a structural superset of the narrow view the baseline checklist
 * reads ({@link RiskMapInput}): `hunks`, `criteria`, `changedSourceFiles`,
 * `changedTestFiles` and `changedFiles` keep the names and shapes that view
 * declares, so a map can be handed to the checklist unchanged.
 *
 * @module review-risk-map/types
 */

import type { FileClass, SecurityCategory } from '../review-plan/types.js';
import type { VerificationStatus } from '../types.js';

export type RoutingReviewer = 'testing' | 'critic' | 'security';

/** Probabilities (0..1) the judgment layer returned for one hunk. */
export interface HunkNouls {
  authAuthz: number;
  statePersistence: number;
  concurrency: number;
  inputHandling: number;
  errorHandling: number;
  behaviourWithoutTestChange: number;
}

export interface HunkStructural {
  status: 'available' | 'unavailable';
  callers?: string[];
  callees?: string[];
  referencingTests?: string[];
  schemaConsumers?: string[];
  coverageLines?: number[];
}

export interface RiskMapHunk {
  id: string;
  file: string;
  header: string;
  startLine: number;
  endLine: number;
  fileClass: FileClass;
  testsChanged: boolean;
  /** Changed symbols. Present only when structural facts are available. */
  symbols?: string[];
  structural: HunkStructural;
  /** False when the judgment layer was off or abstained on this hunk. */
  judged: boolean;
  nouls?: HunkNouls;
  /** The judged change-risk Score scaled to 0..1. Present only when judged. */
  judgmentScore?: number;
  /** Ranking score: 1 for an unjudged hunk or one without structural facts. */
  riskScore: number;
  flags: SecurityCategory[];
  /** Redaction markers for secrets found in the hunk; the secret is never recorded. */
  secretMarkers: string[];
  /** 1 is the highest risk. */
  rank: number;
}

export interface RiskMapCriterion {
  id: string;
  text: string;
  likelyUncovered: boolean;
  coverageProbability?: number;
}

export interface RiskMapSourceFile {
  path: string;
  changedTests: string[];
}

export interface RiskMapVerifications {
  build?: VerificationStatus;
  test?: VerificationStatus;
  lint?: VerificationStatus;
  format?: VerificationStatus;
  patchCoveragePercent?: number;
}

export interface ReviewRiskMap {
  schemaVersion: 1;
  generatedAt: string;
  stats: {
    filesChanged: number;
    linesAdded: number;
    linesRemoved: number;
    hunks: number;
    unparseableHeaders: number;
  };
  flags: {
    dependencyManifestChanged: boolean;
    workflowChanged: boolean;
    secretsFound: boolean;
  };
  verifications?: RiskMapVerifications;
  changedFiles: string[];
  changedTestFiles: string[];
  changedSourceFiles: RiskMapSourceFile[];
  /** Ranked from highest risk to lowest. */
  hunks: RiskMapHunk[];
  criteria: RiskMapCriterion[];
  acCoverage: {
    status: 'evaluated' | 'unavailable';
    uncovered: number;
    abstainReason?: string;
  };
  injectionScreen: {
    status: 'clean' | 'suspicious' | 'unavailable';
    findings: string[];
  };
  routing: {
    /** `path-rules-only` when the judgment did not run or did not decide. */
    status: 'judged' | 'path-rules-only';
    reviewers: RoutingReviewer[];
    added: RoutingReviewer[];
    signals: string[];
  };
}
