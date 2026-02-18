# RFC-0003: AI-SDLC Orchestrator — Product Strategy

**Status:** Draft
**Author:** AI-SDLC Contributors
**Created:** 2026-02-11
**Updated:** 2026-02-12
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
| **AI coding agents** (Claude Code, Copilot, Cursor, Codex) | Write code from prompts | Manage complexity, maintain context, enforce process |
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
│                                  │ Codex     │                      │
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
- `ClaudeCodeRunner` — invokes Claude Code CLI in `--print` mode
- `CopilotRunner` — invokes GitHub Copilot CLI in `--yolo` mode
- `CursorRunner` — invokes Cursor CLI (`cursor-agent`) with stream-json output
- `CodexRunner` — invokes OpenAI Codex CLI (`codex exec`) via stdin
- `GenericLLMRunner` — invokes any OpenAI-compatible API endpoint

This means the orchestrator works with whatever AI coding agents the team already uses.

### Human-Directed AI Usage: The MCP Session Tracker

The orchestrator controls agent execution when *it* invokes the agent. But most AI-assisted development today happens in a developer's IDE — a developer opens Claude Code, Copilot, or Cursor and works directly, bypassing the orchestrator entirely. This creates a **shadow IT blind spot**: no cost tracking, no quality gates, no attribution, no audit trail.

The solution is an **MCP Session Tracker** — an MCP server that runs alongside human-directed AI tool sessions, acting as a telemetry and context bridge between the developer's IDE and the orchestrator.

```
┌──────────────────────────────────────────────────────────────┐
│                      Developer's IDE                          │
│                                                              │
│  ┌──────────────┐          ┌───────────────────────────────┐ │
│  │  Claude Code  │◄──MCP──►│  AI-SDLC Session Tracker      │ │
│  │  (or Copilot, │         │  (MCP Server)                 │ │
│  │   Cursor)     │         │                               │ │
│  └──────┬───────┘         │  • Links session to issue     │ │
│         │                  │  • Injects codebase context   │ │
│         │ writes code      │  • Tracks tokens/cost         │ │
│         ▼                  │  • Records file changes       │ │
│  ┌──────────────┐         │  • Enforces soft guardrails   │ │
│  │  Working Dir  │         └──────────┬────────────────────┘ │
│  └──────────────┘                    │                       │
└──────────────────────────────────────┼───────────────────────┘
                                       │ Reports to
                                       ▼
                              ┌──────────────────┐
                              │  AI-SDLC          │
                              │  Orchestrator     │
                              │                  │
                              │  • Cost ledger   │
                              │  • Autonomy      │
                              │  • Audit trail   │
                              │  • Metrics       │
                              └──────────────────┘
```

#### Why This Prevents Shadow IT

Shadow IT isn't prevented by blocking — it's prevented by making the governed path **more valuable** than the ungoverned path. The MCP server gives developers something they *want*:

| What the developer gets | What the organization gets |
|---|---|
| Codebase context injected automatically (architecture, conventions, hotspots — no re-explaining to the agent) | Usage tracking across all AI tools |
| Issue context pre-loaded (no copy-pasting issue descriptions) | Cost attribution per developer, per task, per team |
| Episodic memory ("last time someone changed auth, payments tests broke") | Audit trail for compliance |
| Hotspot warnings before touching dangerous files | Quality gate data even for IDE-originated PRs |
| Budget visibility ("you've used $50 of your $200 this week") | Budget enforcement before it's too late |
| Conventions auto-loaded (agent follows project patterns without prompting) | Shadow IT visibility — know who's using what |

The developer's agent is **better** with the MCP server connected than without it. That's the adoption lever.

#### MCP Tools Exposed

| MCP Tool | When Called | What It Does |
|---|---|---|
| `session_start` | When the AI tool starts a session | Registers session with orchestrator, loads codebase context, links to assigned issue |
| `get_context` | When agent starts working on a task | Returns codebase profile, conventions, hotspots, architectural patterns, relevant episodic memory |
| `check_task` | When agent is about to make changes | Identifies which issue the developer is working on, checks autonomy level, returns applicable constraints |
| `track_usage` | After each model API call | Records token counts, model used, cost, timestamps |
| `check_file` | Before modifying a file | Checks if the file is a hotspot, blocked path, or crosses module boundaries — returns advisory warnings |
| `session_end` | When session closes | Finalizes cost receipt, submits usage report to orchestrator |

#### MCP Resources Exposed

| MCP Resource | Content |
|---|---|
| `ai-sdlc://context/codebase-profile` | Current codebase complexity, modules, patterns |
| `ai-sdlc://context/conventions` | Naming, testing, import conventions |
| `ai-sdlc://context/hotspots` | High-churn, high-complexity files with advisory notes |
| `ai-sdlc://context/my-tasks` | Issues assigned to this developer |
| `ai-sdlc://context/budget` | Team's remaining budget, developer's personal usage |
| `ai-sdlc://context/history` | Relevant episodic memory for the current task |

#### Session-to-Issue Linking

The MCP server determines which issue the developer is working on through multiple signals:

1. **Branch name** — If the developer is on branch `ai-sdlc/issue-247`, the MCP server parses the issue number. The orchestrator's branch naming convention makes this reliable.
2. **Explicit declaration** — The developer tells the AI tool "I'm working on issue #247" and the MCP server captures this from the conversation context.
3. **Git context** — The MCP server reads recent commits, checks which issues are assigned to this developer, and infers based on file overlap.
4. **Unattributed** — If no issue can be determined, the session is tracked under the developer's identity with a flag for manual attribution later.

#### Two Data Channels Into the Orchestrator

The orchestrator receives development activity through two complementary channels:

```
┌──────────────────────────────────────────────────────────────┐
│                    AI-SDLC Orchestrator                        │
│                                                              │
│  ┌──────────────────────────┐  ┌───────────────────────────┐ │
│  │ Channel 1:               │  │ Channel 2:                │ │
│  │ Orchestrated Pipelines   │  │ Human-Directed Sessions   │ │
│  │ (automated)              │  │ (MCP Session Tracker)     │ │
│  │                          │  │                           │ │
│  │ Full control:            │  │ Observability + context:  │ │
│  │ • Invokes agents         │  │ • Tracks usage            │ │
│  │ • Enforces gates         │  │ • Provides context        │ │
│  │ • Circuit breakers       │  │ • Records costs           │ │
│  │ • Cost limits            │  │ • Advisory guardrails     │ │
│  │ • Auto-merge             │  │ • Links to issues         │ │
│  └──────────────────────────┘  └───────────────────────────┘ │
│                                                              │
│  Unified: cost ledger, autonomy tracking, audit trail,       │
│           metrics, codebase state, episodic memory            │
└──────────────────────────────────────────────────────────────┘
```

- **Channel 1 (orchestrated):** Full control — the orchestrator invokes agents, enforces everything, manages the pipeline end-to-end.
- **Channel 2 (human-directed):** Observability + context — the MCP server tracks what developers do with AI tools and feeds it back to the same cost ledger, autonomy tracking, and audit trail.

Both channels produce the same data artifacts (cost receipts, provenance metadata, usage metrics), enabling a **unified view** of all AI-assisted development regardless of how it was initiated:

```
Development Activity Report — February 2026
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

                     Orchestrated    Human+AI (IDE)    Total
                     (automated)     (MCP tracked)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Issues completed          34              18            52
Token cost            $420.00         $890.00     $1,310.00
Human review hrs          12               —            12
PRs merged                34              18            52
Avg cost/issue        $12.35          $49.44        $25.19
Gate pass rate           94%             71%           85%
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Insight: Human+AI sessions cost 4x more per issue than
orchestrated pipelines. Primary drivers: no model selection
optimization, longer exploratory sessions, no circuit breaker.

Recommendation: Enable cost-aware model selection for IDE
sessions. Move high-volume task types to orchestrated pipeline.
```

This data is invaluable for engineering leadership: it answers "should we invest more in orchestrated pipelines (cheaper, more governed) or in better IDE tooling (more flexible, more expensive)?" and "which developers would benefit most from moving their workflow to the orchestrator?"

#### Configuration

The MCP session tracker is configured per-project in the standard MCP settings format:

```json
// .mcp.json (or IDE-specific MCP config)
{
  "mcpServers": {
    "ai-sdlc": {
      "command": "npx",
      "args": ["@ai-sdlc/mcp-session-tracker"],
      "env": {
        "AI_SDLC_ORCHESTRATOR_URL": "https://orchestrator.acme.com",
        "AI_SDLC_PROJECT": "acme/user-service"
      }
    }
  }
}
```

When a developer clones a repo with this configuration, their AI tool automatically connects to the MCP session tracker. No workflow change required.

### Interface Design

The orchestrator serves four distinct personas with different information needs, decision cadences, and workflow contexts. Rather than building a single UI, the interface is **layered** — each layer targets the personas that need it, and every layer builds on the one below it.

#### Personas

| Persona | Core question | Decision cadence | Primary interface |
|---|---|---|---|
| **Individual developer** | "What's the agent doing on my issue? Why did the gate fail?" | Real-time, per-task | CLI + platform integration (PR comments, check statuses) |
| **Tech lead / senior engineer** | "Are tasks routing correctly? What's the complexity distribution? Which agents need attention?" | Daily | CLI summary + TUI dashboard |
| **Engineering manager** | "How's autonomy trending? What's the cost per task? Are we getting ROI?" | Weekly / monthly | Web dashboard with trends and reports |
| **Platform / DevOps engineer** | "Is the orchestrator healthy? Are pipelines stalling? Do routing thresholds need tuning?" | Operational / on-alert | CLI + existing observability tools (Grafana, Datadog) |

#### Layer 1: CLI (Community Edition)

The CLI is the orchestrator's native interface — its `kubectl`. Every persona uses it; the developer and platform engineer live in it.

**Task tracking commands:**

```bash
ai-sdlc status                      # Summary: active pipelines, recent completions, agent status
ai-sdlc status ISSUE-142            # Pipeline progress for a specific issue
ai-sdlc log ISSUE-142               # Full execution trace (stages, gates, agent invocations)
ai-sdlc gates ISSUE-142             # Gate results: what passed, what failed, why
ai-sdlc diff ISSUE-142              # What changed: files modified, complexity delta
```

**Orchestrator inspection commands:**

```bash
ai-sdlc agents                      # Agent roster: autonomy levels, recent performance, promotion proximity
ai-sdlc agents claude-senior        # Detailed view of a specific agent's history
ai-sdlc routing --last 7d           # Task routing distribution (autonomous / ai-with-review / human-led)
ai-sdlc complexity                  # Current codebase complexity profile and hotspot map
ai-sdlc cost --last 7d              # Cost summary: per-pipeline, per-agent, budget utilization
```

**Operational commands:**

```bash
ai-sdlc health                      # Orchestrator health: state store, adapters, agent runners
ai-sdlc pipelines --active          # Currently executing pipelines with stage progress
ai-sdlc config validate             # Validate pipeline, gate, and autonomy configuration
ai-sdlc metrics                     # OpenTelemetry export endpoint status
```

**TUI mode:**

```bash
ai-sdlc dashboard                   # Live terminal dashboard (like k9s or lazygit)
```

The TUI dashboard provides a real-time view with panels for:
- Active pipelines with stage progress bars
- Recent completions with pass/fail status
- Agent autonomy levels with promotion/demotion indicators
- Gate failure feed
- Cost burn rate

Design principle: **the CLI is an operational interface, not just a setup tool.** Developers should never need to leave their terminal to understand what the orchestrator is doing or why it made a decision.

#### Layer 2: Platform Integration (Community Edition)

Most developers should not need to learn the CLI at all. The orchestrator surfaces information where developers already work:

**Pull request comments** — Every PR created by the orchestrator includes a structured summary:

```markdown
## AI-SDLC Orchestrator Summary

| Field | Value |
|---|---|
| Issue | ISSUE-142: Add user avatar upload |
| Complexity | 4/10 (moderate) |
| Routing | AI-with-review |
| Agent | claude-senior (Level 2) |
| Cost | $0.47 (budget: $5.00) |
| Gates passed | 6/6 |

### Quality Gates
✅ Lint — 0 violations
✅ Type check — clean
✅ Test coverage — 87% (threshold: 80%)
✅ Security scan — no findings
✅ Complexity delta — +0.3 (threshold: +2.0)
✅ Convention adherence — consistent with existing patterns

### Provenance
Agent: claude-code v1.2 | Model: claude-sonnet-4-5-20250929 | Duration: 4m 12s
Files: 3 modified, 1 created | Lines: +142 / -18
```

**Check runs** — Quality gate results appear as native GitHub/GitLab check statuses on the PR. Each gate maps to a separate check, providing fine-grained pass/fail visibility without requiring the developer to read the full comment.

**Issue comments** — As the pipeline progresses, the orchestrator posts stage transitions on the source issue:

```
🔄 Pipeline started — Complexity: 4/10, routing to AI-with-review
📋 Planning complete — 2 subtasks identified
🤖 Implementation in progress — agent: claude-senior
✅ All gates passed — PR #287 created, awaiting human review
```

**Notifications** (Team Cloud) — Pipeline events, gate failures, and promotion alerts delivered to Slack or Microsoft Teams channels. Configurable by event type and severity.

#### Layer 3: Web Dashboard (Team Cloud / Enterprise)

The web dashboard answers **strategic questions** for engineering managers and leadership. It is deliberately a paid feature because it targets the persona who controls the budget and needs the ROI story. Developers get everything they need through CLI and platform integrations in the free tier.

**Org-level overview:**
- Active pipelines across all repos with real-time stage progress
- Agent fleet status: autonomy levels, utilization, health
- Cost burn rate with budget tracking and forecasts

**Autonomy trajectory:**
- Graph: agent trust levels over time (when did each agent get promoted/demoted?)
- Promotion proximity: which agents are close to leveling up?
- Demotion events: what triggered them and what was the recovery?

**Codebase health:**
- Complexity trends over time (is the codebase getting harder to work with?)
- Hotspot map: which areas of the code are changing most frequently?
- Convention drift: are new contributions following established patterns?
- Architectural dependency graph with change-frequency overlay

**Cost analytics** (integrates with RFC-0004):
- Per-pipeline, per-agent, per-repo cost attribution
- Model usage breakdown (which models are being used for what?)
- Budget utilization with burn-rate projection
- Cost-per-task trend (are we getting more efficient over time?)

**ROI metrics:**
- Time-to-merge comparison: agent-driven vs human-driven tasks
- Rework rate: how often do agent PRs require revision?
- Gate pass rate trends: are agents improving?
- Developer velocity impact: issues closed per week, before and after orchestrator adoption

**Audit trail:**
- Searchable history of all orchestrator decisions with full provenance
- Filter by agent, repo, time range, outcome, cost
- Exportable for compliance reporting (Enterprise tier adds SIEM export)

#### Layer 4: Observability Export (Community Edition)

The orchestrator emits all metrics, traces, and logs via OpenTelemetry. Teams with existing observability stacks should be able to build their own dashboards from orchestrator telemetry without needing the paid web dashboard.

**What's exported:**
- All 13 cost metrics from RFC-0004
- Pipeline execution traces (each stage as a span, gates as child spans)
- Agent invocation traces (model, tokens, duration, cost)
- Autonomy events (promotions, demotions, threshold changes)
- Codebase analysis results (complexity scores, hotspot changes)

**Integration targets:**
- Prometheus / Grafana (metrics + dashboards)
- Datadog, New Relic (APM-style pipeline monitoring)
- Splunk, ELK (audit trail and log analysis)
- Custom dashboards via OTLP endpoint

This ensures the Community edition is genuinely useful for teams that already have observability infrastructure. The paid web dashboard adds value through pre-built views, cross-repo aggregation, and trend analysis — not through data access gating.

#### Interface Tier Summary

| Interface | Community (Free) | Team Cloud | Enterprise |
|---|---|---|---|
| CLI (all commands) | ✅ | ✅ | ✅ |
| TUI dashboard | ✅ | ✅ | ✅ |
| PR comments + check runs | ✅ | ✅ | ✅ |
| Issue stage comments | ✅ | ✅ | ✅ |
| OpenTelemetry export | ✅ | ✅ | ✅ |
| Slack / Teams notifications | — | ✅ | ✅ |
| Web dashboard | — | ✅ | ✅ |
| Advanced analytics + ROI | — | — | ✅ |
| SIEM audit export | — | — | ✅ |
| Compliance reporting | — | — | ✅ |

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
│   ├── cli/
│   │   ├── commands/            # CLI command handlers (status, agents, routing, cost)
│   │   ├── formatters/          # Output formatters (table, JSON, minimal)
│   │   └── tui/                 # TUI dashboard (terminal UI panels, keybindings)
│   ├── Dockerfile
│   └── package.json
│
├── dashboard/                   # Web dashboard (Team Cloud / Enterprise)
│   ├── src/
│   │   ├── pages/               # Overview, autonomy, codebase health, cost, audit
│   │   ├── components/          # Charts, pipeline views, agent cards, gate results
│   │   ├── api/                 # Dashboard API routes (reads from orchestrator state)
│   │   └── hooks/               # Data fetching, real-time subscriptions
│   └── package.json
│
├── mcp-session-tracker/         # MCP server for human-directed AI usage tracking
│   ├── src/
│   │   ├── tools/               # MCP tool handlers (start/end session, log action)
│   │   ├── resources/           # MCP resource providers (active sessions, metrics)
│   │   ├── linking/             # Session-to-issue linking logic
│   │   └── telemetry/           # OpenTelemetry export (traces, cost events)
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
- [ ] Implement `ai-sdlc status` command (pipeline progress, gate results)
- [ ] Implement `ai-sdlc health` command (orchestrator health check)
- [ ] CLI output formatters (table, JSON, minimal) for all commands
- [ ] SQLite-backed autonomy ledger and codebase state store
- [ ] Basic ClaudeCodeRunner implementation
- [ ] PR comment generation (structured orchestrator summary on agent-created PRs)
- [ ] Issue comment updates (stage transition notifications on source issues)

### Phase 1: Context and Routing (Weeks 3-8)

- [ ] Codebase complexity analyzer (file count, module structure, dependency graph)
- [ ] Architectural pattern detection (heuristic-based, not LLM-dependent)
- [ ] Hotspot identification (git log analysis for churn + complexity)
- [ ] Convention detection (naming patterns, test structure, import style)
- [ ] Context injection into agent tasks
- [ ] Complexity-based task routing with configurable thresholds
- [ ] Implement `ai-sdlc agents` command (roster, autonomy levels, performance)
- [ ] Implement `ai-sdlc routing` command (task routing distribution)
- [ ] Implement `ai-sdlc complexity` command (codebase complexity profile)
- [ ] Check run integration (quality gate results as GitHub/GitLab check statuses)

### Phase 2: Progressive Foundations (Weeks 6-12)

- [ ] Progressive gate threshold adjustment based on codebase complexity
- [ ] Automatic process escalation as complexity grows
- [ ] Episodic memory — record successes, failures, regressions
- [ ] Agent context enrichment from episodic memory
- [ ] Autonomy promotion/demotion with full metrics tracking
- [ ] Implement `ai-sdlc cost` command (per-pipeline, per-agent cost summary)
- [ ] TUI dashboard (`ai-sdlc dashboard`) — active pipelines, agent status, gate feed, cost burn rate
- [ ] OpenTelemetry export for all orchestrator metrics, traces, and autonomy events

### Phase 3: Multi-Agent and Scale (Weeks 10-16)

- [ ] Parallel agent execution for decomposed tasks
- [ ] Handoff contract validation between agents
- [ ] Multi-repo orchestration (monorepo and polyrepo)
- [x] Additional agent runners (Copilot, Cursor, Codex, custom)
- [ ] Python SDK: custom agent runner interface + policy evaluator
- [ ] Go SDK: Kubernetes operator for orchestrator deployment
- [ ] Web dashboard: org overview, autonomy trajectory, codebase health (Team Cloud)
- [ ] Slack / Teams notification integration (Team Cloud)

### Phase 4: Production Hardening (Weeks 14-20)

- [ ] GitHub adapter (full webhook integration, Check Runs, PR management)
- [ ] GitLab adapter (merge requests, CI integration)
- [ ] Linear / Jira adapters (issue tracking)
- [ ] Deployment stage support (Kubernetes, Vercel, Fly.io)
- [ ] Staged rollout with canary monitoring
- [ ] Production-grade audit trail with integrity verification
- [ ] Web dashboard: advanced analytics, cost optimization, ROI dashboards (Enterprise)
- [ ] SIEM audit export integration (Splunk, Datadog, ELK) (Enterprise)
- [ ] Compliance reporting views (ISO 42001, NIST AI RMF, EU AI Act) (Enterprise)

## Resolved Design Decisions

The following questions were raised during RFC drafting and have been resolved through discussion.

### 1. Orchestrator Hosting Model

**Decision:** All three deployment models, with CI/CD as the initial target.

| Phase | Hosting Model | Use Case |
|---|---|---|
| **Phase 0 (now)** | CI/CD Actions (GitHub Actions, GitLab CI) | Triggered per-event, stateless execution with external state store. Lowest barrier to entry — teams already have CI/CD. |
| **Phase 1** | Team server / VM | Long-running daemon with local state. Enables webhook-driven real-time orchestration. For teams outgrowing CI/CD trigger latency. |
| **Phase 2** | Cloud service | Managed orchestrator-as-a-service. Zero ops. Multi-repo, multi-org. The commercial offering (see Appendix A). |

The CI/CD model works today because the reconciliation loop can run as a triggered job — each invocation reads desired state, observes current state, diffs, acts, and exits. State is persisted externally (SQLite file in repo artifacts, or cloud-backed store). The long-running daemon and cloud service follow once the core orchestration logic is proven.

### 2. Codebase Analysis Depth

**Decision:** Deep nightly analysis with incremental per-pipeline diffs.

Having a thorough understanding of the codebase is critical to the orchestrator's value proposition — it's what enables intelligent routing, context injection, and progressive process foundations. The cost of deep analysis is easily amortized as a scheduled job.

**Nightly deep analysis** (full pass, 2-5 minutes for a 5,000-file codebase):
- Parse full AST for every file (language-specific: TypeScript compiler API, Python `ast` module, Go `go/parser`)
- Build the complete dependency graph (imports, exports, cross-module references)
- Compute cyclomatic complexity per function
- Detect architectural patterns (hexagonal, layered, event-driven) by analyzing import directions
- Identify hotspots (correlate `git log --stat` churn data with complexity scores)
- Map module boundaries and their public interfaces
- Detect circular dependencies, orphaned code, coupling metrics
- Detect **architectural drift** ("three months ago this was cleanly hexagonal, but 15 recent PRs introduced direct adapter-to-adapter imports")

**Per-pipeline incremental diff** (seconds):
- `git diff` against the base branch to identify changed files
- Walk only the changed files' dependency subgraph (what imports them, what they import)
- Recompute complexity only for changed modules
- Flag if changes cross module boundaries (raise complexity score)
- Check if changes touch hotspots (route to higher scrutiny)

The nightly analysis output is stored in `.ai-sdlc/state/codebase-profile.yaml` and cached. The per-pipeline diff is a lightweight overlay that adjusts scores based on the specific changes being made.

### 3. Agent Credential Model

**Decision:** Layered credential chain with fallback, rotation, and provider failover.

The credential model supports three authentication methods in a priority chain:

```yaml
# .ai-sdlc/agents.yaml
agents:
  - name: code-agent
    provider: anthropic
    credentials:
      # Primary: user's OAuth token (for human-initiated work)
      # The agent acts on behalf of the user who triggered the pipeline
      primary:
        type: oauth
        provider: anthropic
        scopes: ["code:write", "code:read"]

      # Fallback chain (tried in order if primary fails)
      fallback:
        # Fallback 1: Org API key (for autonomous work)
        - type: api-key
          keyRef: ANTHROPIC_API_KEY_PRIMARY

        # Fallback 2: Backup key (if primary exposed/rotated)
        - type: api-key
          keyRef: ANTHROPIC_API_KEY_SECONDARY

        # Fallback 3: Different provider entirely (graceful degradation)
        - type: api-key
          provider: openai
          keyRef: OPENAI_API_KEY
          model: gpt-4o

      # Key rotation: array of pre-provisioned keys for instant rotation
      rotation:
        keys:
          - ANTHROPIC_API_KEY_PRIMARY
          - ANTHROPIC_API_KEY_SECONDARY
          - ANTHROPIC_API_KEY_TERTIARY
        activeSlot: 0
        rotateOnFailure: true    # Auto-advance to next slot on auth failure
        notifyOnRotation: ["#ops-channel"]
```

**Semantics:**
- **OAuth primary:** When a human triggers a pipeline (labels an issue, assigns it), the agent uses the triggering user's OAuth subscription. The agent acts *on behalf of* the human.
- **API key fallback:** When the pipeline is triggered autonomously (scheduled, event-driven with no human initiator), the agent uses the organization's API key.
- **Provider failover:** If all keys for the primary provider fail (outage, rate limit), the orchestrator falls back to a different model/provider. The pipeline continues with degraded capability rather than failing entirely.
- **Instant rotation:** Pre-provisioned key array means a compromised key can be disabled immediately. The orchestrator advances `activeSlot` and notifies ops. No downtime.

### 4. Failure Recovery

**Decision:** Reset to branch point and restart from the beginning.

When the orchestrator crashes mid-pipeline while an agent has made modifications to the working directory, the safest recovery is a **clean restart**:

```
On orchestrator crash recovery:
  1. Detect in-flight pipelines (status: Running, no heartbeat in >5 minutes)
  2. For each in-flight pipeline:
     a. git reset --hard to the branch creation point
        (or delete the working branch entirely)
     b. Set pipeline status to "Failed (orchestrator crash, restarting)"
     c. Re-enqueue the original issue for fresh execution
  3. Resume the reconciliation loop from clean state
```

**Rationale:** Trying to resume from a partially modified working directory risks subtle corruption — incomplete refactors, half-applied changes, inconsistent state. The lost work is AI-generated code that can be regenerated deterministically (same issue, same context, same agent). The token cost of re-execution is trivial compared to the risk of shipping corrupted code.

The reconciliation model makes this natural: the loop is **level-triggered** (based on state, not events). When the orchestrator restarts, it observes "this issue is assigned and has no completed pipeline" and starts fresh. No special recovery logic needed — the normal loop handles it.

### 5. Multi-Repo Architecture Awareness

**Decision:** One orchestrator per organization, with cross-repo architectural reasoning.

The framing of "multi-tenant isolation" was incorrect. The correct model is: **one orchestrator per organization**, managing multiple repos that are architecturally related (e.g., microservice backends). The repos aren't isolated tenants — they're parts of a system that need to reason about each other.

**Per-repo state** (isolated):
- Codebase complexity profile
- Autonomy ledger (per-agent, per-repo)
- Episodic memory
- Conventions and hotspots

**Cross-repo state** (organizational):
```yaml
# .ai-sdlc/org-state/service-map.yaml
# Maintained by nightly analysis across all repos
services:
  user-service:
    repo: acme/user-service
    apis:
      - type: rest
        spec: openapi.yaml
        endpoints: ["/users/*"]
      - type: grpc
        spec: user.proto
    events:
      publishes: [user.created, user.updated, user.deleted]
      subscribes: []
    dependencies:
      - service: auth-service
        type: runtime
        interface: "JWT validation"

  auth-service:
    repo: acme/auth-service
    apis:
      - type: rest
        spec: openapi.yaml
        endpoints: ["/auth/*", "/oauth/*"]
    dependencies:
      - service: user-service
        type: runtime
        interface: "GET /users/{id}"

  notification-service:
    repo: acme/notification-service
    events:
      subscribes: [user.created, order.completed]
    dependencies:
      - service: user-service
        type: runtime
        interface: "GET /users/{id} (contact info)"
```

**How this affects orchestration:**

When Issue #248 says "add email verification to User model," the orchestrator:
1. Identifies `user-service` as the primary repo
2. Looks up the service map: `user-service` has 3 downstream dependents (`auth-service`, `notification-service`, `api-gateway`)
3. Scores the issue *higher complexity* because changes cascade across services
4. Decomposes into coordinated sub-tasks per repo with the right ordering
5. Ensures API contract changes don't break consumers (validates OpenAPI/proto compatibility)
6. Routes the cross-service coordination to a higher autonomy level or human architect

Storage model: per-repo SQLite databases for isolated state, plus an org-level state directory for the service map and cross-repo metrics. No shared database needed — the orchestrator reads all state directly.

### 6. Self-Evolving Spec Process

**Decision:** Formal "orchestrator found a spec gap" → RFC process.

The dogfood already demonstrated this pattern: ~600 lines of hardcoded orchestration logic in `execute.ts` became RFC-0002. The orchestrator will continue to reveal spec gaps as it encounters real-world scenarios the spec doesn't cover.

**Process:**

1. **Detection** — During orchestration, if the engine encounters a decision that should be declarative but isn't (must be hardcoded), it logs a `spec-gap` event with context.

2. **Triage** — Spec gaps are reviewed weekly. Gaps that affect portability (two orchestrator implementations would behave differently) or correctness (the gap leads to surprising behavior) are flagged for RFC.

3. **RFC** — A new RFC is drafted with:
   - The orchestrator scenario that revealed the gap
   - The hardcoded behavior currently in the orchestrator
   - The proposed spec extension to make it declarative
   - Conformance test cases derived from real pipeline executions

4. **Merge back** — Once the RFC is accepted, the orchestrator replaces its hardcoded logic with spec-driven configuration, and the conformance test suite is updated.

This creates a **self-evolving specification**: the orchestrator discovers what the spec should say, and the spec makes the orchestrator more portable and correct. The spec and product co-evolve through real-world usage, not theoretical design.

### 7. Commercial Model

**Decision:** Open-core with a managed cloud service and enterprise tier.

See **Appendix A: Commercial Strategy** below for the full analysis.

---

## Appendix A: Commercial Strategy

### Market Context

The AI developer tooling market is experiencing explosive growth:
- AI captured **$211 billion** in venture funding in 2025 (85% YoY increase)
- Cursor (Anysphere) went from $0 to **$1B+ ARR** in ~24 months, valued at **$29.3B**
- Cognition (Devin + Windsurf) raised $400M at a **$10.2B** valuation
- The AI governance market is projected to grow from **$309M (2025)** to **$4.8B (2034)** at 35.7% CAGR

No one is monetizing the AI SDLC orchestration layer yet. Cursor, Copilot, and Codex monetize *code generation*. SonarQube and Snyk monetize *code scanning*. Jira and Linear monetize *project tracking*. Nobody monetizes the orchestration of AI agents through the full SDLC — the layer that coordinates all of these.

### Pricing Model: Open-Core + Managed Cloud

The model follows the pattern proven by GitLab, Grafana Labs, Temporal, and Akuity: an open-source core that teams can self-host freely, with a managed cloud service and enterprise features for organizations that need them.

#### Community Edition (Free, Apache 2.0)

Everything needed to run the orchestrator for a single team:

| Feature | Included |
|---|---|
| Full orchestration engine | Pipeline execution, stage management, agent invocation |
| All agent runners | Claude Code, Copilot, Cursor, Codex, custom |
| Quality gate engine | Advisory, soft-mandatory, hard-mandatory enforcement |
| Autonomy system | Levels 0-3, promotion/demotion, full metrics |
| Codebase analysis | Nightly deep analysis, per-pipeline diffs |
| Context injection | Conventions, hotspots, architectural patterns |
| Adapter ecosystem | GitHub, GitLab, Linear, Jira, SonarQube, Semgrep |
| SQLite state store | Autonomy ledger, episodic memory, codebase profile |
| CLI tools | `ai-sdlc init`, `ai-sdlc run`, `ai-sdlc start` |
| OpenTelemetry | Traces, metrics, logs for all orchestration decisions |
| Single-repo | One repository per orchestrator instance |

**Why this is generous:** The community edition must be genuinely useful — not a crippled trial. Teams should be able to run their entire SDLC with the free edition. This builds adoption, community, and the contributor pipeline. The paid tiers monetize scale, operations, and enterprise requirements — not core functionality.

#### Team Cloud ($49/active-agent/month)

Managed orchestrator-as-a-service for teams scaling beyond a single repo:

| Feature | Added over Community |
|---|---|
| Managed hosting | Zero-ops orchestrator, always-on, webhook-driven |
| Multi-repo | Up to 25 repos per organization |
| Cross-repo service map | Architectural reasoning across microservices |
| PostgreSQL state store | Durable, backed up, queryable |
| Dashboard | Codebase complexity trends, autonomy trajectories, gate pass rates, agent performance |
| Slack/Teams notifications | Pipeline events, promotion alerts, gate failures |
| Team management | Invite members, assign roles, manage agents |
| 99.9% SLA | On the orchestration service |

**Pricing rationale:** "Active agent" = an agent that executed at least one pipeline stage in the billing period. This aligns cost with value — teams pay for agents that are doing work, not idle seats. At $49/active-agent/month, a team with 3 active agents pays $147/month. This is comparable to 3 Cursor Pro seats ($60/month) but delivers orchestration value on top of the coding agents the team already pays for.

#### Enterprise ($199/active-agent/month, annual commitment)

For organizations with compliance, security, and scale requirements:

| Feature | Added over Team Cloud |
|---|---|
| Unlimited repos | No repo limit per organization |
| SSO/SAML | Okta, Azure AD, Google Workspace integration |
| Audit export | Immutable audit trail export to SIEM (Splunk, Datadog, ELK) |
| Compliance reporting | ISO 42001, NIST AI RMF, EU AI Act mapped reports |
| Custom quality gates | Rego/CEL policy evaluation, LLM-based gate evaluation |
| Private deployment | VPC, on-prem, air-gapped options |
| IP indemnity | Legal coverage for AI-generated code orchestrated through the platform |
| Priority support | 4-hour SLA for critical issues, dedicated CSM |
| Advanced analytics | Cost-per-task, model usage optimization, ROI dashboards |
| Custom agent runners | Dedicated engineering support for proprietary agent integrations |
| Organization-level autonomy | Cross-repo agent autonomy with organizational policies |

**Pricing rationale:** $199/active-agent/month for an enterprise with 10 active agents = $23,880/year. This is a fraction of what enterprises pay for comparable developer infrastructure:
- GitLab Ultimate + Duo Enterprise: $138/user/month (per human developer)
- Snyk Enterprise (50 devs): ~$35K-47K/year
- SonarQube Enterprise (5M LOC): ~$35K/year
- DataRobot Enterprise: $15K-20K/month

The AI-SDLC Orchestrator replaces orchestration logic that would otherwise require significant custom engineering (the dogfood is 8,700 lines — that's months of senior engineering time).

#### Professional Services

| Service | Model |
|---|---|
| **Implementation** | Fixed-price engagement to configure orchestrator for org's SDLC |
| **Training** | Per-seat training for engineering teams on orchestrator configuration and agent management |
| **Custom adapters** | Time-and-materials development of proprietary tool integrations |
| **Architecture review** | Periodic assessment of orchestrator configuration and agent performance |

### Revenue Trajectory (Projection)

| Period | Community Users | Team Cloud | Enterprise | Est. ARR |
|---|---|---|---|---|
| Month 6 | 500 repos | 10 orgs (30 agents) | 0 | $18K |
| Month 12 | 2,000 repos | 50 orgs (200 agents) | 5 orgs (50 agents) | $237K |
| Month 18 | 5,000 repos | 150 orgs (700 agents) | 20 orgs (250 agents) | $1.0M |
| Month 24 | 10,000 repos | 400 orgs (2,000 agents) | 50 orgs (800 agents) | $3.1M |

### What Differentiates Free from Paid

The dividing line follows the GitLab "buyer-based" model:

- **Free features** target the **individual developer or small team** — they want to orchestrate their SDLC, and the free edition does everything they need.
- **Team Cloud features** target the **engineering manager** — they want multi-repo visibility, dashboards, and managed ops so they don't have to run infrastructure.
- **Enterprise features** target the **VP of Engineering / CISO** — they need compliance, audit trails, SSO, IP indemnity, and SLAs to satisfy their procurement and legal teams.

The core orchestration engine never becomes paid. Governance gates, autonomy management, context injection, and agent orchestration remain free forever. The commercial value is in **operational convenience, organizational scale, and enterprise compliance** — not in gating the technology that makes AI-driven SDLC work.

## Open Questions (Remaining)

1. **License choice for orchestrator** — Apache 2.0 is maximally permissive but allows competitors to offer a hosted service without contributing back. Should the orchestrator use BSL (like HashiCorp) or AGPL (like Grafana) to protect the commercial cloud offering? Apache 2.0 builds faster community adoption but risks a "free-rider" managed service from a cloud provider. The spec remains Apache 2.0 regardless.

2. **Agent compute cost attribution** — When the orchestrator invokes agents, who pays for the compute? The orchestrator itself is lightweight, but the agents it invokes consume API credits (Anthropic, OpenAI) or compute (self-hosted models). Should the orchestrator track and report per-pipeline agent costs? This would be valuable for the "cost per task" metric but requires integration with billing APIs.

3. **AAIF contribution timing** — At what point does the orchestrator have enough traction to propose the spec as a governance layer for the AAIF? The target should be quantifiable (e.g., 1,000+ governed repos, 5+ enterprise customers, multiple agent runners proven in production).

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
