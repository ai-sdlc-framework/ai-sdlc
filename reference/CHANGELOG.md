# @ai-sdlc/reference

## [0.32.0](https://github.com/ai-sdlc-framework/ai-sdlc/compare/reference-v0.31.0...reference-v0.32.0) (2026-10-10)


### Miscellaneous

* **reference:** Synchronize node-packages versions

## [0.31.0](https://github.com/ai-sdlc-framework/ai-sdlc/compare/reference-v0.30.0...reference-v0.31.0) (2026-10-10)


### Miscellaneous

* **reference:** Synchronize node-packages versions

## [0.30.0](https://github.com/ai-sdlc-framework/ai-sdlc/compare/reference-v0.29.0...reference-v0.30.0) (2026-10-09)


### Features

* add mark-ready-after-codeql to dispatch operational authority (AISDLC-736) ([#1264](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1264)) ([afed0d8](https://github.com/ai-sdlc-framework/ai-sdlc/commit/afed0d87c6556e16d18e0b83bfcaa5a650c63113))
* executor idle path blocks on claim and self-clears (AISDLC-759) ([#1287](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1287)) ([92e1d1b](https://github.com/ai-sdlc-framework/ai-sdlc/commit/92e1d1bf2c1bf449f7d90dd100ec3434883e349b))
* merge policy follows governance.allowMerge everywhere (AISDLC-753) ([#1258](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1258)) ([39e37d7](https://github.com/ai-sdlc-framework/ai-sdlc/commit/39e37d762986f8b1a15ad0526dbce09cc9f3876e))
* **orchestrator:** resume a done task with feedback, wake idle executors (AISDLC-738) ([#1295](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1295)) ([23643ec](https://github.com/ai-sdlc-framework/ai-sdlc/commit/23643ec973e35d4d36bd666994229b9ba097018b))


### Bug Fixes

* clear known dependency vulnerabilities reported by Scorecard (AISDLC-745) ([#1273](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1273)) ([5b7a40e](https://github.com/ai-sdlc-framework/ai-sdlc/commit/5b7a40e501c802a400b47b508ce65b204f6454c1))
* **pipeline-cli:** usage pane bad-ledger-line test pins the clock (AISDLC-767) ([#1282](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1282)) ([22aa377](https://github.com/ai-sdlc-framework/ai-sdlc/commit/22aa377e17b1b7a62deb712e34e04ba3a87b36ba))

## [0.29.0](https://github.com/ai-sdlc-framework/ai-sdlc/compare/reference-v0.28.0...reference-v0.29.0) (2026-10-06)


### Bug Fixes

* **security:** fix critical DangerousWorkflow alerts and triage code-scanning backlog (AISDLC-704) [supersedes [#1223](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1223)] ([#1232](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1232)) ([1ea76c1](https://github.com/ai-sdlc-framework/ai-sdlc/commit/1ea76c17e77f692b0320dd5f989c5c8958913a20))

## [0.28.0](https://github.com/ai-sdlc-framework/ai-sdlc/compare/reference-v0.27.0...reference-v0.28.0) (2026-10-05)


### Features

* **governance:** internal agents may edit .ai-sdlc config; untrusted runs stay blocked (AISDLC-720) ([#1211](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1211)) ([e07e1c0](https://github.com/ai-sdlc-framework/ai-sdlc/commit/e07e1c0e205a33aceec727af1bd82a841aa05040))
* **orchestrator:** enforce the executor authority matrix with a PreToolUse rule (AISDLC-684) ([#1203](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1203)) ([c80be62](https://github.com/ai-sdlc-framework/ai-sdlc/commit/c80be62b961ea911d2d8fd5f0e39dcb4064bcebb))
* **orchestrator:** lease push on the agent's own branch is allowed by default (AISDLC-710) ([#1213](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1213)) ([7715d5b](https://github.com/ai-sdlc-framework/ai-sdlc/commit/7715d5b5a72285e486df1e0da8f7f8f130bee1c4))
* **orchestrator:** operator-dispatch loop, executor context clear, requeue (AISDLC-667) ([#1191](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1191)) ([12348c8](https://github.com/ai-sdlc-framework/ai-sdlc/commit/12348c89ce625b43e1ff678f41bdf1b5e078d744))
* **orchestrator:** project-scoped session names and peer-binding guards (AISDLC-709) ([#1217](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1217)) ([64680f7](https://github.com/ai-sdlc-framework/ai-sdlc/commit/64680f7482b79c7dffc7becab8f347a8ba2a81a9))
* **orchestrator:** release source kind for cli-merge-if-eligible (AISDLC-702) ([#1196](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1196)) ([79afae6](https://github.com/ai-sdlc-framework/ai-sdlc/commit/79afae6b40bf4d2a930f56e3be3b8bae674e0bc9))


### Bug Fixes

* **orchestrator:** use family aliases for model defaults, one central id module (AISDLC-690) ([#1212](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1212)) ([f01fd32](https://github.com/ai-sdlc-framework/ai-sdlc/commit/f01fd3247dcd837642227eb614816a900dd0fd19))

## [0.27.0](https://github.com/ai-sdlc-framework/ai-sdlc/compare/reference-v0.26.1...reference-v0.27.0) (2026-10-04)


### Features

* add judgment provider interface, registry, fake and Jev adapter (AISDLC-629) ([#1098](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1098)) ([f1ac4db](https://github.com/ai-sdlc-framework/ai-sdlc/commit/f1ac4db65d258123126b280464486337fe4559ea))
* **orchestrator:** advisory ac-coverage and finding-grounding judgments (AISDLC-637) ([#1131](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1131)) ([aeb2266](https://github.com/ai-sdlc-framework/ai-sdlc/commit/aeb226619e7b6d509bc53935e3e9c262c64eae6b))
* **orchestrator:** board ordering, requeue reaper, enqueue (AISDLC-665) ([#1115](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1115)) ([c17c875](https://github.com/ai-sdlc-framework/ai-sdlc/commit/c17c875e0e64773d8265b19d54ef06350a23081d))
* **orchestrator:** claude code transcript ingester and cli-usage ingest (AISDLC-649) ([#1109](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1109)) ([0048523](https://github.com/ai-sdlc-framework/ai-sdlc/commit/0048523839b30b32f2d2527244ea42f8b5f971fc))
* **orchestrator:** model routing table, resolveModel and deterministic exploration (AISDLC-654) ([#1114](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1114)) ([b0f50e0](https://github.com/ai-sdlc-framework/ai-sdlc/commit/b0f50e0767b7edfdd586f65cb01ef838b395b2fd))
* **orchestrator:** one tmux session per hierarchy agent, plus attach and terminals (AISDLC-688) ([#1179](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1179)) ([3e67cfb](https://github.com/ai-sdlc-framework/ai-sdlc/commit/3e67cfbd3df511c9c99fb11d11a17221dcb92771))
* **orchestrator:** review executor probes with contained, redacted evidence (AISDLC-675) ([#1178](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1178)) ([699f3fe](https://github.com/ai-sdlc-framework/ai-sdlc/commit/699f3fef42c42a5e80dd054a6a2f12b134019f22))
* **orchestrator:** review plan schema, baseline checklist and allowlist (AISDLC-673) ([#1164](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1164)) ([618cd8f](https://github.com/ai-sdlc-framework/ai-sdlc/commit/618cd8fc64399ba7d9c7a15f0ebaf2740dd62eb3))
* **orchestrator:** review routing and per-PR reviewer-set judgments (AISDLC-638) ([#1140](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1140)) ([7109589](https://github.com/ai-sdlc-framework/ai-sdlc/commit/7109589f358168e2c28a2fca1ee157456a050fe5))
* **orchestrator:** RFC-0051 executor loop skill, claim-bound complete, next-subid (AISDLC-666) ([#1170](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1170)) ([8a4fbce](https://github.com/ai-sdlc-framework/ai-sdlc/commit/8a4fbce3b16c41ac3c52a00fd718c9b7edda3fe1))
* **orchestrator:** routing bar evaluation and weekly proposal (AISDLC-656.1) ([#1161](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1161)) ([0da3e64](https://github.com/ai-sdlc-framework/ai-sdlc/commit/0da3e645942b5b46ec1de0969102fccc3a93652e))
* **orchestrator:** stable repoId in the usage ledger (AISDLC-653.1) ([#1150](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1150)) ([bbc2b6b](https://github.com/ai-sdlc-framework/ai-sdlc/commit/bbc2b6b521c278f44a2a8904e3be6a8353191d9b))
* **orchestrator:** usage reports, allotment tracking and usage config (AISDLC-651) ([#1119](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1119)) ([85c1294](https://github.com/ai-sdlc-framework/ai-sdlc/commit/85c1294493952c4de8d531e09ff0183ebef9efca))
* **reference:** capability registry and outcome reporting (AISDLC-642) ([#1099](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1099)) ([f1642f2](https://github.com/ai-sdlc-framework/ai-sdlc/commit/f1642f20f5c90308e7973aa2633e0878c02ebfe3))
* **reference:** cli-judgment doctor/list/ask/eval/replay and live contract test (AISDLC-632) ([#1133](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1133)) ([8c2c6c6](https://github.com/ai-sdlc-framework/ai-sdlc/commit/8c2c6c67bff04f4dfebbe8a425b0ddbbd00a1aad))
* **reference:** evaluateJudgment runtime, catalog, JudgmentConfig and loader (AISDLC-630) ([#1118](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1118)) ([530c712](https://github.com/ai-sdlc-framework/ai-sdlc/commit/530c712f7c9be11afb4ec50f6a5f4cf4f3ac678e))
* **reference:** generic OpenAI-compatible judgment adapter, shadow-only (AISDLC-633) ([#1128](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1128)) ([98bf5fe](https://github.com/ai-sdlc-framework/ai-sdlc/commit/98bf5fe8745013def1e53476f3c95b6f95573b19))
* **reference:** judgment log, cache, cost, events and doctor check (AISDLC-631) ([#1129](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1129)) ([468b54d](https://github.com/ai-sdlc-framework/ai-sdlc/commit/468b54d7d73bb81c352d34aed8becaf30e601a27))
* **reference:** model price feed with dated history and held rows (AISDLC-659) ([#1108](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1108)) ([f70ba22](https://github.com/ai-sdlc-framework/ai-sdlc/commit/f70ba2252252895f8a55c6e7f46659ce1d2ff9d8))
* **reference:** registration-time safety rules for judgment definitions (AISDLC-630.1) ([#1130](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1130)) ([10725b0](https://github.com/ai-sdlc-framework/ai-sdlc/commit/10725b09ccf0513a1d580a625cc2d474983bb7fc))
* **reference:** RFC-0049 Group A decision and estimation judgments, conservative form (AISDLC-635) ([#1141](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1141)) ([9c19374](https://github.com/ai-sdlc-framework/ai-sdlc/commit/9c19374edf4b5ba658a16d03363d544abce09684))
* **reference:** usage ledger core with JSONL store and price table (AISDLC-648) ([#1100](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1100)) ([6481737](https://github.com/ai-sdlc-framework/ai-sdlc/commit/6481737f67e87a68330302c52be3db1f72c411bd))
* RFC-0050 Part A: Codex session ingester and direct usage reporters for API runners and embeddings (AISDLC-650) ([#1107](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1107)) ([26a9c28](https://github.com/ai-sdlc-framework/ai-sdlc/commit/26a9c285b9eebb110883dc49500f0866de9598ca))
* RFC-0051: hierarchy roster schema and cli-hierarchy up/status/down bootstrapping named tmux sessions per role (AISDLC-664) ([#1116](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1116)) ([5963b0b](https://github.com/ai-sdlc-framework/ai-sdlc/commit/5963b0b96f1a8b236add11be4cac36903fb9e64d))
* **spec:** add cli-usage scorecard joining usage to review outcomes (AISDLC-653) ([#1122](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1122)) ([95dc642](https://github.com/ai-sdlc-framework/ai-sdlc/commit/95dc6429b9d48c239a84538490b8a6edfed49c16))
* **spec:** require runtime evidence to promote an RFC to Implemented (AISDLC-647) ([#1106](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1106)) ([5f1e6d2](https://github.com/ai-sdlc-framework/ai-sdlc/commit/5f1e6d263354941c698d7522238d24586525707c))
* **spec:** review risk map stages 0 to 2 behind an injected structural provider (AISDLC-672) ([#1175](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1175)) ([a2e70ff](https://github.com/ai-sdlc-framework/ai-sdlc/commit/a2e70ff56374ffb45a1dac0d29a3aa225450c54a))
* **spec:** scope force-push to own branch via leaseOnOwnBranch (AISDLC-663) ([#1113](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1113)) ([bf63baf](https://github.com/ai-sdlc-framework/ai-sdlc/commit/bf63baf71a41c1bb8561c3a6f462e921f3080ccc))


### Bug Fixes

* **hooks:** coverage gate reaps workers and caps memory; vitest workers die with parent (AISDLC-681) ([#1158](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1158)) ([ce802d2](https://github.com/ai-sdlc-framework/ai-sdlc/commit/ce802d25ffe657ecbc33c75f8e497f28aa3f1280))
* **reference:** close redactSecrets gaps for AWS, URL and env secrets (AISDLC-630.2) ([#1143](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1143)) ([0828264](https://github.com/ai-sdlc-framework/ai-sdlc/commit/0828264ae968ca7de02ed0e58054bc87170fde0b))
* **reference:** harden openai-compatible provider options (AISDLC-633.1) ([#1149](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1149)) ([efc493c](https://github.com/ai-sdlc-framework/ai-sdlc/commit/efc493c5126c6166a0a86a45716052851e7c1665))
* **reference:** skip judgment cache reads in enforce mode (AISDLC-631.3) ([#1147](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1147)) ([232230f](https://github.com/ai-sdlc-framework/ai-sdlc/commit/232230f4f276a45fc92bc33e283f34922faf7060))
* **spec:** harden cli-merge-if-eligible before the allowMerge grant (AISDLC-663.5) ([#1134](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1134)) ([ea6b7da](https://github.com/ai-sdlc-framework/ai-sdlc/commit/ea6b7da08bf7c58acb459a43c076be048a20b288))

## [0.26.1](https://github.com/ai-sdlc-framework/ai-sdlc/compare/reference-v0.26.0...reference-v0.26.1) (2026-09-18)


### Miscellaneous

* **reference:** Synchronize node-packages versions

## [0.26.0](https://github.com/ai-sdlc-framework/ai-sdlc/compare/reference-v0.25.0...reference-v0.26.0) (2026-09-17)


### Miscellaneous

* **reference:** Synchronize node-packages versions

## [0.25.0](https://github.com/ai-sdlc-framework/ai-sdlc/compare/reference-v0.24.2...reference-v0.25.0) (2026-09-15)


### Miscellaneous

* **reference:** Synchronize node-packages versions

## [0.24.2](https://github.com/ai-sdlc-framework/ai-sdlc/compare/reference-v0.24.1...reference-v0.24.2) (2026-09-14)


### Miscellaneous

* **reference:** Synchronize node-packages versions

## [0.24.1](https://github.com/ai-sdlc-framework/ai-sdlc/compare/reference-v0.24.0...reference-v0.24.1) (2026-09-08)


### Miscellaneous

* **reference:** Synchronize node-packages versions

## [0.24.0](https://github.com/ai-sdlc-framework/ai-sdlc/compare/reference-v0.23.0...reference-v0.24.0) (2026-09-07)


### Features

* per-repo configurable governance — source of truth + hook render (AISDLC-601) ([#1043](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1043)) ([f9e407e](https://github.com/ai-sdlc-framework/ai-sdlc/commit/f9e407eee452837863b52fd5aa05822ea82e0e2d))

## [0.23.0](https://github.com/ai-sdlc-framework/ai-sdlc/compare/reference-v0.22.0...reference-v0.23.0) (2026-09-07)


### Features

* add anchorEvidence audit-only leaf field (AISDLC-594) ([#1025](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1025)) ([d722f0e](https://github.com/ai-sdlc-framework/ai-sdlc/commit/d722f0e15f734d55498837b0359906ca839d43d7))

## [0.22.0](https://github.com/ai-sdlc-framework/ai-sdlc/compare/reference-v0.21.0...reference-v0.22.0) (2026-09-06)


### Features

* rfc-0046 phase 1 — independenceTier leaf schema + verifier dual-read (AISDLC-588) ([#1018](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1018)) ([aa8409f](https://github.com/ai-sdlc-framework/ai-sdlc/commit/aa8409f60e9e2ce1ad33f1b90f0a43ab41e43e4c))

## [0.21.0](https://github.com/ai-sdlc-framework/ai-sdlc/compare/reference-v0.20.1...reference-v0.21.0) (2026-09-06)


### Miscellaneous

* **reference:** Synchronize node-packages versions

## [0.20.1](https://github.com/ai-sdlc-framework/ai-sdlc/compare/reference-v0.20.0...reference-v0.20.1) (2026-09-05)


### Miscellaneous

* **reference:** Synchronize node-packages versions

## [0.20.0](https://github.com/ai-sdlc-framework/ai-sdlc/compare/reference-v0.19.0...reference-v0.20.0) (2026-09-05)


### Miscellaneous

* **reference:** Synchronize node-packages versions

## [0.19.0](https://github.com/ai-sdlc-framework/ai-sdlc/compare/reference-v0.18.0...reference-v0.19.0) (2026-09-05)


### Miscellaneous

* **reference:** Synchronize node-packages versions

## [0.18.0](https://github.com/ai-sdlc-framework/ai-sdlc/compare/reference-v0.17.2...reference-v0.18.0) (2026-09-05)


### Miscellaneous

* **reference:** Synchronize node-packages versions

## [0.17.2](https://github.com/ai-sdlc-framework/ai-sdlc/compare/reference-v0.17.1...reference-v0.17.2) (2026-09-05)


### Miscellaneous

* **reference:** Synchronize node-packages versions

## [0.17.1](https://github.com/ai-sdlc-framework/ai-sdlc/compare/reference-v0.17.0...reference-v0.17.1) (2026-09-04)


### Miscellaneous

* **reference:** Synchronize node-packages versions

## [0.17.0](https://github.com/ai-sdlc-framework/ai-sdlc/compare/reference-v0.16.0...reference-v0.17.0) (2026-09-04)


### Miscellaneous

* **reference:** Synchronize node-packages versions

## [0.16.0](https://github.com/ai-sdlc-framework/ai-sdlc/compare/reference-v0.15.0...reference-v0.16.0) (2026-09-04)


### Features

* configurable .github/workflows blocking + worktree isolation (AISDLC-567) ([#982](https://github.com/ai-sdlc-framework/ai-sdlc/issues/982)) ([880538f](https://github.com/ai-sdlc-framework/ai-sdlc/commit/880538f615e923c5e7ad005a42bf3a6e2bab1e05))

## [0.15.0](https://github.com/ai-sdlc-framework/ai-sdlc/compare/reference-v0.14.0...reference-v0.15.0) (2026-09-04)


### Miscellaneous

* **reference:** Synchronize node-packages versions

## [0.14.0](https://github.com/ai-sdlc-framework/ai-sdlc/compare/reference-v0.13.0...reference-v0.14.0) (2026-07-29)


### Features

* **orchestrator:** dispatch→merge lifecycle profiling instrumentation (AISDLC-493) ([#909](https://github.com/ai-sdlc-framework/ai-sdlc/issues/909)) ([906f53a](https://github.com/ai-sdlc-framework/ai-sdlc/commit/906f53a9ae2a05389b623873f58e0642de4d1578))
* **orchestrator:** rfc-0018 phase 4 - MetricSnapshot + graduated Erho5 degradation (AISDLC-468) ([#910](https://github.com/ai-sdlc-framework/ai-sdlc/issues/910)) ([2cfe642](https://github.com/ai-sdlc-framework/ai-sdlc/commit/2cfe642be7dab633e5944992f125c1297f518baa))
* **reference:** harden journey.v1 constraints + validate-schemas robustness (AISDLC-494) ([#917](https://github.com/ai-sdlc-framework/ai-sdlc/issues/917)) ([8317c39](https://github.com/ai-sdlc-framework/ai-sdlc/commit/8317c399afcb261e4a33bfcabe7510cb9ac17328))


### Bug Fixes

* **security:** resolve CodeQL source-code findings — ReDoS, cmd-injection, sanitization (AISDLC-535) ([#913](https://github.com/ai-sdlc-framework/ai-sdlc/issues/913)) ([64f0165](https://github.com/ai-sdlc-framework/ai-sdlc/commit/64f016554ee1cea21cef4ca86c89af1332dd9df9))

## [0.13.0](https://github.com/ai-sdlc-framework/ai-sdlc/compare/reference-v0.12.0...reference-v0.13.0) (2026-06-10)


### Features

* AISDLC-464 remaining gaps — execute.md lib sourcing, schema tightening, drift guard ([#805](https://github.com/ai-sdlc-framework/ai-sdlc/issues/805)) ([7bb2191](https://github.com/ai-sdlc-framework/ai-sdlc/commit/7bb2191b7a62f89fd7f123a9cd25cb30c6161f63))
* AISDLC-480 surface dispatched-session decisions to Decision Catalog (async escape hatch) ([#830](https://github.com/ai-sdlc-framework/ai-sdlc/issues/830)) ([80cd5a7](https://github.com/ai-sdlc-framework/ai-sdlc/commit/80cd5a7efb5a336be15aa310a5b2ae8075dc6c55))
* cli-decisions priority/timebox/resolve/auto-expire — AISDLC-463 core slice ([#797](https://github.com/ai-sdlc-framework/ai-sdlc/issues/797)) ([631d6de](https://github.com/ai-sdlc-framework/ai-sdlc/commit/631d6de22b208f382284887d107e634385d6b123))
* **orchestrator:** AISDLC-465 RFC-0018 Phase 1 journeys[] schema + limits + inheritance validator ([#824](https://github.com/ai-sdlc-framework/ai-sdlc/issues/824)) ([c8f449a](https://github.com/ai-sdlc-framework/ai-sdlc/commit/c8f449a3121771c64260e865ba4dfbf414647926))
* **orchestrator:** franc-based language gate + multi-lang opt-in (AISDLC-431) ([#756](https://github.com/ai-sdlc-framework/ai-sdlc/issues/756)) ([745a238](https://github.com/ai-sdlc-framework/ai-sdlc/commit/745a23809913173fa33a147061a4dddc37eeb11d))
* **orchestrator:** instrument parallel-dispatch profiling (AISDLC-479) ([#774](https://github.com/ai-sdlc-framework/ai-sdlc/issues/774)) ([424372e](https://github.com/ai-sdlc-framework/ai-sdlc/commit/424372e06213ab295c0c592a6a371d79fd60293e))
* rfc-0043 phase 2 — report schema + Zod validator + clean-room signer (AISDLC-498) ([#844](https://github.com/ai-sdlc-framework/ai-sdlc/issues/844)) ([e615cb0](https://github.com/ai-sdlc-framework/ai-sdlc/commit/e615cb056ecc629372b861c51da6314fdb5c8ce3))


### Bug Fixes

* harden 17 ReDoS-prone regexes (CodeQL js/polynomial-redos) ([#820](https://github.com/ai-sdlc-framework/ai-sdlc/issues/820)) ([070864e](https://github.com/ai-sdlc-framework/ai-sdlc/commit/070864e01bddd88d6fa3175cd80c59792b52318e))
* **security:** harden command-injection sites (CodeQL js/shell-command-constructed-from-input) ([#812](https://github.com/ai-sdlc-framework/ai-sdlc/issues/812)) ([be944e9](https://github.com/ai-sdlc-framework/ai-sdlc/commit/be944e92bd262172408223dbc999a9504e02e8fc))

## [0.12.0](https://github.com/ai-sdlc-framework/ai-sdlc/compare/reference-v0.11.0...reference-v0.12.0) (2026-05-29)


### Features

* **orchestrator:** z-score flooding detector + quarantine for signal ingestion (AISDLC-433) ([#752](https://github.com/ai-sdlc-framework/ai-sdlc/issues/752)) ([fd14423](https://github.com/ai-sdlc-framework/ai-sdlc/commit/fd14423aa0e97767c2f2162bab2816b61b7f5603))

## [0.11.0](https://github.com/ai-sdlc-framework/ai-sdlc/compare/reference-v0.10.0...reference-v0.11.0) (2026-05-28)


### Features

* add --timebox flag to cli-decisions for urgency escalation (AISDLC-447) ([#747](https://github.com/ai-sdlc-framework/ai-sdlc/issues/747)) ([efa0c82](https://github.com/ai-sdlc-framework/ai-sdlc/commit/efa0c8297b0ebf0a39e5913273949c0a15e84345))
* add /ai-sdlc execute-parallel tmux wrapper (AISDLC-462) ([#764](https://github.com/ai-sdlc-framework/ai-sdlc/issues/764)) ([dda8c5c](https://github.com/ai-sdlc-framework/ai-sdlc/commit/dda8c5c5edee0d29775c870f6226534ddc7582b7))
* add signal source adapter substrate ([#506](https://github.com/ai-sdlc-framework/ai-sdlc/issues/506)) ([f4ee355](https://github.com/ai-sdlc-framework/ai-sdlc/commit/f4ee355bbfc8a3a9d7d69c807861d739e6abad0a))
* **ci:** flaky-test convention + nightly workflow + pre-commit short-circuit (AISDLC-371 reopen) ([#561](https://github.com/ai-sdlc-framework/ai-sdlc/issues/561)) ([21e3f2d](https://github.com/ai-sdlc-framework/ai-sdlc/commit/21e3f2d5a9d7aed7a475b49f7a87f831b2f9eb9c))
* **dispatch:** RFC-0041 Phase 1.5 — iteration mechanism (Conductor-triggered, Worker-driven session resumption) [needs-human-attention] (AISDLC-377.2) ([#586](https://github.com/ai-sdlc-framework/ai-sdlc/issues/586)) ([8dfcfa0](https://github.com/ai-sdlc-framework/ai-sdlc/commit/8dfcfa03a6de7e6d6158c4780f233aba2296c2f7))
* **orchestrator:** add resume-from-draft + rework-pr recovery paths (AISDLC-273) ([#489](https://github.com/ai-sdlc-framework/ai-sdlc/issues/489)) ([39acbcb](https://github.com/ai-sdlc-framework/ai-sdlc/commit/39acbcb4fd44650cbbbeace5bbaf2e6772998bac))
* **orchestrator:** add RFC-0019 phase 1 embedding adapter + registry (AISDLC-337) ([#650](https://github.com/ai-sdlc-framework/ai-sdlc/issues/650)) ([67bc6dd](https://github.com/ai-sdlc-framework/ai-sdlc/commit/67bc6dd8f2eb136fff9bd89dfc75bbd682283073))
* **orchestrator:** harden estimation log + cache for Phase-5 concurrency (AISDLC-328) ([#661](https://github.com/ai-sdlc-framework/ai-sdlc/issues/661)) ([8f55cb7](https://github.com/ai-sdlc-framework/ai-sdlc/commit/8f55cb7cf86fe0c38637cb710ef7d1ccea1b4044))
* **orchestrator:** per-soul DSB authoring + Ck calibration aggregation (AISDLC-314) ([#562](https://github.com/ai-sdlc-framework/ai-sdlc/issues/562)) ([cf8615b](https://github.com/ai-sdlc-framework/ai-sdlc/commit/cf8615b8683c47e3bd193f20e848d53d0ca9e317))
* **orchestrator:** RFC-0022 Phase 1 — CompliancePosture schema + loader (AISDLC-322) ([#505](https://github.com/ai-sdlc-framework/ai-sdlc/issues/505)) ([23f5816](https://github.com/ai-sdlc-framework/ai-sdlc/commit/23f58169ee5b461a289acd33750cde76e31af026))
* **orchestrator:** signal-ingestion schema + governance + runbook for rfc-0030 phase 6 (AISDLC-348) ([#683](https://github.com/ai-sdlc-framework/ai-sdlc/issues/683)) ([b669485](https://github.com/ai-sdlc-framework/ai-sdlc/commit/b66948503977e0655afec5b3b1020b593821cc2c))
* **orchestrator:** wire RFC-0019 phase 4 pipeline schema + embedding load (AISDLC-340) ([#690](https://github.com/ai-sdlc-framework/ai-sdlc/issues/690)) ([cd8425f](https://github.com/ai-sdlc-framework/ai-sdlc/commit/cd8425fc0d4163d87ec21d9e67be28febe51ae58))
* **pipeline-cli:** RFC-0035 Phase 1 — Decision resource schema + cli-decisions {list, show, add} (AISDLC-285) ([#504](https://github.com/ai-sdlc-framework/ai-sdlc/issues/504)) ([019cdfe](https://github.com/ai-sdlc-framework/ai-sdlc/commit/019cdfe265a3301580c003c06a792d6e1ef89c03))
* RFC-0016 Phase 2 — estimate log writer + class cache (AISDLC-280) ([#498](https://github.com/ai-sdlc-framework/ai-sdlc/issues/498)) ([023e845](https://github.com/ai-sdlc-framework/ai-sdlc/commit/023e8454479ad452e19ba4273f8fab958e8f7f1f))
* **spec:** add backlog-task.v1.schema.json with optional specRef field (AISDLC-444) ([#729](https://github.com/ai-sdlc-framework/ai-sdlc/issues/729)) ([d6d0ce4](https://github.com/ai-sdlc-framework/ai-sdlc/commit/d6d0ce4f816dae179a347212e7ca2ac9651b178d))
* **spec:** add dispatch board protocol + in-session-agent worker (AISDLC-377.1) ([#576](https://github.com/ai-sdlc-framework/ai-sdlc/issues/576)) ([0685b95](https://github.com/ai-sdlc-framework/ai-sdlc/commit/0685b9512661fb6c9fe29b41dc6f70216b7a345c))
* **spec:** add triad/tessellation/parentTessellation to DID schema + init scaffolding (AISDLC-312) ([#544](https://github.com/ai-sdlc-framework/ai-sdlc/issues/544)) ([bc8feea](https://github.com/ai-sdlc-framework/ai-sdlc/commit/bc8feeaab54d9dd0dff16bd345ae203831a5850f))
* **spec:** rfc-0009 phase 3 soul-scoping for 4 resources (AISDLC-315) ([#666](https://github.com/ai-sdlc-framework/ai-sdlc/issues/666)) ([5141be3](https://github.com/ai-sdlc-framework/ai-sdlc/commit/5141be30cc65990dd91d37a8d7362de68fc040da))
* **spec:** rfc-0017 phase 1 soul did variant schema additions (AISDLC-435) ([#726](https://github.com/ai-sdlc-framework/ai-sdlc/issues/726)) ([dbe9ffb](https://github.com/ai-sdlc-framework/ai-sdlc/commit/dbe9ffb3caad42159e9b512a02e0fbfb1994813c))
* **spec:** rfc-0035 phase 5 — stage c llm classifier + corpus (AISDLC-289) ([#673](https://github.com/ai-sdlc-framework/ai-sdlc/issues/673)) ([4745f93](https://github.com/ai-sdlc-framework/ai-sdlc/commit/4745f93acd0cbcc884f2354f8fae215656aa866b))
* **spec:** split RFC requires/assumes dependency semantics (AISDLC-311) ([#684](https://github.com/ai-sdlc-framework/ai-sdlc/issues/684)) ([c2b9200](https://github.com/ai-sdlc-framework/ai-sdlc/commit/c2b9200b9a14d4845ecb8703dc7ff6b571471e08))
* v6 envelope schema + signer (RFC-0042 phase 2) (AISDLC-383.3) ([#598](https://github.com/ai-sdlc-framework/ai-sdlc/issues/598)) ([666858d](https://github.com/ai-sdlc-framework/ai-sdlc/commit/666858d89a7f7149dde5d1ab63296fe3568d7be2))


### Bug Fixes

* **ci:** update stale merge_group trigger assertions post-AISDLC-400 (AISDLC-405) ([#639](https://github.com/ai-sdlc-framework/ai-sdlc/issues/639)) ([ec35a48](https://github.com/ai-sdlc-framework/ai-sdlc/commit/ec35a48cc4fb62670a9b9ee07194dbb3944af844))
* **reference:** handle loader-private YAML kinds without false-positive warnings (AISDLC-265) ([#474](https://github.com/ai-sdlc-framework/ai-sdlc/issues/474)) ([e51029c](https://github.com/ai-sdlc-framework/ai-sdlc/commit/e51029c0da04ac4ef6025281579361470e2039ff))

## [0.10.0](https://github.com/ai-sdlc-framework/ai-sdlc/compare/reference-v0.9.0...reference-v0.10.0) (2026-05-11)


### Features

* **deps:** rfc-0014 phase 1 deps snapshot artifact + GC + externalDependencies (AISDLC-166) ([e5d8fd6](https://github.com/ai-sdlc-framework/ai-sdlc/commit/e5d8fd610fb215ccc447d648801bd0b4919bcb76))
* **deps:** rfc-0014 phase 3 — DoR blast-radius surfacing (AISDLC-167.3) ([a0abb46](https://github.com/ai-sdlc-framework/ai-sdlc/commit/a0abb46cc9e2e01e4f5c46857d995b6bb9f568ef))
* **deps:** rfc-0015 phase 3 — pre-dispatch filter chain (AISDLC-169.3) ([1aecbcf](https://github.com/ai-sdlc-framework/ai-sdlc/commit/1aecbcf95048dfcd54631b50c83229c31b9a18b4))
* **deps:** rfc-0015 phase 4 — events.jsonl writer + cli-status --orchestrator (AISDLC-169.4) ([26daa6f](https://github.com/ai-sdlc-framework/ai-sdlc/commit/26daa6f71ee8c784ebafb93e9ff57e8cd5291d2c))
* **orchestrator:** add BlockedFilter admission gate + blocked frontmatter (AISDLC-223) ([#378](https://github.com/ai-sdlc-framework/ai-sdlc/issues/378)) ([b058407](https://github.com/ai-sdlc-framework/ai-sdlc/commit/b0584072fd94ae0e8428352436fe680e8c1333c2))
* **orchestrator:** add phase + iteration discriminator to retry event (AISDLC-196) ([5dc3a7d](https://github.com/ai-sdlc-framework/ai-sdlc/commit/5dc3a7dc5a3d3be239d5d0258e5f2ea76c1a6bec))
* **orchestrator:** autonomous loop sweeps merged worktrees per tick (AISDLC-256) ([#433](https://github.com/ai-sdlc-framework/ai-sdlc/issues/433)) ([8d3b20d](https://github.com/ai-sdlc-framework/ai-sdlc/commit/8d3b20d489e7ccaeda8793b282f1464647d4687d))
* **orchestrator:** dor bypass + 3-round escalation (AISDLC-115.7) ([9af3ed3](https://github.com/ai-sdlc-framework/ai-sdlc/commit/9af3ed355082ed57df0ade0d1461f00834255fef))
* **orchestrator:** rfc-0023 phase 4 — PRs pane + Critical Path pane (AISDLC-178.4) ([#384](https://github.com/ai-sdlc-framework/ai-sdlc/issues/384)) ([e9488fc](https://github.com/ai-sdlc-framework/ai-sdlc/commit/e9488fc31c9ef56a1589f8c5ba819c56121784aa))
* **orchestrator:** step 3 auto-cleans stale branches in autonomous mode (AISDLC-224) ([#377](https://github.com/ai-sdlc-framework/ai-sdlc/issues/377)) ([35892f5](https://github.com/ai-sdlc-framework/ai-sdlc/commit/35892f5275eb97af622f6529d549d762a45c5826))
* rfc-0011 phase 1 schema + needs-clarification status (AISDLC-115.1) ([300682b](https://github.com/ai-sdlc-framework/ai-sdlc/commit/300682bca895ee9a61da67840c567a36e06a87da))
* **spec:** formalize RFC lifecycle convention - Draft to Implemented (AISDLC-118) ([d4cc79f](https://github.com/ai-sdlc-framework/ai-sdlc/commit/d4cc79f57b661522934e5b1ff48a52333c47ab6d))
* **spec:** make pipeline.yaml canonical; deprecate pipeline-backlog.yaml (AISDLC-245.5) ([#444](https://github.com/ai-sdlc-framework/ai-sdlc/issues/444)) ([281d139](https://github.com/ai-sdlc-framework/ai-sdlc/commit/281d1397400778f7dd90ff78ad24197303b6643f))


### Bug Fixes

* **orchestrator:** enforce dev subagent JSON contract with one retry on parse failure (AISDLC-176) ([28bc0ea](https://github.com/ai-sdlc-framework/ai-sdlc/commit/28bc0eae3dd9ecd3f7fc967d4e57e64cfbd92825))
* **orchestrator:** filter orphan-parent tasks from frontier dispatch (AISDLC-175) ([cc024a8](https://github.com/ai-sdlc-framework/ai-sdlc/commit/cc024a863f82cb2463dfc175a16ecb71490272a8))
* **orchestrator:** rollback event payload + ms-precision quarantine refs (AISDLC-186) ([f8f7fe3](https://github.com/ai-sdlc-framework/ai-sdlc/commit/f8f7fe38ba0f86680e6e7a3bd265f21634895774))
* **orchestrator:** rollback task status + sweep worktree on developer-failed (AISDLC-177) ([04ed1b1](https://github.com/ai-sdlc-framework/ai-sdlc/commit/04ed1b15cf49d1bb89430b034004a267beed7446))
* **orchestrator:** track in-flight dispatches to prevent concurrent re-dispatch (AISDLC-179) ([df274e1](https://github.com/ai-sdlc-framework/ai-sdlc/commit/df274e18a06a6969fa5d3c116fa2a13cc1a286a3))

## [0.9.0](https://github.com/ai-sdlc-framework/ai-sdlc/compare/reference-v0.8.0...reference-v0.9.0) (2026-04-30)


### Features

* add action governance — blockedActions in agent-role.yaml ([#45](https://github.com/ai-sdlc-framework/ai-sdlc/issues/45)) ([eb53342](https://github.com/ai-sdlc-framework/ai-sdlc/commit/eb5334229bfd3f66464c4986efb0c432d1756a3e))
* add Claude Code plugin and SDK runner for native governance integration ([804f068](https://github.com/ai-sdlc-framework/ai-sdlc/commit/804f06801e388fb356cde716291abc4e3386f050))
* implement RFC-0006 Design System Governance Pipeline ([e6dfd4c](https://github.com/ai-sdlc-framework/ai-sdlc/commit/e6dfd4c3f9efdf4b6ddb219f02131c206dfdcb67))
* **orchestrator:** implement rfc-0008 ppa triad integration end-to-end ([522950d](https://github.com/ai-sdlc-framework/ai-sdlc/commit/522950d70b566145feb9718ed88495f09b3e9b9a))
* **orchestrator:** rfc-0010 phase 1 foundations ([9197a0d](https://github.com/ai-sdlc-framework/ai-sdlc/commit/9197a0da89916d9a595289cf493a4918b6f1451d))
* **orchestrator:** rfc-0010 phase 2.5 model routing + classifier ([12b9750](https://github.com/ai-sdlc-framework/ai-sdlc/commit/12b97508db1874b847d4fb40e210cfbef62f3c1a))
* **orchestrator:** rfc-0010 phase 2.7 harness adapter framework ([847a965](https://github.com/ai-sdlc-framework/ai-sdlc/commit/847a96541f45924f89070c8a106ff83e329d8d12))
* **orchestrator:** rfc-0010 phase 2.8 subscription-aware scheduling ([ea26d40](https://github.com/ai-sdlc-framework/ai-sdlc/commit/ea26d40de0f82c06abb70a4c2b920336ee62e6af))
* **reference:** add QualityFlag type + PriorityInput.qualityFlags ([3478e14](https://github.com/ai-sdlc-framework/ai-sdlc/commit/3478e14cad32bc3b5c97ff07ccf28cf21415a361))


### Bug Fixes

* address review findings — add schema, audit logging, requireHumanApproval ([e11a79d](https://github.com/ai-sdlc-framework/ai-sdlc/commit/e11a79dcacd8ff0f19934e09e18c6e169879a52f))
* **orchestrator:** address local review findings for RFC-0008 ([3da537b](https://github.com/ai-sdlc-framework/ai-sdlc/commit/3da537b7aa1dd2a8c184414fc65368a3b23c94fe))
* **reference:** strip GIT_DIR from tokens-studio adapter and test ([65df709](https://github.com/ai-sdlc-framework/ai-sdlc/commit/65df70935cd9b33fe45003ed6dc84a3fd994058e))
* resolve issue [#29](https://github.com/ai-sdlc-framework/ai-sdlc/issues/29) ([8b74a6d](https://github.com/ai-sdlc-framework/ai-sdlc/commit/8b74a6dbe9eee88c85fea40269e79c34ceded39c))
* switch OpenShell to process-level isolation, re-enable in CI ([#31](https://github.com/ai-sdlc-framework/ai-sdlc/issues/31)) ([d340eab](https://github.com/ai-sdlc-framework/ai-sdlc/commit/d340eab03757a9fa725f92f010fcc21a6f0c8c07))

## [0.8.0](https://github.com/ai-sdlc-framework/ai-sdlc/compare/reference-v0.7.0...reference-v0.8.0) (2026-04-30)


### Features

* add action governance — blockedActions in agent-role.yaml ([#45](https://github.com/ai-sdlc-framework/ai-sdlc/issues/45)) ([eb53342](https://github.com/ai-sdlc-framework/ai-sdlc/commit/eb5334229bfd3f66464c4986efb0c432d1756a3e))
* add Claude Code plugin and SDK runner for native governance integration ([804f068](https://github.com/ai-sdlc-framework/ai-sdlc/commit/804f06801e388fb356cde716291abc4e3386f050))
* implement RFC-0006 Design System Governance Pipeline ([e6dfd4c](https://github.com/ai-sdlc-framework/ai-sdlc/commit/e6dfd4c3f9efdf4b6ddb219f02131c206dfdcb67))
* **orchestrator:** implement rfc-0008 ppa triad integration end-to-end ([522950d](https://github.com/ai-sdlc-framework/ai-sdlc/commit/522950d70b566145feb9718ed88495f09b3e9b9a))
* **orchestrator:** rfc-0010 phase 1 foundations ([9197a0d](https://github.com/ai-sdlc-framework/ai-sdlc/commit/9197a0da89916d9a595289cf493a4918b6f1451d))
* **orchestrator:** rfc-0010 phase 2.5 model routing + classifier ([12b9750](https://github.com/ai-sdlc-framework/ai-sdlc/commit/12b97508db1874b847d4fb40e210cfbef62f3c1a))
* **orchestrator:** rfc-0010 phase 2.7 harness adapter framework ([847a965](https://github.com/ai-sdlc-framework/ai-sdlc/commit/847a96541f45924f89070c8a106ff83e329d8d12))
* **orchestrator:** rfc-0010 phase 2.8 subscription-aware scheduling ([ea26d40](https://github.com/ai-sdlc-framework/ai-sdlc/commit/ea26d40de0f82c06abb70a4c2b920336ee62e6af))
* **reference:** add QualityFlag type + PriorityInput.qualityFlags ([3478e14](https://github.com/ai-sdlc-framework/ai-sdlc/commit/3478e14cad32bc3b5c97ff07ccf28cf21415a361))


### Bug Fixes

* address review findings — add schema, audit logging, requireHumanApproval ([e11a79d](https://github.com/ai-sdlc-framework/ai-sdlc/commit/e11a79dcacd8ff0f19934e09e18c6e169879a52f))
* **orchestrator:** address local review findings for RFC-0008 ([3da537b](https://github.com/ai-sdlc-framework/ai-sdlc/commit/3da537b7aa1dd2a8c184414fc65368a3b23c94fe))
* **reference:** strip GIT_DIR from tokens-studio adapter and test ([65df709](https://github.com/ai-sdlc-framework/ai-sdlc/commit/65df70935cd9b33fe45003ed6dc84a3fd994058e))
* resolve issue [#29](https://github.com/ai-sdlc-framework/ai-sdlc/issues/29) ([8b74a6d](https://github.com/ai-sdlc-framework/ai-sdlc/commit/8b74a6dbe9eee88c85fea40269e79c34ceded39c))
* switch OpenShell to process-level isolation, re-enable in CI ([#31](https://github.com/ai-sdlc-framework/ai-sdlc/issues/31)) ([d340eab](https://github.com/ai-sdlc-framework/ai-sdlc/commit/d340eab03757a9fa725f92f010fcc21a6f0c8c07))

## [0.7.0](https://github.com/ai-sdlc-framework/ai-sdlc/compare/reference-v0.6.0...reference-v0.7.0) (2026-04-29)


### Features

* add Claude Code plugin and SDK runner for native governance integration ([804f068](https://github.com/ai-sdlc-framework/ai-sdlc/commit/804f06801e388fb356cde716291abc4e3386f050))
* implement RFC-0006 Design System Governance Pipeline ([e6dfd4c](https://github.com/ai-sdlc-framework/ai-sdlc/commit/e6dfd4c3f9efdf4b6ddb219f02131c206dfdcb67))
* **orchestrator:** implement rfc-0008 ppa triad integration end-to-end ([522950d](https://github.com/ai-sdlc-framework/ai-sdlc/commit/522950d70b566145feb9718ed88495f09b3e9b9a))
* **orchestrator:** rfc-0010 phase 1 foundations ([9197a0d](https://github.com/ai-sdlc-framework/ai-sdlc/commit/9197a0da89916d9a595289cf493a4918b6f1451d))
* **orchestrator:** rfc-0010 phase 2.5 model routing + classifier ([12b9750](https://github.com/ai-sdlc-framework/ai-sdlc/commit/12b97508db1874b847d4fb40e210cfbef62f3c1a))
* **orchestrator:** rfc-0010 phase 2.7 harness adapter framework ([847a965](https://github.com/ai-sdlc-framework/ai-sdlc/commit/847a96541f45924f89070c8a106ff83e329d8d12))
* **orchestrator:** rfc-0010 phase 2.8 subscription-aware scheduling ([ea26d40](https://github.com/ai-sdlc-framework/ai-sdlc/commit/ea26d40de0f82c06abb70a4c2b920336ee62e6af))
* **reference:** add QualityFlag type + PriorityInput.qualityFlags ([3478e14](https://github.com/ai-sdlc-framework/ai-sdlc/commit/3478e14cad32bc3b5c97ff07ccf28cf21415a361))


### Bug Fixes

* **orchestrator:** address local review findings for RFC-0008 ([3da537b](https://github.com/ai-sdlc-framework/ai-sdlc/commit/3da537b7aa1dd2a8c184414fc65368a3b23c94fe))
* **reference:** strip GIT_DIR from tokens-studio adapter and test ([65df709](https://github.com/ai-sdlc-framework/ai-sdlc/commit/65df70935cd9b33fe45003ed6dc84a3fd994058e))

## [0.6.0](https://github.com/ai-sdlc-framework/ai-sdlc/compare/reference-v0.5.0...reference-v0.6.0) (2026-03-31)


### Features

* add action governance — blockedActions in agent-role.yaml ([#45](https://github.com/ai-sdlc-framework/ai-sdlc/issues/45)) ([eb53342](https://github.com/ai-sdlc-framework/ai-sdlc/commit/eb5334229bfd3f66464c4986efb0c432d1756a3e))


### Bug Fixes

* address review findings — add schema, audit logging, requireHumanApproval ([e11a79d](https://github.com/ai-sdlc-framework/ai-sdlc/commit/e11a79dcacd8ff0f19934e09e18c6e169879a52f))
* resolve issue [#29](https://github.com/ai-sdlc-framework/ai-sdlc/issues/29) ([8b74a6d](https://github.com/ai-sdlc-framework/ai-sdlc/commit/8b74a6dbe9eee88c85fea40269e79c34ceded39c))
* switch OpenShell to process-level isolation, re-enable in CI ([#31](https://github.com/ai-sdlc-framework/ai-sdlc/issues/31)) ([d340eab](https://github.com/ai-sdlc-framework/ai-sdlc/commit/d340eab03757a9fa725f92f010fcc21a6f0c8c07))

## [0.5.0](https://github.com/ai-sdlc-framework/ai-sdlc/compare/reference-v0.4.0...reference-v0.5.0) (2026-03-24)


### Features

* add composite IssueTracker adapter for multi-backend routing ([0cf6a12](https://github.com/ai-sdlc-framework/ai-sdlc/commit/0cf6a12cdb21a0592ff448156ea452c8c3ce3e55))
* add credential auto-provisioning, autonomy-level policy mapping, and CI setup ([f89ddfd](https://github.com/ai-sdlc-framework/ai-sdlc/commit/f89ddfdb45ea344b1f2a35b50f3c0b10d703f817))
* add NVIDIA OpenShell sandbox integration ([cac7ab2](https://github.com/ai-sdlc-framework/ai-sdlc/commit/cac7ab2000f7a04722a16f21b7ac0bdcfd119a95))
* add test coverage reporting with Codecov ([f31137a](https://github.com/ai-sdlc-framework/ai-sdlc/commit/f31137a52f3c6ec317c68eef50403e05b2b1c19e))
* address PPA architectural concerns for RFC readiness ([db00094](https://github.com/ai-sdlc-framework/ai-sdlc/commit/db00094b74ed825dc88ddcee885961f01d9a7e17))
* integrate Product Priority Algorithm (PPA) across all SDKs (AISDLC-7) ([bc4a32d](https://github.com/ai-sdlc-framework/ai-sdlc/commit/bc4a32df4de65eb9c853b33e85aac56690092ecf))


### Bug Fixes

* backlog adapter, runner lint/format, and gitignore dedup ([#25](https://github.com/ai-sdlc-framework/ai-sdlc/issues/25)) ([ae44805](https://github.com/ai-sdlc-framework/ai-sdlc/commit/ae4480566181b3f715a7365bccff13968fc883ea))
* run prettier on generated-schemas.ts after generation ([9cf5bc4](https://github.com/ai-sdlc-framework/ai-sdlc/commit/9cf5bc4a23861ea6e2083c69c1444a18f89d8efb))

## [0.4.0](https://github.com/ai-sdlc-framework/ai-sdlc/compare/reference-v0.3.0...reference-v0.4.0) (2026-03-08)


### Features

* add Backlog.md IssueTracker adapter ([3b1e11c](https://github.com/ai-sdlc-framework/ai-sdlc/commit/3b1e11cb4022680fa8cd9e1e24719e57b607bffe))

## [0.3.0](https://github.com/ai-sdlc-framework/ai-sdlc/compare/reference-v0.2.0...reference-v0.3.0) (2026-03-08)


### Miscellaneous

* **reference:** Synchronize node-packages versions

## [0.2.0](https://github.com/ai-sdlc-framework/ai-sdlc/compare/reference-v0.1.2...reference-v0.2.0) (2026-03-06)


### Features

* implement RFC-0004 cost governance (phases 1-3) ([34e0e03](https://github.com/ai-sdlc-framework/ai-sdlc/commit/34e0e03a8d01b9a964f71b1096654183c8f6d75f))


### Bug Fixes

* address feedback issues [#3](https://github.com/ai-sdlc-framework/ai-sdlc/issues/3), [#4](https://github.com/ai-sdlc-framework/ai-sdlc/issues/4), [#8](https://github.com/ai-sdlc-framework/ai-sdlc/issues/8), [#9](https://github.com/ai-sdlc-framework/ai-sdlc/issues/9), [#10](https://github.com/ai-sdlc-framework/ai-sdlc/issues/10) ([0efc9dd](https://github.com/ai-sdlc-framework/ai-sdlc/commit/0efc9dd78eb1ab1ebfe93507b74650ca6b687926))
* resolve all lint and format errors across codebase ([27526fa](https://github.com/ai-sdlc-framework/ai-sdlc/commit/27526faef49fec6fabca3cfdbb11994721866e90))
* resolve eslint errors in generated schema files ([0e2180e](https://github.com/ai-sdlc-framework/ai-sdlc/commit/0e2180e098d079da73c2c3393ea4c6b2a8c8a769))
* resolve workspace:* leak and invalid init templates ([68404b7](https://github.com/ai-sdlc-framework/ai-sdlc/commit/68404b7e92687b558e0e842a3642ddc52613698b))
* sync Go SDK schemas with canonical spec and add publishConfig to packages ([78283b3](https://github.com/ai-sdlc-framework/ai-sdlc/commit/78283b35b2c6986f30e35f92a5ddf01c8e3b3462))

## 0.1.2

### Patch Changes

- e37c98a: Fix validation error messages, add validate command, wire gate check runs, and load config into MCP advisor
