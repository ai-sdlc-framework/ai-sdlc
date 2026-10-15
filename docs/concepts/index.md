---
title: "Concepts"
description: "Operator-facing overviews of the framework's five pillars and the RFCs behind them."
---

Operator-facing overviews of the framework's pillars and the RFCs behind them. Each page orients you, then points at the canonical RFC and the operational runbook in the source repository.

## The five pillars

| Concept | Pillar | RFC | Status |
|---------|--------|-----|--------|
| [Definition-of-Ready gate](./dor-gate.md) | Decision engine | [RFC-0011](https://github.com/ai-sdlc-framework/ai-sdlc/blob/main/spec/rfcs/RFC-0011-definition-of-ready-gate.md) | Implemented |
| [Autonomous orchestrator](./autonomous-orchestrator.md) | Dispatch | [RFC-0015](https://github.com/ai-sdlc-framework/ai-sdlc/blob/main/spec/rfcs/RFC-0015-autonomous-pipeline-orchestrator.md) | Approved |
| [Session hierarchy](./session-hierarchy.md) | Dispatch | [RFC-0051](https://github.com/ai-sdlc-framework/ai-sdlc/blob/main/spec/rfcs/RFC-0051-session-hierarchy-parallel-dispatch.md) | Signed off, shipping |
| [Two-tier pipeline architecture](./two-tier-pipeline.md) | Pipeline runtime | [RFC-0012](https://github.com/ai-sdlc-framework/ai-sdlc/blob/main/spec/rfcs/RFC-0012-two-tier-pipeline-architecture.md) | Implemented |
| [Cross-harness review](./cross-harness-review.md) | Review | [RFC-0010 §13](https://github.com/ai-sdlc-framework/ai-sdlc/blob/main/spec/rfcs/RFC-0010-parallel-execution-worktree-pooling.md) | Draft |
| [Staged review pipeline](./staged-review.md) | Review | [RFC-0052](https://github.com/ai-sdlc-framework/ai-sdlc/blob/main/spec/rfcs/RFC-0052-staged-review-pipeline.md) | Signed off, in progress |
| [Judgment layer](./judgment-layer.md) | Review, decision engine | [RFC-0049](https://github.com/ai-sdlc-framework/ai-sdlc/blob/main/spec/rfcs/RFC-0049-system-one-judgment-layer.md) | Signed off, shipping |
| [Operator TUI](./operator-tui.md) | Operator surface | [RFC-0023](https://github.com/ai-sdlc-framework/ai-sdlc/blob/main/spec/rfcs/RFC-0023-operator-tui-pipeline-monitoring.md) | Approved |

## Trust and governance

| Concept | What it guarantees | RFC | Status |
|---------|--------------------|-----|--------|
| [Proof of Execution](./proof-of-execution.md) | A review ran against this exact diff | [RFC-0042](https://github.com/ai-sdlc-framework/ai-sdlc/blob/main/spec/rfcs/RFC-0042-proof-of-execution-attestation.md) | Implemented |
| [Reviewer independence](./reviewer-independence.md) | The review ran where the implementer could not reach | [RFC-0046](https://github.com/ai-sdlc-framework/ai-sdlc/blob/main/spec/rfcs/RFC-0046-attested-reviewer-independence.md), [RFC-0047](https://github.com/ai-sdlc-framework/ai-sdlc/blob/main/spec/rfcs/RFC-0047-re-derivable-isolated-anchor.md) | Signed off, shipping |
| [Zero-trust PR verification](./zero-trust-untrusted-pr-verification.md) | Untrusted contributors cannot escalate, exfiltrate or forge | [RFC-0043](https://github.com/ai-sdlc-framework/ai-sdlc/blob/main/spec/rfcs/RFC-0043-untrusted-contributor-pr-verification.md) | Signed off |
| [Per-repo configurable governance](./per-repo-governance.md) | The rules agents are told match the rules they are held to | [RFC-0048](https://github.com/ai-sdlc-framework/ai-sdlc/blob/main/spec/rfcs/RFC-0048-per-repo-configurable-governance.md) | Implemented |
| [Usage ledger and model routing](./usage-ledger-model-routing.md) | Every model call is accounted for; model choice cites evidence | [RFC-0050](https://github.com/ai-sdlc-framework/ai-sdlc/blob/main/spec/rfcs/RFC-0050-usage-ledger-and-model-routing.md) | Signed off, shipping |

## How these fit together

An issue reaches the **DoR gate**, which decides whether it is ready to dispatch; the **judgment layer** fronts that decision so the generative rubric runs only when needed. Ready issues join the dispatch frontier. The **autonomous orchestrator**, running as the dispatch tier of the **session hierarchy**, picks the next issue, allocates an isolated worktree and runs the **two-tier pipeline**. The review stage fans out to **cross-harness reviewers**, either three in parallel or the **staged pipeline**, and each reviewer's transcript becomes a leaf in the **Proof of Execution** attestation. **Reviewer independence** says where that review ran; the **zero-trust gate** moves the whole thing into a sandbox and clean room when the contributor is untrusted. **Per-repo governance** is where the repository states its own rules, the **usage ledger** records what every step cost, and the **operator TUI** is where a human watches the flow and answers the questions the framework could not.

For the live status of every RFC, see the [RFC registry](../../spec/rfcs/README.md).
