---
id: AISDLC-813
title: >-
  dashboard build rewrites next-env.d.ts and tsconfig.json so format:check fails every pipeline run
status: To Do
assignee: []
created_date: '2026-10-11'
updated_date: '2026-10-11'
labels:
  - dashboard
  - build
  - root-cause
dependencies: []
references:
  - dashboard/next-env.d.ts
  - dashboard/tsconfig.json
  - .prettierignore
  - package.json
priority: high
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
**Context.** On 2026-10-11 AISDLC-631.6 (draft PR #1403, ff7bb022) stopped before review and sign with `format=failed`. The only flagged files were `dashboard/next-env.d.ts` and `dashboard/tsconfig.json`; both are rewritten by the dashboard (Next.js) build during `pnpm build` and neither is part of the PR. The AISDLC-604 worktree shows the same two files modified after its run. Every pipeline that builds the dashboard now hits this.

**Observed rewrite** (`git diff dashboard/next-env.d.ts dashboard/tsconfig.json` in the AISDLC-604 worktree, after `pnpm build`):

```diff
--- a/dashboard/next-env.d.ts
+++ b/dashboard/next-env.d.ts
@@ -1,6 +1,7 @@
 /// <reference types="next" />
 /// <reference types="next/image-types/global" />
-/// <reference path="./.next/types/routes.d.ts" />
+import "./.next/types/routes.d.ts";
+import "./.next/types/root-params.d.ts";

--- a/dashboard/tsconfig.json
+++ b/dashboard/tsconfig.json
-    "lib": ["dom", "dom.iterable", "esnext"],
+    "lib": [
+      "dom",
+      "dom.iterable",
+      "esnext"
+    ],
-    "jsx": "preserve",
+    "jsx": "react-jsx",
-    "plugins": [{ "name": "next" }],
+    "plugins": [
+      {
+        "name": "next"
+      }
+    ],
     "paths": {
-      "@/*": ["./src/*"]
+      "@/*": [
+        "./src/*"
+      ]
     }
-  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
-  "exclude": ["node_modules"]
+  "include": [
+    "next-env.d.ts",
+    "**/*.ts",
+    "**/*.tsx",
+    ".next/types/**/*.ts",
+    ".next/dev/types/**/*.ts"
+  ],
+  "exclude": [
+    "node_modules"
+  ]
```

Next.js (`next build`, no config knob in `dashboard/next.config.mjs`) rewrites `tsconfig.json` to its own expanded JSON style and sets `jsx: react-jsx`, adds `.next/dev/types/**/*.ts` to `include`, and regenerates `next-env.d.ts` with `import` lines instead of the `/// <reference path>` line.

**Findings.**
- `dashboard/package.json` `build` is plain `next build`; nothing restores the files afterwards.
- `.prettierignore` lists `.next/`, `dist/`, `*.md` and others, but neither generated file.
- Root `package.json` `format:check` is `prettier --check .`, so it covers both files. The committed `tsconfig.json` is prettier-formatted, so Next's expanded form fails the check; `next-env.d.ts` is ignored by ESLint (`eslint.config.mjs`) but not by Prettier.
- Both files are git-tracked, so the build also leaves a dirty tree.

**Five-step review (requirements first).**
1. Requirement: "`format:check` passes on the whole tree" (CI lint job). Checking generated files for formatting is a requirement that should not exist; Next.js owns the content of these two files.
2. Delete: take both files out of the format check. Prefer the no-op form that also makes `git status` clean after `pnpm build` in a fresh worktree: commit both files in the exact form Next.js generates AND list them in `.prettierignore` (committing Next's form alone would fail Prettier on `tsconfig.json`; ignoring alone leaves the tree dirty after every build). Pick whichever combination satisfies AC1 and AC2; do not add an auto-restore step to the build.
3. Simplify: a two-line `.prettierignore` change plus regenerated committed files, and one test that `pnpm build` leaves the tree clean.
4. Accelerate: none. 5. Automate: none.

Related: AISDLC-631.6 and AISDLC-604 hit this on 2026-10-11.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] #1 After `pnpm build` in a fresh worktree, `git status --porcelain dashboard/` is empty.
- [ ] #2 `pnpm format:check` passes with the dashboard built.
- [ ] #3 A hermetic test or CI assertion covers AC1 (the build leaves `dashboard/` unmodified).
- [ ] #4 The pipeline format step no longer fails on these files (AISDLC-631.6 re-run or a resumed PR verifies).
- [ ] #5 The PR body names the five steps and which of them the change applies (delete, simplify).
<!-- AC:END -->

## Notes

Verification: `pnpm build && pnpm format:check && git status --porcelain`, `pnpm lint`. Velocity impact: positive; removes a recurring false failure from every pipeline run that builds the dashboard.
