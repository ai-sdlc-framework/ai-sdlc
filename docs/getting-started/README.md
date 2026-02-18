# Getting Started

Get up and running with the AI-SDLC Framework.

## What is AI-SDLC?

AI-SDLC is an orchestrator that drives AI coding agents through the full software development lifecycle. It provides:

- **Agent-agnostic orchestration** — works with Claude Code, GitHub Copilot, Cursor, OpenAI Codex, or any LLM API
- **Structured pipelines** that route tasks through defined stages based on complexity
- **Quality gates** with three-tier enforcement (advisory, soft-mandatory, hard-mandatory)
- **Progressive autonomy** where agents earn trust through demonstrated reliability
- **Codebase intelligence** — complexity analysis, pattern detection, hotspot identification, episodic memory
- **Adapter contracts** that decouple your pipeline from specific tools
- **Tamper-evident audit logging** for every action taken

Everything is declared as YAML resources validated against JSON Schema, following the same patterns as Kubernetes and other infrastructure-as-code systems.

## Architecture Overview

The framework is built on five resource types organized in a four-layer model:

```
┌──────────────────────────────────────────┐
│           Pipeline                        │  Orchestration: triggers, stages, routing
├──────────────────────────────────────────┤
│    AgentRole    │    QualityGate          │  Behavior: agents + enforcement
├──────────────────────────────────────────┤
│         AutonomyPolicy                    │  Governance: trust levels + promotion
├──────────────────────────────────────────┤
│         AdapterBinding                    │  Integration: tool connections
└──────────────────────────────────────────┘
```

| Resource | Purpose |
|---|---|
| **Pipeline** | Defines triggers, providers, stages, routing, and orchestration flow |
| **AgentRole** | Declares an agent's identity (role/goal/backstory), tools, constraints, and handoffs |
| **QualityGate** | Specifies enforcement rules — metric thresholds, tool scans, reviewer requirements |
| **AutonomyPolicy** | Governs trust levels (0-3) with promotion criteria and demotion triggers |
| **AdapterBinding** | Binds a tool (GitHub, Linear, Jira) to a standard interface contract |

## Prerequisites

- Node.js >= 20
- pnpm >= 9

## Installation

### Orchestrator (CLI)

```bash
npm install -g @ai-sdlc/orchestrator

# Initialize in your repository
ai-sdlc init

# Run a pipeline for a single issue
ai-sdlc run --issue 42
```

### Agent runners

The orchestrator auto-discovers available runners from environment variables:

```bash
# Claude Code (always available as default runner)
# Copilot — set GH_TOKEN or GITHUB_TOKEN
export GH_TOKEN=ghp_...

# Cursor — set CURSOR_API_KEY
export CURSOR_API_KEY=cur_...

# Codex — set CODEX_API_KEY
export CODEX_API_KEY=cdx_...

# Any OpenAI-compatible API — set OPENAI_API_KEY or LLM_API_KEY + LLM_API_URL
export OPENAI_API_KEY=sk-...
```

### For SDK users

```bash
npm install @ai-sdlc/reference
# or
pnpm add @ai-sdlc/reference
```

### For contributors

```bash
git clone https://github.com/ai-sdlc-framework/ai-sdlc.git
cd ai-sdlc
pnpm install
pnpm build
```

## Core Concepts

- **Resource envelope** -- Every resource has `apiVersion`, `kind`, `metadata`, and `spec`. Optional `status` is set by the runtime.
- **Enforcement levels** -- Gates use advisory (log only), soft-mandatory (block with override), or hard-mandatory (block always).
- **Autonomy levels** -- Agents progress through Intern (0), Junior (1), Senior (2), Principal (3) by meeting quantitative criteria.
- **Adapter interfaces** -- Six core contracts (IssueTracker, SourceControl, CIPipeline, CodeAnalysis, Messenger, DeploymentTarget) plus infrastructure interfaces.
- **Reconciliation loop** -- A controller pattern that continuously drives actual state toward desired state.

## Validate Schemas

```bash
pnpm --filter @ai-sdlc/reference validate-schemas
```

## Your First Pipeline

### As YAML

Create a `pipeline.yaml`:

```yaml
apiVersion: ai-sdlc.io/v1alpha1
kind: Pipeline
metadata:
  name: my-first-pipeline
spec:
  triggers:
    - event: issue.assigned
  providers:
    issueTracker:
      type: linear
  stages:
    - name: implement
      agent: code-agent
    - name: review
      agent: reviewer-agent
```

### Using the Builder API

```typescript
import { PipelineBuilder, validateResource } from '@ai-sdlc/reference';

const pipeline = new PipelineBuilder('my-first-pipeline')
  .addTrigger({ event: 'issue.assigned' })
  .addProvider('issueTracker', { type: 'linear' })
  .addStage({ name: 'implement', agent: 'code-agent' })
  .addStage({ name: 'review', agent: 'reviewer-agent' })
  .build();

const result = validateResource(pipeline);
console.log(result.valid); // true
```

## Validating Resources Programmatically

The SDK validates resources against JSON Schema (draft 2020-12):

```typescript
import { validate, validateResource } from '@ai-sdlc/reference';
import { readFileSync } from 'fs';
import { parse } from 'yaml';

// Option 1: Infer kind from document
const doc = parse(readFileSync('pipeline.yaml', 'utf-8'));
const result = validateResource(doc);

// Option 2: Specify kind explicitly
const result2 = validate('Pipeline', doc);

if (!result.valid) {
  for (const err of result.errors!) {
    console.error(`${err.path}: ${err.message}`);
  }
}
```

## Your First Quality Gate

```typescript
import { QualityGateBuilder, enforce } from '@ai-sdlc/reference';

const gate = new QualityGateBuilder('code-standards')
  .addGate({
    name: 'test-coverage',
    enforcement: 'soft-mandatory',
    rule: { metric: 'line-coverage', operator: '>=', threshold: 80 },
    override: { requiredRole: 'engineering-manager', requiresJustification: true },
  })
  .addGate({
    name: 'security-scan',
    enforcement: 'hard-mandatory',
    rule: { tool: 'semgrep', maxSeverity: 'medium' },
  })
  .build();

// Evaluate the gate
const result = enforce(gate, {
  authorType: 'ai-agent',
  repository: 'org/my-service',
  metrics: { 'line-coverage': 85 },
  toolResults: { semgrep: { findings: [] } },
});

console.log(result.allowed); // true
console.log(result.results.map(r => `${r.gate}: ${r.verdict}`));
// ['test-coverage: pass', 'security-scan: pass']
```

## Running the Dogfood Pipeline

The repository includes a self-hosted pipeline that uses the framework to manage its own development:

```bash
# Run the dogfood pipeline tests
pnpm --filter @ai-sdlc/dogfood test

# Run all tests across the monorepo
pnpm test
```

## Next Steps

- **[Runners Reference](../api-reference/runners.md)** -- All supported agent runners and configuration
- **[Tutorials](../tutorials/)** -- Step-by-step walkthroughs for pipelines, gates, autonomy, adapters, and orchestration
- **[API Reference](../api-reference/)** -- Complete SDK and orchestrator reference
- **[Architecture](../architecture.md)** -- Package structure, data flow, and design patterns
- **[Troubleshooting](../troubleshooting.md)** -- Common issues and solutions
- **[Primer](../../spec/primer.md)** -- Conceptual introduction to the framework
- **[Specification](../../spec/spec.md)** -- Full normative spec for implementors
- **[Examples](../examples/)** -- Complete working examples
