---
id: AISDLC-612
title: Document the requiredTier independence-policy knob for adopters (MED-4)
status: To Do
priority: medium
labels:
  - docs
  - adopter-facing
  - attestation
references:
  - RFC-0047
created: 2026-09-14
---

## Context

MED-4 from the local-trades LT-595 report: a hand-run / main-session `emit-leaf`
produces `independenceTier=none`, `verdictClass=self-authored`, and the verifier
accepts `none` by default, so review independence is not *enforced* for any
dispatch outside the orchestrator/CI path.

Investigation finding: this is **already fully implemented** — it needs
DOCUMENTATION, not code. RFC-0047 (Re-Derivable Isolated-Review Anchor) is
Signed Off and all 5 phases shipped (AISDLC-593/594/595/596/597), and AISDLC-591
shipped the `requiredTier` policy engine. The enforcement knob exists:

- Config: `.ai-sdlc/independence-policy.yaml` → `requiredTier: none | attested | isolated`
  (default `none`), parsed by `pipeline-cli/src/attestation/independence-policy.ts`.
- Enforcement compares `requiredTier` against the envelope's
  `overallIndependenceTier`; a shortfall blocks via `ai-sdlc/pr-ready` on
  branch-protection repos AND via the ship-skill on procedural-gate repos
  (the no-branch-protection adopter case).
- `isolated` is satisfiable only via the CI clean-room signer (RFC-0047); a
  main-session dispatch (coordinator holds the key) tops out at `none`/`attested`
  by design — a coordinator cannot self-certify independence (the anchor must be
  a distinct identity the verifier re-derives; see RFC-0047).

## Scope (docs only)

- Add an operator runbook page (e.g. `docs/operations/independence-policy.md`)
  covering: what `independenceTier` means (`none`/`attested`/`isolated`), the
  `.ai-sdlc/independence-policy.yaml requiredTier` knob + default, how enforcement
  works on BOTH branch-protection and procedural-gate topologies, and the
  explicit guidance that main-session dispatches are inherently `none` (use the
  CI/isolated path when enforced independence is required).
- Cross-link from the adopter config guide / README and from RFC-0047.
- NO code change — the mechanism already exists and is tested.

## Acceptance Criteria

- [ ] AC-1: Runbook page documents `requiredTier` values, default, config path, and
      the both-topologies enforcement behavior.
- [ ] AC-2: Explicitly documents that a main-session `/ai-sdlc execute` yields
      `independenceTier=none` by design and how to get `attested`/`isolated`.
- [ ] AC-3: Cross-linked from adopter-facing config docs + RFC-0047.
- [ ] AC-4: `docs:check` / drift gates pass.

## References

Adopter report local-trades LT-595 (MED-4). Mechanism: RFC-0047 (Implemented),
AISDLC-591 (requiredTier engine), `pipeline-cli/src/attestation/independence-policy.ts`.
