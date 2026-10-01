import type { CapabilityDefinition } from './types.js';

const registry = new Map<string, CapabilityDefinition>();

/** Register a capability. Throws on a duplicate id. */
export function registerCapability(def: CapabilityDefinition): void {
  if (registry.has(def.id)) {
    throw new Error(`Capability already registered: ${def.id}`);
  }
  registry.set(def.id, { ...def });
}

export function getCapability(id: string): CapabilityDefinition | undefined {
  return registry.get(id);
}

export function listCapabilities(): CapabilityDefinition[] {
  return [...registry.values()];
}

const PENDING = 'The call returns a pending sentinel and the caller continues without it.';

function judgment(id: string, title: string, specifiedBy: string): CapabilityDefinition {
  return {
    id,
    title,
    specifiedBy,
    fallback: PENDING,
    enable: 'Configure a model backend for the judgment layer and leave the capability enabled.',
  };
}

/** The initial capability set (RFC-0049 section 9.1). */
export const BUILT_IN_CAPABILITIES: readonly CapabilityDefinition[] = [
  judgment('classifier.capture-triage', 'Capture triage classifier', 'RFC-0024'),
  judgment('classifier.capture-severity', 'Capture severity classifier', 'RFC-0024'),
  judgment('classifier.pr-comment-is-capture', 'PR comment capture classifier', 'RFC-0024'),
  judgment(
    'classifier.dor-answer-is-new-concern',
    'Definition-of-ready answer concern classifier',
    'RFC-0024',
  ),
  judgment('decisions.stage-c-recommendation', 'Decision stage C recommendation', 'RFC-0035'),
  {
    id: 'decisions.stage-b-signals',
    title: 'Decision stage B signals',
    specifiedBy: 'RFC-0035',
    fallback: 'Signals are constants at 0.5.',
    enable: 'Configure a model backend so stage B signals are computed.',
  },
  {
    id: 'dor.stage-b',
    title: 'Definition-of-ready stage B',
    specifiedBy: 'RFC-0011',
    fallback: 'Gates 4 and 6 are skipped.',
    enable: 'Configure a model backend for the readiness judgments.',
  },
  {
    id: 'estimation.class-assignment',
    title: 'Estimation class assignment',
    specifiedBy: 'RFC-0016',
    fallback: 'The class is taken from a title-prefix regex.',
    enable: 'Configure a model backend for class assignment.',
  },
  {
    id: 'estimation.stage-b',
    title: 'Estimation stage B',
    specifiedBy: 'RFC-0016',
    fallback: 'The stage A verdict is used unchanged.',
    enable: 'Configure a model backend for stage B estimation.',
  },
  {
    id: 'sa.layer3',
    title: 'Situational awareness layer 3',
    specifiedBy: 'RFC-0008',
    fallback: 'No production client exists, so layer 3 does not run.',
    enable: 'Provide a layer 3 client implementation.',
  },
  {
    id: 'review.meta-review',
    title: 'Meta-review',
    specifiedBy: 'orchestrator/src/review-meta.ts',
    fallback: 'The meta-review hook is not wired, so no meta-review happens.',
    enable: 'Wire the meta-review hook into the review pipeline.',
  },
  {
    id: 'policy.llm-evaluator',
    title: 'Policy LLM evaluator',
    specifiedBy: 'reference policy',
    fallback: 'A stub evaluator answers instead of a model.',
    enable: 'Supply a model-backed evaluator to the policy engine.',
  },
  {
    id: 'pricing.feed',
    title: 'Model price feed',
    specifiedBy: 'RFC-0050',
    fallback: 'The last known prices stay in force and are marked stale after the staleness limit.',
    enable: 'Run `cli-usage prices refresh` and allow outbound access to the price sources.',
  },
];

for (const def of BUILT_IN_CAPABILITIES) registerCapability(def);
