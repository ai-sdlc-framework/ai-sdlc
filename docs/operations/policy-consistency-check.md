# Bounded policy consistency check

RFC-0062 OQ-6 (DEC-0390, AISDLC-1215). Config validation (`pipeline-cli/src/tui/config-browser/validator.ts`, logic in `policy-consistency.ts`) catches contradictory policy rules. It adds no dependency: no SAT or SMT solver.

## Checks

1. **Pairwise contradiction** (polynomial, no size limit). In an `AutonomyPolicy` level, a glob listed in `permissions.read` or `permissions.write` and also in `guardrails.blockedPaths` is a contradiction. A broad allow with a narrower block (`**` allowed, `.ai-sdlc/**` blocked) is a normal exception and passes.
2. **Reachability** (truth table, bounded). For a `QualityGate`, every enforcement level in `spec.enforcementLevels` (default: the levels the gates use) must be reachable. A gate may carry `when`, a list of flag literals (`flag` or `!flag`) that must all hold. A level is unreachable when no assignment satisfies any gate at that level, for example `when: [x, "!x"]` or a level no gate declares.

## maxPolicyVariables

Reachability enumerates `2^n` assignments over the `n` distinct flags. `spec.maxPolicyVariables` (default 20) caps `n`. Exceeding it fails validation with a message naming `maxPolicyVariables`; the check is never silently skipped. 20 variables run in well under one second.

## Compliance artefact

`validateYaml` returns `consistencyArtefact` with, per finding, the rule ids and a witness assignment (a path for a contradiction; the variable list for an unreachable level). `writeConsistencyArtefact(dir, artefact)` writes it as JSON under the `compliance/` directory.
