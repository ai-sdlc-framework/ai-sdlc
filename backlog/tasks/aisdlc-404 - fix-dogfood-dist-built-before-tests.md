---
id: AISDLC-404
title: 'fix(ci): dogfood test imports dist/runner/index.js — ensure build runs before tests'
status: In Progress
labels: [ci, dogfood, build, operator-merge]
references:
  - dogfood/src/runner/exports.test.ts
  - dogfood/package.json
  - .github/workflows/ci.yml
priority: high
permittedExternalPaths: []
---

## Description

`dogfood/src/runner/exports.test.ts` imports `dogfood/dist/runner/index.js` to validate the package.json exports surface. CI's Build & Test (Node 22) runs `vitest run` directly without first building dogfood, so the file doesn't exist and 2 tests fail. Multiple PRs in 2026-05-23 session blocked on this. Dev subagents have consistently noted "pre-existing dogfood test failure on main."

## Acceptance criteria

- [ ] AC-1: Diagnose: read `dogfood/package.json` scripts + `.github/workflows/ci.yml` Build & Test step. Determine whether (a) `pnpm test` script needs `pnpm build &&` prefix, (b) CI needs explicit `pnpm --filter @ai-sdlc/dogfood build` step before test, or (c) the exports.test.ts should mock instead of import-from-dist.
- [ ] AC-2: Apply the fix. Prefer (b) CI-level build-before-test step over (a) per-package scripts (consistency). Prefer (b) over (c) because the test's purpose IS to validate the built-dist exports surface.
- [ ] AC-3: Verify fix locally: clean `dogfood/dist`, run `pnpm --filter @ai-sdlc/dogfood test`, confirm fails. Then `pnpm --filter @ai-sdlc/dogfood build && pnpm --filter @ai-sdlc/dogfood test` passes.
- [ ] AC-4: Reference PRs #524, #626, #636 as immediate beneficiaries — they will pass Build & Test on rebase once this lands.
- [ ] AC-5: If the fix is workflow-level, also document in `CLAUDE.md` "Testing" section that dogfood tests require dist + build runs first.

## Out of scope

- Refactoring exports.test.ts to mock instead of import — keep the test's actual validation purpose intact.
- Other packages with similar build-order issues — file separately if found.

## Estimated effort

30 min - 1 hour.
