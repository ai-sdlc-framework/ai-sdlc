# AI-SDLC Vision — The Decision Engine

> **What this framework is for, in one sentence.**
> AI-SDLC turns software development into a series of well-framed decisions that the framework executes deterministically.

This document is the framework's organizing thesis — the design philosophy that grounds every RFC, every CLI, every gate, every operator surface. It complements [`CHARTER.md`](CHARTER.md) (which covers project governance, IP policy, and CNCF alignment) by answering a different question: *not "what is this project, legally?" but "what is this framework, designed for?"*

When an RFC, a feature, or a CLI doesn't trace back to one of the principles below, that's a signal we've drifted.

## 1. The Decision Engine

Software development is a **series of decisions**. The framework's job is to formalize that series so quality is maintained at every step.

The flow:

1. **An idea surfaces** — from a user, a stakeholder, an emergent finding, a market signal.
2. **The idea becomes a well-defined issue** — captured with explicit open questions.
3. **The operator iterates on the open questions** — together with the framework's AI assistance — until every one is resolved.
4. **The resolved issue passes the Definition of Ready (DoR) gate** — see [RFC-0011](spec/rfcs/RFC-0011-definition-of-ready-gate.md).
5. **The autonomous pipeline orchestrator executes the contract** — see [RFC-0015](spec/rfcs/RFC-0015-autonomous-pipeline-orchestrator.md).
6. **The framework merges the work** — gated by quality checks (review attestations, CI, etc.).
7. **The work ships to production**, and the operator monitors it through the operator surface — see [RFC-0023](spec/rfcs/RFC-0023-operator-tui-pipeline-monitoring.md).

The aspirational target is that **a well-frontloaded issue passes through this pipeline without intervention 95% of the time**. The other 5% surface as decisions the operator missed — those become inputs to refining the DoR gate, the open-question prompts, and the framework itself.

## 2. The cost-asymmetry argument

The Decision Engine's leverage move is **frontloading the operator's thinking**. The economic argument:

- **Operator decisions made upfront are cheap and (mostly) correct.** The operator has full context, time to think, and access to stakeholders.
- **AI decisions made under uncertainty mid-execution are expensive and often wrong.** The AI lacks context, has limited reasoning depth per decision, and amplifies errors downstream.

Every "open question" the operator resolves before dispatch is a decision the AI doesn't have to make under pressure (and likely make wrong). This cost asymmetry is the entire game.

The framework's value-add is therefore **not** "AI writes code." It's "AI executes well-specified contracts deterministically." Those are very different products with very different reliability profiles.

## 3. The operator's role: decision steward

In a Decision Engine framework, the operator's primary role becomes:

- **Decision steward** — frame open questions, resolve them, sign off on resolutions
- **Pipeline monitor** — watch for unblocked work, surface stalls, intervene on blockers
- **Quality steward** — set policy (review calibration, gate strictness, compliance posture), not police every commit

The operator is **not**:

- A code reviewer (the framework runs review agents in [RFC-0010 §11](spec/rfcs/RFC-0010-parallel-execution-worktree-pooling.md))
- An implementer (the framework runs developer subagents)
- A bug triager (the framework's emergent-issue capture should make most triage automatic — see RFC-0024 once drafted)

This role shift is the framework's gift to the operator: their time goes to the highest-leverage activity (decisions), not the lowest (typing).

## 4. The framework's quality contract

For the Decision Engine to work, the framework must hold up its end of the contract:

- **Deterministic execution** — given the same well-framed contract, the framework produces the same quality of output. No "AI mood" variability.
- **Faithful gating** — if the framework's gates pass, the operator can trust the work. If they don't pass, the framework explains why in actionable terms.
- **Honest failure modes** — when the framework cannot complete a contract, it surfaces that clearly with quarantined work preserved (no silent abandonment).
- **Self-improvement loop** — every framework failure mode that costs operator time should produce a framework bug task that closes that loop.

This is why "framework quality monitoring" is a first-class concern (see RFC-0025 once drafted) distinct from operator decision quality. Conflating the two — blaming the operator for framework bugs, or the framework for operator under-specification — destroys trust in the Decision Engine.

## 5. What's frontloaded, what's emergent

Not all complexity can be frontloaded. Some emerges only during execution:

- **Performance characteristics** revealed under realistic load
- **Integration interactions** between systems that look orthogonal on paper
- **Scaling thresholds** invisible at small N
- **User behavior** that doesn't match any operator's mental model

The Decision Engine should not pretend everything can be frontloaded. The framework therefore needs explicit support for:

- **Emergent issue capture** — when the operator (or the framework) finds something mid-work, capture it without breaking the current flow (see RFC-0024 once drafted)
- **Exploration workstreams** — when the goal is "discover what we don't know," the standard DoR gate's frontload-everything contract doesn't fit (see RFC-0026 once drafted)
- **Iterative refinement** — sometimes a contract ships, learns from production, and needs revision; the framework should make that loop fast and clean

These are not deviations from the Decision Engine — they ARE the Decision Engine, applied to the harder cases.

## 6. The framework's adopter promise

Adopters of ai-sdlc are buying into the Decision Engine. The framework's contract with them:

- **You frontload thinking. We execute deterministically.**
- **You set policy. We enforce it consistently.**
- **You decide. We don't override.** (Operator overrides are first-class signals; the framework learns from them, doesn't fight them.)
- **You see everything.** (Pipeline observability is non-negotiable — black-box execution destroys the trust the Decision Engine requires.)
- **You can leave anytime.** (Adapter framework per [RFC-0010 §13](spec/rfcs/RFC-0010-parallel-execution-worktree-pooling.md) and [RFC-0019](spec/rfcs/RFC-0019-embedding-provider-adapter.md): the framework is replaceable at every boundary it owns.)

## 7. Anti-patterns this vision rules out

These are the patterns that violate the Decision Engine and should be rejected on sight:

| Anti-pattern | Why it violates the Vision |
|---|---|
| "AI decides architecture mid-implementation" | The cost-asymmetry argument flipped — decisions made under maximum uncertainty |
| "Just keep iterating, the AI will figure it out" | Skips the frontload step; produces unbounded execution cost |
| "We can document the design after the code lands" | The contract IS the design — there's nothing to execute against if it's missing |
| "Add a flag for everything in case the operator wants it later" | Decisions deferred indefinitely become tech debt; operators want the framework to take a position |
| "Silent fallback when the gate fails" | Faithful gating is non-negotiable; if a gate fails, the framework MUST surface it |
| "Reuse one mega-issue for the whole epic" | One issue = one contract; emergent work goes into new issues per RFC-0024 once drafted |

## 8. Vision governance

This vision document changes only through deliberate operator decision — it's load-bearing for every RFC, every CLI, every gate. Updates require:

- A PR proposing the change
- The current version of the document referenced as the diff base
- Sign-off from at least the Engineering Authority + the Product Lead (per the team-roles convention)

Minor edits (typo fixes, broken links, RFC reference updates) can ship without ceremony.

The vision is intentionally separate from `CHARTER.md` (governance) and `GOVERNANCE.md` (decision-making process for the project) — those documents change on different cadences and have different audiences.

## 9. References

The vision operationalizes through these RFCs (in dependency order):

- [RFC-0011 — Definition of Ready Gate](spec/rfcs/RFC-0011-definition-of-ready-gate.md) — the gate that enforces frontloading
- [RFC-0014 — Dependency Graph Composition](spec/rfcs/RFC-0014-dependency-graph-composition.md) — execution ordering
- [RFC-0015 — Autonomous Pipeline Orchestrator](spec/rfcs/RFC-0015-autonomous-pipeline-orchestrator.md) — the contract executor
- [RFC-0023 — Operator TUI](spec/rfcs/RFC-0023-operator-tui-pipeline-monitoring.md) — the operator's decision-monitoring surface
- **RFC-0024 — Emergent Issue Capture + Triage Pattern** (reserved; addresses §5 emergent-work gap)
- **RFC-0025 — Framework Quality Monitoring** (reserved; operationalizes §4 honest failure modes)
- **RFC-0026 — Exploration Workstream Pattern** (reserved; addresses §5 exploration-mode gap)

For the broader RFC catalog, see [`spec/rfcs/README.md`](spec/rfcs/README.md).

For project governance (mission, scope, IP policy, CNCF alignment), see [`CHARTER.md`](CHARTER.md).

---

**Last updated:** 2026-05-03
