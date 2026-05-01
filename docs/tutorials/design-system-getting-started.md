# Tutorial: Getting Started with Design System Governance

This tutorial shows a frontend team how to bring an existing design system under
AI-SDLC governance using the `DesignSystemBinding` resource introduced by
[RFC-0006](../../spec/rfcs/RFC-0006-design-system-governance-v5-final.md). By
the end you will have:

1. Declared your design system as a governed AI-SDLC resource.
2. Wired three quality gates (token compliance, visual regression, design
   review) into a pipeline that runs whenever a frontend issue is assigned.
3. Worked through three realistic scenarios — an autonomous token re-theme, a
   new-component request that the agent must compose-or-justify, and a token
   deletion that is intentionally blocked for human review.

This is a consumer guide. The full normative spec, including the reconciliation
state machine, addendum on AI-driven design review, and the PPA Triad
integration, lives in the RFC; here we cover only what a typical frontend team
needs to author and operate one binding.

## Prerequisites

- Node.js 18+, pnpm, and a working AI-SDLC workspace (Tutorial 1 covers
  bootstrap).
- A Storybook instance exposing the [Storybook MCP](https://storybook.js.org/docs/sharing/storybook-mcp)
  endpoint over HTTPS — the project-owned `ComponentCatalog` adapter
  (RFC-0006 §9.5) talks to this endpoint.
- A token source. The two co-first reference adapters (RFC-0006 §9.5) are
  Tokens Studio (a JSON file in a Git repo) and Figma Variables (Figma's
  native API). Either will do; this tutorial uses Tokens Studio because it has
  no Figma authentication step.
- A `VisualRegressionRunner` — Playwright is the project-owned reference
  implementation and ships zero-config.
- A design lead (named principal). RFC-0006 §5.3 makes the `designAuthority`
  block mandatory, and several gates literally cannot complete without a human
  in that role.

## Step 1: Declare a `DesignSystemBinding`

Create `bindings/design-system.yaml` in your repository. The minimum viable
binding declares the four required blocks: stewardship, design tool authority,
tokens, and the catalog. Everything else inherits sensible defaults.

```yaml
apiVersion: ai-sdlc.io/v1alpha1
kind: DesignSystemBinding
metadata:
  name: acme-design-system
  namespace: team-frontend
spec:
  stewardship:
    designAuthority:
      principals: ['design-lead']
      scope: [conflictResolution, visualBaselines, tokenSchema]
    engineeringAuthority:
      principals: ['frontend-lead']
      scope: [catalog, visualRegression.config]

  designToolAuthority: collaborative # exploration | specification | collaborative

  tokens:
    provider: tokens-studio
    format: w3c-dtcg
    versionPolicy: minor # block major (breaking) syncs by default
    source:
      repository: 'acme-org/design-tokens'
      branch: main
      path: 'tokens/'
    sync:
      direction: bidirectional
      schedule: 'PT15M' # ISO 8601 duration; cron is intentionally not supported

  catalog:
    provider: storybook-mcp
    source:
      storybookUrl: 'https://storybook.acme.dev'
      manifestPath: '.storybook/component-manifest.json'
    discovery:
      mcpEndpoint: 'https://storybook.acme.dev/mcp'

  compliance:
    coverage:
      minimum: 85
      target: 95
```

A few non-obvious things worth knowing now so you don't fight them later:

- `designToolAuthority` is **the most important field in the binding**. RFC-0006
  §4.2 P2 explicitly leaves the choice to your organization — there is no
  framework default beyond the placeholder `collaborative`. Pick it with
  design and engineering leads in the same room. Picking it wrong creates the
  exact authority ambiguity the resource was designed to surface.
- `versionPolicy` defaults to nothing — RFC-0006 §5.5 makes it required so the
  decision is visible. `minor` is the right starting point for most products.
  Switch to `exact` (with `pinnedVersion`) before a high-stakes release; switch
  to `latest` only in a design-system staging environment.
- `sync.direction: bidirectional` is the long-term goal but you should start
  with `direction: pull` until your Phase 2 baselines are stable
  (RFC-0006 §15). Bidirectional sync sends agent token edits back to Figma
  and is hard to reason about until you trust the loop.

Apply the binding. The orchestrator validates the schema and registers
`acme-design-system` as a resource that pipelines and quality gates can
reference by name.

```bash
pnpm ai-sdlc apply bindings/design-system.yaml
```

## Step 2: Wire Three Quality Gates

Quality gates are how the binding actually shapes agent behavior. Add this
file as `bindings/quality-gates.yaml`:

```yaml
apiVersion: ai-sdlc.io/v1alpha1
kind: QualityGate
metadata:
  name: token-compliance
  namespace: team-frontend
spec:
  scope:
    filePatterns: ['src/components/**/*.{tsx,css,scss}']
  gates:
    - name: no-hardcoded-colors
      enforcement: hard-mandatory
      rule:
        type: designTokenCompliance
        designSystem: acme-design-system
        category: color
        maxViolations: 0
    - name: visual-diff
      enforcement: soft-mandatory
      rule:
        type: visualRegression
        designSystem: acme-design-system
        config:
          diffThreshold: 0.01
          requireBaseline: true
        override:
          approvers: ['design-lead']
    - name: story-completeness
      enforcement: hard-mandatory
      rule:
        type: storyCompleteness
        config:
          requireDefaultStory: true
          requireStateStories: true
          minStories: 3
```

These three gate types are introduced in RFC-0006 §8. The pattern matters:
**advisory → soft-mandatory → hard-mandatory** (RFC-0006 §15) is the migration
path. Start every gate as `advisory` for the first two weeks while the team
gets used to the failure messages, then graduate.

## Step 3: Reference the Binding from a Pipeline

Add a `design-system` stage to your frontend pipeline. The Pipeline resource
shape is covered in Tutorial 1; here we add the binding-aware bits:

```yaml
spec:
  providers:
    designSystem:
      type: design-system-binding
      config: { ref: 'acme-design-system' }

  stages:
    - name: design-context
      type: design-system
      actions: [resolve-tokens, resolve-catalog, assess-reusability]
    - name: implement
      agent: frontend-agent
      constraints:
        requireStory: true
        requireTokenUsage: true
        preferComposition: true
    - name: technical-review
      qualityGates: [token-compliance]
    - name: design-review
      type: design-review
      approval:
        reviewers: ['design-lead']
        timeout: PT48H
        onTimeout: pause
```

That is the whole governed loop: context resolution → agent execution →
technical gates → human design review → merge.

## Worked Example 1: A Token Re-Theme (Autonomous)

Scenario: the design lead changes `color.primary` from `#3B82F6` to `#2563EB`
in Tokens Studio. This matches the worked example in RFC-0006 §14.

What happens, end to end:

1. The Tokens Studio adapter detects the change and fires
   `design-token.changed`.
2. The orchestrator queries the Storybook MCP catalog. Twenty-three components
   reference `color.primary` directly or through semantic tokens like
   `color.surface.brand`.
3. The cascade exceeds the binding's default `cascadeThreshold` of `5`, so
   the pipeline pauses at a **design impact review** stage. The design lead
   sees the impact list, excludes two intentional exceptions (`AlertBanner`,
   `LegacyHeader`), and approves the cascade for the remaining 21.
4. The frontend agent rebuilds the 21 stories. No code changes are needed
   because the components reference tokens, not raw values.
5. Token compliance gate: PASS. Visual regression: 21 expected diffs.
6. Design quality review fires (visual diffs trigger the gate). The design
   lead approves once at all viewports.
7. The orchestrator opens a single PR with the token bump, the rebuilt
   stories, and the design approval audit trail.

The whole cycle runs without an engineer touching anything. That is the
behavior RFC-0006 was written to make routine.

## Worked Example 2: A New-Component Request (Compose or Justify)

Scenario: a product issue says "add a `MetricCard` to the dashboard".

The agent receives the issue and the catalog manifest. RFC-0006 §7.1's
`componentCreationPolicy: compose-or-justify` means the agent's first job is
to call `ComponentCatalog.canCompose()` against the manifest and ask: can I
build this from existing primitives?

If yes (e.g., `MetricCard = Card + Heading + Number + Trend`), the agent
generates a composition, writes the story, and ships. The new-component
trigger does **not** fire because no new catalog entry is being created.

If no — say the design language has no `Trend` primitive — the agent's
output must include a written justification in the PR body. The
`new-component` trigger fires automatically and the design review gate
becomes blocking. The design lead either approves the new primitive (and it
joins the catalog) or asks the agent to retry with a different composition.

This is the gate that prevents the failure mode RFC-0006 §2.2 calls out:
"agents create new components rather than reusing existing ones from the
catalog".

## Worked Example 3: A Blocked Token Deletion

Scenario: the agent's correction loop wants to remove `color.warning.legacy`
because no component has used it for six months.

RFC-0006 §6.3 and §12.3 are explicit: token deletion is **always** a design
decision, never an agent decision. The `design-token.deleted` event is
hard-blocked at the orchestrator level. The agent's PR includes the proposed
deletion as a `tokenDeletionProposal` payload; the design lead reviews it,
checks for any out-of-tree consumers (other repos, marketing surfaces,
emailed templates), and either approves or vetoes.

If you find yourself wanting the agent to auto-delete tokens to clean up,
you have misunderstood the RFC. Don't. The blocked path is intentional —
it is the cheapest place to catch a deletion that a downstream surface still
depends on.

## Where to go next

- **Operator concerns** (rotating MCP tokens, calibrating the design review
  SLA, handling token-conflict timeouts): see
  [`docs/operations/design-system-operator-runbook.md`](../operations/design-system-operator-runbook.md).
- **Adapter authoring** (writing your own `DesignTokenProvider` for a tool
  that isn't Tokens Studio or Figma Variables): see
  [`docs/operations/adapter-authoring.md`](../operations/adapter-authoring.md)
  and RFC-0006 §9.
- **The full RFC**: [RFC-0006](../../spec/rfcs/RFC-0006-design-system-governance-v5-final.md).
  Sections 5 (`DesignSystemBinding`), 8 (quality gates), and 14 (worked
  example) are the most useful day-one references.
