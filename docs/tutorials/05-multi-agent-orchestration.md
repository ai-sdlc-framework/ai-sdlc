# Tutorial 5: Multi-Agent Orchestration

[AgentRole](../../spec/spec.md#52-agentrole) resources declare an AI agent's
identity, capabilities, constraints, and handoff behavior. Combined with
[Pipeline](../../spec/spec.md#51-pipeline) orchestration, multiple agents can
collaborate on complex software delivery workflows -- each agent focused on a
specific responsibility, passing structured data to the next.

This tutorial builds a three-agent pipeline: an implementation agent writes
code, a review agent inspects it, and a deployment agent ships it.

---

## Prerequisites

- Completion of Tutorials 01-04
- Familiarity with the [AgentRole schema](../../spec/schemas/agent-role.schema.json) and the [Agent Orchestration Specification](../../spec/agents.md)
- A working AI-SDLC environment with the `@ai-sdlc/reference` package installed

---

## Step 1: Define an AgentRole

Create `implement-agent.yaml`. The
[Role-Goal-Backstory](../../spec/glossary.md#role-goal-backstory) pattern gives
the agent its identity, while `tools` and `constraints` define what it can do:

```yaml
apiVersion: ai-sdlc.io/v1alpha1
kind: AgentRole
metadata:
  name: implement-agent
  namespace: my-team
  labels:
    role: engineer
    stage: implement
spec:
  role: "Senior Software Engineer"
  goal: >-
    Implement well-tested features based on issue specifications,
    producing clean code that passes all quality gates.
  backstory: >-
    A seasoned engineer with expertise in TypeScript and Python.
    Values small, focused changes with thorough test coverage.
    Follows established patterns and avoids unnecessary abstraction.
  tools:
    - code-editor
    - terminal
    - test-runner
    - git-client
    - file-search
  constraints:
    maxFilesPerChange: 20
    requireTests: true
    allowedLanguages:
      - typescript
      - python
      - yaml
    blockedPaths:
      - ".env*"
      - "infrastructure/**"
      - "*.pem"
```

Key fields:

- **`spec.role`** -- The agent's title, used in logs and audit trails.
- **`spec.goal`** -- A clear, measurable objective guiding the agent's behavior.
- **`spec.backstory`** -- Additional persona context for LLM-based agents.
- **`spec.tools`** -- The exhaustive list of tools the agent may invoke. The runtime MUST reject calls to unlisted tools.
- **`spec.constraints`** -- Hard limits enforced by the runtime: file count caps, test requirements, language restrictions, and path blocklists.

---

## Step 2: Add Handoff Declarations

Handoffs define how an agent transfers work to the next agent. Add a `handoffs`
array to the implement agent so it knows how to pass results to the review
agent:

```yaml
  handoffs:
    - target: review-agent
      trigger: "implementation complete and all tests passing"
      contract:
        schema: "./contracts/impl-to-review-v1.json"
        requiredFields:
          - prUrl
          - testResults
          - coverageReport
          - changeSummary
```

Each handoff entry specifies:

- **`target`** -- The `metadata.name` of the downstream AgentRole.
- **`trigger`** -- A human-readable condition describing when the handoff fires.
- **`contract`** -- A reference to a JSON Schema plus the fields that MUST be present. The runtime validates the handoff payload against this schema before accepting the transition.

The contract schema (e.g., `impl-to-review-v1.json`) defines the exact data
structure. See the [Handoff Contracts](../../spec/agents.md#4-handoff-contracts)
section of the spec for versioning rules and validation requirements.

---

## Step 3: Add Skills for Agent Discovery

Skills let other agents and tooling discover what an agent can do. They power
the [A2A](../../spec/glossary.md#a2a)-compatible
[Agent Card](../../spec/glossary.md#agent-card) system:

```yaml
  skills:
    - id: implement-feature
      description: >-
        Implements a feature from an issue specification, including source
        code, unit tests, and integration tests.
      tags:
        - implementation
        - feature
        - testing
      examples:
        - input: "Implement user authentication with JWT tokens"
          output: "Auth module with login/logout endpoints, JWT middleware, and 95% test coverage"
        - input: "Add pagination to the /api/users endpoint"
          output: "Cursor-based pagination with tests covering edge cases"
    - id: fix-bug
      description: >-
        Diagnoses and fixes a reported bug, adding a regression test to
        prevent recurrence.
      tags:
        - bugfix
        - debugging
      examples:
        - input: "Fix: users API returns 500 when email contains a plus sign"
          output: "Input sanitization fix with regression test for special characters"
```

Each skill declares an `id`, a `description`, optional `tags` for
categorization, and optional `examples` showing representative input/output
pairs.

---

## Step 4: Wire Agents into a Pipeline

Now define a Pipeline that orchestrates three agents in sequence. Create
`delivery-pipeline.yaml`:

```yaml
apiVersion: ai-sdlc.io/v1alpha1
kind: Pipeline
metadata:
  name: feature-delivery
  namespace: my-team
spec:
  triggers:
    - event: issue.assigned
      filter:
        labels:
          - "ai-ready"

  providers:
    issueTracker:
      type: jira
      config:
        projectKey: "ENG"
    sourceControl:
      type: github
      config:
        repo: "myorg/myrepo"

  stages:
    - name: implement
      agent: implement-agent
      qualityGates:
        - unit-test-gate
        - lint-gate

    - name: review
      agent: review-agent
      qualityGates:
        - code-review-gate
        - security-scan-gate

    - name: deploy
      agent: deploy-agent
      qualityGates:
        - integration-test-gate
```

Each stage references an AgentRole by its `metadata.name`. The runtime:

1. Triggers the pipeline when an issue is assigned with the `ai-ready` label.
2. Runs the **implement** stage -- the `implement-agent` writes code and tests.
3. Validates the handoff payload, then runs the **review** stage -- the `review-agent` inspects the changes.
4. After review passes, runs the **deploy** stage -- the `deploy-agent` handles deployment.

Quality gates at each stage enforce standards before the pipeline advances.

---

## Step 5: Orchestration Patterns

The Pipeline above uses sequential orchestration -- the simplest pattern. The
AI-SDLC spec defines five patterns you can apply depending on your workflow
needs:

### Sequential

Agents execute in stage order. The output of one becomes the input of the next.

```
implement --> review --> deploy
```

Best for: standard feature delivery with clear phase boundaries.

### Parallel

Independent stages run concurrently. A synchronization barrier waits for all
to complete before the pipeline advances.

```
         +-- code-agent --+
trigger -|                 |-- combine --> review
         +-- test-agent --+
```

Best for: tasks where code and tests can be written simultaneously, or multiple
independent reviews run in parallel.

### Router

A complexity scoring step routes tasks to different agent configurations.
Simple tasks go fully autonomous; complex tasks get additional oversight.

```yaml
routing:
  complexityThresholds:
    simple:
      min: 1
      max: 3
      strategy: fully-autonomous
    moderate:
      min: 4
      max: 6
      strategy: ai-with-review
    complex:
      min: 7
      max: 10
      strategy: human-led
```

Best for: teams that want low-friction automation for simple changes while
maintaining human oversight for risky work.

### Hierarchical

A lead agent decomposes a complex task and delegates sub-tasks to specialized
agents. The lead aggregates results and ensures coherence.

```
supervisor
  +-- frontend-agent (UI changes)
  +-- backend-agent  (API changes)
  +-- test-agent     (integration tests)
```

Best for: large features spanning multiple domains or services.

### Collaborative

Agents share context and iterate together in a feedback loop. One agent's
output feeds back as input to another until a convergence condition is met.

```
implement <--> review (iterate until approval)
```

Best for: exploratory tasks where the design emerges through iteration, or
review cycles that require multiple rounds of revision.

See [Orchestration Patterns](../../spec/agents.md#3-orchestration-patterns) in
the spec for detailed characteristics and selection guidance.

---

## Validation

Validate each AgentRole resource against the schema:

```bash
npx ajv validate \
  -s spec/schemas/agent-role.schema.json \
  -r "spec/schemas/common.schema.json" \
  -d implement-agent.yaml
```

Validate the Pipeline resource:

```bash
npx ajv validate \
  -s spec/schemas/pipeline.schema.json \
  -r "spec/schemas/common.schema.json" \
  -d delivery-pipeline.yaml
```

Common validation failures:

- Missing required fields (`role`, `goal`, `tools` in AgentRole; `triggers`, `providers`, `stages` in Pipeline).
- Empty `tools` array (must contain at least one item).
- Handoff `contract` missing the required `schema` field.
- Skill entries missing `id` or `description`.

---

## Summary

In this tutorial you:

1. Defined an **AgentRole** with the Role-Goal-Backstory pattern, tools, and constraints.
2. Added **handoff declarations** with typed contracts to enable structured inter-agent communication.
3. Declared **skills** so agents can be discovered via A2A-compatible Agent Cards.
4. Wired three agents into a **Pipeline** with sequential stage execution and quality gates.
5. Reviewed the five **orchestration patterns** -- sequential, parallel, router, hierarchical, and collaborative -- and when to apply each.

---

## Next Steps

- **[Agent Orchestration Specification](../../spec/agents.md)** -- Full reference for agent roles, handoff contracts, state management, discovery, and security.
- **[Pipeline Specification](../../spec/spec.md#51-pipeline)** -- Detailed schema for triggers, providers, stages, and routing.
- **[Glossary](../../spec/glossary.md)** -- Definitions for Role-Goal-Backstory, handoff contract, Agent Card, A2A, and other key terms.
