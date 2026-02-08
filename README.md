# AI-SDLC Framework

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
[![Spec Version](https://img.shields.io/badge/spec-v1alpha1-orange.svg)](#versioning)
[![Status: Draft](https://img.shields.io/badge/status-draft-yellow.svg)](#status)

**The open, vendor-neutral governance specification for AI-augmented software development lifecycles.**

The AI-SDLC Framework defines how human engineers and AI coding agents collaborate across the full SDLC — from issue triage through code generation, review, testing, and deployment — with predictable, auditable, enterprise-grade outcomes.

---

## The Problem

85% of developers use AI coding tools and 41% of GitHub code is AI-generated, yet only 1 in 5 companies has mature governance for AI agents. The result:

- **Security**: AI-generated code introduces security flaws in 45% of test cases
- **Quality decline**: Refactoring dropped from 25% to 10% of changes; code churn rose from 5.5% to 7.9%
- **Productivity paradox**: Experienced developers using AI tools are 19% slower on mature codebases, despite believing they are 20% faster
- **Review bottleneck**: PRs merged increased 98%, but review time increased 91%

The AI-SDLC Framework closes this governance gap.

## How It Works

```
Declare desired SDLC state in YAML
  → Observe actual development activity via adapters
    → Diff against policy
      → Reconcile — continuously.
```

The framework sits above the emerging agent standards stack as the **orchestration and governance layer**:

| Protocol       | Scope                         | Relationship to AI-SDLC                   |
| -------------- | ----------------------------- | ----------------------------------------- |
| **MCP**        | Agent-to-tool integration     | AI-SDLC adapters can wrap MCP servers     |
| **A2A**        | Agent-to-agent communication  | AI-SDLC agents publish A2A Agent Cards    |
| **AGENTS.md**  | Per-project agent instructions| AI-SDLC policies generate AGENTS.md files |
| **AI-SDLC**    | SDLC orchestration & governance| The orchestration layer above all three   |

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                      SPECIFICATION LAYER                        │
│  Resource types: Pipeline, AgentRole, QualityGate,              │
│  AutonomyPolicy, AdapterBinding — with JSON Schema validation   │
├─────────────────────────────────────────────────────────────────┤
│                        ADAPTER LAYER                            │
│  Terraform-style provider contracts per integration category    │
│  IssueTracker | SourceControl | CIPipeline | CodeAnalysis |    │
│  Messenger | DeploymentTarget                                   │
├─────────────────────────────────────────────────────────────────┤
│                        POLICY LAYER                             │
│  OPA/Gatekeeper template/instance separation                    │
│  Sentinel 3-tier enforcement (advisory|soft-mandatory|hard)     │
│  CSA ATF progressive autonomy levels                            │
├─────────────────────────────────────────────────────────────────┤
│                        RUNTIME LAYER                            │
│  Kubernetes controller reconciliation loop                      │
│  Declarative agent roles | Workflow graphs                      │
│  A2A-compatible Agent Cards for discovery                       │
└─────────────────────────────────────────────────────────────────┘
         ▼               ▼                ▼              ▼
    ┌─────────┐   ┌──────────┐   ┌────────────┐   ┌──────────┐
    │  Linear  │   │  GitHub  │   │  SonarQube │   │  Slack   │
    │  Jira    │   │  GitLab  │   │  Semgrep   │   │  Teams   │
    └─────────┘   └──────────┘   └────────────┘   └──────────┘
```

## Specification Documents

| Document | Type | Status | Description |
| --- | --- | --- | --- |
| [spec.md](spec/spec.md) | Normative | Draft | Core resource model, validation rules, reconciliation semantics |
| [primer.md](spec/primer.md) | Informative | Draft | Concepts, architecture rationale, getting started |
| [adapters.md](spec/adapters.md) | Normative | Draft | Adapter interface contracts, registration, discovery |
| [policy.md](spec/policy.md) | Normative | Draft | Quality gate schema, enforcement levels, evaluation |
| [autonomy.md](spec/autonomy.md) | Normative | Draft | Autonomy levels, promotion criteria, demotion triggers |
| [agents.md](spec/agents.md) | Normative | Draft | Agent roles, handoff contracts, orchestration |
| [metrics.md](spec/metrics.md) | Normative | Draft | Metric definitions, observability conventions |
| [glossary.md](spec/glossary.md) | Informative | Draft | Term definitions |

## Core Resource Types

The framework defines five declarative resource types following the Kubernetes `spec/status` pattern:

- **[Pipeline](spec/spec.md#51-pipeline)** — SDLC workflow from trigger through delivery
- **[AgentRole](spec/spec.md#52-agentrole)** — AI agent identity, capabilities, and constraints
- **[QualityGate](spec/spec.md#53-qualitygate)** — Policy rules with graduated enforcement
- **[AutonomyPolicy](spec/spec.md#54-autonomypolicy)** — Progressive autonomy with earned trust
- **[AdapterBinding](spec/spec.md#55-adapterbinding)** — Tool integrations as swappable providers

## JSON Schemas

All resource types have formal [JSON Schema (draft 2020-12)](spec/schemas/) definitions enabling IDE autocompletion, CI validation, and programmatic tooling.

## Versioning

The specification follows Kubernetes-style API maturity:

| Stage | Format | Stability |
| --- | --- | --- |
| Alpha | `v1alpha1` | No stability guarantee |
| Beta | `v1beta1` | 9 months support after deprecation |
| GA | `v1` | 12 months support after deprecation |

**Current version: `v1alpha1`**

## Packages

| Package | Path | Description |
| --- | --- | --- |
| `spec/` | [`spec/`](spec/) | Formal specification and JSON schemas |
| `@ai-sdlc/reference` | [`reference/`](reference/) | TypeScript reference implementation |
| `@ai-sdlc/conformance` | [`conformance/`](conformance/) | Language-agnostic conformance test suite |
| `@ai-sdlc/sdk` | [`sdk-typescript/`](sdk-typescript/) | TypeScript SDK |
| `sdk-python` | [`sdk-python/`](sdk-python/) | Python SDK (planned) |
| `sdk-go` | [`sdk-go/`](sdk-go/) | Go SDK (planned) |
| `contrib/` | [`contrib/`](contrib/) | Community adapters and plugins |
| `docs/` | [`docs/`](docs/) | User-facing documentation |

## Development Setup

```bash
# Prerequisites: Node.js >= 20, pnpm >= 9

# Install dependencies
pnpm install

# Build all packages
pnpm build

# Run all tests
pnpm test

# Validate JSON schemas
pnpm validate-schemas
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for how to contribute to the specification.

Changes to normative spec documents require the [RFC process](spec/rfcs/README.md).

## Governance

See [GOVERNANCE.md](GOVERNANCE.md) for project roles, decision making, and SIG structure.

## License

This project is licensed under [Apache 2.0](LICENSE).

## Code of Conduct

This project follows the [Contributor Covenant v2.1](CODE_OF_CONDUCT.md).
