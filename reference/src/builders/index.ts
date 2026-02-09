/**
 * Fluent resource builders for all 5 core resource types.
 * Provides type-safe construction with sensible defaults.
 * <!-- Source: PRD Section 9.4 -->
 */

import type {
  Pipeline,
  PipelineSpec,
  AgentRole,
  AgentRoleSpec,
  QualityGate,
  QualityGateSpec,
  AutonomyPolicy,
  AdapterBinding,
  AdapterBindingSpec,
  Stage,
  Trigger,
  Provider,
  Routing,
  AgentConstraints,
  Handoff,
  Skill,
  AgentCard,
  Gate,
  GateScope,
  Evaluation,
  AutonomyLevel,
  PromotionCriteria,
  DemotionTrigger,
  AdapterInterface,
  HealthCheck,
  Metadata,
} from '../core/types.js';

import { API_VERSION } from '../core/types.js';

// Distribution builder
export {
  parseBuilderManifest,
  validateBuilderManifest,
  buildDistribution,
  type BuilderManifest,
  type ManifestAdapter,
  type ManifestOutput,
  type ResolvedAdapter,
  type DistributionBuildResult,
  type BuildDistributionOptions,
} from './distribution.js';

// ── Metadata helpers ─────────────────────────────────────────────────

function baseMetadata(name: string): Metadata {
  return { name, labels: {}, annotations: {} };
}

// ── PipelineBuilder ──────────────────────────────────────────────────

export class PipelineBuilder {
  private _metadata: Metadata;
  private _stages: Stage[] = [];
  private _triggers: Trigger[] = [];
  private _providers: Record<string, Provider> = {};
  private _routing?: Routing;

  constructor(name: string) {
    this._metadata = baseMetadata(name);
  }

  label(key: string, value: string): this {
    this._metadata.labels![key] = value;
    return this;
  }

  annotation(key: string, value: string): this {
    this._metadata.annotations![key] = value;
    return this;
  }

  addStage(stage: Stage): this {
    this._stages.push(stage);
    return this;
  }

  addTrigger(trigger: Trigger): this {
    this._triggers.push(trigger);
    return this;
  }

  addProvider(name: string, provider: Provider): this {
    this._providers[name] = provider;
    return this;
  }

  withRouting(routing: Routing): this {
    this._routing = routing;
    return this;
  }

  build(): Pipeline {
    const spec: PipelineSpec = {
      stages: this._stages,
      triggers: this._triggers,
      providers: this._providers,
    };
    if (this._routing) spec.routing = this._routing;

    return {
      apiVersion: API_VERSION,
      kind: 'Pipeline',
      metadata: { ...this._metadata },
      spec,
    };
  }
}

// ── AgentRoleBuilder ─────────────────────────────────────────────────

export class AgentRoleBuilder {
  private _metadata: Metadata;
  private _role: string;
  private _goal: string;
  private _backstory?: string;
  private _tools: string[] = [];
  private _constraints?: AgentConstraints;
  private _handoffs: Handoff[] = [];
  private _skills: Skill[] = [];
  private _agentCard?: AgentCard;

  constructor(name: string, role: string, goal: string) {
    this._metadata = baseMetadata(name);
    this._role = role;
    this._goal = goal;
  }

  label(key: string, value: string): this {
    this._metadata.labels![key] = value;
    return this;
  }

  annotation(key: string, value: string): this {
    this._metadata.annotations![key] = value;
    return this;
  }

  backstory(backstory: string): this {
    this._backstory = backstory;
    return this;
  }

  addTool(tool: string): this {
    this._tools.push(tool);
    return this;
  }

  tools(tools: string[]): this {
    this._tools = tools;
    return this;
  }

  withConstraints(constraints: AgentConstraints): this {
    this._constraints = constraints;
    return this;
  }

  addHandoff(handoff: Handoff): this {
    this._handoffs.push(handoff);
    return this;
  }

  addSkill(skill: Skill): this {
    this._skills.push(skill);
    return this;
  }

  withAgentCard(card: AgentCard): this {
    this._agentCard = card;
    return this;
  }

  build(): AgentRole {
    const spec: AgentRoleSpec = {
      role: this._role,
      goal: this._goal,
      tools: this._tools,
    };
    if (this._backstory) spec.backstory = this._backstory;
    if (this._constraints) spec.constraints = this._constraints;
    if (this._handoffs.length > 0) spec.handoffs = this._handoffs;
    if (this._skills.length > 0) spec.skills = this._skills;
    if (this._agentCard) spec.agentCard = this._agentCard;

    return {
      apiVersion: API_VERSION,
      kind: 'AgentRole',
      metadata: { ...this._metadata },
      spec,
    };
  }
}

// ── QualityGateBuilder ───────────────────────────────────────────────

export class QualityGateBuilder {
  private _metadata: Metadata;
  private _gates: Gate[] = [];
  private _scope?: GateScope;
  private _evaluation?: Evaluation;

  constructor(name: string) {
    this._metadata = baseMetadata(name);
  }

  label(key: string, value: string): this {
    this._metadata.labels![key] = value;
    return this;
  }

  annotation(key: string, value: string): this {
    this._metadata.annotations![key] = value;
    return this;
  }

  addGate(gate: Gate): this {
    this._gates.push(gate);
    return this;
  }

  withScope(scope: GateScope): this {
    this._scope = scope;
    return this;
  }

  withEvaluation(evaluation: Evaluation): this {
    this._evaluation = evaluation;
    return this;
  }

  build(): QualityGate {
    const spec: QualityGateSpec = {
      gates: this._gates,
    };
    if (this._scope) spec.scope = this._scope;
    if (this._evaluation) spec.evaluation = this._evaluation;

    return {
      apiVersion: API_VERSION,
      kind: 'QualityGate',
      metadata: { ...this._metadata },
      spec,
    };
  }
}

// ── AutonomyPolicyBuilder ────────────────────────────────────────────

export class AutonomyPolicyBuilder {
  private _metadata: Metadata;
  private _levels: AutonomyLevel[] = [];
  private _promotionCriteria: Record<string, PromotionCriteria> = {};
  private _demotionTriggers: DemotionTrigger[] = [];

  constructor(name: string) {
    this._metadata = baseMetadata(name);
  }

  label(key: string, value: string): this {
    this._metadata.labels![key] = value;
    return this;
  }

  annotation(key: string, value: string): this {
    this._metadata.annotations![key] = value;
    return this;
  }

  addLevel(level: AutonomyLevel): this {
    this._levels.push(level);
    return this;
  }

  addPromotionCriteria(key: string, criteria: PromotionCriteria): this {
    this._promotionCriteria[key] = criteria;
    return this;
  }

  addDemotionTrigger(trigger: DemotionTrigger): this {
    this._demotionTriggers.push(trigger);
    return this;
  }

  build(): AutonomyPolicy {
    return {
      apiVersion: API_VERSION,
      kind: 'AutonomyPolicy',
      metadata: { ...this._metadata },
      spec: {
        levels: this._levels,
        promotionCriteria: this._promotionCriteria,
        demotionTriggers: this._demotionTriggers,
      },
    };
  }
}

// ── AdapterBindingBuilder ────────────────────────────────────────────

export class AdapterBindingBuilder {
  private _metadata: Metadata;
  private _interface: AdapterInterface;
  private _type: string;
  private _version: string;
  private _source?: string;
  private _config?: Record<string, unknown>;
  private _healthCheck?: HealthCheck;

  constructor(name: string, iface: AdapterInterface, type: string, version: string) {
    this._metadata = baseMetadata(name);
    this._interface = iface;
    this._type = type;
    this._version = version;
  }

  label(key: string, value: string): this {
    this._metadata.labels![key] = value;
    return this;
  }

  annotation(key: string, value: string): this {
    this._metadata.annotations![key] = value;
    return this;
  }

  source(source: string): this {
    this._source = source;
    return this;
  }

  config(config: Record<string, unknown>): this {
    this._config = config;
    return this;
  }

  withHealthCheck(healthCheck: HealthCheck): this {
    this._healthCheck = healthCheck;
    return this;
  }

  build(): AdapterBinding {
    const spec: AdapterBindingSpec = {
      interface: this._interface,
      type: this._type,
      version: this._version,
    };
    if (this._source) spec.source = this._source;
    if (this._config) spec.config = this._config;
    if (this._healthCheck) spec.healthCheck = this._healthCheck;

    return {
      apiVersion: API_VERSION,
      kind: 'AdapterBinding',
      metadata: { ...this._metadata },
      spec,
    };
  }
}
