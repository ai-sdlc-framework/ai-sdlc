# AI-SDLC Framework Charter

## Mission

Provide the open, vendor-neutral governance specification that enables enterprises to adopt AI coding agents with the same confidence, auditability, and predictability they expect from their existing SDLC tooling.

## Scope

The AI-SDLC Framework specification defines:

1. **Resource model** — Declarative resource types for SDLC pipelines, agent roles, quality gates, autonomy policies, and adapter bindings
2. **Adapter contracts** — Typed interface contracts for integrating with development tools (issue trackers, source control, CI/CD, code analysis, messaging)
3. **Policy framework** — Quality gate definitions with graduated enforcement levels (advisory, soft-mandatory, hard-mandatory)
4. **Autonomy system** — Progressive autonomy levels with quantitative promotion criteria and automatic demotion triggers
5. **Agent orchestration** — Agent role definitions, handoff contracts, and orchestration patterns
6. **Metrics and observability** — Standard metric definitions and OpenTelemetry integration conventions
7. **Conformance levels** — Testable criteria for implementation conformance

### In Scope

- Specification documents defining normative requirements
- JSON Schema definitions for all resource types
- Reference implementation (TypeScript)
- Conformance test suite
- Language-specific SDKs
- Community adapter implementations
- RFC process for specification evolution
- Informative guides, documentation, and glossary

### Out of Scope

- Hosted services or SaaS offerings
- Endorsement of specific AI models or tools

## Design Principles

| # | Principle | Rationale |
| --- | --- | --- |
| DP-1 | Separate WHAT from HOW | Users declare desired state; controllers encode operational knowledge |
| DP-2 | Declarative over imperative | YAML-defined policies, not procedural scripts |
| DP-3 | Spec-first with implementation traceability | Specification drives implementation; all code traces back to normative requirements |
| DP-4 | Extensible from day one | Custom resource types for org-specific needs |
| DP-5 | Tool-agnostic via adapters | Swap tools without changing pipeline definitions |
| DP-6 | Progressive enforcement | Start advisory, graduate to hard-mandatory |
| DP-7 | Earned autonomy, not granted | Agents start at minimum autonomy; promotion requires evidence |
| DP-8 | Reconciliation over point-in-time checks | Continuous convergence, not one-shot validation |
| DP-9 | Core-plus-extensions model | Minimal required core; rich extension mechanism |
| DP-10 | Compliance by design | Map controls to ISO 42001, NIST AI RMF, EU AI Act |

## CNCF Alignment

This project intends to seek acceptance into the Cloud Native Computing Foundation (CNCF) at the Sandbox level. The specification and all associated repositories:

- Are licensed under Apache 2.0 as required by CNCF
- Follow CNCF governance best practices
- Adopt the Contributor Covenant Code of Conduct
- Maintain vendor neutrality in all specification decisions

## Intellectual Property Policy

- All specification content is licensed under [Apache License 2.0](LICENSE)
- All contributions are made under the Apache 2.0 license
- Contributors retain copyright to their contributions
- The project does not require a Contributor License Agreement (CLA) beyond the license terms
- Patent grants are provided under the Apache 2.0 patent clause

## Amendments

Changes to this charter require:

1. An RFC describing the proposed change
2. A 14-day comment period
3. A formal vote with two-thirds majority of maintainers (see [GOVERNANCE.md](GOVERNANCE.md))
