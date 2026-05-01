# Design System Adapters

Adapter interface contracts and reference implementations introduced by
[RFC-0006](../../spec/rfcs/RFC-0006-design-system-governance-v5-final.md). This
page covers the three adapter interfaces a design system integration needs
to satisfy and the project-owned reference implementations of each.

For end-to-end usage of these adapters under a `DesignSystemBinding` resource,
see the [design system tutorial](../tutorials/design-system-getting-started.md).
For day-to-day operation, see the
[design system operator runbook](../operations/design-system-operator-runbook.md).

## Adapter map

| Interface                  | Purpose                                                              | Project-owned reference impls                |
| -------------------------- | -------------------------------------------------------------------- | -------------------------------------------- |
| `DesignTokenProvider`      | Read, diff, and push design tokens in W3C DTCG format                | `tokens-studio`, `figma-variables` (co-first) |
| `ComponentCatalog`         | Expose the Storybook MCP component manifest to the agent             | `storybook-mcp`                              |
| `VisualRegressionRunner`   | Capture and diff visual baselines, return structured failure context | `playwright-visual`                          |
| `UsabilitySimulationRunner`| Browser-driven task-completion testing for design review (Addendum A)| Unassigned in v1alpha1                       |

The `co-first` pairing of `tokens-studio` + `figma-variables` is intentional
(RFC-0006 §9.5): two real implementations validate the interface shape before
the spec surface locks. If you are building a third token provider, those two
are the canonical examples.

## `DesignTokenProvider`

```typescript
interface DesignTokenProvider {
  /** Fetch current tokens in W3C DTCG format. */
  getTokens(options?: {
    categories?: string[];
    scope?: 'primitive' | 'semantic' | 'component';
    mode?: string;
  }): Promise<DesignTokenSet>;

  /** Diff two token snapshots. */
  diffTokens(baseline: DesignTokenSet, current: DesignTokenSet): Promise<TokenDiff>;

  /** Identify deleted tokens between two snapshots. */
  detectDeletions(
    baseline: DesignTokenSet,
    current: DesignTokenSet,
  ): Promise<TokenDeletion[]>;

  /** Push token changes back to the design tool (bidirectional sync). */
  pushTokens(
    tokens: DesignTokenSet,
    options?: { branch?: string; message?: string },
  ): Promise<PushResult>;

  /** Subscribe to token-change events. */
  onTokensChanged(callback: (diff: TokenDiff) => void): Unsubscribe;

  /** Subscribe to token-deletion events. */
  onTokensDeleted(callback: (deletions: TokenDeletion[]) => void): Unsubscribe;

  /**
   * Determine whether a schema-version change is breaking. Used by the
   * orchestrator to enforce `tokens.versionPolicy` (RFC-0006 §5.5).
   * Breaking = any token removal, rename, type change, or alias restructuring.
   * A value change (e.g., a color hex update) is non-breaking.
   */
  detectBreakingChange(
    fromVersion: string,
    toVersion: string,
  ): Promise<{ isBreaking: boolean; breakingChanges: string[] }>;

  /** Report the current token-schema version. */
  getSchemaVersion(): Promise<string>;
}
```

### Notes for adapter authors

- `getTokens()` MUST return W3C DTCG-compliant output when
  `DesignSystemBinding.spec.tokens.format` is `w3c-dtcg`. This is not optional —
  the orchestrator validates the returned set against the DTCG schema before
  any downstream gate runs.
- `detectBreakingChange()` is the linchpin of the version-policy enforcement
  in RFC-0006 §5.5. Returning `false` for an actually-breaking change is a
  correctness bug that will silently apply token removals to consumer pipelines.
  Implementations SHOULD include a regression test per breaking-change
  category (removal, rename, type change, alias restructuring).
- `pushTokens()` is only invoked when `sync.direction` is `bidirectional`.
  Adapters MAY no-op `pushTokens()` if their tool does not support inbound
  writes; the orchestrator will reject any binding that requests
  `bidirectional` sync against a no-op adapter at admission time.

### Reference implementations

| Adapter            | Source                                | Status   | Scope                                                                                          |
| ------------------ | ------------------------------------- | -------- | ---------------------------------------------------------------------------------------------- |
| `tokens-studio`    | `@ai-sdlc/adapters-tokens-studio`     | v1alpha1 | Reads/writes `tokens.json` files in a Git repo via the Tokens Studio plugin schema             |
| `figma-variables`  | `@ai-sdlc/adapters-figma-variables`   | v1alpha1 | Native Figma Variables API; **token extraction only** per RFC-0006 §9.5 boundary with RFC-0007 |
| `style-dictionary` | community                             | optional | Wraps Amazon's Style Dictionary token transformer                                              |
| `penpot-tokens`    | community                             | optional | Open-source Penpot integration                                                                 |

The Figma adapter does NOT cover Figma Make, design file reading, or layout
extraction. Those workflows belong to RFC-0007 and MUST NOT overlap with the
RFC-0006 token-extraction scope.

## `ComponentCatalog`

```typescript
interface ComponentCatalog {
  /** Get the component manifest in Storybook MCP format. */
  getManifest(): Promise<ComponentManifest>;

  /** Resolve a component by name, category, or capability. */
  resolveComponent(query: {
    name?: string;
    category?: string;
    capabilities?: string[];
  }): Promise<ComponentMatch[]>;

  /**
   * Check whether the catalog can satisfy a requirement by composing
   * existing primitives (the `compose-or-justify` policy from RFC-0006 §7.1).
   */
  canCompose(requirement: ComponentRequirement): Promise<CompositionPlan>;

  /** Get all stories for a named component. */
  getStories(componentName: string): Promise<Story[]>;

  /** Validate generated code against the catalog's manifest. */
  validateAgainstCatalog(
    code: string,
    options?: { strict?: boolean },
  ): Promise<ValidationResult>;
}
```

### Notes for adapter authors

- `getManifest()` returns the full Storybook MCP component manifest. The
  manifest is cached by the orchestrator at the interval declared in
  `catalog.discovery.refreshInterval`; the adapter does not need to debounce.
- `canCompose()` is what enables RFC-0006 §7.1's `componentCreationPolicy:
  compose-or-justify`. A `CompositionPlan` with `feasible: true` lets the
  agent reuse existing primitives; `feasible: false` triggers the new-component
  path and the design review gate.
- `validateAgainstCatalog()` is invoked by the `storyCompleteness` and
  `tokenCompliance` gates (RFC-0006 §8.1, §8.3). The adapter should not throw
  on validation failure — return a `ValidationResult` with `passed: false` and
  the structured failures.

### Reference implementation

The `storybook-mcp` adapter is the project-owned reference. It speaks to the
Storybook MCP endpoint declared in
`DesignSystemBinding.spec.catalog.discovery.mcpEndpoint` and authenticates
with bearer tokens scoped to `manifest:read` / `stories:read` /
`tests:execute` (RFC-0006 §16.3). Bearer tokens are JIT-rotated by the
orchestrator on a 24-hour TTL by default.

## `VisualRegressionRunner`

```typescript
interface VisualRegressionRunner {
  /** Capture baselines for all stories. */
  captureBaselines(stories: Story[]): Promise<BaselineSet>;

  /** Compare current state against baselines. */
  compareSnapshots(options: {
    stories: Story[];
    baselines: BaselineSet;
    viewports: number[];
    diffThreshold: number;
  }): Promise<VisualDiffResult>;

  /**
   * Provide structured failure context for agent self-correction. MUST conform
   * to RFC-0006 §8.4's `VisualRegressionFailure` schema — adapters MUST NOT
   * return a bare pass/fail or an unstructured diff image URL.
   */
  getFailurePayload(diffResult: VisualDiffResult): Promise<VisualRegressionFailure[]>;

  /**
   * Approve a visual change (update the baseline). The approver MUST be a
   * principal in the binding's `designAuthority` scope.
   */
  approveChange(diffId: string, approver: string): Promise<void>;
}
```

### `VisualRegressionFailure` payload

This is the structured-failure schema the autonomous correction loop
(RFC-0006 §8.4) consumes. An adapter that returns less than this will cause
the loop to thrash through retries without converging.

```typescript
interface VisualRegressionFailure {
  componentName: string;
  storyName: string;
  viewport: number;
  diffPercentage: number;
  changedRegions: Array<{
    x: number;
    y: number;
    width: number;
    height: number;
    expectedTokens?: string[]; // Token references the region SHOULD have used
    actualValues?: string[];   // Computed values found instead
  }>;
  diffImageUrl?: string;       // For audit, not primary agent input
  affectedTokens: string[];
  baselineUrl: string;
  currentUrl: string;
}
```

### Reference implementation

The `playwright-visual` adapter wraps Playwright's screenshot diffing. It is
self-hosted (no external service dependency), supports cross-browser capture,
and translates Playwright's diff output into the `VisualRegressionFailure`
schema above. Community-maintained alternatives include `chromatic` and
`percy` for Storybook-native and BrowserStack-hosted workflows respectively.

## `UsabilitySimulationRunner` (Addendum A)

The `UsabilitySimulationRunner` interface (RFC-0006 Addendum A §A.5.2)
governs browser-driven task-completion testing — running an AI agent through
a real browser against a deployed component to measure whether the design is
actually usable. It is the most complex adapter in RFC-0006 and is **not
assigned to a project-owned implementation in v1alpha1**. Teams that need
usability simulation before a community adapter exists may implement the
interface directly. Until an implementation lands, the design review gate's
Addendum A Layer 3 evaluation is informational only.

## Resource shapes

### `DesignSystemBinding`

The full schema is normative in RFC-0006 §5. The
[design system tutorial](../tutorials/design-system-getting-started.md) covers
the minimal viable shape; the
[design system operator runbook](../operations/design-system-operator-runbook.md)
covers the operating concerns of each block.

### Quality gate rule types

Three new rule types are added to the `QualityGate` resource by RFC-0006 §8:

- `designTokenCompliance` — checks for hardcoded values disallowed by
  `compliance.disallowHardcoded`, plus optional coverage thresholds.
- `visualRegression` — runs the `VisualRegressionRunner` against the bound
  baselines.
- `storyCompleteness` — verifies that components have the required Storybook
  stories (default, state, accessibility, viewport coverage).

A fourth rule type, `designReview`, is introduced by RFC-0006 §8.5 as a
human-judgment gate rather than a programmatic rule — it is not implemented by
an adapter but by the design review request flow.

## See also

- [RFC-0006 Design System Governance Pipeline](../../spec/rfcs/RFC-0006-design-system-governance-v5-final.md) —
  full normative spec.
- [Tutorial: Getting Started with Design System Governance](../tutorials/design-system-getting-started.md).
- [Design System Operator Runbook](../operations/design-system-operator-runbook.md).
- [Adapters API reference](adapters.md) — general adapter framework
  (`AdapterBinding` resource, registry, and lifecycle).
- [Design Intent & Soul Alignment](design-intent.md) — RFC-0008's PPA Triad
  scoring layer that consumes `DesignSystemBinding` outputs.
