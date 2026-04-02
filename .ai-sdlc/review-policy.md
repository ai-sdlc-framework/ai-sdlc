# AI-SDLC Review Policy

This document provides calibration context for the automated review agents.
Apply the **principles** and **exemplars** below before analyzing the PR.

## Golden Rule

**When in doubt, approve with a suggestion — do not request changes.**

## Review Principles

Read `.ai-sdlc/review-principles.md` for the 7 durable principles:
1. **Evidence-First** — trace the code path or don't flag it
2. **Deterministic-First** — defer to CI for lint, types, coverage
3. **Trust Boundaries** — only flag at real untrust boundaries
4. **Context Awareness** — read surrounding code before flagging
5. **Severity Honesty** — no failureScenario = not critical/major
6. **Signal Over Noise** — one good finding beats ten bad ones
7. **Scope Discipline** — don't flag deferred work or unchanged code

## Review Exemplars

Read `.ai-sdlc/review-exemplars.yaml` for 20 labeled examples showing:
- **True positives** — real bugs you should catch (null pointers, injection, off-by-one)
- **False positives** — issues you should NOT flag (trusted config, bounded regex, sequential awaits)
- **Borderline cases** — judgment calls with correct disposition (approve with suggestion)

When you encounter a pattern similar to an exemplar, follow the exemplar's verdict.

## CI Boundary — Deterministic Checks You Must Defer To

| CI Check | What It Covers | Your Scope? |
|---|---|---|
| ESLint (`pnpm lint`) | Lint violations, unused imports, naming | No |
| Prettier (`pnpm format:check`) | Formatting, whitespace, semicolons | No |
| TypeScript (`pnpm build`) | Type errors, missing types, generics | No |
| Vitest (`pnpm test`) | Test failures, broken assertions | No |
| Codecov (`codecov/patch`) | Line coverage on changed code (80% patch) | No |
| Schema validation | YAML/JSON schema conformance | No |

## Threat Model

### Trusted Input Sources (do NOT flag for injection)
- `.ai-sdlc/*.yaml` pipeline configuration files — committed by maintainers
- `orchestrator/src/defaults.ts` constants — hardcoded values
- Environment variables set by the platform (`CLAUDE_PROJECT_DIR`)
- `resolveRepoRoot()` output — git working directory

### Untrusted Input Sources (DO flag for injection)
- Issue titles and bodies from GitHub (user-submitted)
- PR bodies and review comments
- CLI arguments from external callers
- Agent output (filesChanged, summary) — LLM-generated

## Severity Classification

- **critical**: Data loss, security breach, crash in production. MUST have failureScenario.
- **major**: Correctness bug in common paths, exploitable vulnerability. MUST have failureScenario.
- **minor**: Code quality issue, no correctness impact
- **suggestion**: Nice-to-have improvement
