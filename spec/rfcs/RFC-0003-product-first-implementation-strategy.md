# RFC-0003: Product-First Implementation Strategy

**Status:** Draft
**Author:** AI-SDLC Contributors
**Created:** 2026-02-11
**Updated:** 2026-02-11
**Target Spec Version:** v1alpha1

---

## Summary

This RFC proposes a fundamental shift in how AI-SDLC reaches adoption: from a **spec-first** approach (publish specification, wait for implementors) to a **product-first** approach (ship runnable governance products, extract the spec from what works). Concretely, we propose building two complementary products — an **MCP Governance Server** and a **GitHub Governance App** — that deliver immediate value to teams using AI coding agents, while the spec evolves as the configuration format and interoperability contract behind these products.

This RFC also reframes the SDK strategy. Rather than building standalone Python and Go SDKs as spec implementations, we position them as **client libraries** for the MCP Governance Server and **building blocks** for custom reconcilers, giving them a concrete purpose and immediate users.

## Motivation

### The spec-first path is slow

Successful infrastructure specifications follow a predictable timeline: 2-3 years from first draft to meaningful adoption. CloudEvents (CNCF) took 3 years to reach 1.0. OpenTelemetry took 4 years from merger to stable traces+metrics+logs. OPA took 2 years from sandbox to incubation. AI-SDLC cannot afford this timeline — the AI coding agent governance gap is acute *now*:

- **85%** of developers use AI coding tools, but only **20%** of companies have governance (GitHub 2025)
- **45%** of AI-generated code has security flaws (Veracode 2025)
- **75%** of tech leaders cite governance as their primary deployment challenge (Gartner 2025)
- Every **25%** increase in AI adoption correlates with **7.2%** drop in system stability (Google DORA)

By the time a spec-first AI-SDLC reaches v1.0, vendor-specific solutions (GitHub Copilot policies, Snyk AI governance, Qodo quality gates) will have fragmented the market.

### The AAIF is the kingmaker — and has a governance gap

The Agentic AI Foundation (AAIF), formed under the Linux Foundation in December 2025, houses the three emerging agent infrastructure standards:

| AAIF Project | What it solves | Status |
|---|---|---|
| **MCP** (Anthropic) | How agents connect to tools | 97M+ monthly SDK downloads, 10,000+ servers |
| **A2A** (Google) | How agents communicate with each other | Active development, enterprise adoption |
| **AGENTS.md** (OpenAI) | What agents should do per-project | 60,000+ repos, adopted by Cursor/Copilot/Codex/Devin |

The glaring gap:

| Missing layer | What it would solve |
|---|---|
| **???** | What agents are *allowed* to do, and under what policy |

AGENTS.md is advisory — it tells agents what conventions to follow, but cannot enforce quality gates, block merges, manage autonomy levels, or orchestrate workflows. MCP provides connectivity, not authorization. A2A provides communication, not governance.

AI-SDLC is the natural occupant of this governance layer. But approaching the AAIF with a draft specification and no users is a weak position. Approaching with a **working MCP server used by hundreds of teams** is a fundamentally different conversation.

### Products win, then standardize

The pattern is consistent across cloud-native infrastructure:

| Product shipped first | Standard extracted later |
|---|---|
| Docker (containers) | OCI (image + runtime spec) |
| etcd (KV store) | Kubernetes storage interface |
| Prometheus (metrics) | OpenMetrics (exposition format) |
| Envoy (proxy) | xDS (control plane API) |
| Terraform (IaC) | HCL (config language), provider protocol |
| Istio (service mesh) | SMI / GAMMA (mesh APIs) |

In every case, the specification succeeded *because* it described something that already worked in production. The spec became the **interoperability contract** between multiple implementations, not the starting point for the first implementation.

## Goals

- Ship two runnable governance products that deliver value in < 5 minutes of setup
- Achieve 500+ GitHub stars and 50+ actively governed repositories within 6 months
- Position AI-SDLC as the de facto governance layer for the AAIF stack
- Reframe SDKs (Python, Go) around concrete product use cases rather than abstract spec conformance
- Maintain the spec as the authoritative configuration format, validated by real-world usage
- Create an adoption funnel: free product users -> spec contributors -> AAIF proposal

## Non-Goals

- Replacing the specification with ad-hoc product design — the spec remains the source of truth for resource semantics
- Building a commercial SaaS platform — both products are open-source (Apache 2.0)
- Supporting every AI coding agent on day one — start with the top 3-5 by MCP adoption
- Achieving AAIF membership before products are proven — contribute from a position of traction
- Abandoning the TypeScript reference implementation — it becomes the runtime engine for the products

## Proposal

### Architecture Overview

```
                    ┌─────────────────────────────────────────────┐
                    │              AI Coding Agents                │
                    │   (Claude Code, Copilot, Cursor, Devin...)  │
                    └──────────┬──────────────────┬───────────────┘
                               │ MCP              │ Git push / PR
                               ▼                  ▼
                    ┌──────────────────┐  ┌──────────────────────┐
                    │  MCP Governance  │  │  GitHub Governance   │
                    │     Server       │  │       App            │
                    │                  │  │                      │
                    │  "Am I allowed   │  │  "Can this PR        │
                    │   to do this?"   │  │   merge?"            │
                    └────────┬─────────┘  └──────────┬───────────┘
                             │                       │
                             ▼                       ▼
                    ┌─────────────────────────────────────────────┐
                    │           AI-SDLC Policy Engine              │
                    │                                             │
                    │  ┌───────────┐ ┌──────────┐ ┌───────────┐  │
                    │  │ Quality   │ │ Autonomy │ │ Adapter   │  │
                    │  │ Gates     │ │ Ledger   │ │ Registry  │  │
                    │  └───────────┘ └──────────┘ └───────────┘  │
                    │                                             │
                    │  Configured via:  .ai-sdlc/policy.yaml     │
                    │  (AI-SDLC spec resource definitions)        │
                    └─────────────────────────────────────────────┘
```

### Product 1: MCP Governance Server

An MCP server that any MCP-compatible AI coding agent can connect to. The server exposes governance as **tools** that agents query during their workflow.

#### MCP Tools Exposed

| Tool Name | Description | Input | Output |
|---|---|---|---|
| `check_permission` | Check if an action is allowed at the agent's current autonomy level | `{ action, resource, context }` | `{ allowed, reason, requiredLevel }` |
| `get_autonomy_level` | Get the agent's current autonomy level and what it permits | `{ agentId }` | `{ level, permissions, restrictions }` |
| `evaluate_gate` | Evaluate a quality gate against provided evidence | `{ gate, evidence }` | `{ passed, failures[], advisory[] }` |
| `get_policy` | Retrieve the active policy for a repository/context | `{ repo, stage? }` | `{ policy }` (AI-SDLC resource) |
| `record_action` | Record an agent action for audit and autonomy tracking | `{ action, outcome, metadata }` | `{ recorded, autonomyImpact }` |
| `request_approval` | Request human approval for a gated action | `{ action, reason, evidence }` | `{ approvalId, status }` |

#### How Agents Use It

An AI coding agent with MCP support (Claude Code, Copilot, Cursor, etc.) connects to the governance server as an MCP server. The agent can then query governance before taking actions:

```
Agent: "I want to merge this PR with 200 lines changed across 8 files."

→ check_permission({ action: "merge_pr", resource: "PR #42",
    context: { linesChanged: 200, filesChanged: 8 }})

← { allowed: false,
    reason: "Agent at Level 1 (Junior). PRs over 100 lines require
             Level 2+ or human approval.",
    requiredLevel: 2,
    override: { type: "human_approval", approvers: ["@tech-lead"] }}
```

#### Configuration

The server reads `.ai-sdlc/policy.yaml` from the repository root. This file uses standard AI-SDLC resource definitions:

```yaml
# .ai-sdlc/policy.yaml
apiVersion: ai-sdlc.io/v1alpha1
resources:
  - kind: AutonomyPolicy
    metadata:
      name: default
    spec:
      defaultLevel: 1
      levels:
        - level: 0
          name: observer
          permissions: [read]
        - level: 1
          name: junior
          permissions: [read, write, create_pr]
          guardrails:
            maxLinesPerPR: 100
            requireTests: true
            blockedPaths: ["**/security/**", "**/infrastructure/**"]
        - level: 2
          name: senior
          permissions: [read, write, create_pr, merge]
          guardrails:
            maxLinesPerPR: 500
            requireTests: true
        - level: 3
          name: principal
          permissions: [read, write, create_pr, merge, configure]
      promotionCriteria:
        "1-to-2":
          minPRsApproved: 20
          approvalRate: 0.90
          minTimeAtLevel: P14D
          zeroSecurityIncidents: true
        "2-to-3":
          minPRsApproved: 50
          approvalRate: 0.95
          minTimeAtLevel: P30D
          zeroSecurityIncidents: true
      demotionTriggers:
        - event: security_incident
          severity: critical
          demoteTo: 0
        - event: rollback_rate_exceeded
          threshold: 0.05
          demoteTo: 1

  - kind: QualityGate
    metadata:
      name: pr-checks
    spec:
      gates:
        - name: test-coverage
          enforcement: hard-mandatory
          rule: "coverage >= 80"
        - name: security-scan
          enforcement: hard-mandatory
          rule: "critical_findings == 0"
        - name: lint-clean
          enforcement: soft-mandatory
          rule: "lint_errors == 0"
        - name: ai-attribution
          enforcement: advisory
          rule: "provenance.model != null"
```

#### Runtime

- Built on the existing TypeScript reference implementation (`reference/src/`)
- Runs as a standalone process or Docker container
- Maintains an **autonomy ledger** (SQLite for local, PostgreSQL for team) tracking agent actions and autonomy level transitions
- Emits OpenTelemetry spans for every governance decision

### Product 2: GitHub Governance App

A GitHub App that enforces AI-SDLC policies at the platform level — even if agents ignore the MCP server.

#### Core Features

| Feature | Mechanism |
|---|---|
| **PR Quality Gates** | GitHub Check Runs that block merge when gates fail |
| **AI Detection** | Identify AI-generated PRs via git trailers, Copilot metadata, agent signatures |
| **Autonomy Enforcement** | Track agent autonomy levels; block actions that exceed current level |
| **Governance Dashboard** | Repository-level view of gate pass rates, autonomy levels, intervention rates |
| **Auto-labeling** | Label PRs with `ai-generated`, `autonomy-level-N`, `gate-passed`/`gate-failed` |
| **Override Workflow** | Allow authorized humans to override soft-mandatory gates with audit trail |

#### How It Works

1. Team installs the GitHub App on their repository
2. App reads `.ai-sdlc/policy.yaml` from the repo (same file as MCP server)
3. On every PR event (opened, synchronized, review_submitted):
   - Evaluates quality gates as Check Runs
   - Checks autonomy level constraints
   - Posts status summary as a PR comment
   - Blocks merge if hard-mandatory gates fail
4. Dashboard available at `github.com/apps/ai-sdlc/dashboard/{owner}/{repo}`

#### Check Run Example

```
AI-SDLC Governance                              ❌ Failed

Quality Gates:
  ✅ test-coverage: 84% (threshold: 80%)        hard-mandatory  PASSED
  ❌ security-scan: 2 critical findings          hard-mandatory  FAILED
  ✅ lint-clean: 0 errors                        soft-mandatory  PASSED
  ⚠️  ai-attribution: missing provenance block   advisory        WARNING

Autonomy Check:
  Agent: claude-code (Level 1 — Junior)
  PR size: 247 lines across 12 files
  ❌ Exceeds Level 1 guardrail: maxLinesPerPR (100)
  → Requires Level 2+ or human approval override

Action Required:
  • Fix 2 critical security findings
  • Request autonomy override from @tech-lead OR reduce PR scope
```

#### Defense in Depth

The MCP server and GitHub App provide two complementary enforcement points:

| Scenario | MCP Server (agent-side) | GitHub App (platform-side) |
|---|---|---|
| Agent checks before acting | Blocks action preemptively | N/A (hasn't reached platform yet) |
| Agent ignores MCP server | N/A (bypassed) | Blocks merge at PR level |
| Agent has no MCP support | N/A (not connected) | Still enforces via Check Runs |
| Both connected | Pre-flight check + merge-time enforcement | Full governance |

This means governance works even with agents that don't support MCP, providing a backstop for all AI-generated code.

### SDK Reframing

The Python and Go SDKs shift from "abstract spec implementations" to concrete product-oriented roles:

#### Python SDK: `ai-sdlc-python`

| Previous plan | New purpose |
|---|---|
| Pydantic models from schemas | **Same** — still generated from JSON Schemas |
| Schema validation | **Same** — still uses jsonschema |
| Adapter interface protocols | **Client library for MCP Governance Server** |
| Policy enforcement engine | **Embeddable policy evaluator** for Python-based agents and CI tools |

**Primary users:** Teams building custom AI agents in Python (LangChain, CrewAI, AutoGen) that need to query governance before taking actions.

**Key deliverable:** A Python client that wraps the MCP governance tools:

```python
from ai_sdlc import GovernanceClient

gov = GovernanceClient(server="localhost:3000", agent_id="my-agent")

# Check before acting
decision = await gov.check_permission(
    action="merge_pr",
    resource="PR #42",
    context={"lines_changed": 200}
)

if not decision.allowed:
    print(f"Blocked: {decision.reason}")
    if decision.override:
        approval = await gov.request_approval(
            action="merge_pr",
            reason="Large but well-tested refactor",
            evidence={"coverage": 0.92, "tests_passed": True}
        )
```

#### Go SDK: `ai-sdlc-go`

| Previous plan | New purpose |
|---|---|
| Go structs from schemas | **Same** — still generated from JSON Schemas |
| Schema validation | **Same** — still uses gojsonschema |
| Adapter interfaces | **Same** — Go interfaces for adapter contracts |
| Reconciliation loop library | **Kubernetes operator for AI-SDLC governance** |

**Primary users:** Platform engineering teams running Kubernetes who want governance-as-infrastructure.

**Key deliverable:** A controller-runtime compatible operator that reconciles AI-SDLC resources as Kubernetes CRDs:

```go
// AI-SDLC resources become Kubernetes CRDs
// kubectl apply -f autonomy-policy.yaml

type AutonomyPolicyReconciler struct {
    client.Client
    Scheme *runtime.Scheme
    Ledger autonomy.Ledger
}

func (r *AutonomyPolicyReconciler) Reconcile(ctx context.Context,
    req ctrl.Request) (ctrl.Result, error) {
    // Fetch the AutonomyPolicy resource
    // Compare declared state vs actual agent behavior
    // Promote/demote agents based on criteria
    // Requeue for continuous reconciliation
}
```

### Repo Structure Changes

```
ai-sdlc/
├── spec/                        # UNCHANGED — authoritative specification
│   ├── schemas/                 # JSON Schemas (source of truth)
│   └── rfcs/                    # Enhancement proposals (including this one)
│
├── reference/                   # EVOLVED — becomes the policy engine core
│   └── src/
│       ├── core/                # Resource types, validation
│       ├── policy/              # Gate evaluation engine
│       ├── autonomy/            # Autonomy ledger and level management
│       └── adapters/            # Adapter interface implementations
│
├── products/                    # NEW — runnable governance products
│   ├── mcp-server/              # MCP Governance Server
│   │   ├── src/
│   │   │   ├── server.ts        # MCP server setup (stdio + SSE transport)
│   │   │   ├── tools/           # MCP tool implementations
│   │   │   │   ├── check-permission.ts
│   │   │   │   ├── get-autonomy-level.ts
│   │   │   │   ├── evaluate-gate.ts
│   │   │   │   ├── get-policy.ts
│   │   │   │   ├── record-action.ts
│   │   │   │   └── request-approval.ts
│   │   │   ├── ledger/          # Autonomy ledger (SQLite/PostgreSQL)
│   │   │   └── config/          # Policy file loader (.ai-sdlc/policy.yaml)
│   │   ├── Dockerfile
│   │   └── package.json
│   │
│   └── github-app/              # GitHub Governance App
│       ├── src/
│       │   ├── app.ts           # Probot/Octokit app setup
│       │   ├── checks/          # Check Run implementations
│       │   ├── detection/       # AI-generated PR detection
│       │   ├── dashboard/       # Governance dashboard UI
│       │   └── webhooks/        # GitHub webhook handlers
│       ├── Dockerfile
│       └── package.json
│
├── sdk-typescript/              # EVOLVED — powers products + standalone use
├── sdk-python/                  # EVOLVED — MCP client + embeddable evaluator
├── sdk-go/                      # EVOLVED — Kubernetes operator + CRDs
│
├── conformance/                 # UNCHANGED — language-agnostic test suite
└── contrib/                     # UNCHANGED — community adapters
```

## Design Details

### Schema Changes

No changes to the core JSON Schemas. The `.ai-sdlc/policy.yaml` format uses existing resource definitions composed into a single multi-resource file (similar to Kubernetes multi-resource YAML). A thin wrapper schema is introduced:

```json
{
  "$id": "https://ai-sdlc.io/schemas/policy-file.schema.json",
  "type": "object",
  "properties": {
    "apiVersion": {
      "type": "string",
      "const": "ai-sdlc.io/v1alpha1"
    },
    "resources": {
      "type": "array",
      "items": {
        "oneOf": [
          { "$ref": "pipeline.schema.json" },
          { "$ref": "quality-gate.schema.json" },
          { "$ref": "autonomy-policy.schema.json" },
          { "$ref": "agent-role.schema.json" },
          { "$ref": "adapter-binding.schema.json" }
        ]
      }
    }
  },
  "required": ["apiVersion", "resources"]
}
```

### Behavioral Changes

#### MCP Server Governance Loop

The MCP server implements a simplified reconciliation cycle:

1. **Load** — Read `.ai-sdlc/policy.yaml` on startup, watch for changes
2. **Evaluate** — On each tool call, evaluate the request against loaded policy
3. **Decide** — Return allow/deny/override-required with structured reasoning
4. **Record** — Append decision to the autonomy ledger
5. **Reconcile** — Periodically evaluate autonomy promotion/demotion criteria against the ledger

#### GitHub App Enforcement Flow

1. **Webhook** — Receive PR event from GitHub
2. **Detect** — Classify PR as AI-generated or human-authored
3. **Load** — Fetch `.ai-sdlc/policy.yaml` from the PR's base branch
4. **Evaluate** — Run quality gates and autonomy checks
5. **Report** — Create/update Check Runs and PR comments
6. **Enforce** — Set Check Run conclusion (success/failure) to gate merge

#### Autonomy Ledger Schema

The autonomy ledger is a persistent store tracking agent behavior over time:

```sql
-- Core tables for the autonomy ledger
CREATE TABLE agents (
  id          TEXT PRIMARY KEY,
  repo        TEXT NOT NULL,
  level       INTEGER NOT NULL DEFAULT 1,
  promoted_at TIMESTAMP,
  demoted_at  TIMESTAMP
);

CREATE TABLE actions (
  id          TEXT PRIMARY KEY,
  agent_id    TEXT REFERENCES agents(id),
  action      TEXT NOT NULL,
  outcome     TEXT NOT NULL,  -- 'allowed', 'denied', 'overridden'
  timestamp   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  metadata    JSONB
);

CREATE TABLE level_transitions (
  id          TEXT PRIMARY KEY,
  agent_id    TEXT REFERENCES agents(id),
  from_level  INTEGER NOT NULL,
  to_level    INTEGER NOT NULL,
  reason      TEXT NOT NULL,
  timestamp   TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

### Migration Path

This is not a breaking change to the specification. It is an additive change to the project structure:

- Existing spec documents remain unchanged and authoritative
- The TypeScript reference implementation is refactored into the policy engine consumed by both products, but its public API does not change
- The `.ai-sdlc/policy.yaml` convention is new but uses existing resource schemas
- SDKs gain new functionality but retain their planned feature sets

## Backward Compatibility

- **Spec:** No changes. All existing resources validate identically.
- **Reference implementation:** Internal refactoring only. Public types and validation functions unchanged.
- **SDK plans:** Additive. All previously planned features (Pydantic models, Go structs, schema validation) are retained. New features (MCP client, Kubernetes operator) are added.
- **Conformance tests:** Unchanged. Products must pass the same conformance suite.

## Alternatives Considered

### Alternative 1: Spec-First, Products Later

Continue the current approach: finalize spec v1alpha1, publish it, build reference implementation, then hope for community-built products.

**Rejected because:** The governance gap is urgent and the competitive window is narrow. Vendor-specific solutions (GitHub Copilot policies, Snyk AI governance, Qodo quality gates) are shipping now. By the time a spec-first approach reaches adoption, the market will have fragmented into incompatible vendor silos. The AAIF is actively seeking governance solutions — arriving with a spec and no users is weaker than arriving with a product and traction.

### Alternative 2: CLI Wrapper Only

Build a CLI tool (`ai-sdlc run --agent ... --policy ...`) that wraps agent commands with governance, without an MCP server or GitHub App.

**Rejected because:** A CLI wrapper requires agents to be launched through it, which is impractical for IDE-integrated agents (Copilot, Cursor, Windsurf). The MCP approach meets agents where they already are — as a server they connect to using an existing protocol. The GitHub App meets code where it already is — as a check on the platform where PRs are reviewed.

### Alternative 3: MCP Server Only, No GitHub App

Ship only the MCP Governance Server and rely on agents to respect governance decisions.

**Rejected because:** Agent compliance cannot be assumed. An agent that doesn't support MCP, or one that ignores the governance server's response, would bypass all governance. The GitHub App provides a platform-level backstop that enforces governance regardless of agent behavior. Defense in depth is a core security principle.

### Alternative 4: GitHub App Only, No MCP Server

Ship only the GitHub App and enforce governance at merge time.

**Rejected because:** Merge-time enforcement is too late. An agent that spends 30 minutes writing code only to have it blocked at merge time wastes significant compute and time. The MCP server enables pre-flight checks — agents can ask "am I allowed to do this?" before starting, avoiding wasted effort. Additionally, an MCP server is agent-agnostic and platform-agnostic, supporting future expansion to GitLab, Bitbucket, etc.

### Alternative 5: Build on Eclipse LMOS/ADL

Contribute SDLC-specific extensions to the Eclipse LMOS Agent Definition Language rather than building standalone products.

**Rejected because:** Eclipse LMOS is architecturally focused on general enterprise agent orchestration (customer service, sales, routing). Its runtime model (Kubernetes/Istio-based multi-agent routing) is over-engineered for the SDLC governance use case, where most teams need simple policy evaluation, not agent routing meshes. Building on LMOS would inherit unnecessary complexity and tie the project to Eclipse Foundation governance and release cadence. However, we should monitor LMOS/ADL evolution and consider interoperability where beneficial.

### Alternative 6: Contribute Directly to AAIF Without Products

Submit the AI-SDLC specification to the AAIF as a governance standard proposal.

**Rejected because:** The AAIF founding projects (MCP, A2A, AGENTS.md) all entered with significant existing adoption. MCP had 97M+ monthly SDK downloads; AGENTS.md had 60,000+ repos. Proposing a draft spec with no users would not meet the foundation's bar. The product-first strategy builds the traction needed to make an AAIF contribution credible.

## Implementation Plan

### Phase 0: Foundation (Weeks 1-4)

- [ ] Refactor `reference/src/` into a standalone policy engine package
- [ ] Define `.ai-sdlc/policy.yaml` multi-resource file format
- [ ] Add `policy-file.schema.json` wrapper schema
- [ ] Create `products/` directory structure
- [ ] Implement autonomy ledger with SQLite backend

### Phase 1: MCP Governance Server (Weeks 3-8)

- [ ] Scaffold MCP server with stdio + SSE transports
- [ ] Implement `check_permission` tool
- [ ] Implement `get_autonomy_level` tool
- [ ] Implement `evaluate_gate` tool
- [ ] Implement `get_policy` tool
- [ ] Implement `record_action` tool
- [ ] Implement `request_approval` tool
- [ ] Policy file watcher (reload on change)
- [ ] Docker container packaging
- [ ] Integration test with Claude Code as MCP client
- [ ] Documentation: "Add governance to your AI agent in 5 minutes"

### Phase 2: GitHub Governance App (Weeks 5-10)

- [ ] Scaffold GitHub App with Probot/Octokit
- [ ] PR webhook handler (opened, synchronize, review_submitted)
- [ ] AI-generated PR detection (git trailers, metadata, heuristics)
- [ ] Quality gate evaluation as Check Runs
- [ ] Autonomy level enforcement
- [ ] PR comment with governance summary
- [ ] Soft-mandatory override workflow (authorized human approval)
- [ ] Basic dashboard (gate pass rates, autonomy levels per repo)
- [ ] GitHub Marketplace listing
- [ ] Documentation: "Add governance to your GitHub repo in 2 minutes"

### Phase 3: SDK Evolution (Weeks 8-14)

- [ ] Python SDK: MCP governance client library
- [ ] Python SDK: Embeddable policy evaluator (for LangChain/CrewAI/AutoGen agents)
- [ ] Go SDK: Kubernetes CRD definitions for AI-SDLC resources
- [ ] Go SDK: Controller-runtime reconciler for AutonomyPolicy
- [ ] Conformance test harness updates for all SDKs

### Phase 4: AAIF Contribution (Week 16+)

- [ ] Compile adoption metrics (installs, governed repos, active agents)
- [ ] Draft AAIF contribution proposal
- [ ] Present at AAIF community meeting
- [ ] Submit governance layer specification for AAIF consideration

## Open Questions

1. **MCP server hosting model** — Should we offer a hosted (cloud) version of the MCP server for teams that don't want to self-host, or start local-only? A hosted version accelerates adoption but introduces operational complexity and trust concerns (governance decisions flowing through a third-party server).

2. **Autonomy ledger federation** — When an agent operates across multiple repositories, should autonomy levels be per-repo or global? Per-repo is safer (agent earns trust per codebase) but creates fragmented autonomy states. Global requires a federated ledger across repos.

3. **AI detection accuracy** — Reliably detecting whether a PR is AI-generated is non-trivial. Git trailers and Copilot metadata cover some cases, but agents that don't self-identify create blind spots. Should the GitHub App require explicit AI attribution (via `.ai-sdlc` provenance) or attempt heuristic detection?

4. **Policy file location convention** — Is `.ai-sdlc/policy.yaml` the right convention? Alternatives include `ai-sdlc.yaml` (root-level, like `.eslintrc`), `.github/ai-sdlc.yaml` (GitHub-specific), or `GOVERNANCE.yaml` (generic). The chosen convention affects discoverability and ecosystem alignment.

5. **AGENTS.md integration** — Should the MCP server or GitHub App auto-generate an `AGENTS.md` file from the policy? This would bridge the AAIF ecosystem: teams define policy in `.ai-sdlc/policy.yaml`, and the product generates a conforming `AGENTS.md` that tells agents about the governance rules in a format they already understand.

6. **Pricing and sustainability** — If the GitHub App is free and open-source, what is the sustainability model? Options include: (a) fully community-funded via AAIF/CNCF, (b) open-core with a paid enterprise tier (SSO, audit exports, multi-repo dashboards), (c) hosted service with a free tier.

## References

- [MCP Specification](https://modelcontextprotocol.io/) — Model Context Protocol, the connectivity layer for AI agents
- [A2A Protocol](https://github.com/google/A2A) — Agent-to-Agent Protocol for inter-agent communication
- [AGENTS.md](https://github.com/anthropics/agents-md) — Per-project agent instruction format
- [Agentic AI Foundation (AAIF)](https://www.linuxfoundation.org/press/linux-foundation-announces-the-formation-of-the-agentic-ai-foundation) — Linux Foundation initiative housing MCP, A2A, AGENTS.md
- [Eclipse LMOS / ADL](https://eclipse.dev/lmos/) — Agent Definition Language for enterprise agent orchestration
- [Agentgateway](https://agentgateway.dev/) — AI-native proxy for MCP/A2A traffic with RBAC
- [OPA (Open Policy Agent)](https://www.openpolicyagent.org/) — General-purpose policy engine
- [Sonatype: The Last Mile Problem](https://www.sonatype.com/blog/the-last-mile-problem-ai-can-write-code-but-only-policy-can-ship-it) — Governance as the bottleneck for AI-generated code
- [Qodo 2.0](https://www.qodo.ai/) — AI code review with quality gates
- [GitHub Copilot Enterprise Policies](https://docs.github.com/en/copilot/concepts/policies) — Vendor-specific governance for Copilot
- [AI-SDLC spec.md](../spec.md) — Core resource model specification
- [AI-SDLC Foundation Research](../../research/ai-sdlc-foundation-research.md) — 10-domain market analysis
- [RFC-0002: Pipeline Orchestration Policy](./RFC-0002-pipeline-orchestration.md) — Prior RFC extending Pipeline resource
