# RFC-0003: AI-SDLC Orchestrator — Product Strategy

**Status:** Draft
**Author:** AI-SDLC Contributors
**Created:** 2026-02-11
**Updated:** 2026-02-11
**Target Spec Version:** v1alpha1

---

## Summary

This RFC redefines what AI-SDLC ships as a product. Rather than a governance specification that waits for implementations, or governance sidecars (MCP servers, GitHub Apps) that tell agents "no," we propose shipping the **orchestrator itself**: a runtime that takes issues as input and drives them through the complete software development lifecycle — with AI agents doing the work and humans in the loop at the right moments.

The core insight: **AI agents can build small greenfield projects, but software falls apart as it grows.** Technical debt compounds, complexity overwhelms context windows, and developer velocity collapses. The AI-SDLC Orchestrator solves this by encoding the institutional knowledge and process discipline that mature engineering organizations develop over time — and applying it progressively as the codebase grows.

The product operates on a spectrum from **mostly human-run** (AI assists, humans decide) to **fully autonomous** (agents run the entire SDLC, humans audit). Teams start wherever they're comfortable and the system adapts as trust is earned.

## Motivation

### AI projects start strong but collapse at scale

Every team building with AI coding agents encounters the same trajectory:

1. **Greenfield euphoria** (weeks 1-4): AI agents generate code quickly. Simple project, few files, everything fits in context. Velocity is high.
2. **Complexity creep** (weeks 5-12): The codebase grows. Agents start losing context. Architectural decisions made in week 2 are invisible to agents in week 8. Duplicate patterns emerge. Inconsistencies accumulate.
3. **Technical debt spiral** (weeks 12+): Agents go down wrong paths because they can't see the full picture. Fixes introduce new bugs. Refactoring drops (from 25% to 10% of work — Gitclear 2024). Code churn spikes (5.5% to 7.9%). Developer velocity that was "10x" is now slower than writing by hand.

**The data confirms this:**
- Experienced developers using AI tools are **19% slower** despite believing they're 20% faster — a 39 percentage-point perception gap (METR 2025)
- Every **25% increase** in AI adoption = **7.2% drop** in system stability (Google DORA)
- Code churn jumped from **5.5% to 7.9%** — AI agents write code that gets rewritten faster (Gitclear 2024)
- Only **3%** of developers express high trust in AI output (Stack Overflow, Dec 2025)

The root cause isn't that AI agents write bad code. It's that **nobody orchestrates how they work as the codebase grows**. A human engineering organization naturally develops institutional knowledge: coding standards, architectural patterns, review processes, deployment procedures. These emerge organically and scale with complexity. AI agents have none of this unless someone builds it.

### The missing product: a programmable engineering organization

The market has:

| What exists | What it does | What it doesn't do |
|---|---|---|
| **AI coding agents** (Claude Code, Copilot, Cursor, Devin) | Write code from prompts | Manage complexity, maintain context, enforce process |
| **CI/CD pipelines** (GitHub Actions, Argo, Tekton) | Build, test, deploy | Orchestrate the *full* SDLC; know nothing about AI agents |
| **Agent frameworks** (LangChain, CrewAI, AutoGen) | Wire agents together | Understand software engineering; manage codebase growth |
| **Code quality tools** (SonarQube, Snyk, CodeRabbit) | Scan for issues | Orchestrate; route tasks; manage autonomy |
| **Project management** (Jira, Linear, GitHub Issues) | Track work | Execute work; enforce quality; close the loop |

Nobody provides the thing in the middle: **a system that takes an issue, understands the codebase, routes the task to the right combination of agents and humans, enforces quality at every stage, and grows its process foundations as the software grows.**

That's what the AI-SDLC Orchestrator is.

### The orchestrator already exists — in the dogfood

The `dogfood/src/orchestrator/` directory contains **~8,700 lines across 50 TypeScript files** implementing exactly this end-to-end flow. It:

1. Receives a trigger (issue assigned, labeled `ai-eligible`)
2. Fetches and validates the issue against quality gates
3. Routes by complexity (autonomous / AI-with-review / AI-assisted / human-led)
4. Checks the agent's autonomy level and constraints
5. Creates a branch, sets up the working environment
6. Issues JIT credentials, sandboxes the agent
7. Invokes the agent with context, constraints, and tools
8. Validates the output against guardrails (ABAC, file limits, blocked paths)
9. Creates a PR with provenance metadata
10. Evaluates promotion eligibility based on accumulated performance
11. Records everything in an immutable audit trail

Of these 11 steps, only 2 are driven by the spec's Pipeline resource definition — the other 9 are hardcoded orchestration logic (documented as the "600-line gap" in RFC-0002). **The dogfood IS the product. It just needs to be packaged as one.**

## Goals

- Ship the AI-SDLC Orchestrator as a runnable product that teams can deploy to automate their SDLC
- Support the full spectrum: mostly-human (AI assists) through fully-autonomous (agents run everything)
- Solve the "AI projects fall apart at scale" problem through progressive SDLC foundations
- Deliver the orchestrator as the primary product; governance emerges from orchestration, not the reverse
- Enable teams to go from "install" to "first AI-driven PR merged" in under 30 minutes
- Grow organically: start with a single repo and agent, scale to multi-repo organizations with agent fleets

## Non-Goals

- Building yet another AI coding agent — we orchestrate existing agents, not replace them
- Replacing CI/CD systems — we orchestrate the stages *before* and *around* CI/CD, not the build/test/deploy mechanics
- Requiring Kubernetes — the orchestrator runs as a standalone process; Kubernetes is an optional deployment target
- Mandating full autonomy — teams that want human-in-the-loop for every PR should feel first-class
- Competing with the AAIF — the orchestrator consumes MCP, A2A, and AGENTS.md; it doesn't replace them

## Proposal

### What the AI-SDLC Orchestrator Is

The orchestrator is a **long-running process** that manages the software development lifecycle for one or more repositories. It watches for work (issues, events), routes that work through a declared pipeline of stages, assigns AI agents and/or human reviewers at each stage, enforces quality gates, and continuously learns which agents can be trusted with what.

Think of it as a **programmable engineering team lead**: it understands the process, knows the codebase, assigns the work, reviews the output, and grows the team's maturity over time.

```
┌──────────────────────────────────────────────────────────────────────┐
│                       AI-SDLC Orchestrator                           │
│                                                                      │
│  ┌─────────┐    ┌───────────┐    ┌───────────┐    ┌──────────────┐  │
│  │ Trigger  │───▶│  Route &  │───▶│  Execute  │───▶│  Validate &  │  │
│  │ Watch    │    │  Assign   │    │  Stage    │    │  Promote     │  │
│  └─────────┘    └───────────┘    └───────────┘    └──────────────┘  │
│       │              │                │                   │          │
│       ▼              ▼                ▼                   ▼          │
│  ┌─────────┐    ┌───────────┐    ┌───────────┐    ┌──────────────┐  │
│  │ Issue    │    │ Complexity│    │ Agent     │    │ Quality      │  │
│  │ Tracker  │    │ Analysis  │    │ Runtime   │    │ Gates        │  │
│  │ Adapter  │    │ + Routing │    │ (sandbox, │    │ + Autonomy   │  │
│  │          │    │           │    │  creds,   │    │   Ledger     │  │
│  │ Linear   │    │ Codebase  │    │  context) │    │              │  │
│  │ Jira     │    │ State     │    │           │    │ Promotion/   │  │
│  │ GitHub   │    │ Store     │    │ Claude    │    │ Demotion     │  │
│  └─────────┘    └───────────┘    │ Copilot   │    └──────────────┘  │
│                                  │ Cursor    │                      │
│                                  │ Devin     │                      │
│                                  │ Any MCP   │                      │
│                                  └───────────┘                      │
│                                                                      │
│  Configured via: .ai-sdlc/pipeline.yaml                              │
│  Codebase state: .ai-sdlc/state/ (autonomy ledger, episodic memory) │
└──────────────────────────────────────────────────────────────────────┘
```

### The Orchestration Loop

The orchestrator implements a continuous reconciliation loop — not a one-shot CI pipeline:

```
forever {
  1. WATCH    — Listen for triggers (issue.assigned, pr.review_submitted,
                ci.failed, schedule.daily)

  2. ASSESS   — For each triggered item:
                a. Fetch the issue/task details from the issue tracker
                b. Analyze codebase complexity (files, dependencies, architecture)
                c. Score task complexity (1-10)
                d. Determine routing strategy based on complexity + policy

  3. PLAN     — Build an execution plan:
                a. Select pipeline stages from the declared Pipeline resource
                b. Resolve which agent(s) or human(s) handle each stage
                c. Check autonomy levels — can this agent do this task?
                d. Determine approval requirements

  4. EXECUTE  — For each stage in the plan:
                a. Set up the environment (branch, sandbox, JIT credentials)
                b. Provide context to the agent (issue, codebase state,
                   architectural decisions, prior learnings)
                c. Run the agent within constraints (file limits, blocked paths,
                   time limits)
                d. Handle failures per the stage's failure policy
                   (retry / pause / escalate / abort)

  5. VALIDATE — After agent execution:
                a. Run quality gates (tests, coverage, security, lint)
                b. Check guardrails (files changed within limits, no blocked
                   paths touched)
                c. Verify output matches task requirements

  6. DELIVER  — If all gates pass:
                a. Create/update PR with provenance
                b. Request human review if required by autonomy level
                c. Auto-merge if autonomous and all gates pass
                d. Deploy if pipeline includes deployment stages

  7. LEARN    — After completion:
                a. Record outcome in the autonomy ledger
                b. Update agent's performance metrics
                c. Evaluate promotion/demotion criteria
                d. Store episodic memory for future context
                e. Update codebase complexity profile

  8. RECONCILE — Continuously:
                a. Detect drift (policy changed, gates added, thresholds raised)
                b. Re-evaluate in-flight work against updated policy
                c. Grow process foundations as codebase complexity increases
}
```

### How It Solves "AI Projects Fall Apart at Scale"

The core problem is that as software grows, AI agents lose the context and process discipline that keeps codebases healthy. The orchestrator addresses this at four levels:

#### Level 1: Context Management

Agents fail at scale because they can't see the full picture. The orchestrator maintains persistent codebase state that agents can't:

```yaml
# .ai-sdlc/state/codebase-profile.yaml (maintained by orchestrator)
codebaseComplexity:
  score: 6.2              # Updated after every PR merge
  files: 847
  modules: 12
  dependencies: 94
  architecturalPatterns:
    - pattern: "hexagonal"
      confidence: 0.89
      description: "Ports and adapters pattern in src/domain/, src/adapters/"
    - pattern: "event-driven"
      confidence: 0.73
      description: "Event bus in src/events/, consumers in src/handlers/"
  hotspots:                # Files with highest churn + complexity
    - path: "src/auth/session-manager.ts"
      churnRate: 0.14
      complexity: 8
      lastModified: "2026-02-10"
      note: "Frequent source of regressions. Route changes here to Level 2+."
  conventions:
    naming: "camelCase for functions, PascalCase for types, kebab-case for files"
    testing: "Co-located test files (*. test.ts), integration tests in __tests__/"
    imports: "Absolute imports from src/, no circular dependencies"
```

When an agent starts a task, the orchestrator injects this context. The agent doesn't need to rediscover the architecture, naming conventions, or known trouble spots — the orchestrator remembers.

#### Level 2: Progressive Process Foundations

The orchestrator doesn't apply the same process to a 50-file project and a 5,000-file project. Process scales with complexity:

| Codebase Complexity | Process Foundations Applied |
|---|---|
| **Low** (1-3: <100 files, simple architecture) | Basic linting, test coverage gate, single agent can handle most tasks autonomously |
| **Medium** (4-6: 100-1000 files, emerging patterns) | Architecture conformance checks, dependency validation, mandatory PR review for cross-module changes, agent context includes module boundaries |
| **High** (7-8: 1000+ files, established architecture) | Architectural review for structural changes, hotspot-aware routing (changes to high-churn files get extra scrutiny), multi-agent decomposition for large tasks, human architect involved in design decisions |
| **Critical** (9-10: large-scale, multi-service) | Architecture review board, change impact analysis across services, staged rollouts, human-led design with AI implementation support |

This is the key differentiator: **the SDLC process grows with the software.** A startup with 10 files doesn't need an architecture review board. A system with 10,000 files does. The orchestrator manages this transition automatically based on the codebase complexity profile.

#### Level 3: Intelligent Task Routing

Not every task should go to the same agent with the same constraints. The orchestrator routes based on what the task *actually requires*:

```
Issue #247: "Add created_at timestamp to User model"
  → Complexity: 2 (single file, single field, migration)
  → Route: Fully autonomous (Level 1 agent can handle)
  → Process: implement → test → auto-merge
  → Estimated time: 5 minutes

Issue #248: "Refactor authentication to support OAuth2 + SAML"
  → Complexity: 8 (cross-cutting, security-critical, 15+ files)
  → Route: AI-assisted with human architect
  → Process: design review → decompose into sub-tasks → implement
             (parallel agents) → security scan → human review → staged merge
  → Human involvement: architect reviews design, security lead reviews implementation
  → Estimated time: 2-3 days with human cycles

Issue #249: "Migrate from PostgreSQL to CockroachDB"
  → Complexity: 10 (infrastructure, data migration, entire system affected)
  → Route: Human-led with AI support
  → Process: human designs migration plan → AI generates migration scripts
             → human reviews → staged execution with rollback plan
  → Human involvement: leads the entire effort; AI assists with boilerplate
```

The routing isn't static. As agents prove themselves (promotion criteria met), they earn the right to handle higher-complexity tasks with less oversight.

#### Level 4: Earned Autonomy Over Time

The orchestrator tracks every agent's performance and progressively grants or restricts autonomy:

```
Agent: claude-code-team-alpha
  Current Level: 2 (Senior)
  Time at Level: 6 weeks
  Tasks Completed: 47
  PR Approval Rate: 94%
  Rollback Rate: 0.8%
  Security Incidents: 0

  Promotion to Level 3 requires:
    ✅ pr-approval-rate >= 0.95  (actual: 0.94 — close but not yet)
    ✅ rollback-rate <= 0.01     (actual: 0.008)
    ✅ zero security incidents    (actual: 0)
    ✅ min 50 tasks at level     (actual: 47 — 3 more needed)
    ✅ min 8 weeks at level      (actual: 6 weeks — 2 more needed)

  Status: On track for promotion in ~2 weeks
```

This is the "programmable engineering organization" — it mimics how a real engineering org builds trust in new team members. Junior developers start with small tasks, earn autonomy through demonstrated competence, and get more responsibility over time. The orchestrator does the same for AI agents.

### The Human-AI Spectrum

The orchestrator supports the full spectrum of human involvement, configured per-team:

```yaml
# .ai-sdlc/pipeline.yaml

# Example 1: Mostly human, AI assists
# (Early adoption — team is cautious)
apiVersion: ai-sdlc.io/v1alpha1
kind: Pipeline
metadata:
  name: human-led
spec:
  triggers:
    - event: issue.labeled
      filter: { labels: ["ai-assist"] }
  routing:
    complexityThresholds:
      low:      { min: 1, max: 3, strategy: "ai-with-review" }
      medium:   { min: 4, max: 6, strategy: "ai-assisted" }
      high:     { min: 7, max: 10, strategy: "human-led" }
  stages:
    - name: implement
      agent: code-agent
      approval:
        required: true
        blocking: true        # Human must approve before agent starts
    - name: review
      agent: review-agent
      approval:
        required: true        # Human must also review the review
    - name: merge
      approval:
        required: true        # Human clicks merge
```

```yaml
# Example 2: Mostly autonomous, humans audit
# (Mature adoption — agents have earned trust)
apiVersion: ai-sdlc.io/v1alpha1
kind: Pipeline
metadata:
  name: autonomous
spec:
  triggers:
    - event: issue.assigned
      filter: { labels: ["ai-eligible"] }
  routing:
    complexityThresholds:
      low:      { min: 1, max: 3, strategy: "fully-autonomous" }
      medium:   { min: 4, max: 6, strategy: "ai-with-review" }
      high:     { min: 7, max: 8, strategy: "ai-assisted" }
      critical: { min: 9, max: 10, strategy: "human-led" }
  stages:
    - name: implement
      agent: code-agent
    - name: validate
      qualityGates: [tests, coverage, security, architecture]
    - name: review
      agent: review-agent
    - name: merge
      # Auto-merge if all gates pass and complexity <= 3
      # Otherwise, request human review
    - name: deploy
      approval:
        required: true         # Always human-approved deploys (for now)
```

```yaml
# Example 3: Fully autonomous software organization
# (Future state — high trust, comprehensive gates)
apiVersion: ai-sdlc.io/v1alpha1
kind: Pipeline
metadata:
  name: fully-autonomous
spec:
  triggers:
    - event: issue.created       # Agents even triage incoming issues
  routing:
    complexityThresholds:
      low:      { min: 1, max: 6, strategy: "fully-autonomous" }
      medium:   { min: 7, max: 8, strategy: "ai-with-review" }
      high:     { min: 9, max: 10, strategy: "ai-assisted" }
  stages:
    - name: triage
      agent: triage-agent        # AI triages, assigns complexity, labels
    - name: design
      agent: architect-agent     # AI designs approach for complex tasks
    - name: decompose
      agent: architect-agent     # Break into sub-tasks if complexity > 5
    - name: implement
      agent: code-agent
      orchestration: parallel    # Multiple agents for decomposed sub-tasks
    - name: validate
      qualityGates: [tests, coverage, security, architecture, performance]
    - name: review
      agent: review-agent
    - name: merge
    - name: deploy
      qualityGates: [staging-tests, canary-metrics]
    - name: monitor
      agent: monitor-agent       # Watch production metrics post-deploy
      onFailure:
        strategy: rollback       # Auto-rollback if metrics degrade
```

### How Teams Adopt It

#### Day 1: Install and connect

```bash
# Install the orchestrator
npm install -g @ai-sdlc/orchestrator

# Initialize in your repository
ai-sdlc init

# This creates:
# .ai-sdlc/
#   pipeline.yaml      ← Your SDLC pipeline definition
#   agents.yaml        ← Agent roles and constraints
#   gates.yaml         ← Quality gate definitions
#   autonomy.yaml      ← Autonomy levels and promotion criteria
```

The `init` command detects the project's language, framework, and existing CI setup, then generates a starter configuration:

```
Detected: TypeScript + React + Jest + GitHub Actions
Generated pipeline with:
  - Stages: validate → implement → test → review → merge
  - Quality gates: jest coverage (80%), eslint (0 errors), npm audit (0 critical)
  - Autonomy: Starting at Level 1 (all PRs require human review)
  - Agent: claude-code (default, configurable)

Ready. Label any issue with "ai-eligible" to start.
```

#### Week 1: First AI-driven PRs

The team labels a few simple issues as `ai-eligible`. The orchestrator:
1. Picks up the issue
2. Creates a branch
3. Invokes the configured agent with full context (issue, codebase profile, conventions)
4. Runs quality gates
5. Creates a PR and requests human review
6. Human reviews, provides feedback, merges

The team sees: AI did the work, but I'm in full control.

#### Month 1: Process foundations emerge

After 20-30 PRs, the orchestrator has built up:
- An autonomy ledger showing agent performance metrics
- A codebase profile tracking complexity growth
- Episodic memory of what worked and what didn't
- Suggested gate threshold adjustments based on actual data

The team sees: "Our agent has a 92% approval rate. The orchestrator is suggesting we can auto-merge simple PRs (complexity 1-3) now."

#### Month 3: Scaling with the codebase

The codebase has grown from 200 to 800 files. The orchestrator has automatically:
- Raised complexity thresholds (more tasks now score "medium" instead of "low")
- Added architecture conformance checks (detected a hexagonal pattern, now enforces it)
- Introduced hotspot-aware routing (changes to `session-manager.ts` get extra review)
- Promoted the primary agent to Level 2 (can now merge low-complexity PRs without human approval)

The team sees: the process grew with the software, and I didn't have to configure anything.

#### Month 6+: Running an AI software organization

The team now has multiple agents at various autonomy levels, handling 60-70% of issues end-to-end. Humans focus on architecture decisions, complex features, and the occasional override. The orchestrator handles everything else.

### Architecture

#### Core Components

```
┌─────────────────────────────────────────────────────────┐
│                 AI-SDLC Orchestrator                     │
│                                                         │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  │
│  │  Trigger      │  │  Pipeline    │  │  Agent       │  │
│  │  Watcher      │  │  Controller  │  │  Runtime     │  │
│  │              │  │              │  │              │  │
│  │  Webhook     │  │  Stage       │  │  Sandbox     │  │
│  │  listener,   │  │  sequencing, │  │  management, │  │
│  │  polling,    │  │  routing,    │  │  JIT creds,  │  │
│  │  scheduling  │  │  assignment  │  │  context     │  │
│  │              │  │              │  │  injection   │  │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘  │
│         │                 │                 │          │
│         ▼                 ▼                 ▼          │
│  ┌────────────────────────────────────────────────────┐ │
│  │              Reconciliation Engine                  │ │
│  │                                                    │ │
│  │  Desired state (Pipeline YAML)                     │ │
│  │  vs.                                               │ │
│  │  Observed state (adapter events, CI results,       │ │
│  │                   agent output, human feedback)     │ │
│  │  →                                                 │ │
│  │  Actions (invoke agent, create PR, request review, │ │
│  │           enforce gate, promote/demote agent)       │ │
│  └────────────────────────────────────────────────────┘ │
│         │                 │                 │          │
│         ▼                 ▼                 ▼          │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  │
│  │  Codebase    │  │  Autonomy    │  │  Quality     │  │
│  │  State       │  │  Ledger      │  │  Gate        │  │
│  │  Store       │  │              │  │  Engine      │  │
│  │              │  │  Performance │  │              │  │
│  │  Complexity  │  │  tracking,   │  │  Evaluation, │  │
│  │  profile,    │  │  promotion/  │  │  enforcement │  │
│  │  conventions,│  │  demotion,   │  │  levels,     │  │
│  │  hotspots,   │  │  per-agent   │  │  overrides   │  │
│  │  episodic    │  │  per-repo    │  │              │  │
│  │  memory      │  │  history     │  │              │  │
│  └──────────────┘  └──────────────┘  └──────────────┘  │
│                                                         │
│  ┌────────────────────────────────────────────────────┐ │
│  │                  Adapter Layer                      │ │
│  │                                                    │ │
│  │  IssueTracker    SourceControl    CIPipeline       │ │
│  │  (Linear,Jira,   (GitHub,GitLab,  (GH Actions,    │ │
│  │   GH Issues)      Bitbucket)      GitLab CI)      │ │
│  │                                                    │ │
│  │  CodeAnalysis    Messenger        DeployTarget     │ │
│  │  (SonarQube,     (Slack,Teams)    (k8s,Vercel,    │ │
│  │   Semgrep)                         Fly.io)        │ │
│  └────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────┘
```

#### The Codebase State Store

This is what makes the orchestrator fundamentally different from a CI/CD pipeline. It maintains **persistent, evolving knowledge about the codebase**:

| State | What it tracks | Why it matters |
|---|---|---|
| **Complexity Profile** | File count, module structure, dependency graph, architectural patterns, overall complexity score | Determines routing strategy, gate thresholds, and process foundations |
| **Conventions** | Naming patterns, import style, test structure, directory layout | Injected as context so agents follow established patterns |
| **Hotspots** | Files with high churn + high complexity | Changes to hotspots get extra scrutiny, higher-level review |
| **Episodic Memory** | What happened in past pipeline executions — successes, failures, regressions | Agents learn from history: "Last time we changed auth, tests in payments broke" |
| **Architecture Decisions** | Detected and declared architectural patterns | Agents are constrained to conform: "This is a hexagonal architecture — don't import adapters from domain" |

The state store is updated after every pipeline execution and is used to provide context to agents, inform routing decisions, and adjust process foundations.

#### Agent Invocation Model

The orchestrator is **agent-agnostic**. It invokes agents through a standard interface:

```typescript
interface AgentRunner {
  run(task: AgentTask): Promise<AgentResult>;
}

interface AgentTask {
  // What to do
  issue: Issue;
  instructions: string;

  // Constraints
  constraints: {
    maxFiles: number;
    maxLines: number;
    blockedPaths: string[];
    requiredTests: boolean;
    timeout: string;            // ISO 8601 duration
  };

  // Context (from codebase state store)
  context: {
    codebaseProfile: CodebaseProfile;
    conventions: Convention[];
    relevantHistory: EpisodicEntry[];
    architecturalPatterns: Pattern[];
    hotspots: Hotspot[];
  };

  // Environment
  environment: {
    workDir: string;
    branch: string;
    credentials: JITCredential;
    sandbox?: SandboxConfig;
  };
}

interface AgentResult {
  success: boolean;
  filesChanged: string[];
  summary: string;
  testResults?: TestResults;
}
```

Concrete agent runners implement this interface for specific agents:
- `ClaudeCodeRunner` — invokes Claude Code via CLI or API
- `CopilotRunner` — invokes GitHub Copilot Workspace
- `CursorRunner` — invokes Cursor's agent mode
- `CustomRunner` — invokes any agent via a configurable command

This means the orchestrator works with whatever AI coding agents the team already uses.

### SDK Roles in the Orchestrator Model

The SDKs serve concrete purposes in this architecture:

#### TypeScript SDK

Powers the orchestrator itself. The existing reference implementation (`reference/src/`) and dogfood (`dogfood/src/orchestrator/`) become the orchestrator runtime.

#### Python SDK: `ai-sdlc-python`

Two primary use cases:

1. **Custom agent runners** — Teams building agents in Python (LangChain, CrewAI, AutoGen) implement the `AgentRunner` interface to plug their agents into the orchestrator

2. **Embeddable policy evaluator** — Python-based CI tools and scripts can evaluate AI-SDLC quality gates locally:

```python
from ai_sdlc import PolicyEvaluator, load_pipeline

pipeline = load_pipeline(".ai-sdlc/pipeline.yaml")
evaluator = PolicyEvaluator(pipeline)

result = evaluator.evaluate_gates(
    stage="validate",
    evidence={"coverage": 0.84, "lint_errors": 0, "critical_findings": 0}
)

for gate in result.failed:
    print(f"FAILED: {gate.name} ({gate.enforcement}): {gate.reason}")
```

#### Go SDK: `ai-sdlc-go`

Two primary use cases:

1. **Kubernetes-native deployment** — A controller-runtime operator that runs the orchestrator as a Kubernetes controller, reconciling AI-SDLC resources as CRDs. For platform engineering teams that want governance-as-infrastructure.

2. **High-performance adapter implementations** — Go adapters for performance-critical integrations (high-throughput webhook processing, git operations at scale).

### Repo Structure

```
ai-sdlc/
├── spec/                        # UNCHANGED — authoritative specification
│   ├── spec.md                  # Core resource model
│   ├── agents.md                # Agent orchestration spec
│   ├── autonomy.md              # Progressive autonomy spec
│   ├── policy.md                # Quality gate enforcement spec
│   ├── adapters.md              # Adapter interface contracts
│   ├── schemas/                 # JSON Schemas (source of truth)
│   └── rfcs/                    # Enhancement proposals
│
├── orchestrator/                # THE PRODUCT — AI-SDLC Orchestrator
│   ├── src/
│   │   ├── core/                # Pipeline controller, reconciliation engine
│   │   ├── triggers/            # Webhook listener, polling, scheduling
│   │   ├── routing/             # Complexity analysis, task routing
│   │   ├── agents/              # Agent runner interface + concrete runners
│   │   ├── gates/               # Quality gate evaluation engine
│   │   ├── autonomy/            # Autonomy ledger, promotion/demotion
│   │   ├── state/               # Codebase state store (complexity, conventions,
│   │   │                        #   hotspots, episodic memory)
│   │   ├── adapters/            # Issue tracker, source control, CI, etc.
│   │   ├── security/            # Sandbox, JIT credentials, ABAC
│   │   └── telemetry/           # OpenTelemetry integration
│   ├── bin/
│   │   └── ai-sdlc.ts           # CLI entry point
│   ├── Dockerfile
│   └── package.json
│
├── sdk-typescript/              # TypeScript SDK (shared types + validation)
├── sdk-python/                  # Python SDK (agent runners + policy evaluator)
├── sdk-go/                      # Go SDK (K8s operator + Go adapters)
│
├── conformance/                 # UNCHANGED — language-agnostic test suite
├── contrib/                     # UNCHANGED — community adapters
└── docs/                        # Updated for orchestrator-first onboarding
```

## Design Details

### Schema Changes

No changes to core resource schemas. The orchestrator consumes existing AI-SDLC resources (Pipeline, AgentRole, QualityGate, AutonomyPolicy, AdapterBinding) as its configuration format.

One new schema is introduced for the codebase state store:

```json
{
  "$id": "https://ai-sdlc.io/schemas/codebase-state.schema.json",
  "type": "object",
  "properties": {
    "complexity": {
      "type": "object",
      "properties": {
        "score": { "type": "number", "minimum": 1, "maximum": 10 },
        "files": { "type": "integer" },
        "modules": { "type": "integer" },
        "dependencies": { "type": "integer" }
      }
    },
    "architecturalPatterns": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "pattern": { "type": "string" },
          "confidence": { "type": "number", "minimum": 0, "maximum": 1 },
          "description": { "type": "string" }
        }
      }
    },
    "hotspots": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "path": { "type": "string" },
          "churnRate": { "type": "number" },
          "complexity": { "type": "number" },
          "lastModified": { "type": "string", "format": "date-time" }
        }
      }
    },
    "conventions": {
      "type": "object",
      "properties": {
        "naming": { "type": "string" },
        "testing": { "type": "string" },
        "imports": { "type": "string" }
      }
    }
  }
}
```

### Behavioral Changes

#### Reconciliation Engine

The existing reconciliation loop (`reference/src/reconciler/loop.ts`) is extended to be the orchestrator's core execution engine. The key behavioral changes:

1. **Long-running** — The reconciliation loop runs continuously (not invoked per-event). It maintains a work queue and processes items as they arrive.

2. **Multi-resource** — A single reconciliation cycle may involve Pipeline, AgentRole, QualityGate, and AutonomyPolicy resources simultaneously.

3. **State-aware** — The reconciler reads from and writes to the codebase state store, making decisions based on accumulated knowledge, not just the current event.

4. **Agent-invoking** — The reconciler directly invokes agent runners as part of stage execution, rather than delegating to an external system.

#### Codebase State Updates

The codebase state store is updated at three points:

1. **Post-merge** — After a PR is merged, the orchestrator re-analyzes the codebase to update complexity scores, detect new patterns, and identify new hotspots.

2. **Post-failure** — When a pipeline fails, the failure context is recorded in episodic memory so future agent invocations can learn from it.

3. **Scheduled** — A daily reconciliation pass updates the full complexity profile, even without new events. This catches drift (e.g., manually added files, dependency updates).

### Migration Path

The orchestrator is a new product built from existing components:

- `reference/src/` provides the resource model, validation, and reconciliation primitives
- `dogfood/src/orchestrator/` provides the proven end-to-end flow (~8,700 lines)
- The migration is a **refactoring**, not a rewrite — extracting the dogfood into a distributable package with a clean public API

Existing spec documents and schemas are unchanged.

## Backward Compatibility

- **Spec:** No changes. All existing resources validate identically.
- **Reference implementation:** Refactored into the orchestrator's core library. Public types unchanged.
- **Conformance tests:** Unchanged. The orchestrator must pass the same conformance suite.
- **Dogfood:** The dogfood becomes the orchestrator's test/demo environment.

## Alternatives Considered

### Alternative 1: Governance Sidecars (MCP Server + GitHub App)

Build an MCP Governance Server that agents query ("am I allowed to do this?") and a GitHub App that enforces gates as Check Runs.

**Rejected because:** This approach treats governance as a checkpoint alongside the SDLC, not as the orchestration of it. An MCP server that says "no" doesn't solve the core problem — AI projects falling apart at scale due to complexity, context loss, and missing process foundations. Governance sidecars don't route tasks, don't manage context, don't grow process, and don't orchestrate the end-to-end lifecycle. They're traffic cops, not team leads.

That said, the orchestrator *could* expose an MCP interface and GitHub Checks as secondary integration points in the future. The orchestrator is the primary product; sidecars are potential features of it.

### Alternative 2: Spec-First, Orchestrator Later

Continue perfecting the specification, then build the orchestrator from the spec.

**Rejected because:** The dogfood already proves the orchestrator works end-to-end. Waiting for spec completion before packaging it as a product loses the window. The spec continues to evolve (RFC-0002 is bringing 600 lines of dogfood logic into the spec), and the orchestrator provides real-world validation of spec decisions. Product and spec co-evolve.

### Alternative 3: Plugin for Existing CI/CD

Build the orchestrator as a GitHub Actions workflow, Argo Workflow template, or Tekton pipeline.

**Rejected because:** CI/CD systems orchestrate build/test/deploy — they don't understand issues, agents, autonomy levels, codebase complexity, or SDLC-wide workflows. Fitting the orchestrator into CI/CD requires fighting the platform's assumptions (stateless runs, no persistent state, no agent management). The orchestrator needs to be a first-class runtime with its own state, not a workflow crammed into YAML steps.

### Alternative 4: Agent Framework Extension

Build the orchestrator as a LangChain/CrewAI/AutoGen extension.

**Rejected because:** Agent frameworks orchestrate agent conversations and tool use. They don't understand the SDLC — branching, PRs, quality gates, deployment, autonomy. The orchestrator is agent-framework-agnostic: it invokes agents through a standard interface, regardless of whether they're built with LangChain, raw API calls, or CLI tools. Tying to one framework limits adoption.

### Alternative 5: SaaS Platform

Build a hosted SaaS platform where teams connect their repos and agents.

**Rejected because:** Premature. A SaaS platform requires infrastructure investment, security certification, and ongoing operations before validating product-market fit. The orchestrator should first prove itself as an open-source, self-hosted tool. A hosted offering can follow once the product is validated. Additionally, many enterprises (the target adopters) require self-hosted governance for compliance reasons.

## Implementation Plan

### Phase 0: Extract and Package (Weeks 1-4)

- [ ] Extract dogfood orchestration logic into `orchestrator/` package
- [ ] Define clean public API boundaries (AgentRunner interface, configuration loading, CLI)
- [ ] Implement `ai-sdlc init` command (project detection, starter config generation)
- [ ] Implement `ai-sdlc run` command (single pipeline execution for testing)
- [ ] Implement `ai-sdlc start` command (long-running orchestrator daemon)
- [ ] SQLite-backed autonomy ledger and codebase state store
- [ ] Basic ClaudeCodeRunner implementation

### Phase 1: Context and Routing (Weeks 3-8)

- [ ] Codebase complexity analyzer (file count, module structure, dependency graph)
- [ ] Architectural pattern detection (heuristic-based, not LLM-dependent)
- [ ] Hotspot identification (git log analysis for churn + complexity)
- [ ] Convention detection (naming patterns, test structure, import style)
- [ ] Context injection into agent tasks
- [ ] Complexity-based task routing with configurable thresholds

### Phase 2: Progressive Foundations (Weeks 6-12)

- [ ] Progressive gate threshold adjustment based on codebase complexity
- [ ] Automatic process escalation as complexity grows
- [ ] Episodic memory — record successes, failures, regressions
- [ ] Agent context enrichment from episodic memory
- [ ] Autonomy promotion/demotion with full metrics tracking
- [ ] Dashboard: codebase complexity over time, agent autonomy trajectory, gate pass rates

### Phase 3: Multi-Agent and Scale (Weeks 10-16)

- [ ] Parallel agent execution for decomposed tasks
- [ ] Handoff contract validation between agents
- [ ] Multi-repo orchestration (monorepo and polyrepo)
- [ ] Additional agent runners (Copilot, Cursor, Devin, custom)
- [ ] Python SDK: custom agent runner interface + policy evaluator
- [ ] Go SDK: Kubernetes operator for orchestrator deployment

### Phase 4: Production Hardening (Weeks 14-20)

- [ ] GitHub adapter (full webhook integration, Check Runs, PR management)
- [ ] GitLab adapter (merge requests, CI integration)
- [ ] Linear / Jira adapters (issue tracking)
- [ ] Deployment stage support (Kubernetes, Vercel, Fly.io)
- [ ] Staged rollout with canary monitoring
- [ ] Production-grade audit trail with integrity verification

## Open Questions

1. **Orchestrator hosting model** — Should the orchestrator run as a local daemon (developer laptop), a team server (shared VM), or a cloud service? Each has different implications for state management, webhook delivery, and agent invocation. The likely answer is "all three, progressively" — but the initial target matters for development priorities.

2. **Codebase analysis depth** — How deep should the complexity analyzer go? Simple metrics (file count, LOC) are cheap but imprecise. Full dependency graph analysis is precise but expensive. AST-level pattern detection is powerful but language-specific. Start simple and add depth as users demand it?

3. **Agent credential model** — How does the orchestrator authenticate as agents? For Claude Code, it needs API keys. For Copilot, it needs GitHub tokens. Should credentials be per-agent in the config, per-execution via a vault, or delegated to the host environment?

4. **Failure recovery** — When the orchestrator itself crashes mid-pipeline, how does it resume? The reconciliation loop is designed for this (level-triggered, idempotent), but the agent execution state (partially modified working directory) needs careful handling.

5. **Multi-tenant isolation** — When orchestrating multiple repos, how is state isolated? Per-repo SQLite databases? A shared PostgreSQL with row-level security? This affects both security and operational complexity.

6. **Feedback loop to spec** — As the orchestrator evolves, how do we feed learnings back into the spec? The dogfood already revealed the 600-line gap (RFC-0002). The orchestrator will reveal more. Should there be a formal process for "orchestrator found a spec gap" → RFC?

7. **License and sustainability** — The orchestrator is Apache 2.0. Is there a commercial model (enterprise features, hosted service, support) to sustain development? Or is this purely community/foundation-funded?

## References

- [AI-SDLC spec.md](../spec.md) — Core resource model specification
- [AI-SDLC agents.md](../agents.md) — Agent orchestration patterns
- [AI-SDLC autonomy.md](../autonomy.md) — Progressive autonomy system
- [AI-SDLC policy.md](../policy.md) — Quality gate enforcement
- [AI-SDLC adapters.md](../adapters.md) — Adapter interface contracts
- [RFC-0002: Pipeline Orchestration Policy](./RFC-0002-pipeline-orchestration.md) — The "600-line gap" between spec and dogfood
- [AI-SDLC Foundation Research](../../research/ai-sdlc-foundation-research.md) — 10-domain market analysis
- [AI-SDLC PRD](../../research/ai-sdlc-framework-prd.md) — Product requirements document
- [METR 2025: AI Tools Slow Down Experienced Developers](https://metr.org/) — Evidence for the productivity paradox
- [Gitclear 2024: Code Quality in the AI Era](https://www.gitclear.com/) — Evidence for rising code churn
- [Google DORA: AI Adoption and System Stability](https://dora.dev/) — Evidence for stability regression
- [MCP Specification](https://modelcontextprotocol.io/) — Agent-tool connectivity (consumed by orchestrator)
- [A2A Protocol](https://github.com/google/A2A) — Agent-agent communication (consumed by orchestrator)
- [AGENTS.md](https://github.com/anthropics/agents-md) — Per-project agent instructions (generated by orchestrator)
