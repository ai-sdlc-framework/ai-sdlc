---
id: AISDLC-261
title: init doesn't scaffold GitHub workflows
status: To Do
assignee: []
created_date: '2026-05-13 23:55'
labels:
  - adopter-friction
  - init
  - scaffolding
  - rfc-0005
dependencies: []
priority: high
references:
  - .github/workflows/ai-sdlc-gate.yml
  - .github/workflows/verify-attestation.yml
  - .github/workflows/ai-sdlc-review.yml
  - orchestrator/src/cli/commands/init-features.ts
---

## Bug

The `ai-sdlc init` scaffold doesn't lay down the `.github/workflows/*.yml` files an adopter needs for the framework to function end-to-end. The current state is self-acknowledged in `.github/workflows/ai-sdlc-gate.yml:13` ("AISDLC-140 sub-5"), but the gap is still live and every adopter has to either copy workflows manually or live without the gate / attestation verification / review automation.

## Repro (against forge or any fresh repo)

```bash
ai-sdlc init        # populates .ai-sdlc/, agents, hooks
ls .github/workflows/  # → directory may not exist; ai-sdlc-{gate,review,verify-attestation}.yml absent
```

Adopter then either (a) cargo-cults the YAML from this repo, or (b) ships without the gate and discovers months later that `ai-sdlc/pr-ready` was never wired.

## Fix candidates

1. **`--with-workflows` flag** on `ai-sdlc init` that copies the canonical workflow set (`ai-sdlc-gate.yml`, `verify-attestation.yml`, `ai-sdlc-review.yml`, `auto-enable-auto-merge.yml`) into `.github/workflows/` of the target repo.
2. **`ai-sdlc init --add workflows`** subcommand for retroactive add to a project that init-ed without them.
3. **Source-of-truth pointer**: the templates already exist in this repo at `.github/workflows/`. `init.mjs` should read them as templates (not have a separate fork) so they stay in sync as the framework evolves.
4. **Idempotent**: re-running `--add workflows` against an existing `.github/workflows/` should diff-apply, not blindly overwrite operator customizations.

## Acceptance criteria

- [ ] `ai-sdlc init --with-workflows` (or equivalent) copies the 4 canonical workflows into `.github/workflows/`.
- [ ] `ai-sdlc init --add workflows` works on a repo that previously init-ed without the flag.
- [ ] Source = the templates in this repo's `.github/workflows/` (single source of truth, no drift).
- [ ] Re-running on an existing `.github/workflows/` is idempotent: skips files that already exist by default; `--force` overwrites with operator confirmation.
- [ ] `init.mjs` test coverage exercises `--with-workflows` against a temp repo.
- [ ] Docs (`ai-sdlc-plugin/README.md` + `docs/operations/`) explain the flag and the upgrade path for projects that init-ed pre-261.

## Source

Adopter session 2026-05-13, ranked #1 by friction (forge integration).
