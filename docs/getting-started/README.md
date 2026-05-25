# Getting Started

Get up and running with the AI-SDLC Framework.

## What is AI-SDLC?

AI-SDLC is a **Decision Engine** for autonomous AI software development. It's the **contract-to-shipped** half of a spec-driven development stack: you (or a front-of-funnel tool like [GitHub Spec Kit](https://github.com/github/spec-kit)) hand it a well-specified contract; AI-SDLC dispatches autonomous agents, enforces quality gates, attests every change, and routes every decision to the right human actor. It provides:

- **Decision Engine substrate** — operator-as-decision-steward; every architectural / quality / autonomy decision routes through the [Decision Catalog (RFC-0035)](../../spec/rfcs/RFC-0035-decision-catalog-operator-routing.md)
- **Spec-kit bridge** — `cli-import-spec` / `/ai-sdlc import-spec` consumes spec-kit `tasks.md`, runs the DoR Gate at import, and lands governed backlog tasks ready for dispatch (RFC-0036). **Recommended adopter authoring path.**
- **Agent-agnostic orchestration** — works with Claude Code, GitHub Copilot, Cursor, OpenAI Codex, or any LLM API
- **Structured pipelines** that route tasks through defined stages based on complexity
- **Quality gates** with three-tier enforcement (advisory, soft-mandatory, hard-mandatory)
- **Progressive autonomy** where agents earn trust through demonstrated reliability
- **Codebase intelligence** — complexity analysis, pattern detection, hotspot identification, episodic memory
- **Adapter contracts** that decouple your pipeline from specific tools
- **Tamper-evident audit logging** for every action taken

Everything is declared as YAML resources validated against JSON Schema, following the same patterns as Kubernetes and other infrastructure-as-code systems.

## The recommended adopter authoring path

AI-SDLC supports three artifact altitudes (RFC → Spec → Task; see [`docs/concepts/spec-driven.md`](../concepts/spec-driven.md)). For day-to-day feature work, the recommended path uses **GitHub Spec Kit** as the front-of-funnel tool and the **spec-kit bridge** to land tasks in the AI-SDLC backlog:

```text
spec-kit  ──────►  cli-import-spec  ──────►  AI-SDLC backlog  ──────►  /ai-sdlc execute
(idea →            (DoR Gate at                (governed tasks            (autonomous
 contract)          import; refuse              passing the                 dispatch +
                    + emit clarification        quality contract)            reviewers +
                    upstream on failure)                                     attestation +
                                                                             merge)
```

The bridge is **the seam** between authoring and execution. Each side evolves independently:

- **Front of funnel** (your choice): spec-kit, an adopter RFC scaffold, Linear, Notion, plain markdown. As long as the output is translatable to spec-kit-style `tasks.md`, AI-SDLC consumes it. Spec-kit is recommended because its mature integrations and `/speckit.analyze` cross-artifact consistency check compose cleanly with the DoR Gate.
- **Back of funnel** (always AI-SDLC): DoR Gate → PPA → execute → cross-harness review → attest → merge.

**Start here:** [Tutorial 10 — Spec-Kit Bridge end-to-end walkthrough](../tutorials/10-spec-kit-bridge.md). Authors a feature in spec-kit, imports it, walks through DoR-at-import + analyze auto-resolution + the upstream-clarification feedback loop, dispatches, and ships. Use this if you want the recommended adopter authoring path end-to-end.

> **Spec-kit is recommended, not required.** Adopters can author backlog tasks directly without any upstream tool. The framework's contract with adopters is the DoR Gate; whatever feeds the gate is the adopter's choice. See [`docs/concepts/spec-driven.md`](../concepts/spec-driven.md) §5 ("When to skip tiers") for guidance.

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

- **[Spec-Kit Bridge tutorial](../tutorials/10-spec-kit-bridge.md)** -- **Recommended adopter authoring path.** End-to-end walkthrough: install spec-kit → author spec → import → DoR-at-import → dispatch → ship → handle drift (RFC-0036).
- **[Concepts: spec-driven development](../concepts/spec-driven.md)** -- The three-tier authoring model (RFC → Spec → Task), Decision-Engine framing, and the seam contract.
- **[Runners Reference](../api-reference/runners.md)** -- All supported agent runners and configuration
- **[Tutorials](../tutorials/)** -- Step-by-step walkthroughs for pipelines, gates, autonomy, adapters, and orchestration
- **[API Reference](../api-reference/)** -- Complete SDK and orchestrator reference
- **[Architecture](../architecture.md)** -- Package structure, data flow, and design patterns
- **[Troubleshooting](../troubleshooting.md)** -- Common issues and solutions
- **[Primer](../../spec/primer.md)** -- Conceptual introduction to the framework
- **[Specification](../../spec/spec.md)** -- Full normative spec for implementors
- **[Examples](../examples/)** -- Complete working examples
