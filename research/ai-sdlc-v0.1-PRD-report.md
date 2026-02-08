# Best practices for an AI-SDLC Framework PRD

**The most effective path to building an open-source governance framework for AI coding agents is to combine Kubernetes' declarative resource model (spec/status), OpenTelemetry's four-layer spec architecture (API/SDK/protocol/conventions), and a Terraform-style adapter system — all enforced through a reconciliation loop with graduated policy enforcement.** This synthesis draws from analysis of 20+ major open-source infrastructure projects and 6 multi-agent orchestration frameworks. The patterns converge on a clear architectural blueprint: declare desired SDLC state in YAML, observe actual development activity via adapters, diff against policy, and reconcile — continuously. What follows is a detailed pattern catalog organized around the eight dimensions required for the AI-SDLC Framework PRD.

---

## 1. How successful infrastructure specs are structured

Every major spec project studied — Kubernetes, OpenTelemetry, CloudEvents, GraphQL, and MCP — shares a common structural DNA despite surface-level differences. Understanding these patterns is foundational to designing the AI-SDLC specification.

**Kubernetes** established the canonical resource model: every object carries five top-level fields (`apiVersion`, `kind`, `metadata`, `spec`, `status`). The **spec/status split** is the single most important design pattern — `spec` represents user intent (desired state), `status` represents system-observed reality. Controllers continuously reconcile the gap between them. K8s versions APIs through a maturity progression (`v1alpha1` → `v1beta1` → `v1`) with defined stability guarantees at each stage: alpha features can disappear without notice, beta features get 9 months of support after deprecation, and GA features get 12 months.

**OpenTelemetry** pioneered a **four-layer separation** that directly applies to AI-SDLC: the API layer (thin, stable interfaces imported by libraries), the SDK layer (configurable runtime implementation), the Protocol layer (OTLP wire format with its own stability guarantees), and Semantic Conventions (standardized attribute keys). Each signal (traces, metrics, logs) progresses independently through Development → Stable → Deprecated → Removed. Every spec document carries a machine-readable `Status:` header. Changes flow through formal OTEPs (Enhancement Proposals), mirroring Kubernetes KEPs.

**CloudEvents** demonstrated the **core-plus-extensions model**: a minimal set of four required context attributes (`specversion`, `id`, `source`, `type`) plus optional attributes and a rich extension mechanism. The spec separates normative content (`spec.md`) from informative guidance (`primer.md`), and cleanly decouples the core spec from event format specs (JSON, Avro, Protobuf) and protocol bindings (HTTP, Kafka, AMQP). This layered separation prevents the core from becoming bloated.

**GraphQL** took a different approach with a **single monolithic specification** organized into numbered chapters (Language, Type System, Introspection, Validation, Execution, Response). Execution semantics are defined as explicit pseudocode algorithms like `ExecuteSelectionSet()` and `ResolveFieldValue()`. GraphQL versions by date-named editions (e.g., "September 2025") rather than semantic versions, and each edition is additive — no features have ever been removed.

**MCP (Model Context Protocol)** uses a **two-layer architecture** — a data layer built on JSON-RPC 2.0 and a transport layer (STDIO for local, Streamable HTTP for remote). Its most relevant pattern for AI-SDLC is **capability negotiation**: during initialization, client and server declare which primitives they support, preventing unsupported operations. MCP versions by date strings (`"2025-06-18"`) negotiated during the handshake.

The universal patterns across all five projects that should inform the AI-SDLC spec:

- **Embedded versioning**: The version travels with the data (`apiVersion` in K8s, `specversion` in CloudEvents, `protocolVersion` in MCP)
- **RFC 2119 normative keywords**: MUST, SHOULD, MAY distinguish requirements from recommendations
- **Separation of concerns**: Core spec, bindings/adapters, and implementations live in separate documents
- **Discovery mechanisms**: Introspection (GraphQL), capability negotiation (MCP), API discovery (K8s)
- **Enhancement proposal processes**: KEPs, OTEPs, and RFC-style processes gate spec changes through formal review

---

## 2. Declarative configuration-as-code architecture

The AI-SDLC Framework needs a declarative configuration system that is expressive enough to capture complex SDLC policies yet simple enough for engineering teams to author and maintain. Five configuration systems provide the design vocabulary.

**Kubernetes CRDs** are the gold standard for declarative extensibility. A CRD defines a new resource type with an **OpenAPI v3 schema** embedded in the definition, enabling server-side validation, field pruning (rejecting unknown fields), defaults, pattern matching, and enum constraints. The critical insight is that CRDs separate schema definition from behavior — the CRD declares structure, while a controller implements reconciliation logic. Multiple API versions can coexist via conversion webhooks, enabling non-breaking evolution. For AI-SDLC, this means SDLC policies, agent configurations, and workflow definitions should all be expressible as CRD-style resources with validated schemas.

**GitHub Actions** provides the best model for **event-driven workflow triggers**. The `on:` block supports typed event triggers with filtering (branches, paths, schedules, manual dispatch with typed inputs). The two-tier reuse model — reusable workflows (job-level templates) and composite actions (step-level templates) — shows how to build layered configuration reuse. GitHub Actions' `uses: owner/repo@version` pattern for referencing shared components is directly applicable to AI-SDLC adapter references.

**Terraform's HCL** demonstrates the most mature **provider abstraction**. Resources are declared uniformly (`resource "type" "name" { ... }`) regardless of which cloud provider implements them. Provider sources are declared in `required_providers`, downloaded during `terraform init`, and locked in `.terraform.lock.hcl` for reproducibility. The `variable` block with `validation` constraints shows how to add semantic validation to configuration inputs. For AI-SDLC, this pattern translates to declaring tool integrations (Jira, Linear, GitHub, GitLab) as swappable providers behind a uniform interface.

**ArgoCD** proves the **reconciliation-driven configuration model** at scale. Its `Application` resource declares source (Git repo), destination (cluster), and sync policy (automated pruning, self-healing). The `ApplicationSet` resource uses generators (list, cluster, Git directory, SCM provider, pull request) to template multiple Applications from a single definition — directly applicable to generating AI-SDLC policies across multiple repositories or teams.

**CircleCI Orbs** model the **packageable, versioned configuration component**. Orbs bundle reusable commands, jobs, and executors into SemVer-versioned packages identified as `namespace/name@version`, published to a registry, and composed into workflows. The parameterization system supports typed inputs (`string`, `boolean`, `integer`, `enum`, `executor`, `steps`). For AI-SDLC, quality gate definitions, agent role templates, and workflow patterns could all be distributed as Orb-style packages.

The recommended configuration architecture for AI-SDLC combines these patterns:

```yaml
apiVersion: ai-sdlc.io/v1alpha1
kind: Pipeline
metadata:
  name: feature-delivery
  namespace: team-alpha
spec:
  triggers:
    - event: issue.assigned
      filter: { labels: ["ai-eligible"] }
  providers:
    issueTracker:
      type: linear # Swappable: linear | jira | github-issues
      config: { teamId: "ENG" }
    sourceControl:
      type: github # Swappable: github | gitlab | bitbucket
      config: { org: "reliable-genius" }
  stages:
    - name: implement
      agent: code-agent
      qualityGates: [test-coverage, security-scan]
    - name: review
      agent: reviewer-agent
      qualityGates: [human-approval]
```

---

## 3. Adapter and plugin architecture for tool-agnostic integration

The AI-SDLC Framework must support swapping tools (Linear for Jira, GitHub for GitLab) without changing pipeline definitions. Four plugin architectures offer battle-tested patterns.

**Terraform's provider model** is the most directly applicable. Each provider is a standalone binary communicating with Terraform Core over **gRPC using the Plugin Protocol** (versions 5 and 6). The provider interface contract requires implementing `Metadata()` (name), `Schema()` (configuration schema), `Configure()` (API client initialization), `Resources()` (list of managed types), and `DataSources()` (list of read-only types). Each resource then implements a **CRUD interface**: `Create()`, `Read()`, `Update()`, `Delete()`, plus optional `ImportState()` and `ValidateConfig()`. Providers are discovered from the Terraform Registry via `source = "namespace/type"` declarations. This separation means any provider implementing the interface contract is automatically compatible with all Terraform configurations.

**Kubernetes CSI (Container Storage Interface)** shows how to standardize plugin contracts via **protobuf-defined gRPC services**. CSI defines three services: Identity (health check, capability advertisement), Controller (provision, attach, snapshot), and Node (mount, unmount). Plugins run as separate processes communicating over Unix domain sockets. Sidecar containers (external-provisioner, external-attacher) bridge between Kubernetes API events and CSI gRPC calls. Swapping storage drivers is literally plug-and-play: change the container image, ensure it listens on the same socket.

**OpenTelemetry's Collector pipeline** provides the best model for **composable data processing**. The Collector defines four component types — Receivers, Processors, Exporters, and Connectors — each implementing a typed interface (`ConsumeTraces()`, `ConsumeMetrics()`, `ConsumeLogs()`). Components are declared in YAML config and wired into named pipelines. The `type/name` naming convention (`otlp/backend1`, `otlp/backend2`) enables multiple instances of the same component type. The **OpenTelemetry Collector Builder (ocb)** assembles custom distributions from a manifest listing desired components — directly applicable to building custom AI-SDLC distributions with specific adapter sets.

**Backstage's extension point system** offers the most relevant pattern for a **TypeScript-based reference implementation**. Plugins export extension points — typed interfaces with string IDs — that modules can implement. The additions-only design means extending functionality never requires modifying existing code. Backend plugins declare dependencies on core services (`logger`, `httpRouter`, `config`) via dependency injection, and modules register implementations via `env.registerInit()`.

For AI-SDLC, the recommended adapter architecture defines typed interface contracts for each integration category:

- **`IssueTracker`**: `listIssues()`, `getIssue()`, `createIssue()`, `updateIssue()`, `transitionIssue()`
- **`SourceControl`**: `createBranch()`, `createPR()`, `mergePR()`, `getFileContents()`, `listChangedFiles()`
- **`CIPipeline`**: `triggerBuild()`, `getBuildStatus()`, `getTestResults()`, `getCoverageReport()`
- **`CodeAnalysis`**: `runScan()`, `getFindings()`, `getSeveritySummary()`
- **`Messenger`**: `sendNotification()`, `createThread()`, `postUpdate()`

Each adapter implements one or more of these interfaces, is registered via a manifest (`metadata.yaml` with ownership, stability level, supported interface versions), and is discovered at runtime from a registry or local directory.

---

## 4. Quality gates and policy-as-code for AI-generated code

Enforcing quality standards on AI-generated code requires a policy framework that can express complex rules declaratively, enforce them at multiple points, and support graduated enforcement levels. Three production-grade frameworks provide the patterns.

**OPA/Gatekeeper** separates policy logic from policy instantiation through its **ConstraintTemplate/Constraint pattern**. A ConstraintTemplate defines reusable policy logic in Rego (a Datalog-inspired declarative query language) plus a parameter schema. Applying the template creates a CRD. A Constraint then instantiates that template with specific parameters and target selectors. Gatekeeper supports three enforcement actions: `deny` (block), `warn` (allow with warning), and `dryrun` (audit only). The `gator` CLI enables testing ConstraintTemplates with explicit pass/fail test cases before deployment. This template/instance separation is critical for AI-SDLC — a "require-test-coverage" template can be instantiated with different thresholds for different teams.

**Kyverno** proves that policies can be expressed in **pure YAML without a separate policy language**, making them accessible to teams without Rego expertise. Kyverno policies are Kubernetes resources (`ClusterPolicy`, `Policy`) with rule types for validation, mutation, generation, and image verification. Its anchor system (`+()` for add-if-not-present, `<()` for global conditions) provides pattern-matching directly in YAML. Kyverno's **mutation capability** is particularly relevant: rather than just rejecting non-compliant AI-generated code, policies can automatically enrich PRs with required metadata, labels, or default configurations.

**HashiCorp Sentinel** introduces **three enforcement levels** that map directly to AI-SDLC governance needs: **advisory** (policy can fail, warning logged), **soft-mandatory** (must pass unless an authorized user overrides), and **hard-mandatory** (must pass, no override possible). This three-tier model enables graduated rollout — start with advisory to understand impact, escalate to soft-mandatory for accountability, then hard-mandatory for critical gates. Sentinel's enforcement levels are **decoupled from policy logic** — the same policy code operates at different levels depending on context.

For AI-SDLC, these patterns combine into a quality gate specification:

```yaml
apiVersion: ai-sdlc.io/v1alpha1
kind: QualityGate
metadata:
  name: ai-code-standards
spec:
  scope:
    repositories: ["org/service-*"]
    authorTypes: ["ai-agent"]
  gates:
    - name: test-coverage
      enforcement: soft-mandatory # Sentinel-style levels
      rule:
        metric: line-coverage
        operator: ">="
        threshold: 80
    - name: security-scan
      enforcement: hard-mandatory
      rule:
        tool: semgrep
        maxSeverity: medium
        rulesets: ["owasp-top-10"]
    - name: human-review
      enforcement: hard-mandatory
      rule:
        minimumReviewers: 2
        aiAuthorRequiresExtraReviewer: true
    - name: documentation
      enforcement: advisory
      rule:
        changedFilesRequireDocUpdate: true
status:
  compliant: false
  conditions:
    - type: TestCoverage
      status: "False"
      reason: "3 PRs below threshold"
```

The enforcement pipeline mirrors **Kubernetes admission controllers**: requests flow through authentication → authorization → mutating gates (auto-enrich) → validation → enforcing gates (accept/reject). This means AI-generated PRs first get auto-enriched (add labels, assign reviewers, inject metadata), then validated against quality gates.

---

## 5. Declarative patterns for multi-agent orchestration

The AI-SDLC Framework must specify how multiple AI agents (coder, reviewer, tester, deployer, PM) coordinate. Five frameworks reveal a spectrum from fully imperative to fully declarative agent definition.

**CrewAI offers the most declarative agent specification** of any framework studied. Agents are defined in YAML with `role`, `goal`, `backstory`, and `tools` — the Role-Goal-Backstory pattern. Tasks are similarly YAML-defined with `description`, `expected_output`, `agent`, and `context` (dependency references). The Python layer only handles tool wiring and process orchestration. Variable interpolation (`{topic}`) enables template reuse. This pattern directly translates to SDLC agent roles.

**Google's A2A Protocol** provides the best **inter-service agent discovery** pattern. Each agent publishes an Agent Card at `/.well-known/agent.json` declaring its name, capabilities, skills (with ID, description, tags, examples), version, and security schemes. The task lifecycle (`submitted → working → input-required → completed/failed`) provides a clear state machine for tracking agent work. A2A uses JSON-RPC 2.0 for communication, making it transport-agnostic. For AI-SDLC, agents running as separate services (a code generation service, a review service) should publish A2A-compatible Agent Cards.

**LangGraph** provides the best model for **workflow control flow**. Agent workflows are directed graphs with nodes (processing steps), edges (fixed transitions), and conditional edges (routing based on state). The `Send()` API dynamically spawns parallel workers. Checkpointing enables state persistence, time-travel debugging, and human-in-the-loop interrupts. LangGraph's graph topology maps naturally to SDLC workflows: implement → [review, test] (parallel) → deploy, with conditional loops back for revision.

**AutoGen/Microsoft Agent Framework** demonstrates **handoff protocols** most clearly. The `HandoffMessage` type explicitly signals delegation from one agent to another. The Swarm pattern lets agents declare `handoffs=[...]` — the LLM decides when to invoke them. Termination conditions (`HandoffTermination`, `MaxMessageTermination`) prevent infinite loops. The v0.4+ Agent Framework unifies five orchestration patterns: sequential, concurrent, group chat, handoff, and magentic (dynamic task ledger).

**OpenAI's Agents SDK** shows how to keep things **minimal and composable**. Three primitives — Agent (instructions + tools + handoffs), Handoffs (tool-call-based delegation), and Guardrails (parallel input/output validation) — compose into complex behaviors. Handoffs appear as tools to the LLM, making delegation a natural language decision. The "agents as tools" pattern (one agent uses another as a tool, getting results back rather than handing off control) enables hierarchical orchestration.

The synthesized declarative specification for SDLC agents combines CrewAI's YAML definitions, A2A's discovery model, and LangGraph's graph topology:

```yaml
apiVersion: ai-sdlc.io/v1alpha1
kind: AgentRole
metadata:
  name: code-agent
spec:
  role: "Senior Software Engineer"
  goal: "Implement features from specifications with clean, tested code"
  tools: [code_editor, terminal, git_client, test_runner]
  constraints:
    maxFilesPerChange: 20
    requireTests: true
    allowedLanguages: [python, typescript]
  handoffs:
    - target: reviewer-agent
      trigger: "implementation_complete"
    - target: tester-agent
      trigger: "implementation_complete"
  skills:
    - id: implement_feature
      description: "Implements features from ticket specifications"
      tags: [coding, implementation]
```

---

## 6. Progressive autonomy with measurable promotion criteria

The most critical governance challenge for AI coding agents is determining how much autonomy each agent should have — and how to safely increase it over time. Three frameworks provide the theoretical and practical foundations.

**The Cloud Security Alliance Agentic Trust Framework (ATF)**, published February 2026, applies Zero Trust principles to AI agents. Its core axiom: **"No AI agent should be trusted by default. Trust must be earned through demonstrated behavior and continuously verified through monitoring."** ATF defines four trust levels with increasing autonomy — **Intern** (read-only, minimum 2 weeks), **Junior** (recommend with human approval, minimum 4 weeks, requires >95% recommendation acceptance), **Senior** (execute within guardrails with real-time notification, minimum 8 weeks with zero critical incidents), and **Principal** (autonomous within domain, continuous validation, automatic demotion on incidents). Every promotion requires passing five gates: demonstrated accuracy, security audit, measurable positive impact, clean operational history, and explicit stakeholder approval.

**The Knight-Columbia autonomy levels** (Feng, McDonald & Zhang, July 2025) frame autonomy as a **deliberate design decision separate from capability** — a highly capable agent can intentionally operate at low autonomy. Five levels define the user's relationship to the agent: **L1 User as Operator** (copilot, agent suggests, user decides), **L2 User as Collaborator** (both plan and execute, user retains control), **L3 User as Consultant** (agent takes initiative, user provides guidance at inflection points), **L4 User as Approver** (agent presents completed work for approval), **L5 User as Observer** (fully autonomous, user monitors via logs). The paper proposes **autonomy certificates** — third-party attestations of an agent's allowed autonomy level.

**The Principle of Least Autonomy** extends the cybersecurity Principle of Least Privilege: agents should operate at the **lowest autonomy level sufficient for their function**. AWS's Well-Architected Framework (GENSEC05-BP01) implements this through permission boundaries on model requests, separate IAM roles per agent function, and user confirmation requirements. Singapore's IMDA governance framework recommends "limiting the agent's impact on the external environment by enforcing least-privilege" and "gradually rolling out agents with continuous monitoring."

The proposed declarative autonomy schema synthesizes all three frameworks. Each autonomy level specifies permissions (read/write/execute scopes), guardrails (blocked paths, transaction limits, max changes), approval requirements, and monitoring intensity. Promotion criteria are quantitative: a "2-to-3" promotion requires **≥90% PR approval rate** over the last 50 PRs, **≤2% rollback rate**, **≤1.5 average review iterations**, zero critical incidents, maintained code coverage ≥80%, engineering manager approval, and a security review. Automatic demotion triggers fire on critical security incidents (demote to level 0), rollback rates exceeding 5% (demote one level), or unauthorized access attempts (demote to level 0 with 4-week cooldown).

This is the most novel and differentiated aspect of the AI-SDLC Framework — no existing framework combines declarative autonomy specification, quantitative promotion criteria, and automatic demotion triggers into a single configuration-as-code system.

---

## 7. Repository structure for spec plus reference implementation

Every major project studied separates specification from implementation while maintaining tight traceability between them. The patterns vary from GraphQL's paired spec/reference-implementation repos to JSON Schema's spec-plus-conformance-test-only approach.

**GraphQL's paired model** is the most instructive. The `graphql-spec` repo contains the formal specification while `graphql-js` serves as the canonical reference implementation. The source directory structure of graphql-js **mirrors spec sections directly** — `src/language/` corresponds to §2 Language, `src/type/` to §3 Type System, `src/validation/` to §5 Validation, `src/execution/` to §6 Execution. Spec proposals (RFCs) require a proof-of-concept PR to graphql-js before acceptance. This structural mirroring makes it trivial to trace any spec requirement to its implementation.

**JSON Schema's conformance-test-only approach** offers an important alternative. The JSON Schema organization explicitly chose NOT to maintain a reference implementation, instead investing in a **language-agnostic conformance test suite** — pure JSON test data organized by spec version (`tests/draft2020-12/`, `tests/draft2019-09/`). Each test file contains a schema, test instances, and expected valid/invalid results. Implementations consume this test suite as a git submodule. This is the gold standard for ensuring interoperability across implementations.

**OpenTelemetry's Collector architecture** demonstrates the most sophisticated **plugin component model**. The core Collector repo is a Go monorepo where each component directory is its own Go module with independent `go.mod`. Every component has a `metadata.yaml` declaring ownership, stability level, and supported signals — this drives automated CODEOWNERS generation and distribution assembly. The **Collector Builder (ocb)** tool assembles custom distributions from a manifest listing desired components. The `opentelemetry-collector-contrib` repo hosts 90+ community-contributed components following the same structure.

**Kubernetes' staging directory pattern** solves the mono-vs-multi-repo dilemma. Code lives in `staging/src/k8s.io/` within the monorepo, but a **publishing-bot** automatically syncs merged commits to downstream repos (`kubernetes/client-go`, `kubernetes/api`). This gives the development efficiency of a monorepo with the consumption convenience of separate packages.

The recommended repository structure for AI-SDLC combines these patterns into a multi-repo organization:

- **`ai-sdlc/spec`** — Formal specification (Markdown), SDK requirements doc, RFC/proposal process, glossary
- **`ai-sdlc/reference`** — Reference implementation with source structure mirroring spec sections, built-in plugins, and `metadata.yaml` per component
- **`ai-sdlc/conformance`** — Language-agnostic test suite (JSON/YAML test data organized by spec version), consumable as git submodule
- **`ai-sdlc/contrib`** — Community adapter/plugin repository following OTel-contrib patterns, with builder manifest for custom distributions
- **`ai-sdlc/sdk-{language}`** — Language-specific SDKs, independently versioned
- **`ai-sdlc/docs`** — Documentation website with auto-generated API reference
- **`ai-sdlc/community`** — Governance, charter, SIG definitions

Spec changes should require an RFC → working group review → reference implementation proof-of-concept → formal approval pipeline. The spec versions independently from implementations (`v1.0`, `v1.1`) while implementations use SemVer and document which spec version they support.

---

## 8. The reconciliation loop as SDLC governance engine

The Kubernetes controller pattern — **desired state → observe → diff → act → loop** — is the architectural heart of the AI-SDLC Framework. This pattern transforms SDLC governance from point-in-time checks into continuous convergence toward declared policy.

The controller-runtime architecture consists of a **Manager** (shared clients, caches, leader election), **Informers** (List+Watch on resource types, maintaining a local cache via Reflector → DeltaFIFO → Indexer), a **rate-limited WorkQueue** (deduplicating, with exponential backoff on failures), and the **Reconciler** (user logic implementing the four-step loop). Key properties make this robust: the pattern is **level-triggered, not edge-triggered** (decisions based on current state difference, not specific events), **idempotent** (same reconciliation produces the same result regardless of how many times it runs), and **eventually consistent** (converges over time through repeated reconciliation).

The controller's `Reconcile()` function returns one of four results: success (done until next event), error (requeue with exponential backoff), explicit requeue (immediate retry), or delayed requeue (check again in N minutes). **Predicates** filter events to avoid unnecessary reconciliation — `GenerationChangedPredicate` ignores status-only updates, preventing infinite loops where a controller's own status updates trigger re-reconciliation.

For AI-SDLC, this translates to a concrete governance loop:

1. **Desired state**: Declared in `SDLCPolicy` resources — test coverage ≥80%, PRs require 2 reviewers, security scans must pass, AI-authored code requires extra review
2. **Observe**: Informers watch GitHub/GitLab webhooks (PR events, CI results), coverage APIs (SonarQube, Codecov), security scanners (Snyk, Semgrep), and deployment platforms
3. **Diff**: Compare actual metrics against policy thresholds per PR and per repository — coverage 72% vs. required 80% is a violation; 0 critical findings is a pass
4. **Act** (by enforcement level): hard-mandatory violations block the merge via status check API; soft-mandatory violations block but allow authorized override; advisory violations post PR comments and update dashboards
5. **Remediate** (auto-heal): Trigger the AI code agent to generate missing tests, auto-assign required reviewers, create tickets for compliance gaps
6. **Update status**: Write compliance state to the `SDLCPolicy` resource's `status.conditions` array
7. **Requeue**: Schedule next reconciliation (event-driven for real-time response + periodic for catching drift)

ArgoCD and Flux CD already prove this pattern works for deployment governance (Git → cluster state reconciliation). **Crossplane** extends it to managing external cloud resources via Kubernetes controllers, proving reconciliation works beyond Kubernetes-native objects. The AI-SDLC Framework extends this pattern one layer further — governing the development process itself rather than just infrastructure.

---

## Architectural synthesis for the PRD

The eight research dimensions converge on a coherent architecture that the PRD should specify. The framework has four layers that map cleanly to OTel's separation pattern:

The **Specification Layer** defines resource types using Kubernetes-style `apiVersion/kind/metadata/spec/status` structures with OpenAPI v3 schema validation. Core resource types include `Pipeline`, `AgentRole`, `QualityGate`, `AutonomyPolicy`, and `AdapterBinding`. The spec uses RFC 2119 normative language, versions through `v1alpha1 → v1beta1 → v1` maturity stages, and evolves through a formal RFC process.

The **Adapter Layer** implements Terraform-style provider contracts for each integration category (issue trackers, source control, CI/CD, code analysis, messaging). Adapters are standalone modules with `metadata.yaml` (ownership, stability, supported interfaces), discovered from a registry or local directory, and configured declaratively in pipeline specs. Swapping Linear for Jira means changing one `type:` field.

The **Policy Layer** combines OPA/Gatekeeper's template/instance separation with Sentinel's three-tier enforcement and CSA ATF's progressive autonomy levels. Quality gates are declared as resources with enforcement levels, evaluated continuously by the reconciliation engine, and graduated from advisory through soft-mandatory to hard-mandatory as policies mature.

The **Runtime Layer** implements the Kubernetes controller pattern — a reconciliation loop that continuously observes development activity, diffs against declared policies, and acts to close gaps. Agent orchestration follows CrewAI's declarative role/task model with LangGraph-style graph topology for workflow control flow and A2A-compatible Agent Cards for inter-service discovery.

The key architectural decisions the PRD should codify: spec and implementation in separate repositories with structural mirroring; a language-agnostic conformance test suite (JSON Schema pattern); component-level stability tracking via `metadata.yaml` (OTel pattern); a builder tool for assembling custom distributions from selected adapters; and a formal RFC → proof-of-concept → approval pipeline for spec changes. The target audience — the Reliable Genius team — should begin with the spec and conformance tests, then build the reference implementation in TypeScript or Go, starting with GitHub and Linear adapters as the first provider implementations to validate the adapter interface contracts.
