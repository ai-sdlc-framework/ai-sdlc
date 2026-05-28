# @ai-sdlc/reference

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
