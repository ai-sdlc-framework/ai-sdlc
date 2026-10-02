import type { JudgmentDefinition } from '../definition.js';
import { getJudgmentDefinition, registerJudgmentDefinition } from '../catalog.js';
import { acCoverageJudgment } from './ac-coverage.js';
import { decisionDuplicateDefinition } from './decision-duplicate.js';
import { decisionPillarsDefinition } from './decision-pillars.js';
import { decisionReversibilityDefinition } from './decision-reversibility.js';
import { decisionStageBSignalsDefinition } from './decision-stage-b-signals.js';
import { estimateClassDefinition } from './estimate-class.js';
import { findingGroundingJudgment } from './finding-grounding.js';

export * from './ac-coverage.js';
export * from './common.js';
export * from './decision-duplicate.js';
export * from './decision-pillars.js';
export * from './decision-reversibility.js';
export * from './decision-stage-b-signals.js';
export * from './estimate-class.js';
export * from './finding-grounding.js';

/** The judgments that replace the Decision and estimation heuristics (RFC-0049 Group A). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const DECISION_ESTIMATION_JUDGMENTS: readonly JudgmentDefinition<any, any>[] = [
  decisionReversibilityDefinition,
  decisionPillarsDefinition,
  decisionDuplicateDefinition,
  decisionStageBSignalsDefinition,
  estimateClassDefinition,
];

for (const def of DECISION_ESTIMATION_JUDGMENTS) {
  if (!getJudgmentDefinition(def.id)) registerJudgmentDefinition(def);
}

/** Register the built-in catalog definitions once; safe to call repeatedly. */
export function registerBuiltInJudgmentDefinitions(): void {
  if (!getJudgmentDefinition(acCoverageJudgment.id)) {
    registerJudgmentDefinition(acCoverageJudgment);
  }
  if (!getJudgmentDefinition(findingGroundingJudgment.id)) {
    registerJudgmentDefinition(findingGroundingJudgment);
  }
}
